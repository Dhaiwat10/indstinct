import { Cron } from "croner";

/** Recurring jobs must be at least this far apart, so a bad cron can't spam the user (or get the SIM banned). */
const MIN_INTERVAL_MS = 60 * 60_000;

export function formatWhen(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

/** Parses a model-supplied time. An explicit offset is required: without one "07:00" is ambiguous. */
export function parseAt(iso: string): Date | string {
  if (!/(Z|[+-]\d\d:?\d\d)$/i.test(iso.trim())) return `"${iso}" has no UTC offset; include one, e.g. +05:30`;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return `"${iso}" is not a valid ISO time`;
  if (at.getTime() < Date.now() - 60_000) return `${iso} is in the past`;
  return at;
}

/** Next occurrence of a 5-field cron in `tz`, or an error message for the model. */
export function nextCron(expr: string, tz: string, after = new Date()): Date | string {
  if (expr.trim().split(/\s+/).length !== 5) return `"${expr}" must have 5 fields: min hour dom mon dow`;
  let job: Cron;
  try {
    job = new Cron(expr, { timezone: tz, paused: true });
  } catch (err) {
    return `invalid cron "${expr}": ${(err as Error).message}`;
  }
  const [a, b] = job.nextRuns(2, after);
  if (!a) return `"${expr}" never runs`;
  if (b && b.getTime() - a.getTime() < MIN_INTERVAL_MS) return "recurring tasks can run at most once an hour";
  return a;
}
