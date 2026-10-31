import { runAgent } from "../agent/run.js";
import { saveMessage } from "../db/messages.js";
import { dueSchedules, markRan, type Schedule } from "../db/schedules.js";
import { getUser } from "../db/users.js";
import { log } from "../log.js";
import { nextCron } from "./time.js";

const TICK_MS = 30_000;
/** At most one unsolicited message per user per minute; extra due jobs wait for a later tick. */
const PROACTIVE_GAP_MS = 60_000;

export type Send = (jid: string, text: string) => Promise<void>;

const lastProactive = new Map<string, number>();

async function fire(s: Schedule, send: Send): Promise<void> {
  const user = getUser(s.user_id);
  if (!user) return markRan(s, undefined);
  const jid = user.chat_jid ?? user.id;

  if (s.kind === "reminder") {
    const text = `⏰ *Reminder:* ${s.payload}`;
    await send(jid, text); // throws → stays due and retries next tick
    saveMessage(user.id, "assistant", text);
    return markRan(s, undefined);
  }

  // Advance first so a failing task can't retry every 30 seconds.
  const next = nextCron(s.cron_expr!, user.timezone);
  markRan(s, typeof next === "string" ? undefined : next);
  if (typeof next === "string") log.warn({ schedule: s.id, err: next }, "cron no longer valid, deactivated");
  const { reply } = await runAgent(user, { text: s.payload, images: [], scheduled: { id: s.id, description: s.description } });
  await send(jid, reply);
}

/** Runs due reminders and recurring tasks every 30 seconds. */
export function startScheduler(send: Send, connected: () => boolean): void {
  let running = false;
  const tick = async () => {
    if (running || !connected()) return;
    running = true;
    try {
      for (const s of dueSchedules()) {
        if (Date.now() - (lastProactive.get(s.user_id) ?? 0) < PROACTIVE_GAP_MS) continue;
        lastProactive.set(s.user_id, Date.now());
        try {
          await fire(s, send);
          log.info({ schedule: s.id, kind: s.kind, user: s.user_id }, "schedule fired");
        } catch (err) {
          log.error({ err, schedule: s.id }, "schedule failed");
        }
      }
    } finally {
      running = false;
    }
  };
  setInterval(tick, TICK_MS).unref();
  void tick();
}
