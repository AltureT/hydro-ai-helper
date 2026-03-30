-- Migration 0002: Add enhanced heartbeat columns to plugin_stats
-- These columns are nullable/defaulted so existing rows are unaffected.
-- Apply with: wrangler d1 migrations apply <db-name>

ALTER TABLE plugin_stats ADD COLUMN error_count_24h INTEGER DEFAULT 0;
ALTER TABLE plugin_stats ADD COLUMN api_success_count_24h INTEGER DEFAULT 0;
ALTER TABLE plugin_stats ADD COLUMN api_failure_count_24h INTEGER DEFAULT 0;
ALTER TABLE plugin_stats ADD COLUMN avg_latency_ms_24h REAL DEFAULT 0;
ALTER TABLE plugin_stats ADD COLUMN active_endpoint_count INTEGER DEFAULT 0;
ALTER TABLE plugin_stats ADD COLUMN node_version TEXT;
ALTER TABLE plugin_stats ADD COLUMN os_platform TEXT;
ALTER TABLE plugin_stats ADD COLUMN features TEXT;
