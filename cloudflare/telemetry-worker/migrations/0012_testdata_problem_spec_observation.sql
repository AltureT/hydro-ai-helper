-- Migration 0012: bounded, aggregate-only ProblemSpec observe telemetry.
-- No statement, title, problem identifier, evidence quote, expression,
-- uncertainty description, arbitrary metadata, code, input/output, or endpoint.

ALTER TABLE testdata_runs ADD COLUMN spec_schema_version INTEGER
  CHECK (spec_schema_version = 1);
ALTER TABLE testdata_runs ADD COLUMN spec_extraction_succeeded INTEGER
  CHECK (spec_extraction_succeeded IN (0, 1));
ALTER TABLE testdata_runs ADD COLUMN spec_constraint_count INTEGER
  CHECK (spec_constraint_count BETWEEN 0 AND 512);
ALTER TABLE testdata_runs ADD COLUMN spec_invariant_count INTEGER
  CHECK (spec_invariant_count BETWEEN 0 AND 256);
ALTER TABLE testdata_runs ADD COLUMN spec_uncertainty_count INTEGER
  CHECK (spec_uncertainty_count BETWEEN 0 AND 100);
