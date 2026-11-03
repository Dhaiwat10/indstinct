import type { WASocket } from "baileys";
import "./db/index.js";
import { runAgent, type ProgressEvent } from "./agent/run.js";
import { handleCommand } from "./commands.js";
import { upsertUser } from "./db/users.js";
import { config } from "./config.js";
import { startInboxWatch } from "./gmail/watch.js";
import { startHttp } from "./http/server.js";
import { log } from "./log.js";
import { InferenceUnavailable } from "./nearai/capture.js";
import { startScheduler } from "./scheduler/tick.js";
import { startTaskRunner } from "./tasks/runner.js";
import { onInbound, type Inbound } from "./wa/inbound.js";
import { sendFile, sendText, typing } from "./wa/outbound.js";
import { connect } from "./wa/socket.js";

/** People send three short messages in a row; wait this long after the last one and reply once. */
const DEBOUNCE_MS = 2500;
/** If a reply takes longer than this, say so once instead of leaving the user staring at "typing…". */
const SLOW_NOTICE_MS = 15_000;

const devanagari = /[\u0900-\u097F]/;

function slowNotice(text: string): string {
  return devanagari.test(text) ? "एक सेकंड, देख रहा हूँ… ⏳" : "One sec, on it… ⏳";
}

/** Sent the moment a long job starts, in place of the generic slow notice. */
function progressNotice(event: ProgressEvent, text: string): string {
  switch (event) {
    case "browsing":
      return devanagari.test(text) ? "साइट खोल रहा हूँ, इसमें एक-दो मिनट लग सकते हैं ⏳" : "Opening the site now, this can take a minute or two ⏳";
  }
}

function failureMessage(err: unknown): string {
  const cause = err instanceof InferenceUnavailable ? err : (err as { cause?: unknown })?.cause;
  if (cause instanceof InferenceUnavailable) {
    return cause.status === 402
      ? "I'm out of thinking credits right now 😅 My owner has been told. Try again a bit later?"
      : "My AI backend (NEAR AI) isn't responding right now. Give it a minute and send that again?";
  }
  return "Sorry, something broke on my side. Try sending that again?";
}

// One turn at a time per user, so quick follow-ups see the previous reply in history.
const queues = new Map<string, Promise<void>>();
function serial(key: string, job: () => Promise<void>): Promise<void> {
  const next = (queues.get(key) ?? Promise.resolve()).then(job, job);
  queues.set(key, next);
  void next.finally(() => queues.get(key) === next && queues.delete(key));
  return next;
}

async function respond(sock: WASocket, burst: Inbound[]): Promise<void> {
  const last = burst.at(-1)!;
  const user = upsertUser(last.chatJid, last.phone, last.pushName);
  const text = burst.map((m) => m.text).filter(Boolean).join("\n");
  const images = burst.flatMap((m) => (m.image ? [m.image] : []));
  log.info({ user: user.id, chars: text.length, images: images.length, messages: burst.length }, "inbound");
  await typing(sock, last.chatJid, true);
  // WhatsApp drops "typing…" after ~25s; browsing can take minutes.
  const keepTyping = setInterval(() => void typing(sock, last.chatJid, true), 10_000);
  let slow: NodeJS.Timeout | undefined;
  // One interim message per turn at most: whichever of "slow" and "browsing" comes first.
  let noticed = false;
  const notice = (message: string) => {
    if (noticed) return;
    noticed = true;
    void sendText(sock, last.chatJid, message).catch(() => {});
  };
  try {
    const command = images.length ? undefined : await handleCommand(user, text);
    if (!command) slow = setTimeout(() => notice(slowNotice(text)), SLOW_NOTICE_MS);
    const result =
      command === undefined
        ? await runAgent(user, { text, images, waMessageId: last.waMessageId, progress: (event) => notice(progressNotice(event, text)) })
        : undefined;
    const reply = command ?? result!.reply;
    clearTimeout(slow);
    for (const part of [reply].flat()) await sendText(sock, last.chatJid, part);
    for (const f of result?.files ?? []) await sendFile(sock, last.chatJid, f.data, f.mimeType, f.name);
  } catch (err) {
    log.error({ err, user: user.id }, "turn failed");
    await sendText(sock, last.chatJid, failureMessage(err)).catch(() => {});
  } finally {
    clearTimeout(slow);
    clearInterval(keepTyping);
    await typing(sock, last.chatJid, false);
  }
}

const pending = new Map<string, { burst: Inbound[]; timer: NodeJS.Timeout }>();

function flush(sock: WASocket, chatJid: string): void {
  const p = pending.get(chatJid);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(chatJid);
  void serial(chatJid, () => respond(sock, p.burst));
}

// The scheduler outlives reconnects: it sends through the open socket and pauses while there is none.
let current: WASocket | undefined;
const send = async (jid: string, text: string) => {
  if (!current) throw new Error("WhatsApp not connected");
  await sendText(current, jid, text);
};
const connected = () => !!current;
startScheduler(send, connected);
startTaskRunner(
  {
    send,
    sendFile: async (jid, f) => {
      if (!current) throw new Error("WhatsApp not connected");
      await sendFile(current, jid, f.data, f.mimeType, f.name);
    },
  },
  connected,
);
// Always up, for /health; the Gmail routes just report "link expired" until Gmail is configured.
startHttp(send);
if (config.GMAIL_ENABLED) startInboxWatch(send, connected);
else log.info("Gmail features off: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable /gmail");

await connect((sock) => {
  sock.ev.on("connection.update", ({ connection }) => {
    if (connection === "open") current = sock;
    if (connection === "close" && current === sock) current = undefined;
  });
  onInbound(sock, async (msg) => {
    // Commands run on their own, right away, after whatever was already typed.
    if (!msg.image && msg.text.trim().startsWith("/")) {
      flush(sock, msg.chatJid);
      void serial(msg.chatJid, () => respond(sock, [msg]));
      return;
    }
    const p = pending.get(msg.chatJid);
    if (p) clearTimeout(p.timer);
    const burst = [...(p?.burst ?? []), msg];
    pending.set(msg.chatJid, { burst, timer: setTimeout(() => flush(sock, msg.chatJid), DEBOUNCE_MS) });
  });
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log.info("shutting down");
    process.exit(0);
  });
}
