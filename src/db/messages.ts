import { db } from "./index.js";

export type StoredMessage = { id: number; role: "user" | "assistant"; content: string; created_at: string };

/** `/reset` writes this as a system row; history only reads past the latest one. */
const RESET_MARKER = "[history reset]";

const insert = db.prepare(
  "INSERT INTO messages (user_id, role, content, wa_message_id) VALUES (?, ?, ?, ?)",
);
const recent = db.prepare<[string, string, string, number], StoredMessage>(`
  SELECT * FROM (
    SELECT id, role, content, created_at FROM messages
    WHERE user_id = ? AND role IN ('user','assistant') AND content IS NOT NULL
      AND id > COALESCE((SELECT MAX(id) FROM messages WHERE user_id = ? AND role = 'system' AND content = ?), 0)
    ORDER BY id DESC LIMIT ?
  ) ORDER BY id ASC
`);

export function saveMessage(userId: string, role: "user" | "assistant", content: string, waMessageId?: string): number {
  return Number(insert.run(userId, role, content, waMessageId ?? null).lastInsertRowid);
}

export function history(userId: string, limit = 30): StoredMessage[] {
  return recent.all(userId, userId, RESET_MARKER, limit);
}

/** Hides earlier messages from the model without deleting them, so message ids never get reused. */
export function clearHistory(userId: string): void {
  insert.run(userId, "system", RESET_MARKER, null);
}
