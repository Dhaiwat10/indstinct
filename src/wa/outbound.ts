import type { WASocket } from "baileys";

const MAX_CHUNK = 4000;

/** Splits on paragraph, then line, then hard boundaries to stay under WhatsApp's comfortable length. */
function split(text: string): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > MAX_CHUNK) {
    const window = rest.slice(0, MAX_CHUNK);
    const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"));
    const at = cut > MAX_CHUNK / 2 ? cut : MAX_CHUNK;
    chunks.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export async function sendText(sock: WASocket, jid: string, text: string): Promise<void> {
  for (const chunk of split(text)) await sock.sendMessage(jid, { text: chunk });
}

/** Delivers a file (e.g. an email attachment) as a WhatsApp document. */
export async function sendFile(sock: WASocket, jid: string, data: Buffer, mimetype: string, fileName: string): Promise<void> {
  await sock.sendMessage(jid, { document: data, mimetype, fileName });
}

export async function typing(sock: WASocket, jid: string, on: boolean): Promise<void> {
  await sock.sendPresenceUpdate(on ? "composing" : "paused", jid).catch(() => {});
}
