import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** The bot fetches pages from our server, so it must never reach localhost or the private network. */
export function blockedHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (isIP(h) === 4) {
    const [a, b] = h.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(h) === 6) return h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80") || h.startsWith("::ffff:");
  return false;
}

/** Also resolves the name, so a public hostname pointing at a private address is refused too. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (!/^https?:$/.test(url.protocol)) throw new Error("only http(s) URLs");
  if (blockedHost(url.hostname)) throw new Error("that address is not allowed");
  if (!isIP(url.hostname.replace(/^\[|\]$/g, ""))) {
    const addrs = await lookup(url.hostname, { all: true }).catch(() => []);
    if (!addrs.length) throw new Error(`can't resolve ${url.hostname}`);
    if (addrs.some((a) => blockedHost(a.address))) throw new Error("that address is not allowed");
  }
  return url;
}
