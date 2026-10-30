import { db } from "./index.js";

export type User = {
  id: string;
  chat_jid: string | null;
  phone: string | null;
  name: string | null;
  city: string | null;
  language: string;
  timezone: string;
  onboarded_at: string | null;
  created_at: string;
};

const get = db.prepare<[string], User>("SELECT * FROM users WHERE id = ?");
const insert = db.prepare("INSERT INTO users (id, chat_jid, phone, name) VALUES (?, ?, ?, ?)");
const touchChat = db.prepare("UPDATE users SET chat_jid = ? WHERE id = ?");

export function getUser(id: string): User | undefined {
  return get.get(id);
}

/** Users are keyed by phone jid when WhatsApp gives us the number, so @lid churn doesn't split them. */
export function upsertUser(chatJid: string, phone: string | undefined, pushName: string | undefined): User {
  const id = phone ? `${phone}@s.whatsapp.net` : chatJid;
  const existing = get.get(id);
  if (!existing) insert.run(id, chatJid, phone ?? null, pushName ?? null);
  else if (existing.chat_jid !== chatJid) touchChat.run(chatJid, id);
  return get.get(id)!;
}

export type Profile = Partial<Pick<User, "name" | "city" | "language" | "timezone">>;

export function updateProfile(id: string, profile: Profile): User {
  const fields = (["name", "city", "language", "timezone"] as const).flatMap((k) => (profile[k] ? [[k, profile[k]]] : []));
  if (fields.length)
    db.prepare(`UPDATE users SET ${fields.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`).run(
      ...fields.map(([, v]) => v),
      id,
    );
  return get.get(id)!;
}

/** Set after the welcome turn, so the onboarding instructions only apply once. */
export function markOnboarded(id: string): void {
  db.prepare("UPDATE users SET onboarded_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND onboarded_at IS NULL").run(id);
}
