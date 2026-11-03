import { db } from "./index.js";

export type Todo = { id: number; title: string; due_at: string | null; done_at: string | null };

const insert = db.prepare("INSERT INTO todos (user_id, title, due_at) VALUES (?, ?, ?)");
const open = db.prepare<[string], Todo>(`
  SELECT id, title, due_at, done_at FROM todos WHERE user_id = ? AND done_at IS NULL
  ORDER BY due_at IS NULL, due_at, id
`);
// A done to-do is deleted; nothing lists finished ones. (done_at only exists on old rows.)
const markDone = db.prepare("DELETE FROM todos WHERE id = ? AND user_id = ? AND done_at IS NULL");
db.exec("DELETE FROM todos WHERE done_at IS NOT NULL");

export function addTodo(userId: string, title: string, dueAt?: string): number {
  return Number(insert.run(userId, title, dueAt ?? null).lastInsertRowid);
}

export function openTodos(userId: string): Todo[] {
  return open.all(userId);
}

/** Completes by id, or by a case-insensitive title match when it picks exactly one to-do. */
export function completeTodo(userId: string, idOrTitle: number | string): Todo | "ambiguous" | undefined {
  const todos = openTodos(userId);
  const matches =
    typeof idOrTitle === "number"
      ? todos.filter((t) => t.id === idOrTitle)
      : todos.filter((t) => t.title.toLowerCase().includes(idOrTitle.toLowerCase().trim()));
  if (matches.length > 1) return "ambiguous";
  const todo = matches[0];
  if (todo) markDone.run(todo.id, userId);
  return todo;
}
