// Applied on every boot; every statement must be idempotent.
export const schema = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,              -- phone jid (91…@s.whatsapp.net) when known, else chat jid
  chat_jid TEXT,                    -- jid to send to (may be a @lid)
  phone TEXT,
  name TEXT,
  city TEXT,
  language TEXT NOT NULL DEFAULT 'auto',
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  onboarded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('user','assistant','tool','system')),
  content TEXT,
  tool_calls TEXT,                  -- JSON
  tool_call_id TEXT,
  wa_message_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS messages_user ON messages(user_id, id);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('person','preference','fact','event','other')),
  source TEXT NOT NULL DEFAULT 'explicit' CHECK (source IN ('explicit','inferred')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  archived_at TEXT
);
CREATE INDEX IF NOT EXISTS memories_user ON memories(user_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  notes TEXT,
  due_at TEXT,                      -- UTC ISO
  done_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS todos_open ON todos(user_id) WHERE done_at IS NULL;

CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('reminder','cron')),
  cron_expr TEXT,
  payload_kind TEXT NOT NULL CHECK (payload_kind IN ('text','agent')),
  payload TEXT NOT NULL,            -- reminder text, or the prompt a cron run executes
  description TEXT NOT NULL,
  last_run_at TEXT,
  next_run_at TEXT NOT NULL,        -- UTC ISO
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS schedules_due ON schedules(next_run_at) WHERE active = 1;

CREATE TABLE IF NOT EXISTS inference_log (
  id INTEGER PRIMARY KEY,
  user_id TEXT,
  message_id INTEGER,
  completion_id TEXT,
  model TEXT,
  request_sha256 TEXT NOT NULL,
  response_sha256 TEXT NOT NULL,
  request_raw BLOB NOT NULL,        -- exact bytes sent; NEAR AI signs their hash
  response_raw BLOB NOT NULL,       -- exact bytes received
  signature TEXT,                   -- JSON, cached /v1/signature result
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS inference_log_completion ON inference_log(completion_id);
`;

/** Columns added after a table first shipped: [table, column, definition]. */
export const addedColumns: [string, string, string][] = [
  ["users", "chat_jid", "TEXT"],
  // 'agent' for calls that write the reply, 'extract' for background memory extraction.
  ["inference_log", "purpose", "TEXT NOT NULL DEFAULT 'agent'"],
];
