import { tool } from "ai";
import { z } from "zod";
import { config } from "../../config.js";
import { formatWhen } from "../../scheduler/time.js";

type TavilyResult = { title: string; url: string; content: string; published_date?: string };
type TavilyResponse = { results: TavilyResult[]; answer?: string };

const SNIPPET_CHARS = 600;

/** "Sat, 31 Oct 2026 08:10:00 GMT" → "31 Oct 2026"; anything unparseable is passed through. */
function published(r: TavilyResult, timezone: string): string {
  if (!r.published_date) return "undated";
  const d = new Date(r.published_date);
  if (Number.isNaN(d.getTime())) return r.published_date;
  return new Intl.DateTimeFormat("en-IN", { timeZone: timezone, day: "numeric", month: "short", year: "numeric" }).format(d);
}

/**
 * First rung of the ladder: find where an answer lives. Results carry their date and the
 * output starts with today's, so the model can tell stale from fresh instead of giving up on
 * search and escalating to the browser.
 */
export const webSearch = (timezone: string) =>
  tool({
    description:
      "Search the web. The first step for anything live or recent: news, prices, scores, weather, schedules, what happened. Returns dated results with snippets plus a short summary. Write specific queries (place, names, today's date for anything live). If a snippet isn't enough, read_page the best result.",
    inputSchema: z.object({
      query: z.string().min(2),
      recency: z
        .enum(["day", "week", "month", "any"])
        .optional()
        .describe("How fresh results must be: 'day' for today's news, weather or scores; 'week'/'month' for recent events; 'any' (default) for background facts."),
      news: z.boolean().optional().describe("true to search news sources only (headlines, current events)"),
    }),
    execute: async ({ query, recency, news }) => {
      if (!config.TAVILY_API_KEY) return "web search is not configured";
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.TAVILY_API_KEY}` },
        body: JSON.stringify({
          query,
          max_results: 5,
          include_answer: "advanced",
          topic: news ? "news" : "general",
          ...(recency && recency !== "any" && { time_range: recency }),
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return `search failed (${res.status})`;
      const { results, answer } = (await res.json()) as TavilyResponse;
      const header = `Searched on ${formatWhen(new Date(), timezone)}.`;
      if (!results.length) return `${header} No results. Try different words or a wider recency.`;
      const list = results
        .map((r, i) => `${i + 1}. ${r.title} (${published(r, timezone)})\n${r.url}\n${r.content.slice(0, SNIPPET_CHARS)}`)
        .join("\n\n");
      return [header, answer && `Summary of the results: ${answer}`, list].filter(Boolean).join("\n\n");
    },
  });
