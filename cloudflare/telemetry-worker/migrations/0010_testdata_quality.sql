-- Migration 0010: privacy-minimized test-data quality lifecycle telemetry.
-- All tables are additive and safe to create repeatedly. No raw statement,
-- code, input/output, error text, user/problem/job identifiers, or filenames.

-- Atomic idempotency ledger shared by every event type. payload_hash is the
-- SHA-256 of the already validated, privacy-bounded event object.
CREATE TABLE IF NOT EXISTS testdata_event_slots (
  event_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'run_started', 'stage_completed', 'stage_failed', 'run_completed', 'teacher_outcome'
  )),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (event_id),
  UNIQUE (instance_id, run_id, sequence)
);

CREATE TABLE IF NOT EXISTS testdata_runs (
  instance_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  started_event_id TEXT UNIQUE,
  completed_event_id TEXT UNIQUE,
  plugin_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  generation_mode TEXT CHECK (generation_mode IN ('direct', 'sandbox')),
  reliability_mode TEXT CHECK (reliability_mode IN ('legacy', 'observe', 'enforce')),
  risk_tier TEXT CHECK (risk_tier IN ('low', 'medium', 'high', 'blocked')),
  problem_kind TEXT CHECK (problem_kind IN ('traditional', 'function')),
  has_subtasks INTEGER,
  has_custom_checker INTEGER,
  has_samples INTEGER,
  has_stateful_operations INTEGER,
  statement_length_bucket TEXT,
  pipeline_completed INTEGER,
  verified INTEGER,
  would_block INTEGER,
  model_escalated INTEGER,
  stress_generated INTEGER,
  stress_valid INTEGER,
  stress_dropped_invalid INTEGER,
  stress_unique INTEGER,
  stress_compared INTEGER,
  stress_agreed INTEGER,
  template_py_requested INTEGER,
  template_py_verified INTEGER,
  template_java_requested INTEGER,
  template_java_verified INTEGER,
  template_cc_requested INTEGER,
  template_cc_verified INTEGER,
  template_failure_kinds TEXT,
  checker_configured INTEGER,
  checker_read INTEGER,
  checker_compiled INTEGER,
  checker_executed INTEGER,
  checker_infra_failures INTEGER,
  checker_failure_kind TEXT,
  model_role TEXT,
  model_identity_hash TEXT,
  PRIMARY KEY (instance_id, run_id)
);

CREATE TABLE IF NOT EXISTS testdata_stage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  instance_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('stage_completed', 'stage_failed')),
  stage TEXT NOT NULL,
  failure_code TEXT,
  artifact TEXT,
  retry_policy TEXT,
  duration_ms INTEGER,
  attempt INTEGER,
  token_count INTEGER,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (instance_id, run_id, sequence)
);

CREATE TABLE IF NOT EXISTS testdata_teacher_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  instance_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN (
    'accepted_unchanged', 'accepted_edited', 'discarded', 'regenerated'
  )),
  reason TEXT,
  edited_file_count INTEGER,
  changed_file_kinds TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (instance_id, run_id)
);

CREATE INDEX IF NOT EXISTS idx_testdata_runs_completed_at ON testdata_runs(completed_at);
CREATE INDEX IF NOT EXISTS idx_testdata_event_slots_instance_received_at
  ON testdata_event_slots(instance_id, received_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_testdata_event_slots_terminal
  ON testdata_event_slots(instance_id, run_id, event_type)
  WHERE event_type IN ('run_started', 'run_completed', 'teacher_outcome');
CREATE INDEX IF NOT EXISTS idx_testdata_runs_received_at ON testdata_runs(received_at);
CREATE INDEX IF NOT EXISTS idx_testdata_runs_instance_received_at ON testdata_runs(instance_id, received_at);
CREATE INDEX IF NOT EXISTS idx_testdata_runs_plugin_version ON testdata_runs(plugin_version);
CREATE INDEX IF NOT EXISTS idx_testdata_runs_risk_tier ON testdata_runs(risk_tier);
CREATE INDEX IF NOT EXISTS idx_testdata_runs_verified ON testdata_runs(verified);
CREATE INDEX IF NOT EXISTS idx_testdata_runs_would_block ON testdata_runs(would_block);
CREATE INDEX IF NOT EXISTS idx_testdata_stage_received_at ON testdata_stage_events(received_at);
CREATE INDEX IF NOT EXISTS idx_testdata_stage_instance_received_at ON testdata_stage_events(instance_id, received_at);
CREATE INDEX IF NOT EXISTS idx_testdata_stage_failure_code ON testdata_stage_events(failure_code);
CREATE INDEX IF NOT EXISTS idx_testdata_stage_stage ON testdata_stage_events(stage);
CREATE INDEX IF NOT EXISTS idx_testdata_outcome_received_at ON testdata_teacher_outcomes(received_at);
CREATE INDEX IF NOT EXISTS idx_testdata_outcome_instance_received_at ON testdata_teacher_outcomes(instance_id, received_at);
CREATE INDEX IF NOT EXISTS idx_testdata_outcome_outcome ON testdata_teacher_outcomes(outcome);
