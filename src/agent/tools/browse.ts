import { tool } from "ai";
import { z } from "zod";
import { browse as run } from "../../browse/agent.js";

/** Each browse can take most of a minute; one per message is the most a user should wait for. */
export const BROWSE_PER_TURN = 1;

/** Created per turn so the call budget resets with every message. */
export const browse = () => {
  let calls = 0;
  return tool({
    description:
      "SLOW (30-60 seconds): drive a real browser for pages that need clicking or typing to get an answer, e.g. entering a PNR or train number in a form. Never for news, weather, prices or scores (use web_search) or for reading a known page (use read_page). Give a precise goal with every detail needed. One per message. No logins or payments.",
    inputSchema: z.object({
      goal: z.string().min(5).describe('e.g. "Find the current status of PNR 4512345678"'),
      start_url: z.string().url().optional().describe("A good page to start from, if you know one"),
    }),
    execute: async ({ goal, start_url }) => {
      if (++calls > BROWSE_PER_TURN) return "browse limit reached for this message; answer with what you have";
      return run(goal, start_url);
    },
  });
};
