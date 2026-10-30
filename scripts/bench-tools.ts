// Tool-calling benchmark: which TEE-tier model picks the right tool with the right
// arguments most often, and how fast? Tools are stubs; nothing is saved.
// Run: pnpm bench:tools [runs-per-case]
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { config } from "../src/config.js";

const MODELS = ["Qwen/Qwen3.8-27B", "z-ai/glm-5.3-flash", "deepseek-ai/DeepSeek-V4.1-Flash-1017", "Qwen/Qwen3.6-35B-A3B-FP8"];
const RUNS = Number(process.argv[2] ?? 2);

// Fixed clock so time arithmetic has one right answer: Sat 31 Oct 2026, 10:00 am IST.
const NOW = "Saturday, 31 October 2026 at 10:00 am (Asia/Kolkata, UTC+05:30)";
const ist = (s: string) => new Date(`${s}+05:30`).getTime();

const nearai = createOpenAICompatible({ name: "nearai", baseURL: config.NEAR_AI_BASE_URL, apiKey: config.NEAR_AI_API_KEY });

const ok = async () => "ok";
const tools = {
  remember: tool({
    description: "Save one durable fact about the user or someone in their life.",
    inputSchema: z.object({ fact: z.string(), category: z.enum(["person", "preference", "fact", "event", "other"]) }),
    execute: ok,
  }),
  forget: tool({
    description: "Archive memories matching a description.",
    inputSchema: z.object({ query: z.string() }),
    execute: ok,
  }),
  add_todo: tool({
    description: "Add an item to the user's to-do list.",
    inputSchema: z.object({ title: z.string(), due_at_iso: z.string().optional() }),
    execute: ok,
  }),
  list_todos: tool({ description: "List the user's open to-dos.", inputSchema: z.object({}), execute: ok }),
  set_reminder: tool({
    description: "Send the user a one-time reminder message at a specific time. at_iso must include a UTC offset.",
    inputSchema: z.object({ at_iso: z.string(), text: z.string() }),
    execute: ok,
  }),
  schedule_recurring: tool({
    description:
      "Run a task on a recurring schedule in the user's timezone. cron_expr is 5-field cron (min hour dom mon dow, Sunday=0). prompt is what to do each time.",
    inputSchema: z.object({ cron_expr: z.string(), prompt: z.string(), description: z.string() }),
    execute: ok,
  }),
  web_search: tool({
    description: "Search the web for current information.",
    inputSchema: z.object({ query: z.string() }),
    execute: async () => "1. Example result — https://example.com — snippet",
  }),
};

type Call = { toolName: string; input: Record<string, any> };
type Case = { name: string; prompt: string; check: (calls: Call[]) => string | true };

const find = (calls: Call[], name: string) => calls.find((c) => c.toolName === name);
const at = (c: Call | undefined) => (c ? new Date(c.input.at_iso).getTime() : NaN);
const cron = (c: Call | undefined) => String(c?.input.cron_expr ?? "").trim().replace(/\s+/g, " ");
const has = (c: Call | undefined, field: string, re: RegExp) => re.test(String(c?.input[field] ?? ""));

const CASES: Case[] = [
  {
    name: "reminder · Hinglish tomorrow",
    prompt: "remind me kal subah 7 baje to call mom",
    check: (cs) => {
      const c = find(cs, "set_reminder");
      if (!c) return "no set_reminder";
      return at(c) === ist("2026-11-01T07:00:00") || `wrong time ${c.input.at_iso}`;
    },
  },
  {
    name: "reminder · relative",
    prompt: "remind me in 2 hours to take my medicine",
    check: (cs) => {
      const c = find(cs, "set_reminder");
      if (!c) return "no set_reminder";
      return at(c) === ist("2026-10-31T12:00:00") || `wrong time ${c.input.at_iso}`;
    },
  },
  {
    name: "reminder · parso, 1h before",
    prompt: "parso shaam 6 baje dentist appointment hai, ek ghanta pehle yaad dila dena",
    check: (cs) => {
      const c = find(cs, "set_reminder");
      if (!c) return "no set_reminder";
      return at(c) === ist("2026-11-02T17:00:00") || `wrong time ${c.input.at_iso}`;
    },
  },
  {
    name: "remember · person",
    prompt: "my sister Priya's birthday is on 12 March",
    check: (cs) => {
      const c = find(cs, "remember");
      if (!c) return "no remember";
      return (has(c, "fact", /priya/i) && has(c, "fact", /march|12\/03|03-12/i)) || `weak fact "${c.input.fact}"`;
    },
  },
  {
    name: "forget",
    prompt: "forget that I'm vegetarian, I eat chicken now",
    check: (cs) => (find(cs, "forget") ? true : "no forget"),
  },
  {
    name: "todo · add",
    prompt: "add buy milk and eggs to my list",
    check: (cs) => {
      const adds = cs.filter((c) => c.toolName === "add_todo");
      if (!adds.length) return "no add_todo";
      const titles = adds.map((c) => c.input.title).join(" | ");
      return (/milk/i.test(titles) && /egg/i.test(titles)) || `titles "${titles}"`;
    },
  },
  {
    name: "todo · list",
    prompt: "what's on my todo list?",
    check: (cs) => (find(cs, "list_todos") ? true : "no list_todos"),
  },
  {
    name: "cron · daily",
    prompt: "every morning at 8 send me the top 3 cricket headlines",
    check: (cs) => {
      const c = find(cs, "schedule_recurring");
      if (!c) return "no schedule_recurring";
      return cron(c) === "0 8 * * *" || `cron "${cron(c)}"`;
    },
  },
  {
    name: "cron · Hindi weekly",
    prompt: "हर रविवार सुबह 9 बजे मुझे हफ्ते का प्लान बनाने की याद दिलाना",
    check: (cs) => {
      const c = find(cs, "schedule_recurring");
      if (!c) return "no schedule_recurring";
      return ["0 9 * * 0", "0 9 * * 7", "0 9 * * SUN"].includes(cron(c)) || `cron "${cron(c)}"`;
    },
  },
  {
    name: "search",
    prompt: "what's the latest on the Bengaluru metro yellow line?",
    check: (cs) => (find(cs, "web_search") ? true : "no web_search"),
  },
  {
    name: "no tool · chit-chat",
    prompt: "haha kaise ho yaar",
    check: (cs) => cs.length === 0 || `called ${cs.map((c) => c.toolName).join(",")}`,
  },
  {
    name: "multi · remember + remind",
    prompt: "I moved to Pune last month. Remind me tomorrow at 10am to update my address with the bank",
    check: (cs) => {
      const r = find(cs, "set_reminder");
      const m = find(cs, "remember");
      if (!r || !m) return `called ${cs.map((c) => c.toolName).join(",") || "nothing"}`;
      if (!has(m, "fact", /pune/i)) return `weak fact "${m.input.fact}"`;
      return at(r) === ist("2026-11-01T10:00:00") || `wrong time ${r.input.at_iso}`;
    },
  },
];

const SYSTEM = `You are Indstinct, a personal assistant on WhatsApp for Indian users. Be brief.
Use tools whenever the user asks you to remember, forget, remind, schedule, track to-dos or look something up. Save durable personal facts with remember even if not asked.
Now: ${NOW}. Interpret all times in IST unless told otherwise.`;

type Result = { model: string; case: string; pass: boolean; why?: string; ms: number };

async function runCase(model: string, c: Case): Promise<Result> {
  const t0 = Date.now();
  try {
    const r = await generateText({
      model: nearai.chatModel(model),
      system: SYSTEM,
      prompt: c.prompt,
      tools,
      stopWhen: stepCountIs(3),
      maxRetries: 1,
    });
    const calls = r.steps.flatMap((s) => s.toolCalls.map((tc) => ({ toolName: tc.toolName, input: tc.input as any })));
    const verdict = c.check(calls);
    return { model, case: c.name, pass: verdict === true, why: verdict === true ? undefined : verdict, ms: Date.now() - t0 };
  } catch (err) {
    return { model, case: c.name, pass: false, why: `error: ${(err as Error).message.slice(0, 80)}`, ms: Date.now() - t0 };
  }
}

async function runModel(model: string): Promise<Result[]> {
  const out: Result[] = [];
  for (let run = 0; run < RUNS; run++) for (const c of CASES) out.push(await runCase(model, c));
  return out;
}

const results = (await Promise.all(MODELS.map(runModel))).flat();

const pct = (n: number, d: number) => `${Math.round((100 * n) / d)}%`;
const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

console.log(`\n${CASES.length} cases × ${RUNS} runs\n`);
console.log("model".padEnd(40), "pass".padStart(6), "p50 ms".padStart(8), "p90 ms".padStart(8));
for (const m of MODELS) {
  const rs = results.filter((r) => r.model === m);
  const ms = rs.map((r) => r.ms).sort((a, b) => a - b);
  console.log(
    m.padEnd(40),
    pct(rs.filter((r) => r.pass).length, rs.length).padStart(6),
    String(median(ms)).padStart(8),
    String(ms[Math.floor(ms.length * 0.9)] ?? 0).padStart(8),
  );
}

console.log("\nFailures:");
for (const r of results.filter((r) => !r.pass)) console.log(`  ${r.model.split("/").pop()} · ${r.case}: ${r.why}`);
