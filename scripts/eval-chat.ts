// Conversation eval: scripted multi-turn chats through the real agent, each on a fresh user in a
// throwaway database. Hard checks look at replies and saved state; a judge model grades every
// reply on language, focus, length and needless follow-up questions.
// Run: pnpm eval:chat [name-filter]
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z as Z } from "zod";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "indstinct-eval-"));
process.env.LOG_LEVEL ??= "error";

const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
const { generateText, Output } = await import("ai");
const { z } = await import("zod");
const { config } = await import("../src/config.js");
const { runAgent } = await import("../src/agent/run.js");
const { clearHistory } = await import("../src/db/messages.js");
const { listMemories } = await import("../src/db/memories.js");
const { activeSchedules } = await import("../src/db/schedules.js");
const { openTodos } = await import("../src/db/todos.js");
const { getUser, markOnboarded, upsertUser } = await import("../src/db/users.js");

type User = NonNullable<ReturnType<typeof getUser>>;
type Ctx = { reply: string; tools: { name: string; input: any }[]; user: User };
type Check = (c: Ctx) => string | true;
type Turn = { say: string; check?: Check; waitMs?: number; resetAfter?: boolean };
type Convo = { name: string; fresh?: boolean; turns: Turn[] };

// --- helpers -----------------------------------------------------------------

const TZ = "Asia/Kolkata";
/** IST wall-clock time `days` from today, as epoch ms. */
function ist(days: number, hh: number, mm = 0): number {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(Date.now() + days * 86_400_000))
    .split("-");
  return new Date(`${y}-${m}-${d}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+05:30`).getTime();
}
const ratio = (s: string, re: RegExp) => (s.match(new RegExp(re, "g"))?.length ?? 0) / Math.max(1, s.replace(/\s/g, "").length);
const used = (c: Ctx, name: string) => c.tools.some((t) => t.name === name);
const all = (...checks: Check[]): Check => (c) => {
  for (const ch of checks) {
    const r = ch(c);
    if (r !== true) return r;
  }
  return true;
};
const scheduleAt = (when: () => number, slackMs = 60_000): Check => (c) => {
  const s = activeSchedules(c.user.id).at(-1);
  if (!s) return "no schedule saved";
  const diff = Math.abs(new Date(s.next_run_at).getTime() - when());
  return diff <= slackMs || `scheduled for ${s.next_run_at}`;
};
const script = (re: RegExp, name: string): Check => (c) => ratio(c.reply, re) > 0.3 || `reply not in ${name} script`;
const maxLen = (n: number): Check => (c) => c.reply.length <= n || `reply is ${c.reply.length} chars (max ${n})`;
const contains = (re: RegExp): Check => (c) => re.test(c.reply) || `reply missing ${re}`;
const noTools: Check = (c) => c.tools.length === 0 || `called ${c.tools.map((t) => t.name).join(", ")}`;

// --- conversations -------------------------------------------------------------

const CONVOS: Convo[] = [
  {
    name: "onboarding",
    fresh: true,
    turns: [
      { say: "hi", check: all(contains(/\?/), maxLen(350), (c) => !config.GMAIL_ENABLED || /\/gmail/i.test(c.reply) || "welcome doesn't mention /gmail") },
      {
        say: "I'm Dhaiwat, based in Bangalore. English is fine",
        check: (c) => {
          const u = getUser(c.user.id)!;
          return (/dhaiwat/i.test(u.name ?? "") && /bangalore|bengaluru/i.test(u.city ?? "")) || `profile ${u.name}/${u.city}`;
        },
      },
    ],
  },
  {
    name: "english after hinglish",
    turns: [
      { say: "yaar aaj office mein bahut kaam tha, thak gaya" },
      { say: "Can you suggest a good book to read this weekend?", check: (c) => ratio(c.reply, /[a-z]/i) > 0.5 || "not English" },
    ],
  },
  {
    name: "hindi reminder",
    turns: [{ say: "मुझे कल सुबह 6 बजे उठना है, याद दिला देना", check: all(script(/[ऀ-ॿ]/, "Devanagari"), scheduleAt(() => ist(1, 6))) }],
  },
  {
    name: "gujarati reminder",
    turns: [{ say: "મને કાલે સવારે 8 વાગ્યે યાદ કરાવજો કે દવા લેવાની છે", check: all(script(/[઀-૿]/, "Gujarati"), scheduleAt(() => ist(1, 8))) }],
  },
  {
    name: "memory recall after reset",
    turns: [
      { say: "my sister Priya's wedding is on 12 December in Jaipur", waitMs: 12_000, resetAfter: true },
      { say: "what's happening in December?", check: contains(/priya|jaipur|wedding/i) },
    ],
  },
  {
    name: "memory correction",
    turns: [
      { say: "btw I'm vegetarian", waitMs: 10_000 },
      {
        say: "actually I started eating chicken last month",
        waitMs: 12_000,
        check: (c) => {
          const stale = listMemories(c.user.id).find((m) => /vegetarian/i.test(m.content) && !/(no longer|not|chicken|stopped|used to)/i.test(m.content));
          return !stale || `stale memory: ${stale.content}`;
        },
      },
    ],
  },
  { name: "reminder kal", turns: [{ say: "remind me kal subah 7 baje to call mom", check: scheduleAt(() => ist(1, 7)) }] },
  {
    name: "reminder relative",
    turns: [{ say: "remind me in 2 hours to take my medicine", check: scheduleAt(() => Date.now() + 2 * 3_600_000, 3 * 60_000) }],
  },
  {
    name: "recurring weekdays",
    turns: [
      {
        say: "every weekday at 9am remind me to stand up and stretch",
        check: (c) => {
          const s = activeSchedules(c.user.id).find((x) => x.kind === "cron");
          return ["0 9 * * 1-5", "0 9 * * MON-FRI"].includes(s?.cron_expr ?? "") || `cron ${s?.cron_expr}`;
        },
      },
    ],
  },
  {
    name: "cancel reminder",
    turns: [
      { say: "remind me tomorrow at 6pm to water the plants" },
      { say: "actually cancel that", check: (c) => activeSchedules(c.user.id).length === 0 || "schedule still active" },
    ],
  },
  {
    name: "todos",
    turns: [
      { say: "add pay electricity bill and buy groceries to my list", check: (c) => openTodos(c.user.id).length === 2 || `${openTodos(c.user.id).length} todos` },
      { say: "paid the electricity bill", check: (c) => !openTodos(c.user.id).some((t) => /electric/i.test(t.title)) || "still open" },
    ],
  },
  {
    name: "search follow-up",
    turns: [
      { say: "what's the latest news about ISRO?", check: (c) => used(c, "web_search") || "no web_search" },
      { say: "tell me more about the first one", check: maxLen(2000) },
    ],
  },
  { name: "chit-chat", turns: [{ say: "haha kaise ho yaar", check: all(noTools, maxLen(300)) }] },
  { name: "quick math", turns: [{ say: "what's 15% of 2400?", check: all(contains(/360/), maxLen(250)) }] },
  { name: "thanks", turns: [{ say: "thanks!", check: all(noTools, maxLen(150)) }] },
  { name: "can't do it", turns: [{ say: "can you call my mom and tell her I'll be late?", check: all(noTools, maxLen(400)) }] },
];

// --- judge ---------------------------------------------------------------------

const judgeModel = createOpenAICompatible({
  name: "nearai",
  baseURL: config.NEAR_AI_BASE_URL,
  apiKey: config.NEAR_AI_API_KEY,
  supportsStructuredOutputs: true,
}).chatModel(process.env.EVAL_JUDGE ?? "Qwen/Qwen3.8-27B");

const verdict = z.object({
  language_ok: z.boolean().describe("Reply uses the same language and script as the user's latest message (English→English, Hinglish→Hinglish, Hindi in Devanagari→Devanagari, …)"),
  focused: z.boolean().describe("Answers what was asked, with no unrelated tangents or unrequested extra topics"),
  concise: z.boolean().describe("No longer than a good WhatsApp reply to this message needs to be"),
  needless_question: z
    .boolean()
    .describe("Ends with a follow-up question or offer of more help that wasn't needed. Asking back in casual small talk, or asking for info required to do the task, is fine"),
  note: z.string().describe("At most 15 words on the biggest problem, or empty if none"),
});
type Verdict = Z.infer<typeof verdict>;

async function judge(prev: string | undefined, say: string, reply: string): Promise<Verdict | undefined> {
  try {
    const { output } = await generateText({
      model: judgeModel,
      system:
        "You grade replies from a WhatsApp personal assistant for Indian users. Be strict but fair. Judge only the four criteria; don't fact-check (the assistant may have searched the web for things after your training data).",
      prompt: `${prev ? `Earlier user message: ${prev}\n` : ""}User's latest message: ${say}\n\nAssistant reply:\n${reply}`,
      output: Output.object({ schema: verdict }),
    });
    return output;
  } catch {
    return undefined;
  }
}

// --- run -----------------------------------------------------------------------

type Row = { convo: string; turn: number; say: string; reply: string; tools: string[]; fail?: string; v?: Verdict; ms: number };

async function runConvo(convo: Convo, i: number): Promise<Row[]> {
  const phone = `9100${String(i).padStart(8, "0")}`;
  const id = `${phone}@s.whatsapp.net`;
  upsertUser(id, phone, "Dev");
  if (!convo.fresh) markOnboarded(id);
  const rows: Row[] = [];
  for (const [n, turn] of convo.turns.entries()) {
    const user = getUser(id)!;
    const t0 = Date.now();
    let row: Row;
    try {
      const { reply, tools } = await runAgent(user, { text: turn.say, images: [] });
      const ctx = { reply, tools: tools.map((t) => ({ name: t.name, input: t.input })), user };
      const ok = turn.check?.(ctx) ?? true;
      row = { convo: convo.name, turn: n + 1, say: turn.say, reply, tools: ctx.tools.map((t) => t.name), fail: ok === true ? undefined : ok, ms: Date.now() - t0 };
    } catch (err) {
      row = { convo: convo.name, turn: n + 1, say: turn.say, reply: "", tools: [], fail: `error: ${(err as Error).message}`, ms: Date.now() - t0 };
    }
    row.v = row.reply ? await judge(convo.turns[n - 1]?.say, turn.say, row.reply) : undefined;
    rows.push(row);
    if (turn.waitMs) await new Promise((r) => setTimeout(r, turn.waitMs));
    if (turn.resetAfter) clearHistory(id);
  }
  return rows;
}

const filter = process.argv[2]?.toLowerCase();
const convos = CONVOS.filter((c) => !filter || c.name.includes(filter));

/** A few conversations at a time, to stay friendly with rate limits. */
async function pool<T, R>(items: T[], size: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

const rows = (await pool(convos, 5, runConvo)).flat();

const checked = rows.filter((r) => convos.find((c) => c.name === r.convo)!.turns[r.turn - 1]!.check);
const judged = rows.filter((r) => r.v);
const rate = (f: (v: Verdict) => boolean) => `${Math.round((100 * judged.filter((r) => f(r.v!)).length) / Math.max(1, judged.length))}%`;

for (const r of rows) {
  const flags = [
    r.fail && `❌ ${r.fail}`,
    r.v && !r.v.language_ok && "lang",
    r.v && !r.v.focused && "tangent",
    r.v && !r.v.concise && "long",
    r.v?.needless_question && "question",
  ].filter(Boolean);
  if (!flags.length && !process.env.VERBOSE) continue;
  console.log(`\n── ${r.convo} #${r.turn}  [${flags.join(", ") || "ok"}]  ${r.ms}ms  tools: ${r.tools.join(", ") || "-"}`);
  console.log(`> ${r.say}\n${r.reply}`);
  if (r.v?.note) console.log(`judge: ${r.v.note}`);
}

const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
console.log(`\n${convos.length} conversations, ${rows.length} turns`);
console.log(`hard checks   ${checked.filter((r) => !r.fail).length}/${checked.length}`);
console.log(`language ok   ${rate((v) => v.language_ok)}`);
console.log(`focused       ${rate((v) => v.focused)}`);
console.log(`concise       ${rate((v) => v.concise)}`);
console.log(`no needless ? ${rate((v) => !v.needless_question)}`);
console.log(`latency p50 ${ms[Math.floor(ms.length / 2)]}ms  p90 ${ms[Math.floor(ms.length * 0.9)]}ms`);
process.exit(checked.some((r) => r.fail) ? 1 : 0);
