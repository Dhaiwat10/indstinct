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

/** `/reset` writes this as a system row; history only reads past the latest one. */
const RESET_MARKER = "[history reset]";

const insert = db.prepare(
  "INSERT INTO messages (user_id, role, content, wa_message_id, tool_calls) VALUES (?, ?, ?, ?, ?)",
);
const recent = db.prepare<[string, string, string, number], Omit<StoredMessage, "tools"> & { tool_calls: string | null }>(`
  SELECT * FROM (
    SELECT id, role, content, tool_calls, created_at FROM messages
    WHERE user_id = ? AND role IN ('user','assistant') AND content IS NOT NULL
      AND id > COALESCE((SELECT MAX(id) FROM messages WHERE user_id = ? AND role = 'system' AND content = ?), 0)
    ORDER BY id DESC LIMIT ?
  ) ORDER BY id ASC
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

export function history(userId: string, limit = 30): StoredMessage[] {
  return recent.all(userId, userId, RESET_MARKER, limit).map(({ tool_calls, ...m }) => ({
    ...m,
    tools: tool_calls ? (JSON.parse(tool_calls) as ToolTrace[]) : [],
  }));
}

/** Hides earlier messages from the model without deleting them, so message ids never get reused. */
export function clearHistory(userId: string): void {
  insert.run(userId, "system", RESET_MARKER, null, null);
}
