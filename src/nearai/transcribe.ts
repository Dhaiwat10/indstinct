import { config } from "../config.js";
import { log } from "../log.js";
import { fetchWithRetry, inferenceContext, InferenceUnavailable, recordInference } from "./capture.js";

/** OpenAI-style transcription endpoints reject uploads over 25 MB; that's well over an hour of WhatsApp voice. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

const extension = (mimeType: string) =>
  mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") || mimeType.includes("m4a") || mimeType.includes("aac") ? "m4a" : mimeType.includes("mpeg") ? "mp3" : mimeType.includes("wav") ? "wav" : mimeType.includes("webm") ? "webm" : "ogg";

/**
 * Speech to text with Whisper on NEAR AI, inside its TEE. Whisper detects the language itself,
 * which matters for Hindi, Hinglish and regional voice notes. The call's request and response
 * hashes go in the inference log like every chat completion; the audio is never stored.
 */
export async function transcribe(audio: Buffer, mimeType: string): Promise<string> {
  const form = new FormData();
  form.append("model", config.MODEL_WHISPER);
  form.append("response_format", "json");
  // WhatsApp sends "audio/ogg; codecs=opus"; the file name's extension is what servers sniff.
  form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType.split(";")[0] }), `voice.${extension(mimeType)}`);

  // Serialize once so the bytes we hash are the bytes we send, on every retry.
  const encoded = new Request("http://local/", { method: "POST", body: form });
  const requestBytes = new Uint8Array(await encoded.arrayBuffer());
  const res = await fetchWithRetry(`${config.NEAR_AI_BASE_URL}/audio/transcriptions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.NEAR_AI_API_KEY}`,
      "content-type": encoded.headers.get("content-type")!,
      "accept-encoding": "identity",
    },
    body: requestBytes,
  });
  const responseBytes = new Uint8Array(await res.arrayBuffer());
  if (res.status === 402) log.error("NEAR AI says the account is out of credits");
  if (!res.ok) throw new InferenceUnavailable(`NEAR AI transcription returned HTTP ${res.status}`, res.status);

  const body = JSON.parse(Buffer.from(responseBytes).toString("utf8")) as { id?: string; text?: string };
  try {
    recordInference(config.MODEL_WHISPER, body.id ?? null, requestBytes, responseBytes, "transcribe");
  } catch (err) {
    log.error({ err }, "failed to record inference");
  }
  return (body.text ?? "").trim();
}

/**
 * A voice note as the text the agent reads, tagged so it knows it was spoken. The tag stays in
 * history, so "what did I say in that voice note?" still works.
 */
export async function voiceNoteText(userId: string, audio: { data: Buffer; mimeType: string }): Promise<string> {
  if (audio.data.length > MAX_AUDIO_BYTES) return "[🎤 voice note too long to transcribe]";
  const transcript = await inferenceContext.run({ userId }, () => transcribe(audio.data, audio.mimeType));
  return transcript ? `[🎤 voice note] ${transcript}` : "[🎤 voice note, no speech heard]";
}
