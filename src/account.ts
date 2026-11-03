// `/delete everything`: the user removes all of their data themselves, no email to us needed.
import { db } from "./db/index.js";
import { disconnectGmail } from "./gmail/connect.js";
import { log } from "./log.js";
import { cancelTask } from "./tasks/runner.js";

/** Child tables first: foreign keys point at users. */
const TABLES = ["inference_log", "messages", "memories", "todos", "schedules", "tasks", "email_drafts", "gmail_accounts"] as const;
const wipe = TABLES.map((t) => db.prepare(`DELETE FROM ${t} WHERE user_id = ?`));
const removeUser = db.prepare("DELETE FROM users WHERE id = ?");

/** Revokes Gmail at Google if linked, then deletes every row the user owns, the user row last. */
export async function deleteEverything(userId: string): Promise<void> {
  await cancelTask(userId); // stop a browser task before its rows go
  await disconnectGmail(userId);
  db.transaction(() => {
    for (const stmt of wipe) stmt.run(userId);
    removeUser.run(userId);
  })();
  log.info({ user: userId }, "user deleted all their data");
}
