import { tool } from "ai";
import { z } from "zod";
import { addTodo as add, completeTodo as complete, openTodos } from "../../db/todos.js";
import type { User } from "../../db/users.js";
import { formatWhen, parseAt } from "../../scheduler/time.js";

export const addTodo = (user: User) =>
  tool({
    description:
      "Add one item to the user's to-do list (call once per item). due_at_iso is optional, ISO 8601 with the user's UTC offset. A to-do doesn't notify; use set_reminder if they want to be pinged.",
    inputSchema: z.object({ title: z.string().min(1), due_at_iso: z.string().optional() }),
    execute: async ({ title, due_at_iso }) => {
      const due = due_at_iso ? parseAt(due_at_iso) : undefined;
      if (typeof due === "string") return `error: ${due}`;
      const id = add(user.id, title, due?.toISOString());
      return `to-do #${id} added${due ? `, due ${formatWhen(due, user.timezone)}` : ""}`;
    },
  });

export const completeTodo = (user: User) =>
  tool({
    description: "Mark a to-do done, by #id or by a few words of its title.",
    inputSchema: z.object({ todo: z.union([z.number().int(), z.string().min(1)]) }),
    execute: async ({ todo }) => {
      const r = complete(user.id, todo);
      if (r === "ambiguous") return "several to-dos match; use the #id";
      return r ? `done: #${r.id} ${r.title}` : "no matching open to-do";
    },
  });

export const listTodos = (user: User) =>
  tool({
    description: "List the user's open to-dos with ids.",
    inputSchema: z.object({}),
    execute: async () => {
      const list = openTodos(user.id);
      return list.length
        ? list.map((t) => `#${t.id} ${t.title}${t.due_at ? ` (due ${formatWhen(new Date(t.due_at), user.timezone)})` : ""}`).join("\n")
        : "no open to-dos";
    },
  });
