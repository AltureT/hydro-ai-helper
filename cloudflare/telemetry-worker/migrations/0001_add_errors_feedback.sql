-- Migration 0001: Add error reporting and feedback tables
-- Apply with: wrangler d1 migrations apply <db-name>

CREATE TABLE IF NOT EXISTS plugin_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT NOT NULL,
  version TEXT,
  domain_hash TEXT,
  error_type TEXT NOT NULL,
  category TEXT NOT NULL,
  message TEXT,
  http_status INTEGER,
  count INTEGER DEFAULT 1,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  stack_fingerprint TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_errors_instance ON plugin_errors(instance_id);
CREATE INDEX IF NOT EXISTS idx_errors_fingerprint ON plugin_errors(stack_fingerprint);
CREATE INDEX IF NOT EXISTS idx_errors_received ON plugin_errors(received_at);

CREATE TABLE IF NOT EXISTS plugin_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT NOT NULL,
  version TEXT,
  domain_hash TEXT,
  type TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT,
  contact_email TEXT,
  environment_info TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_feedback_received ON plugin_feedback(received_at);
