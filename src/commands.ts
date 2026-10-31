import { config } from "./config.js";
import { db } from "./db/index.js";
import { getGmailAccount, setGmailAlerts } from "./db/gmail.js";
import { disconnectGmail } from "./gmail/connect.js";
import { newConnectLink } from "./gmail/oauth.js";
import { forget, listMemories } from "./db/memories.js";
import { activeSchedules, cancelSchedule } from "./db/schedules.js";
import { completeTodo, openTodos } from "./db/todos.js";
import { formatWhen } from "./scheduler/time.js";
import { clearHistory } from "./db/messages.js";
import type { User } from "./db/users.js";
import { verifyInference, type InferenceRow } from "./nearai/verify.js";

const short = (h: string) => {
  const prefix = h.startsWith("0x") ? "0x" : "";
  const body = h.slice(prefix.length);
  return `${prefix}${body.slice(0, 4)}…${body.slice(-4)}`;
};
const tick = (ok: boolean) => (ok ? "✅" : "❌");

/** The final model call behind the user's latest bot reply (or the nth-latest with `/verify n`). */
const lastInference = db.prepare<[string, number], InferenceRow>(`
  SELECT l.* FROM inference_log l
  WHERE l.purpose = 'agent' AND l.message_id = (
    SELECT id FROM messages WHERE user_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1 OFFSET ?
  )
  ORDER BY l.id DESC LIMIT 1
`);

async function verify(user: User, arg: string): Promise<string | string[]> {
  const n = Math.max(1, Number.parseInt(arg, 10) || 1);
  const row = lastInference.get(user.id, n - 1);
  if (!row) return "Nothing to verify yet. Send me a message first, then /verify.";

  const v = await verifyInference(row);
  if (v.error && !v.signer) return `🔐 Couldn't fetch the signature yet (${v.error}). Try again in a minute.`;

  const allGood = v.hashesMatch && v.signatureValid && v.signerAttested && v.quoteBindsSigner;
  const summary = [
    allGood ? "🔐 *Verified private inference*" : "⚠️ *Verification incomplete*",
    `Model: ${v.model} (NEAR AI Confidential TEE)`,
    `Request hash: ${short(v.requestHash)}`,
    `Response hash: ${short(v.responseHash)}`,
    `Signed by: ${v.signer ? short(v.signer) : "?"}`,
    "",
    `${tick(v.hashesMatch)} Signature covers exactly these bytes`,
    `${tick(v.signatureValid)} Signature is valid for that key`,
    `${tick(v.signerAttested)} Key belongs to the attested TEE for this model`,
    `${tick(v.quoteBindsSigner)} Hardware quote commits to that key (fresh nonce)`,
    v.error ? `\n_${v.error}_` : "",
    allGood ? "\nThis reply was generated inside a TEE. Nobody, not NEAR and not us, could read it in plaintext." : "",
    v.receiptUrl ? "\nFull values and independent hardware verification on NEAR AI's Verification Center 👇" : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
  return v.receiptUrl ? [summary, v.receiptUrl] : summary;
}

function memories(user: User): string {
  const list = listMemories(user.id);
  if (list.length === 0) return "I don't know anything about you yet. Tell me something!";
  return `🧠 *What I know about you*\n${list.map((m) => `• ${m.content} _(#${m.id})_`).join("\n")}`;
}

function reminders(user: User): string {
  const list = activeSchedules(user.id);
  if (!list.length) return "No reminders or recurring tasks. Try \"remind me tomorrow at 7 to call mom\".";
  return `⏰ *Reminders*\n${list
    .map((s) => `• ${s.description}: ${s.kind === "cron" ? "next " : ""}${formatWhen(new Date(s.next_run_at), user.timezone)} _(#${s.id})_`)
    .join("\n")}\n\n/cancel <id> to stop one.`;
}

function todos(user: User): string {
  const list = openTodos(user.id);
  if (!list.length) return "Your to-do list is empty 🎉";
  return `📝 *To-dos*\n${list
    .map((t) => `• ${t.title}${t.due_at ? ` (due ${formatWhen(new Date(t.due_at), user.timezone)})` : ""} _(#${t.id})_`)
    .join("\n")}\n\n/done <id> to tick one off.`;
}

async function gmail(user: User, arg: string): Promise<string> {
  if (!config.GMAIL_ENABLED) return "Gmail isn't set up on this bot yet (no Google credentials configured).";
  const account = getGmailAccount(user.id);
  const sub = arg.trim().toLowerCase();
  if (sub === "disconnect" || sub === "off") {
    const gone = await disconnectGmail(user.id);
    if (!gone) return "No Gmail account is connected.";
    const extra = gone.cancelled.length ? ` Also cancelled: ${gone.cancelled.join(", ")}.` : "";
    return `Disconnected ${gone.account.email} and wiped everything I kept from it: tokens, drafts and inbox flags. Google access is revoked too.${extra} /gmail to reconnect any time.`;
  }
  if (sub.startsWith("alerts")) {
    if (!account) return "Connect Gmail first: send /gmail";
    const on = /\bon\b/.test(sub) ? true : /\boff\b|pause|stop/.test(sub) ? false : undefined;
    if (on === undefined) return `Inbox alerts are ${account.alerts ? "on" : "off"}. /gmail alerts on|off to change.`;
    setGmailAlerts(user.id, on);
    return on ? "Inbox alerts on: I'll flag important new mail during the day. 📧" : "Inbox alerts paused. /gmail alerts on to resume.";
  }
  if (account && !account.needs_reauth && sub !== "connect" && sub !== "reconnect") {
    return [
      `📧 *Gmail:* ${account.email} connected`,
      `Inbox alerts: ${account.alerts ? "on" : "off"}`,
      "",
      "Just ask: \"anything important in my inbox?\", \"reply to Riya saying yes\", \"unsubscribe me from Myntra\".",
      "/gmail alerts on|off · /gmail disconnect · /gmail reconnect",
    ].join("\n");
  }
  const link = newConnectLink(user.id);
  return [
    account?.needs_reauth ? "Your Gmail link expired; connect it again 👇" : "Connect your Gmail and I'll handle email for you: summaries, replies from your own address (you approve every send), and a heads-up when something important lands.",
    "",
    link,
    "",
    "_Link works for 15 minutes. Mail is read live from Google, never stored, and every word runs in a NEAR AI TEE. /gmail disconnect removes everything._",
  ].join("\n");
}

const help = `*Commands*
/verify: prove my last reply ran in a TEE
/gmail: connect Gmail (alerts on|off · disconnect)
/reminders: upcoming reminders and recurring tasks
/cancel <id>: stop a reminder or recurring task
/todos: your to-do list
/done <id>: tick off a to-do
/memories: what I remember about you
/forget <id>: forget a memory (ids from /memories)
/reset: clear our chat history (memories stay)
/help: this list`;

/** Handles a slash command without the LLM. Returns undefined if `text` isn't one. */
export async function handleCommand(user: User, text: string): Promise<string | string[] | undefined> {
  const match = text.trim().match(/^\/(\w+)\s*(.*)$/s);
  if (!match) return undefined;
  const [, cmd, arg] = match;
  switch (cmd!.toLowerCase()) {
    case "verify":
      return verify(user, arg!);
    case "gmail":
    case "email":
      return gmail(user, arg!);
    case "memories":
      return memories(user);
    case "forget": {
      const ids = (arg!.match(/\d+/g) ?? []).map(Number);
      if (ids.length === 0) return "Which one? Send /forget followed by the number from /memories, like /forget 12";
      const n = forget(user.id, ids);
      return n ? `🗑️ Forgotten (${n}).` : "I couldn't find that memory. /memories shows the numbers.";
    }
    case "reminders":
      return reminders(user);
    case "todos":
      return todos(user);
    case "cancel": {
      const id = Number.parseInt(arg!.replace(/\D/g, ""), 10);
      if (!id) return "Which one? Send /cancel followed by the number from /reminders";
      return cancelSchedule(user.id, id) ? `Cancelled #${id} ✅` : "I couldn't find that one. /reminders shows the numbers.";
    }
    case "done": {
      const id = Number.parseInt(arg!.replace(/\D/g, ""), 10);
      if (!id) return "Which one? Send /done followed by the number from /todos";
      const t = completeTodo(user.id, id);
      return t && t !== "ambiguous" ? `✅ Done: ${t.title}` : "I couldn't find that to-do. /todos shows the numbers.";
    }
    case "reset":
      clearHistory(user.id);
      return "Chat history cleared. I still remember what you've told me. Send /memories to see it.";
    case "help":
      return help;
    default:
      return undefined;
  }
}
