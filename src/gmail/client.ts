// Gmail REST over fetch with transparent token refresh. One instance per (user, call site);
// cheap to make, holds no state beyond the account row it was given.
import { log } from "../log.js";
import { getGmailAccount, markNeedsReauth, updateAccessToken, type GmailAccount } from "../db/gmail.js";
import { addressOf, buildRaw, flatten, header, type Attachment, type Outgoing, type Part } from "./mime.js";
import { OAuthError, refreshAccessToken } from "./oauth.js";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const TIMEOUT_MS = 20_000;

/** Thrown when the grant is gone (user revoked in Google, password change); the user must /gmail again. */
export class GmailReauthRequired extends Error {
  constructor() {
    super("Gmail access was revoked; reconnect with /gmail");
  }
}

export type MessageMeta = {
  id: string;
  threadId: string;
  from: string;
  to: string;
  cc: string;
  replyTo: string;
  subject: string;
  date: Date;
  snippet: string;
  unread: boolean;
  labels: string[];
  messageIdHeader: string;
  references: string;
  listUnsubscribe?: string;
  listUnsubscribePost?: string;
};

export type FullMessage = MessageMeta & { text: string; attachments: Attachment[] };

type RawMessage = { id: string; threadId: string; labelIds?: string[]; snippet?: string; internalDate?: string; payload?: Part };

const META_HEADERS = ["From", "To", "Cc", "Reply-To", "Subject", "Date", "Message-ID", "References", "List-Unsubscribe", "List-Unsubscribe-Post"];

function meta(m: RawMessage): MessageMeta {
  const h = m.payload?.headers;
  return {
    id: m.id,
    threadId: m.threadId,
    from: header(h, "From") ?? "",
    to: header(h, "To") ?? "",
    cc: header(h, "Cc") ?? "",
    replyTo: header(h, "Reply-To") ?? "",
    subject: header(h, "Subject") ?? "(no subject)",
    date: new Date(Number(m.internalDate ?? 0)),
    snippet: decodeSnippet(m.snippet ?? ""),
    unread: m.labelIds?.includes("UNREAD") ?? false,
    labels: m.labelIds ?? [],
    messageIdHeader: header(h, "Message-ID") ?? "",
    references: header(h, "References") ?? "",
    listUnsubscribe: header(h, "List-Unsubscribe"),
    listUnsubscribePost: header(h, "List-Unsubscribe-Post"),
  };
}

const decodeSnippet = (s: string) => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

export class Gmail {
  constructor(private account: GmailAccount) {}

  get email(): string {
    return this.account.email;
  }

  private async token(): Promise<string> {
    if (this.account.expires_at - Date.now() > 60_000) return this.account.access_token;
    try {
      const t = await refreshAccessToken(this.account.refresh_token);
      updateAccessToken(this.account.user_id, t.accessToken, t.expiresAt);
      this.account = { ...this.account, access_token: t.accessToken, expires_at: t.expiresAt };
      return t.accessToken;
    } catch (err) {
      if (err instanceof OAuthError && (err.code === "invalid_grant" || err.code === "unauthorized_client")) {
        markNeedsReauth(this.account.user_id);
        throw new GmailReauthRequired();
      }
      throw err;
    }
  }

  private async call<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${await this.token()}`, ...(init.body && { "content-type": "application/json" }), ...init.headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401 && retry) {
      this.account = { ...this.account, expires_at: 0 }; // force a refresh
      return this.call<T>(path, init, false);
    }
    if (res.status === 204) return undefined as T;
    const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; status?: string } };
    if (!res.ok) {
      const msg = json.error?.message ?? `HTTP ${res.status}`;
      log.warn({ path, status: res.status, msg }, "gmail call failed");
      throw new Error(`Gmail: ${msg}`);
    }
    return json;
  }

  async profile(): Promise<{ emailAddress: string; messagesTotal: number }> {
    return this.call("/profile");
  }

  /** Gmail search syntax; newest first. Metadata only, so it's one small call per hit. */
  async search(q: string, max = 10): Promise<MessageMeta[]> {
    const list = await this.call<{ messages?: { id: string }[] }>(`/messages?q=${encodeURIComponent(q)}&maxResults=${Math.min(max, 25)}`);
    const ids = list.messages?.map((m) => m.id) ?? [];
    return Promise.all(ids.map((id) => this.getMeta(id)));
  }

  async getMeta(id: string): Promise<MessageMeta> {
    const qs = META_HEADERS.map((h) => `metadataHeaders=${h}`).join("&");
    return meta(await this.call<RawMessage>(`/messages/${id}?format=metadata&${qs}`));
  }

  async getFull(id: string): Promise<FullMessage> {
    const m = await this.call<RawMessage>(`/messages/${id}?format=full`);
    return { ...meta(m), ...flatten(m.payload) };
  }

  async thread(threadId: string): Promise<FullMessage[]> {
    const t = await this.call<{ messages?: RawMessage[] }>(`/threads/${threadId}?format=full`);
    return (t.messages ?? []).map((m) => ({ ...meta(m), ...flatten(m.payload) }));
  }

  async attachment(messageId: string, attachmentId: string): Promise<Buffer> {
    const a = await this.call<{ data: string }>(`/messages/${messageId}/attachments/${attachmentId}`);
    return Buffer.from(a.data, "base64url");
  }

  async createDraft(m: Omit<Outgoing, "from">, threadId?: string): Promise<string> {
    const raw = buildRaw({ ...m, from: this.account.email });
    const d = await this.call<{ id: string }>("/drafts", { method: "POST", body: JSON.stringify({ message: { raw, ...(threadId && { threadId }) } }) });
    return d.id;
  }

  async updateDraft(draftId: string, m: Omit<Outgoing, "from">, threadId?: string): Promise<void> {
    const raw = buildRaw({ ...m, from: this.account.email });
    await this.call(`/drafts/${draftId}`, { method: "PUT", body: JSON.stringify({ message: { raw, ...(threadId && { threadId }) } }) });
  }

  /** Sends whatever the draft holds now, so edits made in the Gmail app go out too. */
  async sendDraft(draftId: string): Promise<{ id: string; threadId: string }> {
    return this.call("/drafts/send", { method: "POST", body: JSON.stringify({ id: draftId }) });
  }

  async send(m: Omit<Outgoing, "from">, threadId?: string): Promise<{ id: string; threadId: string }> {
    const raw = buildRaw({ ...m, from: this.account.email });
    return this.call("/messages/send", { method: "POST", body: JSON.stringify({ raw, ...(threadId && { threadId }) }) });
  }

  async modify(ids: string[], add: string[], remove: string[]): Promise<void> {
    await this.call("/messages/batchModify", { method: "POST", body: JSON.stringify({ ids, addLabelIds: add, removeLabelIds: remove }) });
  }

  async trash(id: string): Promise<void> {
    await this.call(`/messages/${id}/trash`, { method: "POST" });
  }

  /**
   * RFC 8058 one-click first, then a plain https link, then the mailto: route. Returns what
   * was done, or undefined when the sender offers no unsubscribe header at all.
   */
  async unsubscribe(m: MessageMeta): Promise<string | undefined> {
    if (!m.listUnsubscribe) return undefined;
    const targets = [...m.listUnsubscribe.matchAll(/<([^>]+)>/g)].map((x) => x[1]!.trim());
    const https = targets.find((t) => /^https?:\/\//i.test(t));
    const mailto = targets.find((t) => /^mailto:/i.test(t));
    if (https && /one-click/i.test(m.listUnsubscribePost ?? "")) {
      const res = await fetch(https, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "follow",
      }).catch(() => undefined);
      if (res?.ok) return "one-click unsubscribe sent";
    }
    if (mailto) {
      const u = new URL(mailto);
      const to = u.pathname;
      const subject = u.searchParams.get("subject") ?? "unsubscribe";
      await this.send({ to, subject, body: u.searchParams.get("body") ?? "Please unsubscribe me from this list." });
      return `unsubscribe email sent to ${to}`;
    }
    if (https) {
      const res = await fetch(https, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow" }).catch(() => undefined);
      return res?.ok ? "opened the sender's unsubscribe link" : `the sender's unsubscribe link didn't respond (${https})`;
    }
    return undefined;
  }

  /** True when `addr` is this account. */
  isMe(addr: string): boolean {
    return addressOf(addr) === this.account.email.toLowerCase();
  }
}

/** The user's Gmail if connected and usable; undefined otherwise. */
export function gmailFor(userId: string): Gmail | undefined {
  const a = getGmailAccount(userId);
  return a && !a.needs_reauth ? new Gmail(a) : undefined;
}
