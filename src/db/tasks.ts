import { db } from "./index.js";

export type TaskStatus = "running" | "waiting" | "done" | "failed" | "cancelled" | "interrupted";
export type Question = { kind: "choice" | "approval" | "otp" | "info"; text: string; options?: string[] };
export type Task = {
  id: number;
  user_id: string;
  status: TaskStatus;
  goal: string;
  details: string | null;
  question: Question | null;
  step_log: string;
  result: string | null;
};

type Row = Omit<Task, "question"> & { question: string | null };
const parse = (r: Row | undefined): Task | undefined => r && { ...r, question: r.question ? (JSON.parse(r.question) as Question) : null };

const insert = db.prepare("INSERT INTO tasks (user_id, status, goal, details) VALUES (?, 'running', ?, ?)");
const byId = db.prepare<[number], Row>("SELECT * FROM tasks WHERE id = ?");
const open = db.prepare<[string], Row>("SELECT * FROM tasks WHERE user_id = ? AND status IN ('running','waiting') ORDER BY id DESC LIMIT 1");
const setStatus = db.prepare("UPDATE tasks SET status = ?, question = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?");
const finish = db.prepare(
  "UPDATE tasks SET status = ?, result = ?, details = NULL, question = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
);
const log = db.prepare("UPDATE tasks SET step_log = substr(step_log || ? || char(10), -4000) WHERE id = ?");
const interrupt = db.prepare<[], Row>(
  "UPDATE tasks SET status = 'interrupted', details = NULL, question = NULL WHERE status IN ('running','waiting') RETURNING *",
);

export const createTask = (userId: string, goal: string, details: string): number => Number(insert.run(userId, goal, details).lastInsertRowid);
export const getTask = (id: number): Task | undefined => parse(byId.get(id));
/** The user's running or waiting task, if any. One at a time per user. */
export const openTask = (userId: string): Task | undefined => parse(open.get(userId));
export const markWaiting = (id: number, q: Question): void => void setStatus.run("waiting", JSON.stringify(q), id);
export const markRunning = (id: number): void => void setStatus.run("running", null, id);
export const endTask = (id: number, status: "done" | "failed" | "cancelled", result: string): void => void finish.run(status, result, id);
export const logStep = (id: number, line: string): void => void log.run(line, id);
/** On boot: tasks that were mid-flight when the process stopped can't continue. */
export const interruptAll = (): Task[] => interrupt.all().map((r) => parse(r)!);
