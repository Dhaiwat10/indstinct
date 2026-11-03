import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { addedColumns, droppedColumns, schema } from "./schema.js";

mkdirSync(config.DATA_DIR, { recursive: true });

export const db = new Database(join(config.DATA_DIR, "indstinct.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
// Deleted rows are overwritten on disk, not just unlinked, so deleting really removes them.
db.pragma("secure_delete = ON");
db.exec(schema);

for (const [table, column, def] of addedColumns) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}

let dropped = false;
for (const [table, column] of droppedColumns) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    dropped = true;
  }
}
// DROP COLUMN leaves the old values in free pages; rebuilding the file removes them.
if (dropped) db.exec("VACUUM");
