import { generateText, tool } from "ai";
import { createHash } from "node:crypto";
import { z } from "zod";
import { models } from "../nearai/client.js";
import type { Download, Page } from "playwright";
import { openPage, type BrowserHandle } from "./browser.js";

const SNAPSHOT_CHARS = 12_000;

/**
 * A browser page that survives its session dying (a hosted session can time out while a task
 * waits for the user): the next action opens a fresh one and says so.
 */
export class PageSession {
  private handle?: BrowserHandle;
  private current?: Page;
  restarted = false;
  /** The file the page downloaded most recently, for save_file. */
  lastDownload?: Download;
  constructor(private readonly media: boolean) {}

  /** The page in front: a link that opens a new tab (boarding passes often do) moves us there. */
  async page(): Promise<Page> {
    if (!this.handle) {
      this.handle = await openPage({ media: this.media });
      const watch = (p: Page) => {
        p.setDefaultTimeout(15_000);
        p.on("download", (d) => (this.lastDownload = d));
        p.on("close", () => this.current === p && (this.current = this.handle?.context.pages().at(-1)));
      };
      watch(this.handle.page);
      this.current = this.handle.page;
      this.handle.context.on("page", (p) => {
        watch(p);
        this.current = p;
      });
    }
    return this.current ?? this.handle.page;
  }

  /** Drops a dead session so the next call opens a new one. */
  async reset(): Promise<void> {
    await this.handle?.close();
    this.handle = undefined;
    this.current = undefined;
    this.restarted = true;
  }

  async close(): Promise<void> {
    await this.handle?.close();
    this.handle = undefined;
  }
}

const dead = (err: unknown) => /target (page, context or browser )?(has been )?closed|browser has been closed|disconnected|connection closed/i.test(String((err as Error)?.message ?? err));

/** Interactive elements and headings first, so forms survive the cut on long pages. */
function trim(tree: string): string {
  if (tree.length <= SNAPSHOT_CHARS) return tree;
  const lines = tree.split("\n");
  const keep = lines.filter((l) => /^\s*- (button|link|textbox|searchbox|combobox|checkbox|radio|option|heading|tab|menuitem|alert|dialog)\b/.test(l) || /\b(error|invalid|required)\b/i.test(l));
  const text = keep.join("\n");
  return `${text.slice(0, SNAPSHOT_CHARS)}\n…(long page: showing interactive elements and headings only; use find for other text)`;
}

export async function snapshot(session: PageSession): Promise<string> {
  const page = await session.page();
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(800); // let client-side rendering settle
  const tree = await page.locator("body").ariaSnapshot({ timeout: 10_000 }).catch((err) => `(couldn't read page: ${err.message})`);
  return `URL: ${page.url()}\nTitle: ${await page.title().catch(() => "")}\n\n${trim(tree)}`;
}

const roles = z
  .enum(["link", "button", "textbox", "searchbox", "combobox", "listbox", "option", "checkbox", "radio", "switch", "tab", "menuitem", "heading", "cell", "row", "spinbutton"])
  .describe("ARIA role as shown in the page snapshot");

/** Reading and acting on pages. The same tools for quick lookups and for long tasks. */
export function pageTools(session: PageSession) {
  const recent: string[] = [];

  const act = async (fn: () => Promise<unknown>): Promise<string> => {
    let note = "";
    try {
      await fn();
    } catch (err) {
      if (dead(err)) {
        await session.reset();
        return "The browser session ended and a fresh one was opened on a blank page. Go back to where you were with goto.";
      }
      note = `error: ${(err as Error).message.split("\n")[0]}\n\n`;
    }
    const snap = await snapshot(session);
    // Same page, same content, four actions running: the agent is going in circles.
    recent.push(createHash("sha1").update(snap).digest("hex"));
    if (recent.length > 4) recent.shift();
    if (recent.length === 4 && recent.every((h) => h === recent[0]))
      note += "Note: the last four actions left the page unchanged. Try something different, use look to see the page, or ask the user.\n\n";
    return note + snap;
  };

  return {
    goto: tool({
      description: "Open a URL. Returns the page snapshot.",
      inputSchema: z.object({ url: z.string().url() }),
      execute: ({ url }) => act(async () => (await session.page()).goto(url, { waitUntil: "domcontentloaded" })),
    }),
    read: tool({
      description: "Re-read the current page, optionally after waiting (e.g. for results to load).",
      inputSchema: z.object({ wait_seconds: z.number().min(0).max(15).optional() }),
      execute: ({ wait_seconds }) => act(async () => wait_seconds && (await session.page()).waitForTimeout(wait_seconds * 1000)),
    }),
    click: tool({
      description: "Click an element by role and accessible name. Returns the new snapshot.",
      inputSchema: z.object({ role: roles, name: z.string() }),
      execute: ({ role, name }) => act(async () => (await session.page()).getByRole(role, { name }).first().click()),
    }),
    type: tool({
      description: "Type into a field by role and accessible name, optionally pressing Enter. Returns the new snapshot.",
      inputSchema: z.object({ role: roles, name: z.string(), text: z.string(), submit: z.boolean().optional() }),
      execute: ({ role, name, text, submit }) =>
        act(async () => {
          const field = (await session.page()).getByRole(role, { name }).first();
          await field.fill(text);
          if (submit) await field.press("Enter");
        }),
    }),
    select: tool({
      description: "Choose an option in a dropdown (a combobox or listbox) by its visible label.",
      inputSchema: z.object({ name: z.string().describe("the dropdown's accessible name"), option: z.string() }),
      execute: ({ name, option }) =>
        act(async () => {
          const box = (await session.page()).getByRole("combobox", { name }).first();
          await box.selectOption({ label: option }).catch(async () => {
            await box.click(); // custom dropdowns: open, then pick the option
            await (await session.page()).getByRole("option", { name: option }).first().click();
          });
        }),
    }),
    press: tool({
      description: "Press a key on the page, e.g. Escape to close a popup, Tab, Enter.",
      inputSchema: z.object({ key: z.string() }),
      execute: ({ key }) => act(async () => (await session.page()).keyboard.press(key)),
    }),
    find: tool({
      description: "Search the full current page for lines containing these words; for long pages where the snapshot was cut.",
      inputSchema: z.object({ text: z.string().min(2) }),
      execute: async ({ text }) => {
        const tree = await (await session.page()).locator("body").ariaSnapshot({ timeout: 10_000 }).catch(() => "");
        const words = text.toLowerCase().split(/\s+/);
        const hits = tree.split("\n").filter((l) => words.every((w) => l.toLowerCase().includes(w)));
        return hits.length ? hits.slice(0, 40).join("\n") : `no lines mention "${text}"`;
      },
    }),
    look: tool({
      description:
        "Take a screenshot and ask a vision model about it: seat maps, images, icon-only buttons, a captcha, or anything the snapshot doesn't explain. Slower than the snapshot; use when needed.",
      inputSchema: z.object({ question: z.string().describe('e.g. "which window seats are free?"') }),
      execute: async ({ question }) => {
        const image = await (await session.page()).screenshot({ type: "jpeg", quality: 70 });
        const { text } = await generateText({
          model: models.vision(),
          messages: [{ role: "user", content: [{ type: "file", data: image, mediaType: "image/jpeg" }, { type: "text", text: `This is a screenshot of a web page. ${question} Answer briefly and precisely, naming buttons and labels exactly as shown.` }] }],
          maxRetries: 0,
        });
        return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim() || "(the vision model gave no answer)";
      },
    }),
  };
}
