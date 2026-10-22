-- Migration 0011: bounded, aggregate-only ProblemSpec consensus telemetry.
-- Additive nullable columns preserve existing rows. D1's migration ledger applies
-- each named migration once; replaying from a pre-migration database is safe.
-- No statement, evidence quote, expression, reason, code, input/output, or identity.

ALTER TABLE testdata_runs ADD COLUMN spec_consensus_status TEXT
  CHECK (spec_consensus_status IN ('consensus', 'adjudicated', 'unresolved'));
ALTER TABLE testdata_runs ADD COLUMN spec_conflict_count INTEGER
  CHECK (spec_conflict_count BETWEEN 0 AND 1024);
ALTER TABLE testdata_runs ADD COLUMN spec_unresolved_conflict_count INTEGER
  CHECK (spec_unresolved_conflict_count BETWEEN 0 AND 1024);
ALTER TABLE testdata_runs ADD COLUMN spec_roles_used TEXT
  CHECK (length(spec_roles_used) BETWEEN 2 AND 64);
