// Routing eval: does the agent pick the right way to handle a request? Answer directly, do a
// quick lookup (web_search / read_page) inside the reply, or start a background browser task.
// Requests span many kinds of things on purpose; routing must not depend on topic. Browser
// tasks are stubbed, so this measures the decision, not the browsing.
// Run: pnpm eval:routing [name-filter]
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "indstinct-routing-"));
process.env.LOG_LEVEL ??= "error";

const { runAgent } = await import("../src/agent/run.js");
const { getUser, markOnboarded, upsertUser, updateProfile } = await import("../src/db/users.js");
const { startTaskRunner } = await import("../src/tasks/runner.js");

// No browser: a started task finishes at once.
startTaskRunner({ send: async () => {}, sendFile: async () => {} }, () => true, async () => "done");

type Route = "answer" | "lookup" | "task";
/** A request and the routes that count as right for it. */
type Case = [prompt: string, ok: Route[]];

const CASES: Case[] = [
  // Stable knowledge: answer directly.
  ["what's the difference between a PNR and a booking reference?", ["answer"]],
  ["explain compound interest with a simple example", ["answer"]],
  ["how do I make masala chai?", ["answer"]],
  ["translate 'see you tomorrow at the station' into Hindi", ["answer"]],
  ["what's 18% GST on ₹2,450?", ["answer"]],
  ["give me three tips to sleep better", ["answer"]],
  ["what does UPI stand for?", ["answer"]],
  ["write a short birthday wish for my sister Riya", ["answer"]],
  ["what's the capital of Australia?", ["answer"]],
  ["how many days are there between 3 Dec and 20 Jan?", ["answer"]],
  // Things that need money or a password: say so, don't start anything.
  ["pay my electricity bill on the BESCOM site, here's my card 4111 1111 1111 1111", ["answer"]],
  ["log into my HDFC net banking and download last month's statement", ["answer"]],
  // A fact on the open web: quick lookup.
  ["what's the weather in Pune today?", ["lookup"]],
  ["top news in India today", ["lookup"]],
  ["who is the current Chief Election Commissioner of India?", ["lookup"]],
  ["what's the petrol price in Delhi today?", ["lookup"]],
  ["what's the Sensex at right now?", ["lookup"]],
  ["what time does the Taj Mahal open?", ["lookup"]],
  ["did the RBI change the repo rate at its last meeting?", ["lookup"]],
  ["what's the dollar to rupee rate today?", ["lookup"]],
  ["is tomorrow a bank holiday in Maharashtra?", ["lookup"]],
  ["what's the latest score in the India vs New Zealand T20?", ["lookup"]],
  ["when is the next Lok Sabha session starting?", ["lookup"]],
  ["what's the launch price of the iPhone 18 in India?", ["lookup", "task"]],
  // Working a website: typed inputs, many live options, steps, or actions.
  ["find me the cheapest flight from Bengaluru to Delhi next week", ["task"]],
  ["cheapest 3AC train tickets from Mumbai to Ahmedabad this Saturday", ["task"]],
  ["find a hotel in Goa under ₹5,000 a night for 20 to 22 Nov, near Baga", ["task"]],
  ["compare the price of Sony WH-1000XM5 on Amazon, Flipkart and Croma", ["task"]],
  ["what driving test slots are free at the Andheri RTO next week?", ["task"]],
  ["is there an overnight bus from Pune to Goa this Friday, and what does it cost?", ["task"]],
  ["track my Delhivery parcel, AWB 1234567890", ["task", "lookup"]],
  ["check PNR status 4512345678", ["task", "lookup"]],
  ["what's the running status of train 12951 right now?", ["task", "lookup"]],
  ["check me in for my IndiGo flight tomorrow, PNR XQ7ZK2, surname Pandya, just me, any seat", ["task"]],
  // Passport Seva needs the user's login and a fee payment, which tasks don't do yet: saying so is right.
  ["fill in the passport renewal appointment form on passportindia.gov.in for me: Dhaiwat Pandya, Surat PSK, any date next week", ["answer", "task"]],
  ["cancel my table booking on Dineout for tonight, booking ID DO-55821, name Pandya", ["task"]],
  ["find 1BHK flats for rent in Whitefield under ₹25,000 on NoBroker", ["task"]],
  ["get me the 5 best-rated dentists near Andheri West that are open on Sunday", ["task", "lookup"]],
  ["what are the cheapest dates to fly Surat to Kolkata in December?", ["task"]],
  // Most clinics there book by phone; finding that out with a search and saying so is fine too.
  ["book me the first available vaccination slot for my son at a clinic near Vesu, Surat", ["task", "lookup"]],
];

const filter = process.argv[2]?.toLowerCase();
const cases = CASES.filter(([p]) => !filter || p.toLowerCase().includes(filter));
type Result = { prompt: string; ok: Route[]; got: Route; tools: string[]; ms: number; reply: string; error?: string };

function routeOf(tools: string[]): Route {
  if (tools.includes("start_task")) return "task";
  if (tools.some((t) => t === "web_search" || t === "read_page")) return "lookup";
  return "answer";
}

let n = 0;
async function run([prompt, ok]: Case): Promise<Result> {
  const id = ++n;
  const created = upsertUser(`routing-${id}@s.whatsapp.net`, `9188800${String(id).padStart(5, "0")}`, "Eval");
  updateProfile(created.id, { name: "Dhaiwat", city: "Surat" });
  markOnboarded(created.id);
  const user = getUser(created.id)!;
  const t0 = Date.now();
  try {
    const r = await runAgent(user, { text: prompt, images: [] });
    const tools = r.tools.map((t) => t.name);
    return { prompt, ok, got: routeOf(tools), tools, ms: Date.now() - t0, reply: r.reply };
  } catch (err) {
    return { prompt, ok, got: "answer", tools: [], ms: Date.now() - t0, reply: "", error: (err as Error).message.slice(0, 120) };
  }
}

// A few at a time, so NEAR AI doesn't rate-limit us.
const results: Result[] = [];
for (let i = 0; i < cases.length; i += 4) results.push(...(await Promise.all(cases.slice(i, i + 4).map(run))));

const right = results.filter((r) => r.ok.includes(r.got) && !r.error);
const byRoute = (route: Route) => {
  const rs = results.filter((r) => r.ok[0] === route);
  return `${route.padEnd(7)} ${rs.filter((r) => r.ok.includes(r.got) && !r.error).length}/${rs.length}`;
};
const ms = results.map((r) => r.ms).sort((a, b) => a - b);
const pct = (q: number) => ms[Math.min(ms.length - 1, Math.floor(ms.length * q))] ?? 0;

console.log(`\nRouting eval: ${cases.length} requests\n`);
for (const r of results) {
  const mark = r.ok.includes(r.got) && !r.error ? "✓" : "✗";
  console.log(`${mark} ${r.got.padEnd(6)} ${String(r.ms).padStart(6)}ms  ${r.prompt}${mark === "✗" ? `\n    expected ${r.ok.join(" or ")}; tools: ${r.tools.join(", ") || "none"}${r.error ? `; error: ${r.error}` : ""}\n    reply: ${r.reply.replace(/\n/g, " ").slice(0, 200)}` : ""}`);
}
const accuracy = right.length / results.length;
console.log(`\nrouted right  ${right.length}/${results.length} (${Math.round(accuracy * 100)}%)`);
console.log(["answer", "lookup", "task"].map((r) => byRoute(r as Route)).join("   "));
console.log(`time to reply p50 ${pct(0.5)}ms  p90 ${pct(0.9)}ms`);

// Model choices vary run to run; fail only when routing is clearly off.
process.exit(accuracy >= 0.85 ? 0 : 1);
