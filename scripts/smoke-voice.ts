// One real voice note through Whisper on NEAR AI: a Hindi clip ("remind me to call mummy at 8
// tomorrow morning", WhatsApp's ogg/opus format) must come back as recognisable text.
// Run: pnpm smoke:voice
import { readFileSync } from "node:fs";

const { voiceNoteText } = await import("../src/nearai/transcribe.js");

const audio = readFileSync(new URL("./fixtures/voice-hi.ogg", import.meta.url));
const t0 = Date.now();
const text = await voiceNoteText({ data: audio, mimeType: "audio/ogg; codecs=opus" });
console.log(`voice note (${Date.now() - t0}ms): ${text}`);

// Whisper's Hindi spelling varies run to run (मम्मी, ममी, मम्मा), so match loosely.
const heard = /(सुबह|subah)/i.test(text) && /(मम|mumm?y|माँ|मां)/i.test(text);
console.log(heard ? "✅ voice note transcribed" : "❌ transcript missing the key words");
if (!heard) process.exitCode = 1;
