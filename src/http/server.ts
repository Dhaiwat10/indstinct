// The only HTTP surface: Google's OAuth round trip for /gmail. Everything else is WhatsApp.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "../config.js";
import { log } from "../log.js";
import { onGmailConnected } from "../gmail/connect.js";
import { homePage, privacyPage, termsPage } from "./pages.js";
import { authUrl, consumeConnectToken, exchangeCode, OAuthError, peekConnectToken } from "../gmail/oauth.js";
import { Gmail } from "../gmail/client.js";
import { deleteGmailAccount, getGmailAccount, saveGmailAccount } from "../db/gmail.js";
import type { Send } from "../scheduler/tick.js";

const page = (title: string, body: string, ok = true) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1.5rem;line-height:1.5;color:#1a1a1a}h1{font-size:1.4rem}p{color:#444}.ok{color:#128c7e}.bad{color:#b00020}</style>
<h1 class="${ok ? "ok" : "bad"}">${title}</h1>${body}`;

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

async function handle(req: IncomingMessage, res: ServerResponse, send: Send): Promise<void> {
  const url = new URL(req.url ?? "/", config.PUBLIC_URL);
  if (url.pathname === "/health") return void res.writeHead(200).end("ok");
  if (url.pathname === "/") return html(res, 200, homePage);
  if (url.pathname === "/privacy") return html(res, 200, privacyPage);
  if (url.pathname === "/terms") return html(res, 200, termsPage);

  if (url.pathname === "/gmail/connect") {
    const t = url.searchParams.get("t") ?? "";
    if (!peekConnectToken(t)) return html(res, 400, page("Link expired", "<p>Send <b>/gmail</b> to the bot again for a fresh link.</p>", false));
    res.writeHead(302, { location: authUrl(t) });
    return void res.end();
  }

  if (url.pathname === "/gmail/callback") {
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code");
    const userId = consumeConnectToken(state);
    if (!userId) return html(res, 400, page("Link expired", "<p>Send <b>/gmail</b> to the bot again for a fresh link.</p>", false));
    if (!code) return html(res, 400, page("Not connected", `<p>Google said: ${url.searchParams.get("error") ?? "no code"}. Nothing was linked.</p>`, false));
    try {
      const tokens = await exchangeCode(code);
      if (!tokens.scope.includes("gmail.modify"))
        return html(res, 400, page("Permission missing", "<p>Gmail access wasn't granted. Send <b>/gmail</b> again and tick the Gmail permission.</p>", false));
      const draft = saveGmailAccount({ user_id: userId, email: "pending", access_token: tokens.accessToken, refresh_token: tokens.refreshToken, expires_at: tokens.expiresAt });
      const { emailAddress } = await new Gmail(draft).profile();
      const account = saveGmailAccount({ ...draft, email: emailAddress });
      await onGmailConnected(account, send);
      return html(res, 200, page("Gmail connected ✅", `<p><b>${emailAddress}</b> is linked. Go back to WhatsApp, I've sent you a note there.</p>`));
    } catch (err) {
      log.error({ err, userId }, "gmail connect failed");
      if (getGmailAccount(userId)?.email === "pending") deleteGmailAccount(userId);
      const why = err instanceof OAuthError ? err.message : "something failed on our side";
      return html(res, 500, page("Not connected", `<p>${why}. Send <b>/gmail</b> to try again.</p>`, false));
    }
  }

  res.writeHead(404).end("not found");
}

/** Listens on PORT; `send` lets the callback tell the user on WhatsApp that it worked. */
export function startHttp(send: Send): void {
  createServer((req, res) => {
    handle(req, res, send).catch((err) => {
      log.error({ err, url: req.url }, "http handler failed");
      if (!res.headersSent) res.writeHead(500).end("error");
    });
  }).listen(config.PORT, () => log.info({ port: config.PORT, publicUrl: config.PUBLIC_URL }, "http listening"));
}
