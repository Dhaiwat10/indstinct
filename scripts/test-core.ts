// Offline checks for the plain code under reminders, recurring tasks, to-dos and memory: given
// what the model asked for, does the bot store it right and fire it on time? The model itself
// is stubbed; the live chat eval (pnpm eval:chat) covers its choices. Run: pnpm test:core
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "indstinct-core-"));
process.env.NEAR_AI_API_KEY ??= "test";
process.env.LOG_LEVEL ??= "silent";
delete process.env.GOOGLE_CLIENT_ID;

// A recurring task runs the agent; answer every model call with a fixed reply.
const modelCalls: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.endsWith("/chat/completions")) {
    const b = init?.body;
    modelCalls.push(typeof b === "string" ? b : Buffer.from(b as Uint8Array).toString("utf8"));
    const body = { id: `c${modelCalls.length}`, object: "chat.completion", created: 0, model: "stub", choices: [{ index: 0, message: { role: "assistant", content: "Here are today's headlines." }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }
  return realFetch(input, init);
}) as typeof fetch;

const { db } = await import("../src/db/index.js");
const { upsertUser, markOnboarded } = await import("../src/db/users.js");
const { activeSchedules, addSchedule } = await import("../src/db/schedules.js");
const { openTodos, addTodo: addTodoRow } = await import("../src/db/todos.js");
const { listMemories, remember: rememberRow } = await import("../src/db/memories.js");
const { history } = await import("../src/db/messages.js");
const { parseAt, nextCron, formatWhen } = await import("../src/scheduler/time.js");
const { noDashes } = await import("../src/text.js");
const { runDue } = await import("../src/scheduler/tick.js");
const { setReminder, scheduleRecurring, cancelSchedule } = await import("../src/agent/tools/schedule.js");
const { addTodo, completeTodo } = await import("../src/agent/tools/todos.js");
const { handleCommand } = await import("../src/commands.js");

let passed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.log(`  ✗ ${name}\n    ${(err as Error).message.split("\n").join("\n    ")}`);
    process.exitCode = 1;
  }
};
const exec = (t: unknown, input: unknown) => (t as { execute: (i: unknown, o: unknown) => Promise<string> }).execute(input, { toolCallId: "t", messages: [] });

/** An ISO time `days` from today at hh:mm IST, with the offset spelled out like the model sends it. */
function istIso(days: number, hh: number, mm = 0): string {
  const d = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(Date.now() + days * 86_400_000));
  return `${d}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+05:30`;
}
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

let n = 0;
const freshUser = () => {
  const phone = `9190000000${String(++n).padStart(2, "0")}`;
  const u = upsertUser(`${phone}@s.whatsapp.net`, phone, "Test");
  markOnboarded(u.id);
  return u;
};
const sent: { jid: string; text: string }[] = [];
const send = async (jid: string, text: string) => void sent.push({ jid, text });
const sendFails = async () => {
  throw new Error("WhatsApp not connected");
};

console.log("no em dashes");
await test("em dashes become commas, bullets stay bullets, ranges keep their en dash", () => {
  const cases: [string, string][] = [
    ["Bengaluru — 27°C, clear", "Bengaluru, 27°C, clear"],
    ["*US midterms*—early voting surging", "*US midterms*, early voting surging"],
    ["Highs of 30–31°C", "Highs of 30–31°C"],
    ["Done – I'll ping you at 7", "Done, I'll ping you at 7"],
    ["— first\n— second", "• first\n• second"],
    ["That's it —", "That's it"],
    ["Sure — .", "Sure."],
  ];
  for (const [input, want] of cases) assert.equal(noDashes(input), want, input);
});

console.log("time parsing");
await test("parseAt needs a UTC offset", () => {
  assert.match(String(parseAt("2030-01-01T07:00:00")), /no UTC offset/);
});
await test("parseAt rejects garbage and the past", () => {
  assert.match(String(parseAt("tomorrow+05:30")), /not a valid/);
  assert.match(String(parseAt("2020-01-01T07:00:00+05:30")), /in the past/);
});
await test("parseAt turns 7:00 IST into 01:30 UTC", () => {
  const at = parseAt(istIso(1, 7)) as Date;
  assert.equal(at.toISOString().slice(11, 16), "01:30");
});
await test("nextCron runs in the user's timezone", () => {
  const next = nextCron("0 8 * * *", "Asia/Kolkata") as Date;
  assert.equal(next.toISOString().slice(11, 16), "02:30");
  assert.ok(next.getTime() > Date.now() && next.getTime() <= Date.now() + 86_400_000);
});
await test("nextCron refuses bad and too-frequent schedules", () => {
  assert.match(String(nextCron("0 8 * *", "Asia/Kolkata")), /5 fields/);
  assert.match(String(nextCron("*/5 * * * *", "Asia/Kolkata")), /at most once an hour/);
  assert.match(String(nextCron("61 8 * * *", "Asia/Kolkata")), /invalid cron/);
});
await test("formatWhen shows IST wall-clock time", () => {
  assert.match(formatWhen(new Date("2030-01-01T01:30:00Z"), "Asia/Kolkata"), /7:00\s?am/i);
});

console.log("reminders");
await test("set_reminder stores the time in UTC and confirms it in IST", async () => {
  const u = freshUser();
  const out = await exec(setReminder(u), { at_iso: istIso(1, 7), text: "Call mom" });
  assert.match(out, /^reminder #\d+ set for .*7:00\s?am/i);
  const s = activeSchedules(u.id)[0]!;
  assert.equal(s.next_run_at, (parseAt(istIso(1, 7)) as Date).toISOString());
  assert.equal(s.payload, "Call mom");
});
await test("set_reminder passes a bad time back to the model instead of saving it", async () => {
  const u = freshUser();
  assert.match(await exec(setReminder(u), { at_iso: "2020-01-01T07:00:00+05:30", text: "x" }), /^error: .*past/);
  assert.equal(activeSchedules(u.id).length, 0);
});
await test("a due reminder is sent once, then never again", async () => {
  const u = freshUser();
  addSchedule({ user_id: u.id, kind: "reminder", cron_expr: null, payload_kind: "text", payload: "Call mom", description: "Call mom", next_run_at: ago(1000) });
  sent.length = 0;
  await runDue(send);
  await runDue(send);
  const mine = sent.filter((m) => m.jid === u.chat_jid);
  assert.equal(mine.length, 1);
  assert.equal(mine[0]!.text, "⏰ *Reminder:* Call mom");
  assert.equal(activeSchedules(u.id).length, 0);
  assert.equal(history(u.id).at(-1)!.content, "⏰ *Reminder:* Call mom");
});
await test("a reminder that isn't due yet stays put", async () => {
  const u = freshUser();
  await exec(setReminder(u), { at_iso: istIso(1, 7), text: "Later" });
  sent.length = 0;
  await runDue(send);
  assert.equal(sent.filter((m) => m.jid === u.chat_jid).length, 0);
  assert.equal(activeSchedules(u.id).length, 1);
});
await test("if WhatsApp is down, the reminder stays due and goes out next time", async () => {
  const u = freshUser();
  addSchedule({ user_id: u.id, kind: "reminder", cron_expr: null, payload_kind: "text", payload: "Pay rent", description: "Pay rent", next_run_at: ago(1000) });
  await runDue(sendFails);
  assert.equal(activeSchedules(u.id).length, 1);
  sent.length = 0;
  await runDueAMinuteLater();
  assert.equal(sent.filter((m) => m.jid === u.chat_jid).length, 1);
  assert.equal(activeSchedules(u.id).length, 0);
});
await test("two due reminders for one user go out a minute apart, not together", async () => {
  const u = freshUser();
  for (const t of ["One", "Two"]) addSchedule({ user_id: u.id, kind: "reminder", cron_expr: null, payload_kind: "text", payload: t, description: t, next_run_at: ago(1000) });
  sent.length = 0;
  await runDue(send);
  assert.equal(sent.filter((m) => m.jid === u.chat_jid).length, 1);
  assert.equal(activeSchedules(u.id).length, 1);
});
await test("/cancel stops a reminder; cancel_schedule does too", async () => {
  const u = freshUser();
  await exec(setReminder(u), { at_iso: istIso(1, 7), text: "A" });
  await exec(setReminder(u), { at_iso: istIso(1, 8), text: "B" });
  const [a, b] = activeSchedules(u.id);
  assert.match((await handleCommand(u, `/cancel ${a!.id}`)) as string, /Cancelled/);
  assert.match(await exec(cancelSchedule(u), { id: b!.id }), /cancelled/);
  assert.equal(activeSchedules(u.id).length, 0);
  assert.match((await handleCommand(u, "/cancel 999999")) as string, /couldn't find/);
});
await test("/cancel can't touch someone else's reminder", async () => {
  const owner = freshUser();
  const other = freshUser();
  await exec(setReminder(owner), { at_iso: istIso(1, 7), text: "Mine" });
  const id = activeSchedules(owner.id)[0]!.id;
  assert.match((await handleCommand(other, `/cancel ${id}`)) as string, /couldn't find/);
  assert.equal(activeSchedules(owner.id).length, 1);
});

console.log("recurring tasks");
await test("schedule_recurring saves the next 8 am IST", async () => {
  const u = freshUser();
  assert.match(await exec(scheduleRecurring(u), { cron_expr: "0 8 * * *", prompt: "headlines", description: "Daily headlines" }), /first run .*8:00\s?am/i);
  assert.equal(activeSchedules(u.id)[0]!.next_run_at.slice(11, 16), "02:30");
});
await test("a due recurring task runs the agent, sends its reply, and moves to the next day", async () => {
  const u = freshUser();
  db.prepare("DELETE FROM schedules").run();
  addSchedule({ user_id: u.id, kind: "cron", cron_expr: "0 8 * * *", payload_kind: "agent", payload: "Send me top 3 headlines", description: "Daily headlines", next_run_at: ago(1000) });
  sent.length = 0;
  modelCalls.length = 0;
  await runDue(send);
  assert.equal(modelCalls.length, 1);
  assert.match(JSON.parse(modelCalls[0]!).messages[0].content, /scheduled task #\d+ that the user set up: "Daily headlines"/);
  assert.deepEqual(sent.filter((m) => m.jid === u.chat_jid).map((m) => m.text), ["Here are today's headlines."]);
  const s = activeSchedules(u.id)[0]!;
  assert.ok(new Date(s.next_run_at).getTime() > Date.now());
  assert.equal(s.next_run_at.slice(11, 16), "02:30");
});
await test("a scheduled run can't schedule more runs", async () => {
  const body = JSON.parse(modelCalls[0]!);
  const names = (body.tools ?? []).map((t: { function: { name: string } }) => t.function.name);
  assert.ok(names.includes("web_search"));
  assert.ok(!names.includes("schedule_recurring") && !names.includes("set_reminder"));
});

console.log("to-dos");
await test("add_todo, then /done by id", async () => {
  const u = freshUser();
  assert.match(await exec(addTodo(u), { title: "Book train tickets" }), /^to-do #\d+ added/);
  const id = openTodos(u.id)[0]!.id;
  assert.match((await handleCommand(u, `/done ${id}`)) as string, /Done: Book train tickets/);
  assert.equal(openTodos(u.id).length, 0);
});
await test("complete_todo by words picks the one match, and refuses when several match", async () => {
  const u = freshUser();
  addTodoRow(u.id, "Pay electricity bill");
  addTodoRow(u.id, "Pay credit card bill");
  addTodoRow(u.id, "Buy milk");
  assert.match(await exec(completeTodo(u), { todo: "bill" }), /several to-dos match/);
  assert.equal(openTodos(u.id).length, 3);
  assert.match(await exec(completeTodo(u), { todo: "milk" }), /done: #\d+ Buy milk/);
  assert.deepEqual(openTodos(u.id).map((t) => t.title).sort(), ["Pay credit card bill", "Pay electricity bill"]);
});
await test("/done can't tick off someone else's to-do", async () => {
  const owner = freshUser();
  const other = freshUser();
  const id = addTodoRow(owner.id, "Mine");
  assert.match((await handleCommand(other, `/done ${id}`)) as string, /couldn't find/);
  assert.equal(openTodos(owner.id).length, 1);
});

console.log("memory");
await test("remember updates a fact instead of duplicating it", () => {
  const u = freshUser();
  rememberRow(u.id, "Sister: Priya", "person");
  rememberRow(u.id, "Sister: Priya, lives in Pune", "person");
  assert.deepEqual(listMemories(u.id).map((m) => m.content), ["Sister: Priya, lives in Pune"]);
});
await test("/forget removes only that memory, and only for its owner", async () => {
  const u = freshUser();
  const other = freshUser();
  const a = rememberRow(u.id, "Likes filter coffee", "preference").id;
  rememberRow(u.id, "Lives in Bengaluru", "fact");
  assert.match((await handleCommand(other, `/forget ${a}`)) as string, /couldn't find/);
  assert.match((await handleCommand(u, `/forget ${a}`)) as string, /Forgotten \(1\)/);
  assert.deepEqual(listMemories(u.id).map((m) => m.content), ["Lives in Bengaluru"]);
});

console.log("commands");
await test("/reset hides history but keeps memories", async () => {
  const u = freshUser();
  const { saveMessage } = await import("../src/db/messages.js");
  saveMessage(u.id, "user", "hello");
  rememberRow(u.id, "Name is Asha", "fact");
  await handleCommand(u, "/reset");
  assert.equal(history(u.id).length, 0);
  assert.equal(listMemories(u.id).length, 1);
});
await test("normal text isn't a command; unknown commands fall through to the agent", async () => {
  const u = freshUser();
  assert.equal(await handleCommand(u, "remind me at 7"), undefined);
  assert.equal(await handleCommand(u, "/notacommand"), undefined);
  assert.match((await handleCommand(u, "/help")) as string, /\/reminders/);
});

/** Runs a pass as if a minute had passed, so the one-unsolicited-message-a-minute gate allows a retry. */
async function runDueAMinuteLater(): Promise<void> {
  const realNow = Date.now;
  Date.now = () => realNow() + 61_000;
  try {
    await runDue(send);
  } finally {
    Date.now = realNow;
  }
}

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
process.exit();
