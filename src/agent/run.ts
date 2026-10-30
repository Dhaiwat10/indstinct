import { generateText, stepCountIs, type ModelMessage } from "ai";
import { db } from "../db/index.js";
import { history, saveMessage } from "../db/messages.js";
import type { User } from "../db/users.js";
import { log } from "../log.js";
import { models } from "../nearai/client.js";
import { inferenceContext } from "../nearai/capture.js";
import { buildSystemPrompt } from "./prompt.js";
import { remember } from "./tools/remember.js";

const linkInferences = db.prepare(
  "UPDATE inference_log SET message_id = ? WHERE user_id = ? AND message_id IS NULL",
);

/** Some reasoning models leak think blocks or leading blank lines into content. */
function clean(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

/** Runs one agent turn for `text` and returns the reply, persisting both sides. */
export async function runAgent(user: User, text: string, waMessageId?: string): Promise<string> {
  const messages: ModelMessage[] = history(user.id).map((m) => ({ role: m.role, content: m.content }));
  messages.push({ role: "user", content: text });
  saveMessage(user.id, "user", text, waMessageId);

  const t0 = Date.now();
  const result = await inferenceContext.run({ userId: user.id }, () =>
    generateText({
      model: models.primary(),
      system: buildSystemPrompt(user),
      messages,
      tools: { remember: remember(user) },
      stopWhen: stepCountIs(8),
    }),
  );

  const reply = clean(result.text) || "Done ✅";
  const replyId = saveMessage(user.id, "assistant", reply);
  linkInferences.run(replyId, user.id);

  log.info(
    { user: user.id, ms: Date.now() - t0, steps: result.steps.length, tools: result.steps.flatMap((s) => s.toolCalls.map((c) => c.toolName)) },
    "agent turn",
  );
  return reply;
}
