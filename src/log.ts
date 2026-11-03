import pino from "pino";
import { config } from "./config.js";

/**
 * Logs carry timings, ids and counts, never what users said or what the bot replied. Errors are
 * the one place content sneaks in: the AI SDK attaches the whole prompt and response to the
 * errors it throws, so only these fields of an error are kept.
 */
const ERROR_FIELDS = ["type", "message", "stack", "name", "code", "status", "statusCode", "isRetryable"];

function contentFreeError(err: unknown, depth = 0): unknown {
  if (!(err instanceof Error) || depth > 3) return err;
  const out: Record<string, unknown> = { type: err.constructor?.name };
  for (const key of ERROR_FIELDS) {
    const value = (err as unknown as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = value;
  }
  if (err.cause !== undefined) out.cause = contentFreeError(err.cause, depth + 1);
  return out;
}

export const log = pino({ level: config.LOG_LEVEL, serializers: { err: (err: unknown) => contentFreeError(err) } });
