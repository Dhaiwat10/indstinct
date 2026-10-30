import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { db } from "../db/index.js";
import { log } from "../log.js";

/** Who an inference call is for; set with `inferenceContext.run(...)` around agent turns. */
export const inferenceContext = new AsyncLocalStorage<{ userId?: string; messageId?: number; purpose?: "agent" | "extract" }>();

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const insert = db.prepare(`
  INSERT INTO inference_log
    (user_id, message_id, purpose, completion_id, model, request_sha256, response_sha256, request_raw, response_raw)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function toBytes(body: unknown): Uint8Array<ArrayBuffer> | undefined {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return new Uint8Array(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return undefined;
}

/**
 * A fetch that records the exact request and response bytes of every chat completion.
 * NEAR AI signs `model:sha256(request):sha256(response)`, so we must hash the bytes on
 * the wire, never re-serialized JSON. Responses are fully buffered, so this only works
 * for non-streaming calls.
 */
export const capturingFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.endsWith("/chat/completions")) return fetch(input, init);

  const requestBytes = toBytes(init?.body);
  if (!requestBytes) throw new Error("capturingFetch: unsupported request body type");

  const headers = new Headers(init?.headers);
  headers.set("accept-encoding", "identity");
  const res = await fetch(input, { ...init, headers, body: requestBytes });
  const responseBytes = new Uint8Array(await res.arrayBuffer());

  if (res.ok) {
    try {
      const reqJson = JSON.parse(Buffer.from(requestBytes).toString("utf8"));
      const resJson = JSON.parse(Buffer.from(responseBytes).toString("utf8"));
      const ctx = inferenceContext.getStore();
      insert.run(
        ctx?.userId ?? null,
        ctx?.messageId ?? null,
        ctx?.purpose ?? "agent",
        resJson.id ?? null,
        reqJson.model ?? null,
        sha256(requestBytes),
        sha256(responseBytes),
        Buffer.from(requestBytes),
        Buffer.from(responseBytes),
      );
    } catch (err) {
      log.error({ err }, "failed to record inference");
    }
  }

  return new Response(responseBytes, { status: res.status, statusText: res.statusText, headers: res.headers });
};
