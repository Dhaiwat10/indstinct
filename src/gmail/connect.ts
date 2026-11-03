// What happens around linking and unlinking a Gmail account, shared by the HTTP callback and /gmail.
import { db } from "../db/index.js";
import { deleteGmailAccount, deleteUserDrafts, getGmailAccount, type GmailAccount } from "../db/gmail.js";
import { saveMessage } from "../db/messages.js";
import { activeSchedules, cancelSchedule } from "../db/schedules.js";
import { getUser } from "../db/users.js";
import { log } from "../log.js";
import type { Send } from "../scheduler/tick.js";
import { revokeToken } from "./oauth.js";

export const CONNECTED_NOTE = (email: string) =>
  [
    `✅ *Gmail connected:* ${email}`,
    "",
    "Now I can search and summarise your mail, draft replies from your address (you approve every send), unsubscribe you from junk, and pull out attachments.",
    "",
    "Nothing happens unless you ask. If you want it: \"flag important emails as they come in\" or \"inbox brief every morning at 8\".",
    "_/gmail disconnect_ removes my access and wipes everything I kept.",
  ].join("\n");

/** Tells the user on WhatsApp. Deliberately sets up nothing else: briefs are asked for, not imposed. */
export async function onGmailConnected(account: GmailAccount, send: Send): Promise<void> {
  const user = getUser(account.user_id);
  if (!user) return;
  const note = CONNECTED_NOTE(account.email);
  saveMessage(user.id, "assistant", note);
  await send(user.chat_jid ?? user.id, note).catch((err) => log.warn({ err, user: user.id }, "could not send gmail connected note"));
  log.info({ user: user.id }, "gmail connected");
}

const scrubTraces = db.prepare<[string], { id: number; tool_calls: string }>(
  "SELECT id, tool_calls FROM messages WHERE user_id = ? AND tool_calls LIKE '%\"name\":\"email_%'",
);
const setTraces = db.prepare("UPDATE messages SET tool_calls = ? WHERE id = ?");
const deleteFlags = db.prepare("DELETE FROM messages WHERE user_id = ? AND content LIKE '%[gmail:%'");

/** Recurring tasks that read mail, e.g. a morning inbox brief the user asked for. */
const mailRelated = (s: { kind: string; payload: string; description: string }) =>
  s.kind === "cron" && /\b(e-?mails?|inbox|gmail)\b/i.test(`${s.payload} ${s.description}`);

/**
 * Revokes the grant and removes every trace: tokens, drafts, inbox flags, email tool results
 * kept in chat history, and any recurring task that reads mail. Nothing stays searchable.
 */
export async function disconnectGmail(userId: string): Promise<{ account: GmailAccount; cancelled: string[] } | undefined> {
  const account = getGmailAccount(userId);
  if (!account) return undefined;
  await revokeToken(account.refresh_token);
  const cancelled: string[] = [];
  db.transaction(() => {
    for (const s of activeSchedules(userId).filter(mailRelated)) if (cancelSchedule(userId, s.id)) cancelled.push(s.description);
    deleteUserDrafts(userId);
    deleteGmailAccount(userId);
    deleteFlags.run(userId);
    for (const row of scrubTraces.all(userId)) {
      const kept = (JSON.parse(row.tool_calls) as { name: string }[]).filter((t) => !t.name.startsWith("email_"));
      setTraces.run(kept.length ? JSON.stringify(kept) : null, row.id);
    }
  })();
  log.info({ user: userId, cancelled: cancelled.length }, "gmail disconnected");
  return { account, cancelled };
}
