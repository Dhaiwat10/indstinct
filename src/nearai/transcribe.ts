import { config } from "../config.js";
import { log } from "../log.js";
import { fetchWithRetry, InferenceUnavailable } from "./capture.js";

/** OpenAI-style transcription endpoints reject uploads over 25 MB; that's well over an hour of WhatsApp voice. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

const extension = (mimeType: string) =>
  mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") || mimeType.includes("m4a") || mimeType.includes("aac") ? "m4a" : mimeType.includes("mpeg") ? "mp3" : mimeType.includes("wav") ? "wav" : mimeType.includes("webm") ? "webm" : "ogg";

/**
 * Speech to text with Whisper on NEAR AI, inside its TEE. Whisper detects the language itself,
 * which matters for Hindi, Hinglish and regional voice notes. The audio is never stored. The
 * transcript becomes the user's message, so the agent's signed request (and /verify) covers it.
 */
export async function transcribe(audio: Buffer, mimeType: string): Promise<string> {
  const form = new FormData();
  form.append("model", config.MODEL_WHISPER);
  form.append("response_format", "json");
  // WhatsApp sends "audio/ogg; codecs=opus"; the file name's extension is what servers sniff.
  form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType.split(";")[0] }), `voice.${extension(mimeType)}`);

  // Serialize once so every retry resends the same body.
  const encoded = new Request("http://local/", { method: "POST", body: form });
  const res = await fetchWithRetry(`${config.NEAR_AI_BASE_URL}/audio/transcriptions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.NEAR_AI_API_KEY}`,
      "content-type": encoded.headers.get("content-type")!,
      "accept-encoding": "identity",
    },
    body: new Uint8Array(await encoded.arrayBuffer()),
  });
  if (res.status === 402) log.error("NEAR AI says the account is out of credits");
  if (!res.ok) throw new InferenceUnavailable(`NEAR AI transcription returned HTTP ${res.status}`, res.status);

  const body = (await res.json()) as { text?: string };
  return (body.text ?? "").trim();
}

/**
 * A voice note as the text the agent reads, tagged so it knows it was spoken. The tag stays in
 * history, so "what did I say in that voice note?" still works.
 */
export async function voiceNoteText(audio: { data: Buffer; mimeType: string }): Promise<string> {
  if (audio.data.length > MAX_AUDIO_BYTES) return "[🎤 voice note too long to transcribe]";
  const transcript = await transcribe(audio.data, audio.mimeType);
  return transcript ? `[🎤 voice note] ${transcript}` : "[🎤 voice note, no speech heard]";
}
