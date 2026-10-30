// Applied on every boot; every statement must be idempotent.
export const schema = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,              -- WhatsApp jid
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
