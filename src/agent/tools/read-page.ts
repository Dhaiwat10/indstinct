import { tool } from "ai";
import { z } from "zod";
import { config } from "../../config.js";
import { formatWhen } from "../../scheduler/time.js";

type TavilyExtract = {
  results: { url: string; raw_content: string }[];
  failed_results?: { url: string; error: string }[];
};

/** Enough for an article or a results page; the model only needs the part that answers the question. */
const MAX_CHARS = 8000;

/**
 * Second rung of the ladder: read one page in full. One HTTP call, where the browser agent
 * would spend a dozen model calls getting to the same text.
 */
export const readPage = (timezone: string) =>
  tool({
    description:
      "Read one web page as text: give a URL (usually from web_search results) and get its content. The second step of a quick lookup when a snippet isn't enough. It can't click, type or search inside a site; for that, use start_task.",
    inputSchema: z.object({ url: z.string().url() }),
    execute: async ({ url }) => {
      if (!config.TAVILY_API_KEY) return "page reading is not configured";
      const res = await fetch("https://api.tavily.com/extract", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.TAVILY_API_KEY}` },
        body: JSON.stringify({ urls: [url], format: "text" }),
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) return `couldn't read ${url} (${res.status})`;
      const { results, failed_results } = (await res.json()) as TavilyExtract;
      const page = results[0];
      if (!page?.raw_content) {
        const why = failed_results?.[0]?.error;
        return `couldn't read ${url}${why ? ` (${why})` : ""}. Try another result, or browse if the page needs interaction.`;
      }
      const text = page.raw_content.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      const body = text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n…(truncated)` : text;
      return `Content of ${url}, read ${formatWhen(new Date(), timezone)}:\n\n${body}`;
    },
  });
