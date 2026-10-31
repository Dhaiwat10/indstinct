import { db } from "./index.js";

export type GmailAccount = {
  user_id: string;
  email: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  alerts: number;
  watch_cursor: number;
  flags_day: string | null;
  flags_today: number;
  needs_reauth: number;
  created_at: string;
};

export type EmailDraft = {
  id: number;
  user_id: string;
  gmail_draft_id: string;
  to_addr: string;
  subject: string;
  body: string;
  created_ms: number;
  sent_at: string | null;
};

const get = db.prepare<[string], GmailAccount>("SELECT * FROM gmail_accounts WHERE user_id = ?");
const all = db.prepare<[], GmailAccount>("SELECT * FROM gmail_accounts");
const upsert = db.prepare(`
  INSERT INTO gmail_accounts (user_id, email, access_token, refresh_token, expires_at, watch_cursor)
  VALUES (@user_id, @email, @access_token, @refresh_token, @expires_at, @watch_cursor)
  ON CONFLICT(user_id) DO UPDATE SET
    email = excluded.email, access_token = excluded.access_token, refresh_token = excluded.refresh_token,
    expires_at = excluded.expires_at, needs_reauth = 0
`);
const setTokens = db.prepare("UPDATE gmail_accounts SET access_token = ?, expires_at = ? WHERE user_id = ?");
const setReauth = db.prepare("UPDATE gmail_accounts SET needs_reauth = 1 WHERE user_id = ?");
const setAlerts = db.prepare("UPDATE gmail_accounts SET alerts = ?, watch_cursor = ? WHERE user_id = ?");
const setCursor = db.prepare("UPDATE gmail_accounts SET watch_cursor = ? WHERE user_id = ?");
const bumpFlags = db.prepare("UPDATE gmail_accounts SET flags_day = ?, flags_today = ? WHERE user_id = ?");
const remove = db.prepare("DELETE FROM gmail_accounts WHERE user_id = ?");

export function getGmailAccount(userId: string): GmailAccount | undefined {
  return get.get(userId);
}

export function allGmailAccounts(): GmailAccount[] {
  return all.all();
}

export function saveGmailAccount(a: Pick<GmailAccount, "user_id" | "email" | "access_token" | "refresh_token" | "expires_at">): GmailAccount {
  upsert.run({ ...a, watch_cursor: Date.now() });
  return get.get(a.user_id)!;
}

export function updateAccessToken(userId: string, accessToken: string, expiresAt: number): void {
  setTokens.run(accessToken, expiresAt, userId);
}

export function markNeedsReauth(userId: string): void {
  setReauth.run(userId);
}

/** Turning alerts on starts the watch from now, so nothing already in the inbox gets flagged. */
export function setGmailAlerts(userId: string, on: boolean): void {
  setAlerts.run(on ? 1 : 0, Date.now(), userId);
}

export function setWatchCursor(userId: string, ms: number): void {
  setCursor.run(ms, userId);
}

/** Counts one more flag for today (day as yyyy-mm-dd in the user's tz) and returns the new total. */
export function countFlag(a: GmailAccount, day: string): number {
  const n = a.flags_day === day ? a.flags_today + 1 : 1;
  bumpFlags.run(day, n, a.user_id);
  return n;
}

export function deleteGmailAccount(userId: string): void {
  remove.run(userId);
}

// --- drafts -----------------------------------------------------------------------

const insertDraft = db.prepare(`
  INSERT INTO email_drafts (user_id, gmail_draft_id, to_addr, subject, body, created_ms)
  VALUES (@user_id, @gmail_draft_id, @to_addr, @subject, @body, @created_ms)
`);
const getDraft = db.prepare<[number, string], EmailDraft>("SELECT * FROM email_drafts WHERE id = ? AND user_id = ?");
const updateDraft = db.prepare("UPDATE email_drafts SET to_addr = ?, subject = ?, body = ?, created_ms = ? WHERE id = ?");
const markSent = db.prepare("UPDATE email_drafts SET sent_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?");
const deleteDrafts = db.prepare("DELETE FROM email_drafts WHERE user_id = ?");

export function addDraft(d: Omit<EmailDraft, "id" | "sent_at">): number {
  return Number(insertDraft.run(d).lastInsertRowid);
}

export function findDraft(userId: string, id: number): EmailDraft | undefined {
  return getDraft.get(id, userId);
}

/** A rewritten draft counts as new for the send guard: the user must see this version first. */
export function rewriteDraft(id: number, d: Pick<EmailDraft, "to_addr" | "subject" | "body">): void {
  updateDraft.run(d.to_addr, d.subject, d.body, Date.now(), id);
}

export function markDraftSent(id: number): void {
  markSent.run(id);
}

export function deleteUserDrafts(userId: string): void {
  deleteDrafts.run(userId);
}
