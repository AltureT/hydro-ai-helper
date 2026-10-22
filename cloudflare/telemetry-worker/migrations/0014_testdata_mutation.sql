ALTER TABLE testdata_runs ADD COLUMN mutation_gate TEXT
  CHECK (mutation_gate IS NULL OR mutation_gate IN ('off', 'observe', 'enforce'));
ALTER TABLE testdata_runs ADD COLUMN mutation_status TEXT
  CHECK (mutation_status IS NULL OR mutation_status IN ('completed', 'partial', 'skipped'));
ALTER TABLE testdata_runs ADD COLUMN mutation_generated INTEGER
  CHECK (mutation_generated IS NULL OR mutation_generated BETWEEN 0 AND 20);
ALTER TABLE testdata_runs ADD COLUMN mutation_historical INTEGER
  CHECK (mutation_historical IS NULL OR mutation_historical BETWEEN 0 AND 20);
ALTER TABLE testdata_runs ADD COLUMN mutation_viable INTEGER
  CHECK (mutation_viable IS NULL OR mutation_viable BETWEEN 0 AND 20);
ALTER TABLE testdata_runs ADD COLUMN mutation_killed INTEGER
  CHECK (mutation_killed IS NULL OR mutation_killed BETWEEN 0 AND 20);
ALTER TABLE testdata_runs ADD COLUMN mutation_survived INTEGER
  CHECK (mutation_survived IS NULL OR mutation_survived BETWEEN 0 AND 20);
ALTER TABLE testdata_runs ADD COLUMN mutation_score REAL
  CHECK (mutation_score IS NULL OR mutation_score BETWEEN 0.0 AND 1.0);
ALTER TABLE testdata_runs ADD COLUMN mutation_operators TEXT
  CHECK (mutation_operators IS NULL OR length(mutation_operators) <= 1024);
