// One real voice note through Whisper on NEAR AI: a Hindi clip ("remind me to call mummy at 8
// tomorrow morning", WhatsApp's ogg/opus format) must come back as recognisable text, and the
// call must land in the inference log. Also reports whether NEAR AI signs transcriptions.
// Run: pnpm smoke:voice
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR ??= mkdtempSync(join(tmpdir(), "indstinct-voice-"));
const { config } = await import("../src/config.js");
const { db } = await import("../src/db/index.js");
const { voiceNoteText } = await import("../src/nearai/transcribe.js");

const audio = readFileSync(new URL("./fixtures/voice-hi.ogg", import.meta.url));
const t0 = Date.now();
const text = await voiceNoteText("smoke", { data: audio, mimeType: "audio/ogg; codecs=opus" });
console.log(`voice note (${Date.now() - t0}ms): ${text}`);

const heard = /(सुबह|subah)/i.test(text) && /(मम्मी|mummy|मम्मा|माँ)/i.test(text);
const row = db.prepare("SELECT completion_id, model FROM inference_log WHERE purpose = 'transcribe' ORDER BY id DESC LIMIT 1").get() as
  | { completion_id: string | null; model: string }
  | undefined;
console.log(row ? `logged: ${row.model}, id ${row.completion_id ?? "(none returned)"}` : "❌ not logged");

if (row?.completion_id) {
  const res = await fetch(
    `${config.NEAR_AI_BASE_URL}/signature/${encodeURIComponent(row.completion_id)}?model=${encodeURIComponent(row.model)}&signing_algo=ecdsa`,
    { headers: { authorization: `Bearer ${config.NEAR_AI_API_KEY}` } },
  );
  console.log(`signature for the transcription: HTTP ${res.status} (informational)`);
}

console.log(heard && row ? "✅ voice note transcribed" : "❌ transcript missing the key words, or not logged");
if (!heard || !row) process.exitCode = 1;
