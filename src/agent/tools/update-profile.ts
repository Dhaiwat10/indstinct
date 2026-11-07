import { tool } from "ai";
import { z } from "zod";
import { updateProfile as save, type User } from "../../db/users.js";

const validZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const updateProfile = (user: User) =>
  tool({
    description:
      "Save the user's name, city, preferred language or timezone when they tell you, including instructions like \"only reply in English\". Only pass fields they gave you.",
    inputSchema: z.object({
      name: z.string().optional().describe("What they want to be called"),
      city: z.string().optional(),
      language: z.string().optional().describe('Language to always reply in, e.g. "Hinglish", "Hindi", "English", "Tamil"; "auto" to go back to mirroring whatever they write'),
      timezone: z.string().optional().describe('IANA zone, only if they are outside India, e.g. "Asia/Dubai"'),
    }),
    execute: async (input) => {
      if (input.timezone && !validZone(input.timezone)) return `unknown timezone "${input.timezone}"; use an IANA name`;
      const u = save(user.id, input);
      Object.assign(user, u);
      return "saved";
    },
  });
