CREATE TABLE IF NOT EXISTS plugin_stats (
  instance_id TEXT PRIMARY KEY,
  event TEXT,
  version TEXT,
  installed_at TEXT,
  first_used_at TEXT,
  last_report_at TEXT,
  active_users_7d INTEGER,
  total_conversations INTEGER,
  last_used_at TEXT,
  domain_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_plugin_stats_last_report_at ON plugin_stats(last_report_at);
CREATE INDEX IF NOT EXISTS idx_plugin_stats_version ON plugin_stats(version);
