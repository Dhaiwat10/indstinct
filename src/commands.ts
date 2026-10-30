import { db } from "./db/index.js";
import { forget, listMemories } from "./db/memories.js";
import { clearHistory } from "./db/messages.js";
import type { User } from "./db/users.js";
import { verifyInference, type InferenceRow } from "./nearai/verify.js";

const short = (h: string) => {
  const prefix = h.startsWith("0x") ? "0x" : "";
  const body = h.slice(prefix.length);
  return `${prefix}${body.slice(0, 4)}…${body.slice(-4)}`;
};
const tick = (ok: boolean) => (ok ? "✅" : "❌");

/** The final model call behind the user's latest bot reply (or the nth-latest with `/verify n`). */
const lastInference = db.prepare<[string, number], InferenceRow>(`
  SELECT l.* FROM inference_log l
  WHERE l.purpose = 'agent' AND l.message_id = (
    SELECT id FROM messages WHERE user_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1 OFFSET ?
  )
  ORDER BY l.id DESC LIMIT 1
`);

async function verify(user: User, arg: string): Promise<string | string[]> {
  const n = Math.max(1, Number.parseInt(arg, 10) || 1);
  const row = lastInference.get(user.id, n - 1);
  if (!row) return "Nothing to verify yet. Send me a message first, then /verify.";

  const v = await verifyInference(row);
  if (v.error && !v.signer) return `🔐 Couldn't fetch the signature yet (${v.error}). Try again in a minute.`;

  const allGood = v.hashesMatch && v.signatureValid && v.signerAttested && v.quoteBindsSigner;
  const summary = [
    allGood ? "🔐 *Verified private inference*" : "⚠️ *Verification incomplete*",
    `Model: ${v.model} (NEAR AI Confidential TEE)`,
    `Request hash: ${short(v.requestHash)}`,
    `Response hash: ${short(v.responseHash)}`,
    `Signed by: ${v.signer ? short(v.signer) : "?"}`,
    "",
    `${tick(v.hashesMatch)} Signature covers exactly these bytes`,
    `${tick(v.signatureValid)} Signature is valid for that key`,
    `${tick(v.signerAttested)} Key belongs to the attested TEE for this model`,
    `${tick(v.quoteBindsSigner)} Hardware quote commits to that key (fresh nonce)`,
    v.error ? `\n_${v.error}_` : "",
    allGood ? "\nThis reply was generated inside a TEE. Nobody, not NEAR and not us, could read it in plaintext." : "",
    v.receiptUrl ? "\nFull values and independent hardware verification on NEAR AI's Verification Center 👇" : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
  return v.receiptUrl ? [summary, v.receiptUrl] : summary;
}

function memories(user: User): string {
  const list = listMemories(user.id);
  if (list.length === 0) return "I don't know anything about you yet. Tell me something!";
  return `🧠 *What I know about you*\n${list.map((m) => `• ${m.content} _(#${m.id})_`).join("\n")}`;
}

const help = `*Commands*
/verify — prove my last reply ran in a TEE
/memories — what I remember about you
/forget <id> — forget a memory (ids from /memories)
/reset — clear our chat history (memories stay)
/help — this list`;

/** Handles a slash command without the LLM. Returns undefined if `text` isn't one. */
export async function handleCommand(user: User, text: string): Promise<string | string[] | undefined> {
  const match = text.trim().match(/^\/(\w+)\s*(.*)$/s);
  if (!match) return undefined;
  const [, cmd, arg] = match;
  switch (cmd!.toLowerCase()) {
    case "verify":
      return verify(user, arg!);
    case "memories":
      return memories(user);
    case "forget": {
      const ids = (arg!.match(/\d+/g) ?? []).map(Number);
      if (ids.length === 0) return "Which one? Send /forget followed by the number from /memories, like /forget 12";
      const n = forget(user.id, ids);
      return n ? `🗑️ Forgotten (${n}).` : "I couldn't find that memory. /memories shows the numbers.";
    }
    case "reset":
      clearHistory(user.id);
      return "Chat history cleared. I still remember what you've told me — /memories to see it.";
    case "help":
      return help;
    default:
      return undefined;
  }
}
