import { generateText, stepCountIs } from "ai";
import { log } from "../log.js";
import { models } from "../nearai/client.js";
import { PageSession, pageTools } from "./tools.js";

const TIMEOUT_MS = 240_000;
const MAX_STEPS = 20;

const system = `You are a browsing agent looking something up. Use the browser tools to find the answer, then reply with a concise plain-text answer containing exactly the facts that were asked for (numbers, statuses, times), plus the URL you got them from.
Pages are shown as accessibility snapshots: "- role \\"name\\"" lines. Click and type using a role and name from the snapshot. Use find on long pages and look when the snapshot doesn't explain what's on screen.
This is read-only: you may search and fill in lookup forms (a PNR, a train number), but never submit anything that changes something, pay, log in or create an account. If a site fails, try one alternative site at most. Never make up results: if you couldn't find it, say what you saw.`;

/** A quick read-only lookup: runs a short browser session for `goal` and returns a text answer. */
export async function browse(goal: string, startUrl?: string): Promise<string> {
  const session = new PageSession(false);
  const t0 = Date.now();
  try {
    const result = await generateText({
      model: models.heavy(),
      system,
      prompt: `Goal: ${goal}${startUrl ? `\nStart at: ${startUrl}` : ""}`,
      tools: pageTools(session),
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
      maxRetries: 0, // capturingFetch retries
    });
    const answer = result.text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    log.info({ ms: Date.now() - t0, steps: result.steps.length }, "browse done");
    return answer || `Stopped after ${result.steps.length} steps without an answer.`;
  } catch (err) {
    log.warn({ err }, "browse failed");
    return `Browsing failed (${(err as Error).name === "TimeoutError" ? "took too long" : (err as Error).message.split("\n")[0]}).`;
  } finally {
    await session.close();
  }
}
