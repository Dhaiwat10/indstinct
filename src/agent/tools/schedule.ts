import { tool } from "ai";
import { z } from "zod";
import { activeSchedules, addSchedule, cancelSchedule as cancel } from "../../db/schedules.js";
import type { User } from "../../db/users.js";
import { formatWhen, nextCron, parseAt } from "../../scheduler/time.js";

export const setReminder = (user: User) =>
  tool({
    description:
      "Send the user a one-time reminder message at a specific time. at_iso is ISO 8601 with the user's UTC offset (e.g. 2026-11-01T07:00:00+05:30). text is the reminder as you'll send it, in the user's language.",
    inputSchema: z.object({ at_iso: z.string(), text: z.string().min(1) }),
    execute: async ({ at_iso, text }) => {
      const at = parseAt(at_iso);
      if (typeof at === "string") return `error: ${at}`;
      const id = addSchedule({
        user_id: user.id,
        kind: "reminder",
        cron_expr: null,
        payload_kind: "text",
        payload: text,
        description: text,
        next_run_at: at.toISOString(),
      });
      return `reminder #${id} set for ${formatWhen(at, user.timezone)}`;
    },
  });

export const scheduleRecurring = (user: User) =>
  tool({
    description:
      "Run a task on a recurring schedule in the user's timezone; each run, you get `prompt` and your reply is sent to the user. cron_expr is 5-field cron (min hour dom mon dow, Sunday=0). For a plain recurring nudge, make the prompt \"Remind the user to …\". description is a short label, e.g. \"Daily cricket headlines at 8 am\".",
    inputSchema: z.object({ cron_expr: z.string(), prompt: z.string().min(1), description: z.string().min(1) }),
    execute: async ({ cron_expr, prompt, description }) => {
      const next = nextCron(cron_expr, user.timezone);
      if (typeof next === "string") return `error: ${next}`;
      const id = addSchedule({
        user_id: user.id,
        kind: "cron",
        cron_expr: cron_expr.trim(),
        payload_kind: "agent",
        payload: prompt,
        description,
        next_run_at: next.toISOString(),
      });
      return `recurring task #${id} scheduled; first run ${formatWhen(next, user.timezone)}`;
    },
  });

export const listSchedules = (user: User) =>
  tool({
    description: "List the user's active reminders and recurring tasks with their ids.",
    inputSchema: z.object({}),
    execute: async () => {
      const list = activeSchedules(user.id);
      if (!list.length) return "none";
      return list
        .map((s) => `#${s.id} ${s.kind === "cron" ? `recurring (${s.cron_expr})` : "reminder"}: ${s.description} · next ${formatWhen(new Date(s.next_run_at), user.timezone)}`)
        .join("\n");
    },
  });

export const cancelSchedule = (user: User) =>
  tool({
    description: "Cancel a reminder or recurring task by its #id.",
    inputSchema: z.object({ id: z.number().int() }),
    execute: async ({ id }) => (cancel(user.id, id) ? `cancelled #${id}` : `no active schedule #${id}`),
  });
