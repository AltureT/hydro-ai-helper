-- Incremental Task 4 index for databases that already applied 0010.
-- IF NOT EXISTS keeps local and D1 migration replays idempotent.
CREATE INDEX IF NOT EXISTS idx_testdata_runs_model_role ON testdata_runs(model_role);
