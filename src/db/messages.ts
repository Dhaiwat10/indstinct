import { db } from "./index.js";

/** One tool call from a turn, kept so later turns can see what was looked up and found. */
export type ToolTrace = { id: string; name: string; input: unknown; output: string };

export type StoredMessage = {
  id: number;
  role: "user" | "assistant";
  content: string;
  tools: ToolTrace[];
  created_at: string;
};

/** The model sees this many recent messages; older ones are deleted, since nothing reads them. */
export const HISTORY_LIMIT = 30;

const insert = db.prepare(
  "INSERT INTO messages (user_id, role, content, wa_message_id, tool_calls) VALUES (?, ?, ?, ?, ?)",
);
const recent = db.prepare<[string, number], Omit<StoredMessage, "tools"> & { tool_calls: string | null }>(`
  SELECT * FROM (
    SELECT id, role, content, tool_calls, created_at FROM messages
    WHERE user_id = ? AND role IN ('user','assistant') AND content IS NOT NULL
    ORDER BY id DESC LIMIT ?
  ) ORDER BY id ASC
`);
/** Everything of the user's older than their `keep` newest messages, with the model calls behind them. */
const pruneInferences = db.prepare(`
  DELETE FROM inference_log WHERE user_id = @user AND message_id IN (
    SELECT id FROM messages WHERE user_id = @user AND id < COALESCE(
      (SELECT id FROM messages WHERE user_id = @user ORDER BY id DESC LIMIT 1 OFFSET @keep - 1), 0))
`);
const pruneMessages = db.prepare(`
  DELETE FROM messages WHERE user_id = @user AND id < COALESCE(
    (SELECT id FROM messages WHERE user_id = @user ORDER BY id DESC LIMIT 1 OFFSET @keep - 1), 0)
`);

export function saveMessage(
  userId: string,
  role: "user" | "assistant",
  content: string,
  waMessageId?: string,
  tools?: ToolTrace[],
): number {
  const toolJson = tools?.length ? JSON.stringify(tools) : null;
  return Number(insert.run(userId, role, content, waMessageId ?? null, toolJson).lastInsertRowid);
}

export function history(userId: string, limit = HISTORY_LIMIT): StoredMessage[] {
  return recent.all(userId, limit).map(({ tool_calls, ...m }) => ({
    ...m,
    tools: tool_calls ? (JSON.parse(tool_calls) as ToolTrace[]) : [],
  }));
}

/** Deletes all but the user's `keep` (at least 1) newest messages, and the model calls behind the deleted replies. */
export function pruneHistory(userId: string, keep = HISTORY_LIMIT): void {
  if (keep < 1) throw new RangeError("pruneHistory keeps at least one message; use clearHistory");
  db.transaction(() => {
    pruneInferences.run({ user: userId, keep });
    pruneMessages.run({ user: userId, keep });
  })();
}

const clearInferences = db.prepare("DELETE FROM inference_log WHERE user_id = ? AND message_id IS NOT NULL");
const clearMessages = db.prepare("DELETE FROM messages WHERE user_id = ?");

/** `/reset`: deletes the whole conversation and the model calls behind it. Memories, to-dos and reminders stay. */
export function clearHistory(userId: string): void {
  db.transaction(() => {
    clearInferences.run(userId);
    clearMessages.run(userId);
  })();
}

// `/reset` used to hide history behind a marker row instead of deleting it. Finish those resets.
db.exec(`
  DELETE FROM inference_log WHERE message_id IN (
    SELECT m.id FROM messages m WHERE m.id <= (
      SELECT MAX(r.id) FROM messages r WHERE r.user_id = m.user_id AND r.role = 'system' AND r.content = '[history reset]'));
  DELETE FROM messages WHERE id IN (
    SELECT m.id FROM messages m WHERE m.id <= (
      SELECT MAX(r.id) FROM messages r WHERE r.user_id = m.user_id AND r.role = 'system' AND r.content = '[history reset]'));
`);
