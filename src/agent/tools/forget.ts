import { tool } from "ai";
import { z } from "zod";
import { forget as archive } from "../../db/memories.js";
import type { User } from "../../db/users.js";

export const forget = (user: User) =>
  tool({
    description:
      "Forget memories that are wrong, outdated or that the user asks you to drop. Pass the #ids shown in your memory list. To correct a fact, forget the old one and remember the new one.",
    inputSchema: z.object({ ids: z.array(z.number().int()).min(1) }),
    execute: async ({ ids }) => {
      const n = archive(user.id, ids);
      return n ? `forgot ${n}` : "no matching memories";
    },
  });
