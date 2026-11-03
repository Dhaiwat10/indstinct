// Browser tasks: multi-step jobs on websites (web check-in, rescheduling, long forms) that run in
// the background, outside the reply turn. A task can stop to ask the user something, wait for
// the answer in WhatsApp, carry on, and finish by sending text and files.
import { generateText, stepCountIs, tool, type ToolSet } from "ai";
import { z } from "zod";
import { PageSession, pageTools } from "../browse/tools.js";
import { saveMessage } from "../db/messages.js";
import { createTask, endTask, getTask, interruptAll, logStep, markRunning, markWaiting, openTask, type Question, type Task } from "../db/tasks.js";
import { getUser } from "../db/users.js";
import { log } from "../log.js";
import { noDashes } from "../text.js";
import { inferenceContext } from "../nearai/capture.js";
import { models } from "../nearai/client.js";

export type OutFile = { data: Buffer; mimeType: string; name: string };
export type TaskIO = {
  send: (jid: string, text: string) => Promise<void>;
  sendFile: (jid: string, file: OutFile) => Promise<void>;
};
/** What the sub-agent does with a task; the real one drives a browser, tests pass a script. */
export type TaskWorker = (task: Task, tools: ToolSet, abort: AbortSignal) => Promise<string>;

/** How long a question waits for the user before the task stops and reports where it got to. */
export const ANSWER_WAIT_MS = 30 * 60_000;
/** Progress notes are rate-limited so a chatty model can't flood the chat. */
const NOTE_GAP_MS = 2 * 60_000;
/** Open browsers at once, across all users; each is a few hundred MB on one droplet. */
const MAX_RUNNING = 3;
/** Not a task length limit: a guard against a model stuck in a loop burning credits forever. */
const RUNAWAY_STEPS = 250;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

type Live = {
  abort: AbortController;
  answer?: (text: string) => void;
  files: OutFile[];
};
const live = new Map<number, Live>();
let io: TaskIO | undefined;
let worker: TaskWorker = browserWorker;

const jidOf = (userId: string) => getUser(userId)?.chat_jid ?? userId;

/** Sends to the user and keeps it in history, so later turns know what the task said. */
async function say(userId: string, raw: string): Promise<void> {
  // WhatsApp bolds with one asterisk; models often write markdown's two.
  const text = noDashes(raw).replace(/\*\*(.+?)\*\*/g, "*$1*").replace(/^#{1,6}\s+/gm, "");
  saveMessage(userId, "assistant", text);
  await io?.send(jidOf(userId), text);
}

function formatQuestion(id: number, q: Question): string {
  const opts = q.options?.length ? `\n${q.options.map((o, i) => `${i + 1}) ${o}`).join("\n")}` : "";
  const lead = q.kind === "otp" ? "🔐 " : q.kind === "approval" ? "✋ " : "";
  return `${lead}${q.text}${opts}\n\n_(task #${id})_`;
}

/** Luhn-valid 13 to 19 digits: a card number. The task tools refuse to type one. */
function looksLikeCard(text: string): boolean {
  const digits = text.replace(/[\s-]/g, "");
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}
const SECRET_FIELD = /password|passcode|cvv|cvc|card number|upi pin|\bpin\b|net ?banking|expiry/i;

/** True when typing `text` into field `name` would hand over a password or payment details. */
export function forbiddenInput(name: string, text: string): boolean {
  return SECRET_FIELD.test(name) || looksLikeCard(text);
}

/** The tools a task gets on top of the page tools: talk to the user, keep files, and the hard limits. */
function taskTools(task: Task, session: PageSession, state: Live): ToolSet {
  let lastNote = 0;
  const page = pageTools(session);
  const type = page.type.execute!;
  return {
    ...page,
    type: tool({
      description: page.type.description!,
      inputSchema: page.type.inputSchema,
      execute: async (input, options) => {
        if (forbiddenInput(input.name, input.text))
          return "refused: passwords, card details, PINs and payment codes are never typed. If the site needs them, stop and tell the user.";
        logStep(task.id, `type into ${input.role} "${input.name.slice(0, 60)}"`);
        return type(input, options);
      },
    }),
    ask_user: tool({
      description:
        "Ask the user something and wait for their answer (up to 30 minutes). kind: 'choice' for options the site offers that the user didn't settle (passengers, seats, meals); 'approval' before ANY click that submits, confirms, declares or pays, stating exactly what will be submitted; 'otp' when the site sent the user a one-time code; 'info' for a missing detail. Returns the user's words.",
      inputSchema: z.object({
        kind: z.enum(["choice", "approval", "otp", "info"]),
        text: z.string().min(3).describe("the question as the user will read it on WhatsApp"),
        options: z.array(z.string()).optional(),
      }),
      execute: async (q) => {
        markWaiting(task.id, q);
        logStep(task.id, `asked the user (${q.kind})`);
        await say(task.user_id, formatQuestion(task.id, q));
        const answer = await new Promise<string | undefined>((resolve) => {
          const timer = setTimeout(() => resolve(undefined), ANSWER_WAIT_MS);
          state.answer = (text) => {
            clearTimeout(timer);
            resolve(text);
          };
          state.abort.signal.addEventListener("abort", () => (clearTimeout(timer), resolve(undefined)), { once: true });
        });
        state.answer = undefined;
        if (state.abort.signal.aborted) return "The task was cancelled.";
        markRunning(task.id);
        if (answer === undefined) return "No answer in 30 minutes. Stop here: don't submit anything, and finish by saying where you got to.";
        return `The user answered: ${answer}`;
      },
    }),
    tell_user: tool({
      description: "Send the user a short progress note, e.g. \"Found the booking, 2 passengers\". At most one every 2 minutes.",
      inputSchema: z.object({ text: z.string().min(3).max(300) }),
      execute: async ({ text }) => {
        if (Date.now() - lastNote < NOTE_GAP_MS) return "skipped: you sent a note less than 2 minutes ago";
        lastNote = Date.now();
        await say(task.user_id, text);
        return "sent";
      },
    }),
    save_file: tool({
      description:
        "Keep a file to send the user when the task finishes. 'pdf' prints the current page (best for a boarding pass shown on screen); 'screenshot' captures the page or one element (e.g. a QR code); 'download' keeps the file the page downloaded last.",
      inputSchema: z.object({
        kind: z.enum(["pdf", "screenshot", "download"]),
        name: z.string().min(1).describe('file name without extension, e.g. "boarding-pass-dhaiwat"'),
        element: z.object({ role: z.string(), name: z.string() }).optional().describe("for a screenshot of one element"),
      }),
      execute: async ({ kind, name, element }) => {
        const p = await session.page();
        const safe = name.replace(/[^\w.-]+/g, "-").slice(0, 60);
        let file: OutFile;
        try {
          if (kind === "download") {
            const d = session.lastDownload;
            if (!d) return "no download yet: click the download button first, or use pdf or screenshot";
            const chunks: Buffer[] = [];
            for await (const c of await d.createReadStream()) chunks.push(c as Buffer);
            file = { data: Buffer.concat(chunks), mimeType: d.suggestedFilename().endsWith(".pdf") ? "application/pdf" : "application/octet-stream", name: d.suggestedFilename() };
          } else if (kind === "pdf") {
            file = { data: await p.pdf({ printBackground: true }), mimeType: "application/pdf", name: `${safe}.pdf` };
          } else {
            const target = element ? p.getByRole(element.role as Parameters<typeof p.getByRole>[0], { name: element.name }).first() : undefined;
            const data = target ? await target.screenshot() : await p.screenshot({ fullPage: true });
            file = { data, mimeType: "image/png", name: `${safe}.png` };
          }
        } catch (err) {
          const why = (err as Error).message.split("\n")[0];
          return kind === "pdf" ? `couldn't print to PDF (${why}); use a screenshot instead` : `couldn't save the file (${why})`;
        }
        if (file.data.length > MAX_FILE_BYTES) return "file is too large to send on WhatsApp";
        state.files.push(file);
        logStep(task.id, `saved ${kind}`);
        return `saved ${file.name}; it will be sent when you finish`;
      },
    }),
  };
}

const system = `You are doing a task on websites for the user, in a real browser. Work step by step towards the goal using the details given. The user is on WhatsApp and only sees what you send with tell_user and ask_user, and your final answer.
Pages are shown as accessibility snapshots: "- role \\"name\\"" lines. Act using a role and name from the snapshot. Use find on long pages, extract to pull lists of results into rows, and look when the snapshot doesn't explain the page (seat maps, images, captchas).
The user is in India. If a site shows another country, currency or language, switch it to India, INR and English first (a region or currency setting, or URL parameters such as gl=IN, hl=en, curr=INR).
Finding or comparing things (cheapest, best, available options): use the first good site that takes the user's exact criteria (dates, places, filters, sort by price when that's the question), then extract the results. For a range of dates, use the site's date grid or price calendar instead of searching each date. Check a second site only if the first failed, blocked you, or its results look wrong. Report the top few with the facts that matter (price, times, stops, key conditions) and the site, and only what you saw on a page, never an estimate. As soon as you have a good answer, finish: the user is waiting. Lookups like this need no approval, since nothing is submitted.
Rules:
- Before any click that submits, confirms, declares or pays, call ask_user with kind "approval" and say exactly what you are about to submit: names, flight or booking, seats, every declaration you will tick, any fee. Continue only on a clear yes.
- Choices the user didn't settle (which passengers, seats, meals, add-ons): ask with kind "choice". Never pick a paid option without approval; prefer "skip" or the free default.
- If the site sends the user a one-time code (OTP) to verify the booking, ask for it with kind "otp", type it in and carry on. Payment OTPs are different: never.
- Never type passwords, card numbers, CVVs, UPI PINs or bank logins, and never create an account. Booking reference plus surname style access is fine. If a site insists on a password or payment, stop and say so.
- Captchas are solved automatically by the browser most of the time; if one stays, use look and, for a text captcha, ask the user (kind "info").
- When a boarding pass, confirmation or receipt appears, save_file it (pdf, or a screenshot of the QR code).
- Send a short tell_user note when something meaningful happens (found the booking, submitted), not for every click.
- Messages go to WhatsApp: *bold* with single asterisks, • for bullets, no markdown headers or tables, at most one link and only a short one (the site's home or results page, not a long tracking URL).
- Finish with a short message for the user: what was done, key facts (seats, times, confirmation numbers), and what they need to do next, if anything. If you couldn't finish, say exactly where you stopped and why. Never claim something was done that you didn't see confirmed on the page.`;

/** The real worker: the browser sub-agent on the heavy model, with no step cap but a runaway guard. */
async function browserWorker(task: Task, tools: ToolSet, abort: AbortSignal): Promise<string> {
  const started = Date.now();
  let nudged = 0;
  const result = await inferenceContext.run({ userId: task.user_id, purpose: "task" }, () =>
    generateText({
      model: models.heavy(),
      system,
      prompt: `Goal: ${task.goal}\n\nDetails from the user:\n${task.details ?? "(none)"}`,
      tools,
      stopWhen: stepCountIs(RUNAWAY_STEPS),
      abortSignal: abort,
      // Not a limit: every 5 minutes the agent hears how long it's been, so it finishes once it has an answer.
      prepareStep: () => {
        const minutes = Math.floor((Date.now() - started) / 60_000);
        if (minutes < 5 || minutes < nudged + 5) return {};
        nudged = minutes;
        return {
          instructions: `${system}\n\nYou've been working on this for ${minutes} minutes and the user is waiting. If you already have a good answer, finish now with it. If you're stuck, say where and why.`,
        };
      },
      maxRetries: 0, // capturingFetch retries
      onStepFinish: (step) => {
        for (const c of step.toolCalls) {
          const i = c.input as { url?: string; role?: string; name?: string };
          if (c.toolName === "goto" && i.url) logStep(task.id, `goto ${new URL(i.url).hostname}`);
          else if (c.toolName === "click") logStep(task.id, `click ${i.role} "${String(i.name).slice(0, 60)}"`);
        }
      },
    }),
  );
  return result.text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

async function run(task: Task): Promise<void> {
  const state: Live = { abort: new AbortController(), files: [] };
  live.set(task.id, state);
  const session = new PageSession(true);
  const t0 = Date.now();
  try {
    const answer = await worker(task, taskTools(task, session, state), state.abort.signal);
    if (state.abort.signal.aborted) return;
    const text = answer || "I stopped without finishing. Ask me to try again if you like.";
    endTask(task.id, "done", text);
    await say(task.user_id, text);
    for (const f of state.files) await io?.sendFile(jidOf(task.user_id), f);
    log.info({ task: task.id, user: task.user_id, ms: Date.now() - t0, files: state.files.length }, "task done");
  } catch (err) {
    if (state.abort.signal.aborted) return;
    log.warn({ err, task: task.id }, "task failed");
    const text = "Sorry, that task broke on my side and I had to stop. Check the site before trying again, in case something went through. Want me to try again?";
    endTask(task.id, "failed", text);
    await say(task.user_id, text).catch(() => {});
  } finally {
    live.delete(task.id);
    await session.close();
  }
}

/** Starts a task in the background. Returns its id, or why it couldn't start. */
export function startTask(userId: string, goal: string, details: string): { id: number } | { error: string } {
  const current = openTask(userId);
  if (current) return { error: `task #${current.id} (${current.goal}) is still ${current.status}; finish or cancel it first` };
  if (live.size >= MAX_RUNNING) return { error: "too many browser tasks are running right now; try again in a few minutes" };
  const id = createTask(userId, goal, details);
  void run(getTask(id)!);
  log.info({ task: id, user: userId }, "task started");
  return { id };
}

/** Hands the user's answer to the task waiting on it. */
export function replyToTask(userId: string, answer: string): { task: Task } | { error: string } {
  const task = openTask(userId);
  if (!task) return { error: "no task is open" };
  const state = live.get(task.id);
  if (task.status !== "waiting" || !state?.answer) return { error: `task #${task.id} isn't waiting for an answer right now` };
  state.answer(answer);
  return { task };
}

export async function cancelTask(userId: string): Promise<Task | undefined> {
  const task = openTask(userId);
  if (!task) return undefined;
  live.get(task.id)?.abort.abort();
  endTask(task.id, "cancelled", "Cancelled.");
  log.info({ task: task.id }, "task cancelled");
  return task;
}

/** Wires the runner to WhatsApp. Tasks cut off by a restart are reported once, when sending works. */
export function startTaskRunner(taskIO: TaskIO, connected: () => boolean, testWorker?: TaskWorker): void {
  io = taskIO;
  if (testWorker) worker = testWorker;
  const cut = interruptAll();
  if (!cut.length) return;
  const notify = async () => {
    if (!connected()) return void setTimeout(notify, 5_000);
    for (const t of cut)
      await say(t.user_id, `I restarted and lost my place in task #${t.id} (${t.goal}). Check the site in case something went through, then say "try again" and I'll start over.`).catch(() => {});
  };
  void notify();
}
