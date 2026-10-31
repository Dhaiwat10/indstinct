import { tool } from "ai";
import { z } from "zod";
import { config } from "../../config.js";

type TavilyResult = { title: string; url: string; content: string; published_date?: string };
type TavilyResponse = { answer?: string; results: TavilyResult[] };

/** Calls per message; one call can already carry several queries. */
const MAX_PER_TURN = 3;

async function search(query: string, news: boolean): Promise<string> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.TAVILY_API_KEY}` },
    // include_answer: Tavily's own short answer from the results, usually enough to reply directly.
    body: JSON.stringify({ query, max_results: 5, include_answer: true, topic: news ? "news" : "general", ...(news && { days: 3 }) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return `"${query}": search failed (${res.status})`;
  const { answer, results } = (await res.json()) as TavilyResponse;
  if (!results.length && !answer) return `"${query}": no results`;
  const lines = results.map((r, i) => `${i + 1}. ${r.title}${r.published_date ? ` (${r.published_date})` : ""}\n${r.url}\n${r.content.slice(0, 500)}`);
  return [`Search: "${query}"`, answer && `Quick answer: ${answer}`, ...lines].filter(Boolean).join("\n\n");
}

/** Created per turn so the call budget resets with every message. */
export const webSearch = () => {
  let calls = 0;
  return tool({
    description:
      "Search the web (about 2 seconds) for anything current: news, weather, prices, scores, schedules, facts after your training. Returns a quick answer plus top results with URLs. Put every query you need in ONE call (up to 3, run in parallel) instead of calling again.",
    inputSchema: z.object({
      queries: z.array(z.string().min(2)).min(1).max(3).describe("1-3 search queries, run in parallel"),
      news: z.boolean().optional().describe("true for recent news and headlines"),
    }),
    execute: async ({ queries, news }) => {
      if (!config.TAVILY_API_KEY) return "web search is not configured";
      if (++calls > MAX_PER_TURN) return "search limit reached for this message; answer with what you have";
      const out = await Promise.all(queries.map((q) => search(q, !!news).catch((err) => `"${q}": search failed (${(err as Error).message})`)));
      return out.join("\n\n---\n\n");
    },
  });
};
