import { tool } from "ai";
import { z } from "zod";
import { browse as run } from "../../browse/agent.js";

/** Each browse can take a minute; past this many per message the user is left waiting too long. */
const MAX_PER_TURN = 2;

/** Created per turn so the call budget resets with every message. */
export const browse = () => {
  let calls = 0;
  return tool({
    description:
      "Open real websites in a browser to look something up that search snippets can't answer: PNR or train running status, live scores, a restaurant's menu, a page's current contents. Give a precise goal with every detail needed (PNR number, train number, date). Takes up to a minute. No logins or payments.",
    inputSchema: z.object({
      goal: z.string().min(5).describe('e.g. "Find the current status of PNR 4512345678"'),
      start_url: z.string().url().optional().describe("A good page to start from, if you know one"),
    }),
    execute: async ({ goal, start_url }) => {
      if (++calls > MAX_PER_TURN) return "browse limit reached for this message; answer with what you have and offer to check again";
      return run(goal, start_url);
    },
  });
};
