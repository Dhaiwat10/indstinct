import { generateText, Output } from "ai";
import { z } from "zod";
import { CATEGORIES, listMemories, remember, rewrite } from "../db/memories.js";
import type { User } from "../db/users.js";
import { log } from "../log.js";
import { inferenceContext } from "../nearai/capture.js";
import { models } from "../nearai/client.js";

const schema = z.object({
  add: z.array(z.object({ content: z.string(), category: z.enum(CATEGORIES) })),
  update: z.array(z.object({ id: z.number().int(), content: z.string() })),
});

const system = `You maintain a personal assistant's long-term memory about one user.
Read the latest exchange and the existing memories. Return only NEW durable facts the exchange reveals that the memories don't already cover: people and relationships, birthdays and other dates, upcoming plans and events (with absolute dates), places, preferences, health, work, ongoing situations.
Skip chit-chat, questions, requests, one-off tasks and anything already in memory, including less specific versions of an existing memory (if memory says "The user's sister Priya is getting married on 12 Dec", don't add "The user has a sister named Priya"). If a fact changes an existing memory, put it in "update" with that memory's id instead of adding a duplicate.
Write each fact as one short standalone English sentence, using the user's name or "the user", never he/she. Turn relative dates into absolute ones using "Now".
Most exchanges contain nothing new: then return empty lists.`;

/**
 * Background pass after a turn that catches facts the agent didn't save itself, e.g. "my
 * mom's flight lands on the 4th" said in passing. Saved as source=inferred.
 */
export async function extractMemories(user: User, userText: string, reply: string, replyId: number): Promise<void> {
  const existing = listMemories(user.id);
  const now = new Intl.DateTimeFormat("en-IN", { timeZone: user.timezone, dateStyle: "full", timeStyle: "short" }).format(new Date());
  const prompt = [
    `Now: ${now}`,
    `Existing memories:\n${existing.map((m) => `#${m.id} ${m.content}`).join("\n") || "(none)"}`,
    `User: ${userText}`,
    `Assistant: ${reply}`,
  ].join("\n\n");

  const t0 = Date.now();
  const { output } = await inferenceContext.run({ userId: user.id, messageId: replyId, purpose: "extract" }, () =>
    generateText({ model: models.extract(), system, prompt, output: Output.object({ schema }), maxRetries: 0 }),
  );

  for (const m of output.add) remember(user.id, m.content, m.category, "inferred");
  for (const m of output.update) rewrite(user.id, m.id, m.content);
  if (output.add.length || output.update.length)
    log.info({ user: user.id, ms: Date.now() - t0, add: output.add, update: output.update }, "memories extracted");
}
