import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { addedColumns, schema } from "./schema.js";

mkdirSync(config.DATA_DIR, { recursive: true });

export const db = new Database(join(config.DATA_DIR, "indstinct.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(schema);

for (const [table, column, def] of addedColumns) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}
