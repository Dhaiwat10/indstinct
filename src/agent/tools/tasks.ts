import { tool } from "ai";
import { z } from "zod";
import type { User } from "../../db/users.js";
import { cancelTask, replyToTask, startTask } from "../../tasks/runner.js";

/**
 * The main agent's handle on browser tasks. `onSecret` fires when the user's message was a
 * one-time code for a task, so the turn can keep the code out of stored history.
 */
export function taskTools(user: User, onSecret: () => void) {
  return {
    start_task: tool({
      description:
        "Start a task that does something on a website for the user in a real browser, in the background: web check-in, rescheduling or cancelling an appointment, filling in a long form. It can ask the user questions and for approval along the way, and sends files (like boarding passes) at the end. Collect what the site will need first (e.g. booking reference and surname, which passengers). Not for passwords, card payments or creating accounts.",
      inputSchema: z.object({
        goal: z.string().min(5).describe('one sentence, e.g. "Find the 3 cheapest flights Bengaluru to Delhi, 9 to 15 Nov" or "Web check-in for IndiGo PNR ABC123, both passengers"'),
        details: z.string().describe("everything the site will need, as plain text: references, names, dates (as calendar dates), preferences, which site if the user named one"),
        found_so_far: z.string().optional().describe("what a quick lookup already found, if you tried one, so the task doesn't start over"),
      }),
      execute: async ({ goal, details, found_so_far }) => {
        const r = startTask(user.id, goal, found_so_far ? `${details}\n\nAlready found in a quick lookup: ${found_so_far}` : details);
        return "error" in r
          ? `not started: ${r.error}`
          : `task #${r.id} started in the background. Tell the user in one line what you're doing (e.g. "Comparing a few sites, I'll message you in a few minutes") and that you'll message them when it's done. Mention approval only if the task will submit or confirm something.`;
      },
    }),
    task_reply: tool({
      description: "Pass the user's answer to the question the open task is waiting on (see 'Open task' in your instructions).",
      inputSchema: z.object({ answer: z.string().min(1).describe("the user's answer, in their words, or the code exactly as they sent it") }),
      execute: async ({ answer }) => {
        const r = replyToTask(user.id, answer);
        if ("error" in r) return `error: ${r.error}`;
        if (r.task.question?.kind === "otp") onSecret();
        return `passed to task #${r.task.id}. Reply to the user in one short line (e.g. "Got it, continuing").`;
      },
    }),
    cancel_task: tool({
      description: "Stop the user's open task when they ask to cancel or stop it.",
      inputSchema: z.object({}),
      execute: async () => {
        const t = await cancelTask(user.id);
        return t ? `task #${t.id} cancelled` : "no task was open";
      },
    }),
  };
}
