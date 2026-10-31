import { tool } from "ai";
import { z } from "zod";
import { browse as run } from "../../browse/agent.js";
import type { ProgressEvent } from "../run.js";

/** Each browse can take minutes; past this many per message the user is left waiting too long. */
const MAX_PER_TURN = 2;

/**
 * Third rung of the ladder: a real browser for pages that need interaction. Created per turn
 * so the call budget resets with every message; `progress` lets the user know a long job started.
 */
export const browse = (progress?: (event: ProgressEvent) => void) => {
  let calls = 0;
  return tool({
    description:
      "Open real websites in a browser and interact with them: search inside a site, fill forms, press buttons, follow multi-step flows (no logins or payments). The last resort: use it when the page needs interaction, or when web_search and read_page couldn't get the answer. Never call it in the same step as web_search. Slow: a minute or more. Give a precise goal with every detail needed (numbers, names, dates).",
    inputSchema: z.object({
      goal: z.string().min(5).describe('e.g. "Find the current status of PNR 4512345678"'),
      start_url: z.string().url().optional().describe("A good page to start from, if you know one"),
    }),
    execute: async ({ goal, start_url }) => {
      if (++calls > MAX_PER_TURN) return "browse limit reached for this message; answer with what you have and offer to check again";
      progress?.("browsing");
      return run(goal, start_url);
    },
  });
};
