import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { schema } from "./schema.js";

mkdirSync(config.DATA_DIR, { recursive: true });

export const db = new Database(join(config.DATA_DIR, "indstinct.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(schema);
