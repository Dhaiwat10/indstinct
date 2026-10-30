import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type WASocket,
} from "baileys";
import { join } from "node:path";
import qrcode from "qrcode-terminal";
import { config } from "../config.js";
import { log } from "../log.js";

export type OnSocket = (sock: WASocket) => void;

/**
 * Connects to WhatsApp and keeps reconnecting until logged out. `onSocket` runs for every
 * new socket so handlers get re-attached after a reconnect.
 */
export async function connect(onSocket: OnSocket): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(join(config.DATA_DIR, "auth"));
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    browser: Browsers.macOS("Chrome"),
    logger: log.child({ module: "baileys" }, { level: config.LOG_LEVEL === "trace" ? "trace" : "warn" }),
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", saveCreds);

  let pairingRequested = false;
  // Baileys sometimes stops rotating QRs after the first one; reconnect to force a fresh code.
  let qrStale: NodeJS.Timeout | undefined;
  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr && !config.WA_PAIR_NUMBER) {
      clearTimeout(qrStale);
      qrStale = setTimeout(() => {
        log.info("QR expired, fetching a new one");
        sock.end(undefined);
      }, 25_000);
    }
    if (connection) clearTimeout(qrStale);
    if (qr) {
      if (config.WA_PAIR_NUMBER && !pairingRequested) {
        pairingRequested = true;
        const code = await sock.requestPairingCode(config.WA_PAIR_NUMBER);
        log.info(`Pairing code: ${code}  (WhatsApp → Linked devices → Link with phone number)`);
      } else if (!config.WA_PAIR_NUMBER) {
        qrcode.generate(qr, { small: true });
        log.info("Scan the QR above: WhatsApp → Linked devices → Link a device");
      }
    }
    if (connection === "open") log.info({ me: sock.user?.id }, "WhatsApp connected");
    if (connection === "close") {
      const status = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
        ?.statusCode;
      if (status === DisconnectReason.loggedOut) {
        log.fatal("Logged out of WhatsApp. Delete data/auth and restart to pair again.");
        process.exit(1);
      }
      log.warn({ status }, "WhatsApp connection closed, reconnecting");
      setTimeout(() => connect(onSocket).catch((err) => log.error({ err }, "reconnect failed")), 2000);
    }
  });

  onSocket(sock);
}
