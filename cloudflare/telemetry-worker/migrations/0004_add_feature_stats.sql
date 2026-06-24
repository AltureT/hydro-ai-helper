-- Migration 0004: Per-feature health counters
-- Detects whole-feature outages that the aggregate error rate hides
-- ("error rate 0% but teaching analysis 100% broken"). One upserted row per
-- (instance_id, feature) holding the latest 24h snapshot from the heartbeat.
-- Apply with: wrangler d1 migrations apply <db-name>

CREATE TABLE IF NOT EXISTS plugin_feature_stats (
  instance_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  attempts INTEGER DEFAULT 0,
  successes INTEGER DEFAULT 0,
  last_success_at TEXT,
  version TEXT,
  report_at TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (instance_id, feature)
);

CREATE INDEX IF NOT EXISTS idx_feature_stats_feature ON plugin_feature_stats(feature);
CREATE INDEX IF NOT EXISTS idx_feature_stats_report ON plugin_feature_stats(report_at);
