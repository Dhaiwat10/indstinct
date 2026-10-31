// Building outgoing messages and flattening incoming ones. Gmail hands us base64url MIME; we
// never store any of it, we just turn it into text for the model.

export type Header = { name: string; value: string };
export type Part = { mimeType?: string; filename?: string; headers?: Header[]; body?: { data?: string; size?: number; attachmentId?: string }; parts?: Part[] };

export const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");
export const fromB64url = (s: string) => Buffer.from(s, "base64url");

export function header(headers: Header[] | undefined, name: string): string | undefined {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

/** RFC 2047 for non-ASCII header values (Hindi subjects, names with diacritics). */
function encodeWord(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

/** Strips CR/LF so a model-supplied value can't inject extra headers. */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

export type Outgoing = {
  from: string;
  to: string;
  cc?: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
};

/** Plain-text UTF-8 message as base64url, ready for messages.send / drafts.create. */
export function buildRaw(m: Outgoing): string {
  const lines = [
    `From: ${oneLine(m.from)}`,
    `To: ${oneLine(m.to)}`,
    m.cc && `Cc: ${oneLine(m.cc)}`,
    `Subject: ${encodeWord(oneLine(m.subject))}`,
    m.inReplyTo && `In-Reply-To: ${oneLine(m.inReplyTo)}`,
    m.references && `References: ${oneLine(m.references)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(m.body, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n"),
  ].filter((l): l is string => typeof l === "string");
  return b64url(lines.join("\r\n"));
}

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", mdash: "—", ndash: "–", copy: "©" };

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<a\s[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, text: string) => {
      const t = text.replace(/<[^>]+>/g, "").trim();
      return t && t !== href && !/^https?:\/\//.test(t) ? `${t} (${href})` : href;
    })
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") return String.fromCodePoint(Number.parseInt(e[1]?.toLowerCase() === "x" ? e.slice(2) : e.slice(1), e[1]?.toLowerCase() === "x" ? 16 : 10)) || m;
      return entities[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t ]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type Attachment = { filename: string; mimeType: string; size: number; attachmentId: string };

/** Walks the MIME tree: best text body (plain preferred, else html→text) plus named attachments. */
export function flatten(payload: Part | undefined): { text: string; attachments: Attachment[] } {
  let plain = "";
  let html = "";
  const attachments: Attachment[] = [];
  const walk = (p: Part | undefined) => {
    if (!p) return;
    const type = (p.mimeType ?? "").toLowerCase();
    if (p.filename && p.body?.attachmentId) {
      attachments.push({ filename: p.filename, mimeType: type || "application/octet-stream", size: p.body.size ?? 0, attachmentId: p.body.attachmentId });
    } else if (p.body?.data) {
      const data = fromB64url(p.body.data).toString("utf8");
      if (type === "text/plain") plain += (plain ? "\n" : "") + data;
      else if (type === "text/html") html += data;
    }
    p.parts?.forEach(walk);
  };
  walk(payload);
  const text = plain.trim() || htmlToText(html);
  return { text: stripQuoted(text), attachments };
}

/** Drops quoted replies and signatures so a thread doesn't repeat itself N times. */
function stripQuoted(text: string): string {
  const lines = text.split("\n");
  const cut = lines.findIndex(
    (l, i) =>
      i > 0 &&
      (/^On .+wrote:$/.test(l.trim()) || /^-{2,}\s*Original Message\s*-{2,}$/i.test(l.trim()) || /^From: .+/.test(l) && /^Sent: |^Date: /.test(lines[i + 1] ?? "") || l.trim() === "-- "),
  );
  const kept = cut > 0 ? lines.slice(0, cut) : lines;
  return kept.filter((l) => !l.startsWith(">")).join("\n").trim();
}

/** "Riya Sharma <riya@x.com>" → "Riya Sharma"; "riya@x.com" → "riya@x.com". */
export function displayName(addr: string | undefined): string {
  if (!addr) return "unknown";
  const m = addr.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  return (m?.[1]?.trim() || m?.[2] || addr).trim();
}

export function addressOf(addr: string | undefined): string {
  return addr?.match(/<([^>]+)>/)?.[1]?.toLowerCase() ?? addr?.trim().toLowerCase() ?? "";
}
