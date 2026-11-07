import type { User } from "./db/users.js";

/**
 * A chat turn that runs this long is stuck or unusually heavy; say so once. Real long jobs go to
 * background tasks, which tell the user up front, so a quick reply never gets a "wait" message.
 */
export const SLOW_NOTICE_MS = 5 * 60_000;

const notices = {
  english: "Still on it, this one's taking a while ⏳",
  hindi: "अभी भी लगा हूँ, इसमें थोड़ा समय लग रहा है ⏳",
  hinglish: "Abhi bhi laga hoon, thoda time lag raha hai ⏳",
};

const devanagari = /[ऀ-ॿ]/;

/**
 * The one interim message, in the language the user's reply would use: their saved language
 * if they set one (any language we have no line for gets English), otherwise the message's.
 * A spoken Hindi note comes back from Whisper in Devanagari, but people who speak Hindi mostly
 * type Hinglish, so voice gets the Hinglish line, as replies to voice notes do.
 */
export function slowNotice(user: Pick<User, "language">, text: string, voice: boolean): string {
  const saved = user.language.trim().toLowerCase();
  if (saved && saved !== "auto") {
    if (saved.includes("hinglish")) return notices.hinglish;
    if (saved.includes("hindi")) return notices.hindi;
    return notices.english;
  }
  if (!devanagari.test(text)) return notices.english;
  return voice ? notices.hinglish : notices.hindi;
}
