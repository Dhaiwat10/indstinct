import type { WASocket } from "baileys";
import "./db/index.js";
import { runAgent } from "./agent/run.js";
import { handleCommand } from "./commands.js";
import { upsertUser } from "./db/users.js";
import { log } from "./log.js";
import { onInbound, type Inbound } from "./wa/inbound.js";
import { sendText, typing } from "./wa/outbound.js";
import { connect } from "./wa/socket.js";

/** People send three short messages in a row; wait this long after the last one and reply once. */
const DEBOUNCE_MS = 2500;

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
  log.info({ user: user.id, text, images: images.length, messages: burst.length }, "inbound");
  await typing(sock, last.chatJid, true);
  try {
    const reply =
      (images.length ? undefined : await handleCommand(user, text)) ??
      (await runAgent(user, { text, images, waMessageId: last.waMessageId }));
    for (const part of [reply].flat()) await sendText(sock, last.chatJid, part);
  } catch (err) {
    log.error({ err, user: user.id }, "turn failed");
    await sendText(sock, last.chatJid, "Sorry, something went wrong on my side. Try again in a moment?");
  } finally {
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

await connect((sock) => {
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
