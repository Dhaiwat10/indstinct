import { generateText, stepCountIs, tool } from "ai";
import { chromium, type Browser, type Page } from "playwright";
import { z } from "zod";
import { log } from "../log.js";
import { blockedHost } from "../net/safe-url.js";
import { models } from "../nearai/client.js";

// Browsing is the slowest thing the bot does; keep the budget tight. read_page covers plain reading.
const TIMEOUT_MS = 45_000;
const MAX_STEPS = 8;
const SNAPSHOT_CHARS = 8000;

let browser: Promise<Browser> | undefined;
function getBrowser(): Promise<Browser> {
  browser ??= chromium.launch({ headless: true }).catch((err) => {
    browser = undefined;
    throw err;
  });
  return browser;
}

async function snapshot(page: Page): Promise<string> {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(400); // let client-side rendering settle
  const tree = await page.locator("body").ariaSnapshot({ timeout: 10_000 }).catch((err) => `(couldn't read page: ${err.message})`);
  const text = tree.length > SNAPSHOT_CHARS ? `${tree.slice(0, SNAPSHOT_CHARS)}\n…(truncated)` : tree;
  return `URL: ${page.url()}\nTitle: ${await page.title()}\n\n${text}`;
}

const roles = z
  .enum(["link", "button", "textbox", "searchbox", "combobox", "option", "checkbox", "radio", "tab", "menuitem", "heading", "cell", "row"])
  .describe("ARIA role as shown in the page snapshot");

const system = `You are a browsing agent. Use the browser tools to accomplish the goal, then reply with a concise plain-text answer containing exactly the facts that were asked for (numbers, statuses, times), plus the URL you got them from.
Pages are shown as accessibility snapshots: "- role \\"name\\"" lines. Click and type using a role and name from the snapshot.
Rules: never log in, sign up, pay or enter personal data beyond what the goal includes. If a page needs a login, payment or captcha, stop and say so. If a site fails, try one alternative site at most. Never make up results: if you couldn't find it, say what you saw.`;

/** Runs a short browser session for `goal` and returns a text answer. */
export async function browse(goal: string, startUrl?: string): Promise<string> {
  const context = await (await getBrowser()).newContext({ locale: "en-IN", timezoneId: "Asia/Kolkata", viewport: { width: 1280, height: 900 } });
  await context.route("**/*", (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (!/^https?:$/.test(url.protocol) || blockedHost(url.hostname)) return route.abort("blockedbyclient");
    if (["image", "media", "font"].includes(req.resourceType())) return route.abort();
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      return `error: ${(err as Error).message.split("\n")[0]}\n\n${await snapshot(page)}`;
    }
    return snapshot(page);
  };

  const tools = {
    goto: tool({
      description: "Open a URL. Returns the page snapshot.",
      inputSchema: z.object({ url: z.string().url() }),
      execute: ({ url }) => act(() => page.goto(url, { waitUntil: "domcontentloaded" })),
    }),
    read: tool({
      description: "Re-read the current page (e.g. after waiting for results).",
      inputSchema: z.object({ wait_seconds: z.number().min(0).max(10).optional() }),
      execute: async ({ wait_seconds }) => {
        if (wait_seconds) await page.waitForTimeout(wait_seconds * 1000);
        return snapshot(page);
      },
    }),
    click: tool({
      description: "Click an element by role and accessible name. Returns the new snapshot.",
      inputSchema: z.object({ role: roles, name: z.string() }),
      execute: ({ role, name }) => act(() => page.getByRole(role, { name }).first().click()),
    }),
    type: tool({
      description: "Type into a field by role and accessible name, optionally pressing Enter. Returns the new snapshot.",
      inputSchema: z.object({ role: roles, name: z.string(), text: z.string(), submit: z.boolean().optional() }),
      execute: ({ role, name, text, submit }) =>
        act(async () => {
          const field = page.getByRole(role, { name }).first();
          await field.fill(text);
          if (submit) await field.press("Enter");
        }),
    }),
  };

  const t0 = Date.now();
  try {
    const result = await generateText({
      model: models.heavy(),
      system,
      prompt: `Goal: ${goal}${startUrl ? `\nStart at: ${startUrl}` : ""}`,
      tools,
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
      maxRetries: 0, // capturingFetch retries
    });
    const answer = result.text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    log.info({ goal, ms: Date.now() - t0, steps: result.steps.length, url: page.url() }, "browse done");
    return answer || `Stopped after ${result.steps.length} steps without an answer. Last page: ${page.url()}`;
  } catch (err) {
    log.warn({ err, goal }, "browse failed");
    return `Browsing failed (${(err as Error).name === "TimeoutError" ? "took too long" : (err as Error).message.split("\n")[0]}). Last page: ${page.url()}`;
  } finally {
    await context.close().catch(() => {});
  }
}
