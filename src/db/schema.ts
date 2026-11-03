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
  request_sha256 TEXT NOT NULL,     -- of the exact bytes sent; NEAR AI signs both hashes
  response_sha256 TEXT NOT NULL,    -- of the exact bytes received. The bytes themselves are never kept.
  signature TEXT,                   -- JSON, cached /v1/signature result
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS inference_log_completion ON inference_log(completion_id);

CREATE TABLE IF NOT EXISTS gmail_accounts (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  email TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,      -- epoch ms
  alerts INTEGER NOT NULL DEFAULT 0,  -- opt-in: flag important new mail during the day
  watch_cursor INTEGER NOT NULL,    -- epoch ms of the newest inbox message already looked at
  flags_day TEXT,                   -- yyyy-mm-dd the daily flag counter is for
  flags_today INTEGER NOT NULL DEFAULT 0,
  needs_reauth INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Browser tasks: multi-step jobs on websites that run in the background and can stop to ask
-- the user something. Holds as little as possible: details are cleared when a task ends,
-- step_log is one-line action summaries with no page text, files are never stored.
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('running','waiting','done','failed','cancelled','interrupted')),
  goal TEXT NOT NULL,
  details TEXT,                     -- what the site will need; cleared when the task ends
  question TEXT,                    -- JSON {kind, text, options?} while status = 'waiting'
  step_log TEXT NOT NULL DEFAULT '',
  result TEXT,                      -- the final message to the user
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS tasks_user ON tasks(user_id, status);

-- Email the agent has drafted but not sent. Sending needs a later turn than drafting.
CREATE TABLE IF NOT EXISTS email_drafts (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  gmail_draft_id TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  sent_at TEXT
);
`;

/** Columns added after a table first shipped: [table, column, definition]. */
export const addedColumns: [string, string, string][] = [
  ["users", "chat_jid", "TEXT"],
  // 'agent' for calls that write the reply, 'extract' for background memory extraction.
  ["inference_log", "purpose", "TEXT NOT NULL DEFAULT 'agent'"],
];

/** Columns removed after shipping: [table, column]. Dropping them also wipes what they held. */
export const droppedColumns: [string, string][] = [
  // Full prompts and replies; /verify only needs their hashes.
  ["inference_log", "request_raw"],
  ["inference_log", "response_raw"],
];
