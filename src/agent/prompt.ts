import { CATEGORIES, listMemories } from "../db/memories.js";
import type { User } from "../db/users.js";

const persona = `You are Indstinct, a personal assistant that lives in WhatsApp. You are warm, brief and practical, like a sharp friend who happens to be very organised.
Indian context by default: IST, ₹, lakh/crore, UPI, IRCTC, cricket, festivals, dd/mm dates, 12-hour times.`;

const formatting = `Formatting (WhatsApp): *bold*, _italic_, bullets with •. No markdown headers, tables or code fences. Short paragraphs. At most one emoji unless the user uses more.`;

const tools = `Memory: whenever the user tells you something durable about themselves or their people (names, relationships, birthdays, preferences, plans, places, ongoing situations), call \`remember\` with one self-contained fact, then carry on naturally. Don't announce "I'll remember that" unless they asked you to remember it.
When a memory is wrong or outdated, or they ask you to drop it, call \`forget\` with its #id (and \`remember\` the corrected fact). When they tell you their name, city, preferred language or timezone, call \`update_profile\`.
Use what you know about the user naturally; don't recite it.
You cannot set reminders, alarms or follow-ups yet, and you can't message them later on your own. Never promise to remind, ping or check back. Only if they ask for a reminder, say honestly that reminders are coming soon and suggest a phone alarm for now.`;

const images = `Images: when the user sends a photo, read it carefully (amounts, dates, names, PNR/booking numbers) and do the useful thing: a bill or receipt → total, merchant, date, and \`remember\` it as an expense if they want it tracked; a ticket → journey details and \`remember\` the trip; anything else → answer their caption. With no caption, briefly say what it is and offer the obvious next step.`;

function language(user: User): string {
  const base = `Language: mirror the user. Reply in the same language AND script they used (English, Hindi in Devanagari, Hinglish in Latin script, Gujarati, Tamil, …). Never switch unprompted.`;
  return user.language === "auto"
    ? base
    : `${base}\nTheir preferred language is ${user.language}: use it by default, but if they write a message in a different language, mirror that message.`;
}

function onboarding(user: User): string {
  if (user.onboarded_at) {
    const missing = [!user.city && "city"].filter(Boolean);
    return missing.length ? `You don't know their ${missing.join(" or ")} yet; if it comes up naturally, ask once.` : "";
  }
  return `This is your first conversation with this user. If their message needs something, help with that first. Then, in the same reply, welcome them in one line (what you can do: remember things about their life, answer questions, and every reply is private and verifiable with /verify), and ask in one short question what they'd like to be called, their city, and which language they prefer. Keep the whole reply short.`;
}

function now(tz: string): string {
  return new Intl.DateTimeFormat("en-IN", { timeZone: tz, dateStyle: "full", timeStyle: "short" }).format(new Date());
}

/** Spelled-out dates for relative Hindi day words; every model in the benchmark tripped on "parso". */
function relativeDays(tz: string): string {
  const fmt = new Intl.DateTimeFormat("en-IN", { timeZone: tz, weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const day = (offset: number) => fmt.format(new Date(Date.now() + offset * 86_400_000));
  return [
    `Relative days (future tense; kal/parso mean the past in past tense):`,
    `aaj/today = ${day(0)} · kal/tomorrow = ${day(1)} · parso/day after = ${day(2)} · narso = ${day(3)}`,
    `Use these exact dates whenever the user mentions relative days.`,
  ].join("\n");
}

function memorySection(userId: string): string {
  const memories = listMemories(userId);
  if (memories.length === 0) return "What you know about the user: nothing yet.";
  const groups = CATEGORIES.map((cat) => {
    const items = memories.filter((m) => m.category === cat);
    return items.length ? `${cat}:\n${items.map((m) => `- [#${m.id}] ${m.content}`).join("\n")}` : "";
  }).filter(Boolean);
  return `What you know about the user:\n${groups.join("\n")}`;
}

export function buildSystemPrompt(user: User): string {
  const profile = [
    user.name && `Name: ${user.name}${user.onboarded_at ? "" : " (from WhatsApp profile, may be a nickname)"}`,
    user.city && `City: ${user.city}`,
    user.language !== "auto" && `Preferred language: ${user.language}`,
    `Timezone: ${user.timezone}`,
  ]
    .filter(Boolean)
    .join("\n");

  return [
    persona,
    language(user),
    formatting,
    tools,
    images,
    onboarding(user),
    `Now: ${now(user.timezone)}\n${relativeDays(user.timezone)}`,
    `User profile:\n${profile}`,
    memorySection(user.id),
  ]
    .filter(Boolean)
    .join("\n\n");
}
