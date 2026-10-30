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

/** Users are keyed by phone jid when WhatsApp gives us the number, so @lid churn doesn't split them. */
export function upsertUser(chatJid: string, phone: string | undefined, pushName: string | undefined): User {
  const id = phone ? `${phone}@s.whatsapp.net` : chatJid;
  const existing = get.get(id);
  if (!existing) insert.run(id, chatJid, phone ?? null, pushName ?? null);
  else if (existing.chat_jid !== chatJid) touchChat.run(chatJid, id);
  return get.get(id)!;
}
