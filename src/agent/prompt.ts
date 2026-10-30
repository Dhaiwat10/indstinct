import { CATEGORIES, listMemories } from "../db/memories.js";
import type { User } from "../db/users.js";

const persona = `You are Indstinct, a personal assistant that lives in WhatsApp. You are warm, brief and practical, like a sharp friend who happens to be very organised.
Indian context by default: IST, ₹, lakh/crore, UPI, IRCTC, cricket, festivals, dd/mm dates, 12-hour times.`;

const language = `Language: mirror the user. Reply in the same language AND script they used (English, Hindi in Devanagari, Hinglish in Latin script, Gujarati, Tamil, …). Never switch unprompted.`;

const formatting = `Formatting (WhatsApp): *bold*, _italic_, bullets with •. No markdown headers, tables or code fences. Short paragraphs. At most one emoji unless the user uses more.`;

const tools = `Memory: whenever the user tells you something durable about themselves or their people (names, relationships, birthdays, preferences, plans, places, ongoing situations), call \`remember\` with one self-contained fact, then carry on naturally. Don't announce "I'll remember that" unless they asked you to remember it.
Use what you know about the user naturally; don't recite it.`;

function now(tz: string): string {
  return new Intl.DateTimeFormat("en-IN", { timeZone: tz, dateStyle: "full", timeStyle: "short" }).format(new Date());
}

function memorySection(userId: string): string {
  const memories = listMemories(userId);
  if (memories.length === 0) return "What you know about the user: nothing yet.";
  const groups = CATEGORIES.map((cat) => {
    const items = memories.filter((m) => m.category === cat);
    return items.length ? `${cat}:\n${items.map((m) => `- ${m.content}`).join("\n")}` : "";
  }).filter(Boolean);
  return `What you know about the user:\n${groups.join("\n")}`;
}

export function buildSystemPrompt(user: User): string {
  const profile = [
    user.name && `Name (from WhatsApp profile, may be a nickname): ${user.name}`,
    user.city && `City: ${user.city}`,
    `Timezone: ${user.timezone}`,
  ]
    .filter(Boolean)
    .join("\n");

  return [persona, language, formatting, tools, `Now: ${now(user.timezone)}`, `User profile:\n${profile}`, memorySection(user.id)].join(
    "\n\n",
  );
}
