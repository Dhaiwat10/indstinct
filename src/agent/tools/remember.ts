import { tool } from "ai";
import { z } from "zod";
import { CATEGORIES, remember as saveMemory } from "../../db/memories.js";
import type { User } from "../../db/users.js";

export const remember = (user: User) =>
  tool({
    description:
      "Save one durable fact about the user or someone in their life, written as a self-contained sentence using the user's name or \"the user\", never he/she unless they told you their pronouns (e.g. \"The user's sister Priya lives in Pune\"). Updates an existing memory if it overlaps.",
    inputSchema: z.object({
      fact: z.string().min(3).describe("The fact, as a short standalone sentence"),
      category: z.enum(CATEGORIES),
    }),
    execute: async ({ fact, category }) => {
      const { updated } = saveMemory(user.id, fact, category);
      return updated ? "updated existing memory" : "saved";
    },
  });
