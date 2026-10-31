import { tool } from "ai";
import { z } from "zod";
import { config } from "../../config.js";

type TavilyResult = { title: string; url: string; content: string; published_date?: string };

export const webSearch = tool({
  description:
    "Search the web for current information: news, scores, prices, schedules, anything after your training or likely to change. Returns the top results with URLs; cite the useful ones.",
  inputSchema: z.object({
    query: z.string().min(2),
    news: z.boolean().optional().describe("true for recent news and headlines"),
  }),
  execute: async ({ query, news }) => {
    if (!config.TAVILY_API_KEY) return "web search is not configured";
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.TAVILY_API_KEY}` },
      body: JSON.stringify({ query, max_results: 5, topic: news ? "news" : "general", ...(news && { days: 3 }) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return `search failed (${res.status})`;
    const { results } = (await res.json()) as { results: TavilyResult[] };
    if (!results.length) return "no results";
    return results
      .map((r, i) => `${i + 1}. ${r.title}${r.published_date ? ` (${r.published_date})` : ""}\n${r.url}\n${r.content.slice(0, 600)}`)
      .join("\n\n");
  },
});
