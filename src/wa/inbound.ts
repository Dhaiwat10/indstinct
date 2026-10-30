import {
  downloadMediaMessage,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  isPnUser,
  type WAMessage,
  type WASocket,
} from "baileys";
import { config } from "../config.js";
import { log } from "../log.js";

export type Inbound = {
  /** Jid to reply to (may be a @lid). */
  chatJid: string;
  /** Sender's phone number, digits only, when WhatsApp exposes it. */
  phone?: string;
  pushName?: string;
  /** Message text, or an image's caption ("" if none). */
  text: string;
  image?: { data: Buffer; mediaType: string };
  waMessageId?: string;
  raw: WAMessage;
};

function phoneOf(msg: WAMessage): string | undefined {
  const { remoteJid, remoteJidAlt } = msg.key;
  const pn = isPnUser(remoteJid ?? undefined) ? remoteJid : isPnUser(remoteJidAlt ?? undefined) ? remoteJidAlt : undefined;
  return pn?.split("@")[0]?.split(":")[0];
}

function textOf(msg: WAMessage): string | undefined {
  const m = msg.message;
  return m?.conversation ?? m?.extendedTextMessage?.text ?? m?.imageMessage?.caption ?? undefined;
}

function allowed(phone: string | undefined): boolean {
  if (config.ALLOWED_NUMBERS.length === 0) return true;
  return !!phone && config.ALLOWED_NUMBERS.includes(phone);
}

/** Calls `handler` for each new 1:1 text or image message from an allowlisted sender. */
export function onInbound(sock: WASocket, handler: (msg: Inbound) => Promise<void>): void {
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const raw of messages) {
      const chatJid = raw.key.remoteJid;
      if (!chatJid || raw.key.fromMe) continue;
      if (isJidGroup(chatJid) || isJidBroadcast(chatJid) || isJidNewsletter(chatJid) || isJidStatusBroadcast(chatJid))
        continue;

      const imageMessage = raw.message?.imageMessage;
      const text = textOf(raw) ?? "";
      if (!text && !imageMessage) continue;

      const phone = phoneOf(raw);
      if (!allowed(phone)) {
        log.info({ chatJid, phone }, "ignoring message from non-allowlisted sender");
        continue;
      }

      try {
        const image = imageMessage
          ? { data: await downloadMediaMessage(raw, "buffer", {}), mediaType: imageMessage.mimetype ?? "image/jpeg" }
          : undefined;
        await handler({ chatJid, phone, pushName: raw.pushName ?? undefined, text, image, waMessageId: raw.key.id ?? undefined, raw });
      } catch (err) {
        log.error({ err, chatJid }, "inbound handler failed");
      }
    }
  });
}
