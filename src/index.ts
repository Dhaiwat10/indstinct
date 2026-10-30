import "./db/index.js";
import { log } from "./log.js";
import { onInbound } from "./wa/inbound.js";
import { sendText } from "./wa/outbound.js";
import { connect } from "./wa/socket.js";

// Day 1, step 1: echo bot. The agent replaces this handler next.
await connect((sock) => {
  onInbound(sock, async (msg) => {
    log.info({ phone: msg.phone, text: msg.text }, "inbound");
    await sendText(sock, msg.chatJid, `echo: ${msg.text}`);
  });
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log.info("shutting down");
    process.exit(0);
  });
}
