import { db } from "./index.js";

export const CATEGORIES = ["person", "preference", "fact", "event", "other"] as const;
export type Category = (typeof CATEGORIES)[number];
export type Memory = { id: number; content: string; category: Category; source: string; updated_at: string };

const active = db.prepare<[string], Memory>(`
  SELECT id, content, category, source, updated_at FROM memories
  WHERE user_id = ? AND archived_at IS NULL ORDER BY updated_at DESC
`);
const insert = db.prepare("INSERT INTO memories (user_id, content, category, source) VALUES (?, ?, ?, ?)");
const update = db.prepare(
  "UPDATE memories SET content = ?, category = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
);

export function listMemories(userId: string): Memory[] {
  return active.all(userId);
}

/**
 * Saves a fact, replacing an existing memory when one contains the other (case-insensitive),
 * so "Sister: Priya" followed by "Sister: Priya, lives in Pune" doesn't leave both.
 */
export function remember(
  userId: string,
  content: string,
  category: Category,
  source: "explicit" | "inferred" = "explicit",
): { id: number; updated: boolean } {
  const needle = content.toLowerCase().trim();
  const match = listMemories(userId).find((m) => {
    const hay = m.content.toLowerCase();
    return hay.includes(needle) || needle.includes(hay);
  });
  if (match) {
    update.run(content, category, match.id);
    return { id: match.id, updated: true };
  }
  return { id: Number(insert.run(userId, content, category, source).lastInsertRowid), updated: false };
}
