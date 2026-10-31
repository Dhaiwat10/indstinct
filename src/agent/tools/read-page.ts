import { tool } from "ai";
import { z } from "zod";
import { htmlToText } from "../../gmail/mime.js";
import { assertPublicUrl } from "../../net/safe-url.js";

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 3_000_000;
const TEXT_CHARS = 8000;
const MAX_PER_TURN = 3;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0 Safari/537.36";

/** The main content when the page marks it, so menus and footers don't eat the budget. */
function mainHtml(html: string): string {
  return html.match(/<article\b[\s\S]*<\/article>/i)?.[0] ?? html.match(/<main\b[\s\S]*<\/main>/i)?.[0] ?? html;
}

/** Follows redirects by hand so every hop is checked against private addresses. */
async function get(raw: string): Promise<Response> {
  let url = raw;
  for (let hop = 0; hop < 5; hop++) {
    await assertPublicUrl(url);
    const res = await fetch(url, {
      redirect: "manual",
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5", "accept-language": "en-IN,en;q=0.9" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const next = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && next) {
      url = new URL(next, url).href;
      continue;
    }
    return res;
  }
  throw new Error("too many redirects");
}

/** Created per turn so the call budget resets with every message. */
export const readPage = () => {
  let calls = 0;
  return tool({
    description:
      "Read one web page's text (about 2 seconds): an article, a result from web_search, a page the user linked. No clicking or typing; for that, browse.",
    inputSchema: z.object({ url: z.string().url() }),
    execute: async ({ url }) => {
      if (++calls > MAX_PER_TURN) return "read limit reached for this message; answer with what you have";
      try {
        const res = await get(url);
        if (!res.ok) return `couldn't read ${url} (HTTP ${res.status})`;
        const type = res.headers.get("content-type") ?? "";
        if (!/html|text|json|xml/i.test(type)) return `${url} is ${type || "not a web page"}; can't read it as text`;
        const body = (await res.text()).slice(0, MAX_BYTES);
        const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
        const text = /html/i.test(type) ? htmlToText(mainHtml(body)) : body;
        if (text.length < 200 && /html/i.test(type))
          return `${url} returned almost no text (likely built by JavaScript or blocked). Use browse only if this page is essential.`;
        const cut = text.length > TEXT_CHARS ? `${text.slice(0, TEXT_CHARS)}\n…(truncated)` : text;
        return `URL: ${res.url || url}${title ? `\nTitle: ${htmlToText(title)}` : ""}\n\n${cut}`;
      } catch (err) {
        return `couldn't read ${url}: ${(err as Error).name === "TimeoutError" ? "timed out" : (err as Error).message}`;
      }
    },
  });
};
