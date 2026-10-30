// One real call through the capturing client, then fetch NEAR AI's signature for it and
// check the signed text matches our hashes. Run: pnpm smoke:nearai
import { generateText } from "ai";
import { config } from "../src/config.js";
import { db } from "../src/db/index.js";
import { models } from "../src/nearai/client.js";

const t0 = Date.now();
const { text } = await generateText({
  model: models.primary(),
  prompt: "Ek line mein Hinglish mein hello bolo.",
});
console.log(`reply (${Date.now() - t0}ms):`, text);

const row = db
  .prepare("SELECT completion_id, model, request_sha256, response_sha256 FROM inference_log ORDER BY id DESC LIMIT 1")
  .get() as { completion_id: string; model: string; request_sha256: string; response_sha256: string };
console.log("logged:", row);

const sigUrl = `${config.NEAR_AI_BASE_URL}/signature/${encodeURIComponent(row.completion_id)}?model=${encodeURIComponent(row.model)}&signing_algo=ecdsa`;
for (let attempt = 1; attempt <= 5; attempt++) {
  const res = await fetch(sigUrl, { headers: { authorization: `Bearer ${config.NEAR_AI_API_KEY}` } });
  const body = await res.text();
  if (res.status === 404 && attempt < 5) {
    await new Promise((r) => setTimeout(r, 2000));
    continue;
  }
  console.log(`signature ${res.status}:`, body);
  if (res.ok) {
    const sig = JSON.parse(body);
    const expected = `${row.request_sha256}:${row.response_sha256}`;
    console.log(String(sig.text).endsWith(expected) ? "✅ signed text matches our hashes" : `❌ expected …${expected}`);
  }
  break;
}
