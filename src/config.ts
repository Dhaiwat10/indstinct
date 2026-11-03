import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

if (existsSync(".env")) process.loadEnvFile(".env");

const list = z
  .string()
  .default("")
  .transform((s) => s.split(",").map((x) => x.replace(/\D/g, "")).filter(Boolean));

const schema = z.object({
  NEAR_AI_API_KEY: z.string().min(1, "NEAR_AI_API_KEY is required"),
  NEAR_AI_BASE_URL: z.string().url().default("https://cloud-api.near.ai/v1"),
  MODEL_PRIMARY: z.string().default("deepseek-ai/DeepSeek-V4.1-Flash-1017"),
  // DeepSeek has no vision; image turns go here.
  MODEL_VISION: z.string().default("Qwen/Qwen3.8-27B"),
  MODEL_HEAVY: z.string().default("deepseek-ai/DeepSeek-V4.1-Flash-1017"),
  MODEL_EXTRACT: z.string().default("Qwen/Qwen3.6-35B-A3B-FP8"),
  MODEL_WHISPER: z.string().default("openai/whisper-large-v3"),
  TAVILY_API_KEY: z.string().optional(),
  // Hosted browser for browser tasks; without it a local headless Chromium is used.
  BROWSERBASE_API_KEY: z.string().optional(),
  // Google OAuth "Web application" client; Gmail features are off until both are set.
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  // Where the OAuth callback server is reachable from the user's browser; ${PUBLIC_URL}/gmail/callback must be an authorised redirect URI.
  PUBLIC_URL: z.string().url().optional(),
  PORT: z.coerce.number().int().default(3000),
  ALLOWED_NUMBERS: list,
  WA_PAIR_NUMBER: z.string().default("").transform((s) => s.replace(/\D/g, "")),
  DEFAULT_TZ: z.string().default("Asia/Kolkata"),
  DATA_DIR: z.string().default("./data").transform((p) => resolve(p)),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment:\n" + z.prettifyError(parsed.error));
  process.exit(1);
}

export const config = {
  ...parsed.data,
  PUBLIC_URL: (parsed.data.PUBLIC_URL ?? `http://localhost:${parsed.data.PORT}`).replace(/\/$/, ""),
  GMAIL_ENABLED: !!(parsed.data.GOOGLE_CLIENT_ID && parsed.data.GOOGLE_CLIENT_SECRET),
};
