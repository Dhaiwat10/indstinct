import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { config } from "../config.js";
import { capturingFetch } from "./capture.js";

export const nearai = createOpenAICompatible({
  name: "nearai",
  baseURL: config.NEAR_AI_BASE_URL,
  apiKey: config.NEAR_AI_API_KEY,
  fetch: capturingFetch,
});

export const models = {
  primary: () => nearai.chatModel(config.MODEL_PRIMARY),
  vision: () => nearai.chatModel(config.MODEL_VISION),
  heavy: () => nearai.chatModel(config.MODEL_HEAVY),
  extract: () => nearai.chatModel(config.MODEL_EXTRACT),
};
