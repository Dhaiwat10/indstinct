// Where does a live-information turn spend its time? Runs real turns through the agent on a
// throwaway database and prints every outbound request (NEAR AI, Tavily) with its duration,
// token counts and tool calls, so a slow turn can be read step by step.
// Run: pnpm bench:search ["prompt" ...]
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "indstinct-bench-"));
process.env.LOG_LEVEL ??= "warn";

type Rec = { t: number; ms: number; url: string; status: number; note: string };
const trace: Rec[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const t0 = Date.now();
  const res = await realFetch(input, init);
  const ms = Date.now() - t0;
  let note = "";
  if (url.endsWith("/chat/completions")) {
    try {
      const j = JSON.parse(await res.clone().text());
      const u = j.usage ?? {};
      const m = j.choices?.[0]?.message ?? {};
      note = `in=${u.prompt_tokens} out=${u.completion_tokens} tool=${m.tool_calls?.map((c: any) => c.function.name).join(",") ?? "-"} finish=${j.choices?.[0]?.finish_reason}`;
    } catch {
      note = "(non-json response)";
    }
  }
  trace.push({ t: t0, ms, url: url.replace(/^https?:\/\//, "").slice(0, 40), status: res.status, note });
  return res;
}) as typeof fetch;

const { config } = await import("../src/config.js");
const { runAgent } = await import("../src/agent/run.js");
const { markOnboarded, upsertUser, updateProfile } = await import("../src/db/users.js");

const prompts = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["what's the weather like today?", "what's happening in world news today?", "who is the current RBI governor?"];

console.log(`model ${config.MODEL_PRIMARY} via ${config.NEAR_AI_BASE_URL}\n`);

for (const [i, text] of prompts.entries()) {
  let user = upsertUser(`bench-${i}@s.whatsapp.net`, `9100000000${i}`, "Bench");
  user = updateProfile(user.id, { name: "Bench", city: "Bengaluru" });
  markOnboarded(user.id);
  trace.length = 0;
  const t0 = Date.now();
  const r = await runAgent(user, { text, images: [] });
  const total = Date.now() - t0;
  console.log(`=== "${text}" → ${total} ms, tools: ${r.tools.map((t) => t.name).join(",") || "none"}`);
  for (const rec of trace) console.log(`  +${String(rec.t - t0).padStart(6)}ms  ${String(rec.ms).padStart(6)}ms  ${rec.status}  ${rec.url.padEnd(40)} ${rec.note}`);
  console.log(`  reply: ${r.reply.replace(/\n/g, " ").slice(0, 200)}\n`);
}
process.exit(0);
