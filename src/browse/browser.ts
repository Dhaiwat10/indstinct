import { isIP } from "node:net";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { config } from "../config.js";
import { log } from "../log.js";

/**
 * One open browser page and how to close it. Hosted on Browserbase when BROWSERBASE_API_KEY is
 * set (a real browser fingerprint and captcha solving, which airline and news sites need), else
 * a local headless Chromium.
 */
export type BrowserHandle = { page: Page; context: BrowserContext; hosted: boolean; close: () => Promise<void> };

/** Sessions outlive a task's wait for the user's answer; Browserbase's cap is 6 hours. */
const HOSTED_TIMEOUT_S = 2 * 60 * 60;

let local: Promise<Browser> | undefined;
function localBrowser(): Promise<Browser> {
  local ??= chromium.launch({ headless: true }).catch((err) => {
    local = undefined;
    throw err;
  });
  return local;
}

/** The browser runs on our machine, so it must never reach localhost or the private network. */
export function blockedHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (isIP(h) === 4) {
    const [a, b] = h.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(h) === 6) return h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80") || h.startsWith("::ffff:");
  return false;
}

async function hostedSession(): Promise<{ id: string; connectUrl: string }> {
  const create = (body: object) =>
    fetch("https://api.browserbase.com/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "X-BB-API-Key": config.BROWSERBASE_API_KEY! },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  const base = { region: "ap-southeast-1", browserSettings: { solveCaptchas: true, viewport: { width: 1280, height: 900 } } };
  let res = await create({ ...base, timeout: HOSTED_TIMEOUT_S });
  // A plan that won't take the long timeout still gets a browser, with the project default.
  if (res.status === 400 || res.status === 402) res = await create(base);
  if (!res.ok) throw new Error(`Browserbase session failed (HTTP ${res.status})`);
  return (await res.json()) as { id: string; connectUrl: string };
}

/**
 * Opens a page. `media: false` blocks images, media and fonts, which lookups don't need;
 * tasks keep them, since seat maps, icon buttons and QR codes depend on them.
 */
export async function openPage({ media }: { media: boolean }): Promise<BrowserHandle> {
  let context: BrowserContext;
  let close: () => Promise<void>;
  const hosted = !!config.BROWSERBASE_API_KEY;
  if (hosted) {
    const session = await hostedSession();
    const browser = await chromium.connectOverCDP(session.connectUrl);
    context = browser.contexts()[0] ?? (await browser.newContext());
    close = () => browser.close().catch(() => {});
    log.info({ session: session.id }, "browserbase session");
  } else {
    context = await (await localBrowser()).newContext({ locale: "en-IN", timezoneId: "Asia/Kolkata", viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    close = () => context.close().catch(() => {});
  }
  await context.route("**/*", (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (!/^(https?|data|blob):$/.test(url.protocol) || (/^https?:$/.test(url.protocol) && blockedHost(url.hostname)))
      return route.abort("blockedbyclient");
    if (!media && ["image", "media", "font"].includes(req.resourceType())) return route.abort();
    return route.continue();
  });
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(15_000);
  return { page, context, hosted, close };
}
