import "./db/index.js";
import { runAgent } from "./agent/run.js";
import { handleCommand } from "./commands.js";
import { upsertUser } from "./db/users.js";
import { log } from "./log.js";
import { onInbound } from "./wa/inbound.js";
import { sendText, typing } from "./wa/outbound.js";
import { connect } from "./wa/socket.js";

// One turn at a time per user, so quick follow-ups see the previous reply in history.
const queues = new Map<string, Promise<void>>();
function serial(key: string, job: () => Promise<void>): Promise<void> {
  const next = (queues.get(key) ?? Promise.resolve()).then(job, job);
  queues.set(key, next);
  void next.finally(() => queues.get(key) === next && queues.delete(key));
  return next;
}

await connect((sock) => {
  onInbound(sock, (msg) =>
    serial(msg.chatJid, async () => {
      const user = upsertUser(msg.chatJid, msg.phone, msg.pushName);
      log.info({ user: user.id, text: msg.text }, "inbound");
      await typing(sock, msg.chatJid, true);
      try {
        const reply = (await handleCommand(user, msg.text)) ?? (await runAgent(user, msg.text, msg.waMessageId));
        for (const part of [reply].flat()) await sendText(sock, msg.chatJid, part);
      } catch (err) {
        log.error({ err, user: user.id }, "turn failed");
        await sendText(sock, msg.chatJid, "Sorry, something went wrong on my side. Try again in a moment?");
      } finally {
        await typing(sock, msg.chatJid, false);
      }
    }),
  );
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log.info("shutting down");
    process.exit(0);
  });
}
