import { randomBytes } from "node:crypto";
import { config } from "../config.js";

/** Read, label, draft and send; no permanent delete. Plus the address, to show which account is linked. */
export const SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];

export const redirectUri = () => `${config.PUBLIC_URL}/gmail/callback`;

/** Short-lived, single-use tokens that tie a connect link to the WhatsApp user who asked for it. */
const CONNECT_TTL_MS = 15 * 60_000;
const pending = new Map<string, { userId: string; expires: number }>();

export function newConnectLink(userId: string): string {
  for (const [t, p] of pending) if (p.expires < Date.now() || p.userId === userId) pending.delete(t);
  const token = randomBytes(24).toString("base64url");
  pending.set(token, { userId, expires: Date.now() + CONNECT_TTL_MS });
  return `${config.PUBLIC_URL}/gmail/connect?t=${token}`;
}

export function peekConnectToken(token: string): string | undefined {
  const p = pending.get(token);
  return p && p.expires > Date.now() ? p.userId : undefined;
}

export function consumeConnectToken(token: string): string | undefined {
  const userId = peekConnectToken(token);
  pending.delete(token);
  return userId;
}

export function authUrl(state: string): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", config.GOOGLE_CLIENT_ID!);
  u.searchParams.set("redirect_uri", redirectUri());
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", SCOPES.join(" "));
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent"); // always get a refresh token, even on reconnect
  u.searchParams.set("include_granted_scopes", "true");
  u.searchParams.set("state", state);
  return u.href;
}

type TokenResponse = { access_token: string; expires_in: number; refresh_token?: string; scope?: string; error?: string; error_description?: string };

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.GOOGLE_CLIENT_ID!, client_secret: config.GOOGLE_CLIENT_SECRET!, ...params }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json()) as TokenResponse;
  if (!res.ok || json.error) throw new OAuthError(json.error ?? `HTTP ${res.status}`, json.error_description);
  return json;
}

export class OAuthError extends Error {
  constructor(
    readonly code: string,
    description?: string,
  ) {
    super(description ? `${code}: ${description}` : code);
  }
}

export async function exchangeCode(code: string): Promise<{ accessToken: string; refreshToken: string; expiresAt: number; scope: string }> {
  const t = await tokenRequest({ code, grant_type: "authorization_code", redirect_uri: redirectUri() });
  if (!t.refresh_token) throw new OAuthError("no_refresh_token", "Google did not return a refresh token");
  return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + t.expires_in * 1000, scope: t.scope ?? "" };
}

export async function refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresAt: number }> {
  const t = await tokenRequest({ refresh_token: refreshToken, grant_type: "refresh_token" });
  return { accessToken: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 };
}

/** Best effort: Google revokes both tokens of the grant. */
export async function revokeToken(token: string): Promise<void> {
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {});
}
