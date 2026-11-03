import { db } from "./index.js";

export type Schedule = {
  id: number;
  user_id: string;
  kind: "reminder" | "cron";
  cron_expr: string | null;
  payload_kind: "text" | "agent";
  payload: string;
  description: string;
  next_run_at: string;
};

const insert = db.prepare(`
  INSERT INTO schedules (user_id, kind, cron_expr, payload_kind, payload, description, next_run_at)
  VALUES (@user_id, @kind, @cron_expr, @payload_kind, @payload, @description, @next_run_at)
`);
const upcoming = db.prepare<[string], Schedule>(
  "SELECT * FROM schedules WHERE user_id = ? AND active = 1 ORDER BY next_run_at",
);
const due = db.prepare<[string], Schedule>(
  "SELECT * FROM schedules WHERE active = 1 AND next_run_at <= ? ORDER BY next_run_at LIMIT 20",
);
// Cancelled and finished schedules are deleted; nothing reads inactive ones. (Old rows are cleared here.)
const deactivate = db.prepare("DELETE FROM schedules WHERE id = ? AND user_id = ? AND active = 1");
const ran = db.prepare(
  "UPDATE schedules SET last_run_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), next_run_at = ? WHERE id = ?",
);
const finished = db.prepare("DELETE FROM schedules WHERE id = ?");
db.exec("DELETE FROM schedules WHERE active = 0");

export function addSchedule(s: Omit<Schedule, "id">): number {
  return Number(insert.run(s).lastInsertRowid);
}

export function activeSchedules(userId: string): Schedule[] {
  return upcoming.all(userId);
}

export function dueSchedules(now = new Date()): Schedule[] {
  return due.all(now.toISOString());
}

export function cancelSchedule(userId: string, id: number): boolean {
  return deactivate.run(id, userId).changes > 0;
}

/** Records a run: reminders end, cron jobs move to their next occurrence. */
export function markRan(s: Schedule, next: Date | undefined): void {
  if (next) ran.run(next.toISOString(), s.id);
  else finished.run(s.id);
}
