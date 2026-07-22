-- Migration 0009: Per-scenario model outcome telemetry
--
-- Failure reports already carry the model used, but successful requests did not.
-- This table stores daily completed-request counters so the dashboard can compare
-- model success rates without inferring capability from failures alone.

CREATE TABLE IF NOT EXISTS plugin_model_daily (
  instance_id TEXT NOT NULL,
  scenario TEXT NOT NULL,
  model_name TEXT NOT NULL,
  date TEXT NOT NULL,
  attempts INTEGER DEFAULT 0,
  successes INTEGER DEFAULT 0,
  version TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (instance_id, scenario, model_name, date)
);

CREATE INDEX IF NOT EXISTS idx_model_daily_scenario_date
  ON plugin_model_daily(scenario, date);
CREATE INDEX IF NOT EXISTS idx_model_daily_model_date
  ON plugin_model_daily(model_name, date);
