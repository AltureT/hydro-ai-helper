import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import worker, {
  parseTestdataQualityDays,
  testdataEventFingerprint,
  toSqliteUtcTimestamp,
  validateTestdataQualityEventPayload,
} from './worker.js';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const INSTANCE_ID = '77777777-7777-4777-8777-777777777777';

function event(overrides = {}) {
  return {
    schemaVersion: 1,
    eventId: '22222222-2222-4222-8222-222222222222',
    runId: RUN_ID,
    sequence: 1,
    eventType: 'run_started',
    occurredAt: '2026-08-19T00:00:00.000Z',
    pluginVersion: '3.1.0',
    promptVersion: 'testdata-generation-v1',
    reliabilityMode: 'observe',
    riskTier: 'medium',
    ...overrides,
  };
}

class FakeStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    this.db.bound.push({ sql: this.sql, values });
    return this;
  }

  async first() {
    if (this.sql.includes('testdata_rate_count')) return { event_count: this.db.eventCount };
    return this.db.firstFor(this.sql);
  }

  async all() {
    return { results: this.db.rowsFor(this.sql) };
  }

  async run() {
    this.db.executed.push({ sql: this.sql, values: this.values });
    return { meta: { changes: this.db.changesFor(this.sql) } };
  }
}

class FakeDb {
  constructor({ eventCount = 0, rows = {}, firstRows = {}, changes = {} } = {}) {
    this.eventCount = eventCount;
    this.rows = rows;
    this.firstRows = firstRows;
    this.changes = changes;
    this.executed = [];
    this.bound = [];
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  rowsFor(sql) {
    const marker = Object.keys(this.rows).find(key => sql.includes(key));
    return marker ? this.rows[marker] : [];
  }

  firstFor(sql) {
    const marker = Object.keys(this.firstRows).find(key => sql.includes(key));
    if (!marker) return null;
    const value = this.firstRows[marker];
    return Array.isArray(value) ? (value.shift() ?? null) : value;
  }

  changesFor(sql) {
    const marker = Object.keys(this.changes).find(key => sql.includes(key));
    if (!marker) return 1;
    const value = this.changes[marker];
    return Array.isArray(value) ? (value.shift() ?? 1) : value;
  }

  async batch(statements) {
    if (statements.length === 0) throw new Error('D1 batch requires at least one statement');
    const results = [];
    for (const statement of statements) {
      if (statement.sql.trimStart().startsWith('SELECT')) results.push(await statement.all());
      else results.push(await statement.run());
    }
    return results;
  }
}

function request(path, body, token = 'report-secret') {
  return new Request(`https://stats.example${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('migration creates quality tables plus an atomic event-slot ledger', async () => {
  const sql = await readFile(new URL('./migrations/0010_testdata_quality.sql', import.meta.url), 'utf8');
  for (const table of [
    'testdata_event_slots', 'testdata_runs', 'testdata_stage_events', 'testdata_teacher_outcomes',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(sql, /PRIMARY KEY\s*\(event_id\)/i);
  assert.match(sql, /UNIQUE\s*\(instance_id,\s*run_id,\s*sequence\)/i);
  assert.match(sql, /payload_hash\s+TEXT\s+NOT NULL/i);
  assert.match(sql, /event_id\s+TEXT\s+NOT NULL\s+UNIQUE/i);
  assert.match(sql, /UNIQUE\s*\(instance_id,\s*run_id\)/i);
  for (const field of [
    'completed_at', 'received_at', 'plugin_version', 'failure_code', 'stage', 'risk_tier',
    'verified', 'would_block', 'outcome',
  ]) {
    assert.match(sql, new RegExp(`idx_[^\\n]*${field}`));
  }
  assert.match(sql, /ON testdata_stage_events\(instance_id, received_at\)/);
  assert.match(sql, /ON testdata_teacher_outcomes\(instance_id, received_at\)/);
});

test('model role index is an idempotent incremental migration', async () => {
  const sql = await readFile(
    new URL('./migrations/0011_testdata_model_role_index.sql', import.meta.url),
    'utf8',
  );
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_testdata_runs_model_role/i);
  assert.match(sql, /ON testdata_runs\(model_role\)/i);
});

test('problem spec observation migration adds only bounded aggregate columns', async () => {
  const sql = await readFile(
    new URL('./migrations/0012_testdata_problem_spec_observation.sql', import.meta.url),
    'utf8',
  );
  for (const column of [
    'spec_schema_version', 'spec_extraction_succeeded', 'spec_constraint_count',
    'spec_invariant_count', 'spec_uncertainty_count',
  ]) assert.match(sql, new RegExp(`ADD COLUMN ${column}`));
  for (const forbidden of [
    'statement', 'title', 'problem_id', 'quote', 'expression', 'description', 'metadata',
  ]) assert.doesNotMatch(sql, new RegExp(`ADD COLUMN ${forbidden}`, 'i'));
});

test('spec consensus migration adds only nullable enum, count, and role columns', async () => {
  const sql = await readFile(
    new URL('./migrations/0013_testdata_spec_consensus.sql', import.meta.url),
    'utf8',
  );
  for (const column of [
    'spec_consensus_status', 'spec_conflict_count',
    'spec_unresolved_conflict_count', 'spec_roles_used',
  ]) assert.match(sql, new RegExp(`ADD COLUMN ${column}`));
  assert.match(sql, /consensus.*adjudicated.*unresolved/is);
  for (const forbidden of [
    'statement', 'quote', 'expression', 'reason', 'problem_id', 'metadata',
  ]) assert.doesNotMatch(sql, new RegExp(`ADD COLUMN ${forbidden}`, 'i'));
});

test('mutation migration adds only nullable bounded aggregate columns', async () => {
  const sql = await readFile(
    new URL('./migrations/0014_testdata_mutation.sql', import.meta.url),
    'utf8',
  );
  for (const column of [
    'mutation_gate', 'mutation_status', 'mutation_generated', 'mutation_historical',
    'mutation_viable', 'mutation_killed', 'mutation_survived', 'mutation_score',
    'mutation_operators',
  ]) assert.match(sql, new RegExp(`ADD COLUMN ${column}`));
  for (const forbidden of [
    'statement', 'source', 'record_id', 'problem_id', 'input', 'output', 'position', 'metadata',
  ]) assert.doesNotMatch(sql, new RegExp(`ADD COLUMN ${forbidden}`, 'i'));
});

test('event fingerprints are canonical and change with safe payload content', async () => {
  const first = event();
  const reordered = Object.fromEntries(Object.entries(first).reverse());
  assert.equal(await testdataEventFingerprint(first), await testdataEventFingerprint(reordered));
  assert.notEqual(
    await testdataEventFingerprint(first),
    await testdataEventFingerprint({ ...first, riskTier: 'high' }),
  );
});

test('worker validator accepts the closed contract and rejects privacy injection', () => {
  const completed = event({
    eventType: 'run_completed', pipelineCompleted: true, verified: true, wouldBlock: false,
    specSchemaVersion: 1, specExtractionSucceeded: true,
    specConstraintCount: 12, specInvariantCount: 3, specUncertaintyCount: 1,
    specConsensusStatus: 'adjudicated', specConflictCount: 2,
    specUnresolvedConflictCount: 0,
    specRolesUsed: ['specPrimary', 'specCritic', 'adjudicator'],
  });
  assert.equal(validateTestdataQualityEventPayload(completed).specConstraintCount, 12);
  assert.equal(validateTestdataQualityEventPayload(completed).specConsensusStatus, 'adjudicated');
  for (const [key, value] of [
    ['problemId', 'D3102'], ['title', 'secret'], ['statement', '# secret'],
    ['code', 'print(secret)'], ['input', 'secret'], ['output', 'secret'],
    ['apiKey', 'sk-secret'], ['stderr', 'secret'], ['metadata', { secret: true }],
  ]) {
    assert.throws(() => validateTestdataQualityEventPayload({ ...event(), [key]: value }), /unknown field/i);
  }
});

test('worker validator accepts only complete internally consistent mutation aggregates', () => {
  const completed = event({
    eventType: 'run_completed', pipelineCompleted: true, verified: true, wouldBlock: false,
    mutationGate: 'observe', mutationStatus: 'completed', mutationGenerated: 2,
    mutationHistorical: 1, mutationViable: 3, mutationKilled: 2, mutationSurvived: 1,
    mutationScore: 2 / 3,
    mutationOperators: [
      { id: 'comparison-boundary', viable: 2, killed: 1 },
      { id: 'historical-submission', viable: 1, killed: 1 },
    ],
  });
  assert.equal(validateTestdataQualityEventPayload(completed).mutationKilled, 2);

  for (const patch of [
    { mutationGate: undefined },
    { mutationGenerated: 21 },
    { mutationHistorical: 19 },
    { mutationSurvived: 2 },
    { mutationScore: 0.5 },
    { mutationGate: 'off', mutationStatus: 'skipped' },
    { mutationStatus: 'skipped' },
    {
      mutationGenerated: 0, mutationHistorical: 0, mutationViable: 0,
      mutationKilled: 0, mutationSurvived: 0, mutationScore: undefined,
      mutationOperators: [],
    },
    { mutationOperators: [{ id: 'unknown', viable: 3, killed: 2 }] },
    { mutationOperators: [
      { id: 'comparison-boundary', viable: 2, killed: 1 },
      { id: 'comparison-boundary', viable: 1, killed: 1 },
    ] },
    { mutationOperators: [{
      id: 'comparison-boundary', viable: 3, killed: 2, output: 'private output',
    }] },
  ]) assert.throws(
    () => validateTestdataQualityEventPayload({ ...completed, ...patch }),
    /mutation|field/i,
  );

  assert.throws(() => validateTestdataQualityEventPayload(event({
    mutationGate: 'observe',
  })), /mutation/i);
  assert.equal(validateTestdataQualityEventPayload(event({
    eventType: 'stage_failed', stage: 'mutation_testing',
    failureCode: 'MUTATION_EVIDENCE_UNAVAILABLE', artifact: 'mutation', retryPolicy: 'no-retry',
  })).failureCode, 'MUTATION_EVIDENCE_UNAVAILABLE');
});

test('worker validator rejects invalid UUIDs, bounds, arrays, and enums', () => {
  for (const invalid of [
    event({ runId: 'job-id' }),
    event({ eventId: 'event-id' }),
    event({ sequence: -1 }),
    event({ durationMs: Number.NaN }),
    event({ stressGenerated: 1_000_001 }),
    event({ templateLanguagesRequested: ['py', 'rust'] }),
    event({ templateLanguagesRequested: ['py', 'py'] }),
    event({ riskTier: 'critical' }),
    event({ specConsensusStatus: 'resolved' }),
    event({ specConflictCount: -1 }),
    event({ specUnresolvedConflictCount: 1_025 }),
    event({ specRolesUsed: ['specPrimary', 'oracle'] }),
    event({ specRolesUsed: ['specPrimary', 'specPrimary'] }),
    event({
      eventType: 'run_completed', pipelineCompleted: false, verified: true, wouldBlock: false,
    }),
    event({
      eventType: 'run_completed', pipelineCompleted: false, verified: false, wouldBlock: true,
    }),
    event({
      eventType: 'run_completed', pipelineCompleted: true, verified: true, wouldBlock: false,
      specSchemaVersion: 2, specExtractionSucceeded: false,
    }),
    event({
      eventType: 'run_completed', pipelineCompleted: true, verified: true, wouldBlock: false,
      specSchemaVersion: 1, specExtractionSucceeded: true, specConstraintCount: 513,
      specInvariantCount: 0, specUncertaintyCount: 0,
    }),
    event({
      eventType: 'run_completed', pipelineCompleted: true, verified: true, wouldBlock: false,
      specSchemaVersion: 1, specExtractionSucceeded: true,
    }),
    event({
      eventType: 'run_completed', pipelineCompleted: true, verified: true, wouldBlock: false,
      specSchemaVersion: 1, specExtractionSucceeded: false, specConstraintCount: 0,
    }),
  ]) assert.throws(() => validateTestdataQualityEventPayload(invalid));
});

test('POST /api/testdata-events fail-open accepts and stores bounded consensus fields', async () => {
  const db = new FakeDb();
  const completed = event({
    eventType: 'run_completed', pipelineCompleted: true, verified: true, wouldBlock: false,
    specSchemaVersion: 1, specExtractionSucceeded: true,
    specConstraintCount: 12, specInvariantCount: 3, specUncertaintyCount: 1,
    specConsensusStatus: 'adjudicated', specConflictCount: 2,
    specUnresolvedConflictCount: 0,
    specRolesUsed: ['specPrimary', 'specCritic', 'adjudicator'],
  });
  const response = await worker.fetch(
    request('/api/testdata-events', { instanceId: INSTANCE_ID, events: [completed] }, ''),
    { DB: db },
  );

  assert.equal(response.status, 200);
  const stored = db.executed.find(statement => statement.sql.includes('completed_event_id'));
  for (const column of [
    'spec_consensus_status', 'spec_conflict_count',
    'spec_unresolved_conflict_count', 'spec_roles_used',
  ]) assert.match(stored.sql, new RegExp(column));
  assert.equal(stored.values.includes('adjudicated'), true);
  assert.equal(stored.values.includes(2), true);
  assert.equal(stored.values.includes('["specPrimary","specCritic","adjudicator"]'), true);
});

test('POST /api/testdata-events fail-open stores only mutation aggregates', async () => {
  const db = new FakeDb();
  const completed = event({
    eventType: 'run_completed', pipelineCompleted: true, verified: true, wouldBlock: false,
    mutationGate: 'enforce', mutationStatus: 'completed', mutationGenerated: 2,
    mutationHistorical: 1, mutationViable: 3, mutationKilled: 2, mutationSurvived: 1,
    mutationScore: 2 / 3,
    mutationOperators: [
      { id: 'comparison-boundary', viable: 2, killed: 1 },
      { id: 'historical-submission', viable: 1, killed: 1 },
    ],
  });
  const response = await worker.fetch(
    request('/api/testdata-events', { instanceId: INSTANCE_ID, events: [completed] }, ''),
    { DB: db },
  );

  assert.equal(response.status, 200);
  const stored = db.executed.find(statement => statement.sql.includes('completed_event_id'));
  for (const column of [
    'mutation_gate', 'mutation_status', 'mutation_generated', 'mutation_historical',
    'mutation_viable', 'mutation_killed', 'mutation_survived', 'mutation_score',
    'mutation_operators',
  ]) assert.match(stored.sql, new RegExp(column));
  assert.equal(stored.values.includes('enforce'), true);
  assert.equal(stored.values.includes(2 / 3), true);
  const serialized = JSON.stringify(stored);
  for (const forbidden of ['source', 'record_id', 'problem_id', 'private input', 'private output']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('POST /api/testdata-events rejects invalid consensus enums and unknown fields before D1', async () => {
  for (const invalidEvent of [
    event({ specConsensusStatus: 'resolved' }),
    event({ specResolutionReason: 'private model explanation' }),
  ]) {
    const db = new FakeDb();
    const response = await worker.fetch(
      request('/api/testdata-events', { instanceId: INSTANCE_ID, events: [invalidEvent] }),
      { DB: db, REPORT_TOKEN: 'report-secret' },
    );
    assert.equal(response.status, 400);
    assert.equal(db.executed.length, 0);
  }
});

test('worker validator accepts only canonical UTC ISO event timestamps', () => {
  for (const occurredAt of [
    'August 19, 2026 00:00:00 UTC',
    '2026-08-19T00:00:00Z',
    '2026-08-19T08:00:00.000+08:00',
  ]) {
    assert.throws(
      () => validateTestdataQualityEventPayload(event({ occurredAt })),
      /occurredAt/,
    );
  }
});

test('POST /api/testdata-events enforces auth and actual payload bytes', async () => {
  const db = new FakeDb();
  const unauthorized = await worker.fetch(
    request('/api/testdata-events', { instanceId: INSTANCE_ID, events: [event()] }, ''),
    { DB: db, REPORT_TOKEN: 'report-secret' },
  );
  assert.equal(unauthorized.status, 401);

  const oversized = await worker.fetch(
    request('/api/testdata-events', JSON.stringify({ padding: 'x'.repeat(140_000) })),
    { DB: db, REPORT_TOKEN: 'report-secret' },
  );
  assert.equal(oversized.status, 413);
  assert.equal(db.executed.length, 0);
});

test('POST /api/testdata-events rejects privacy fields before D1 and rate-limits an instance', async () => {
  const db = new FakeDb();
  const privacy = await worker.fetch(
    request('/api/testdata-events', {
      instanceId: INSTANCE_ID,
      events: [{ ...event(), problemId: 'D3102', code: 'print(secret)' }],
    }),
    { DB: db, REPORT_TOKEN: 'report-secret' },
  );
  assert.equal(privacy.status, 400);
  assert.equal(db.executed.length, 0);

  const limitedDb = new FakeDb({ eventCount: 2_000 });
  const limited = await worker.fetch(
    request('/api/testdata-events', { instanceId: INSTANCE_ID, events: [event()] }),
    { DB: limitedDb, REPORT_TOKEN: 'report-secret' },
  );
  assert.equal(limited.status, 429);
  const rateCutoff = limitedDb.bound.find(statement => statement.sql.includes('testdata_rate_count')).values[1];
  assert.match(rateCutoff, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test('POST /api/testdata-events deduplicates exact retries and rejects sequence conflicts', async () => {
  const db = new FakeDb();
  const started = event();
  const completed = event({
    eventId: '33333333-3333-4333-8333-333333333333',
    sequence: 2,
    eventType: 'run_completed',
    pipelineCompleted: true,
    verified: false,
    wouldBlock: true,
  });
  const response = await worker.fetch(
    request('/api/testdata-events', {
      instanceId: INSTANCE_ID,
      events: [started, started, completed],
    }),
    { DB: db, REPORT_TOKEN: 'report-secret' },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, accepted: 2, duplicates: 1 });
  assert.equal(db.executed.length, 4);

  const conflict = await worker.fetch(
    request('/api/testdata-events', {
      instanceId: INSTANCE_ID,
      events: [
        started,
        event({ eventId: '44444444-4444-4444-8444-444444444444', sequence: 1 }),
      ],
    }),
    { DB: new FakeDb(), REPORT_TOKEN: 'report-secret' },
  );
  assert.equal(conflict.status, 409);
});

test('cross-request retries are duplicates while occupied sequence slots return 409', async () => {
  const stage = event({
    eventId: '55555555-5555-4555-8555-555555555555',
    sequence: 2,
    eventType: 'stage_completed',
    stage: 'blueprint',
  });
  const payloadHash = await testdataEventFingerprint(stage);
  const existingSlot = {
    event_id: stage.eventId,
    instance_id: INSTANCE_ID,
    run_id: stage.runId,
    sequence: stage.sequence,
    event_type: stage.eventType,
    payload_hash: payloadHash,
  };
  const duplicateDb = new FakeDb({
    firstRows: { testdata_existing_event_slot: existingSlot },
  });
  const duplicate = await worker.fetch(
    request('/api/testdata-events', { instanceId: INSTANCE_ID, events: [stage] }),
    { DB: duplicateDb, REPORT_TOKEN: 'report-secret' },
  );
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), { success: true, accepted: 0, duplicates: 1 });
  assert.equal(duplicateDb.executed.length, 0);

  const conflictDb = new FakeDb({
    firstRows: {
      testdata_existing_event_slot: {
        ...existingSlot,
        event_id: '66666666-6666-4666-8666-666666666666',
      },
    },
  });
  const conflict = await worker.fetch(
    request('/api/testdata-events', { instanceId: INSTANCE_ID, events: [stage] }),
    { DB: conflictDb, REPORT_TOKEN: 'report-secret' },
  );
  assert.equal(conflict.status, 409);
  assert.equal(conflictDb.executed.length, 0);
});

test('atomic slot ownership closes the SELECT-to-batch race for duplicate and conflicting writers', async () => {
  const stage = event({
    eventId: '55555555-5555-4555-8555-555555555555',
    sequence: 2,
    eventType: 'stage_completed',
    stage: 'blueprint',
  });
  const payloadHash = await testdataEventFingerprint(stage);
  const exactSlot = {
    event_id: stage.eventId,
    instance_id: INSTANCE_ID,
    run_id: stage.runId,
    sequence: stage.sequence,
    event_type: stage.eventType,
    payload_hash: payloadHash,
  };
  const duplicateDb = new FakeDb({
    firstRows: { testdata_existing_event_slot: [null, exactSlot] },
    changes: { 'INSERT INTO testdata_event_slots': [0] },
  });
  const duplicate = await worker.fetch(
    request('/api/testdata-events', { instanceId: INSTANCE_ID, events: [stage] }),
    { DB: duplicateDb, REPORT_TOKEN: 'report-secret' },
  );
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), { success: true, accepted: 0, duplicates: 1 });
  const guardedDataWrite = duplicateDb.executed.find(statement => (
    statement.sql.includes('INSERT INTO testdata_stage_events')
  ));
  assert.match(guardedDataWrite.sql, /WHERE EXISTS[\s\S]*testdata_event_slots/);
  assert.match(
    guardedDataWrite.sql,
    /event_id = \? AND instance_id = \? AND run_id = \? AND sequence = \?[\s\S]*AND event_type = \? AND payload_hash = \?/,
  );

  const conflictDb = new FakeDb({
    firstRows: {
      testdata_existing_event_slot: [null, {
        ...exactSlot,
        event_id: '66666666-6666-4666-8666-666666666666',
      }],
    },
    changes: { 'INSERT INTO testdata_event_slots': [0] },
  });
  const conflict = await worker.fetch(
    request('/api/testdata-events', { instanceId: INSTANCE_ID, events: [stage] }),
    { DB: conflictDb, REPORT_TOKEN: 'report-secret' },
  );
  assert.equal(conflict.status, 409);
});

test('completion-first delivery preserves statement buckets and late starts backfill safe dimensions', async () => {
  const db = new FakeDb();
  const completed = event({
    eventId: '33333333-3333-4333-8333-333333333333',
    sequence: 2,
    eventType: 'run_completed',
    pipelineCompleted: true,
    verified: true,
    wouldBlock: false,
    hasSubtasks: true,
    hasCustomChecker: false,
    hasSamples: true,
    hasStatefulOperations: false,
    statementLengthBucket: '4k-16k',
    specSchemaVersion: 1,
    specExtractionSucceeded: true,
    specConstraintCount: 12,
    specInvariantCount: 3,
    specUncertaintyCount: 1,
  });
  const completedResponse = await worker.fetch(
    request('/api/testdata-events', { instanceId: INSTANCE_ID, events: [completed] }),
    { DB: db, REPORT_TOKEN: 'report-secret' },
  );
  assert.equal(completedResponse.status, 200);
  const completionStatement = db.executed.find(statement => (
    statement.sql.includes('INSERT INTO testdata_runs')
      && statement.sql.includes('completed_event_id')
  ));
  const completionSql = completionStatement.sql;
  assert.equal((completionSql.match(/\?/g) || []).length, completionStatement.values.length);
  for (const column of [
    'has_subtasks', 'has_custom_checker', 'has_samples',
    'has_stateful_operations', 'statement_length_bucket', 'spec_schema_version',
    'spec_extraction_succeeded', 'spec_constraint_count', 'spec_invariant_count',
    'spec_uncertainty_count',
  ]) assert.match(completionSql, new RegExp(column));
  assert.equal(completionStatement.values.includes('4k-16k'), true);

  const startedResponse = await worker.fetch(
    request('/api/testdata-events', { instanceId: INSTANCE_ID, events: [event()] }),
    { DB: db, REPORT_TOKEN: 'report-secret' },
  );
  assert.equal(startedResponse.status, 200);
  const startStatement = db.executed.find(statement => (
    statement.sql.includes('INSERT INTO testdata_runs')
      && statement.sql.includes('started_event_id')
      && !statement.sql.includes('completed_event_id')
  ));
  const startSql = startStatement.sql;
  assert.equal((startSql.match(/\?/g) || []).length, startStatement.values.length);
  for (const column of [
    'has_subtasks', 'has_custom_checker', 'has_samples',
    'has_stateful_operations', 'statement_length_bucket',
  ]) {
    assert.match(
      startSql,
      new RegExp(`${column} = COALESCE\\(excluded\\.${column}, testdata_runs\\.${column}\\)`),
    );
  }
});

test('stage and outcome retention/rate timestamps come from D1, not the client clock', async () => {
  const db = new FakeDb();
  const occurredAt = '2025-01-01T00:00:00.000Z';
  const response = await worker.fetch(
    request('/api/testdata-events', {
      instanceId: INSTANCE_ID,
      events: [
        event({
          eventId: '55555555-5555-4555-8555-555555555555',
          sequence: 2,
          eventType: 'stage_completed',
          stage: 'blueprint',
          occurredAt,
        }),
        event({
          eventId: '66666666-6666-4666-8666-666666666666',
          sequence: 1_000_000,
          eventType: 'teacher_outcome',
          teacherOutcome: 'discarded',
          occurredAt,
        }),
      ],
    }),
    { DB: db, REPORT_TOKEN: 'report-secret' },
  );
  assert.equal(response.status, 200);
  assert.equal(db.executed.length, 4);
  for (const statement of db.executed) {
    assert.doesNotMatch(statement.sql, /received_at\s*\)/);
    assert.equal(statement.values.includes(occurredAt), false);
  }
});

test('days parser uses 30 by default and accepts only 1..400', () => {
  assert.equal(parseTestdataQualityDays(new URL('https://x/api/dashboard/testdata-quality')), 30);
  assert.equal(parseTestdataQualityDays(new URL('https://x/api/dashboard/testdata-quality?days=1')), 1);
  assert.equal(parseTestdataQualityDays(new URL('https://x/api/dashboard/testdata-quality?days=400')), 400);
  for (const value of ['0', '401', '-1', 'abc', '1.5']) {
    assert.throws(() => parseTestdataQualityDays(new URL(`https://x/?days=${value}`)));
  }
});

test('received_at cutoffs use D1 datetime text format', () => {
  assert.equal(
    toSqliteUtcTimestamp(new Date('2026-08-19T03:04:05.678Z')),
    '2026-08-19 03:04:05',
  );
});

test('GET dashboard returns aggregate-only rates with explicit denominators and no run detail', async () => {
  const db = new FakeDb({
    rows: {
      testdata_quality_totals: [{
        total_runs: 10, pipeline_completed: 8, verified: 5, would_block: 2,
        spec_attempted: 7, spec_succeeded: 5, spec_constraint_count: 48,
        spec_invariant_count: 11, spec_uncertainty_count: 4,
        stress_generated: 600, stress_valid: 560, stress_dropped_invalid: 40,
        stress_unique: 540, stress_compared: 560, stress_agreed: 550,
        checker_configured: 4, checker_read: 4, checker_compiled: 3,
        checker_executed: 3, checker_infra_failures: 2, checker_infra_failed_runs: 1,
        mutation_runs: 3, mutation_generated: 6, mutation_historical: 2,
        mutation_viable: 8, mutation_killed: 6, mutation_survived: 2,
        mutation_average_score: 0.75,
      }],
      testdata_quality_outcomes: [{
        total_outcomes: 6, accepted_unchanged: 2, accepted_edited: 2, discarded: 1, regenerated: 1,
      }],
      testdata_quality_failures: [
        { key: 'CHECKER_RUNTIME_FAILED', count: 2 },
        { key: 'UNKNOWN', count: 1 },
      ],
      testdata_quality_stages: [
        { key: 'checker', count: 2 },
        { key: 'solution_verification', count: 1 },
      ],
      testdata_quality_artifacts: [
        { key: 'checker', count: 2 },
        { key: 'pipeline', count: 1 },
      ],
      testdata_quality_risks: [{ key: 'high', count: 3 }],
      testdata_quality_templates: [
        { language: 'py', requested: 5, verified: 4 },
        { language: 'java', requested: 4, verified: 2 },
        { language: 'cc', requested: 3, verified: 3 },
      ],
      testdata_quality_fallback: [{ attempts: 2, rescued: 1 }],
      testdata_quality_verified_outcomes: [{ denominator: 4, changed: 2 }],
      testdata_quality_model_roles: [
        { model_role: 'primary', runs: 6, completed: 5, verified: 3, failed: 1 },
        { model_role: 'fallback', runs: 4, completed: 3, verified: 2, failed: 1 },
      ],
      testdata_quality_versions: [{ plugin_version: '3.1.0', runs: 10, pipeline_completed: 8, verified: 5, would_block: 2 }],
      testdata_quality_consensus: [
        { key: 'consensus', count: 6 },
        { key: 'adjudicated', count: 3 },
        { key: 'unresolved', count: 1 },
      ],
      testdata_quality_stage_latency: [
        {
          stage: 'blueprint', runs: 10,
          b_1000: 4, b_3000: 1, b_10000: 4, b_30000: 1,
        },
        {
          stage: 'mutation_testing', runs: 3,
          b_120000: 1, b_300000: 2,
        },
        { stage: 'private-stage', runs: 99, b_1000: 99 },
      ],
    },
  });
  const response = await worker.fetch(new Request(
    'https://stats.example/api/dashboard/testdata-quality?days=30',
    { headers: { Authorization: 'Bearer dashboard-secret' } },
  ), { DB: db, DASHBOARD_TOKEN: 'dashboard-secret' });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.metrics.pipeline_completion, { count: 8, total: 10, rate: 0.8 });
  assert.deepEqual(body.metrics.verified, { count: 5, total: 8, rate: 0.625 });
  assert.deepEqual(body.metrics.accepted_unchanged, { count: 2, total: 6, rate: 1 / 3 });
  assert.deepEqual(body.metrics.model_escalation_rescue, { count: 1, total: 2, rate: 0.5 });
  assert.deepEqual(body.metrics.verified_but_teacher_changed, { count: 2, total: 4, rate: 0.5 });
  assert.deepEqual(body.problem_spec, {
    extraction_succeeded: { count: 5, total: 7, rate: 5 / 7 },
    constraint_count: 48,
    invariant_count: 11,
    uncertainty_count: 4,
    consensus_statuses: [
      { key: 'consensus', count: 6 },
      { key: 'adjudicated', count: 3 },
      { key: 'unresolved', count: 1 },
    ],
  });
  assert.deepEqual(body.checker.infra_failure, { count: 1, total: 4, rate: 0.25 });
  assert.deepEqual(body.mutation, {
    runs: 3,
    generated: 6,
    historical: 2,
    viable: 8,
    killed: 6,
    survived: 2,
    average_score: 0.75,
  });
  assert.deepEqual(body.failure_codes, [
    { key: 'CHECKER_RUNTIME_FAILED', count: 2 }, { key: 'UNKNOWN', count: 1 },
  ]);
  assert.deepEqual(body.failure_stages, [
    { key: 'checker', count: 2 }, { key: 'solution_verification', count: 1 },
  ]);
  assert.deepEqual(body.failure_artifacts, [
    { key: 'checker', count: 2 }, { key: 'pipeline', count: 1 },
  ]);
  assert.deepEqual(body.stage_latency, [
    { stage: 'blueprint', runs: 10, p50Ms: 3000, p95Ms: 30000 },
    { stage: 'mutation_testing', runs: 3, p50Ms: 300000, p95Ms: 300000 },
  ]);
  assert.deepEqual(body.model_roles, {
    primary: {
      runs: 6,
      completed: { count: 5, total: 6, rate: 5 / 6 },
      verified: { count: 3, total: 5, rate: 0.6 },
      failed: { count: 1, total: 6, rate: 1 / 6 },
    },
    fallback: {
      runs: 4,
      completed: { count: 3, total: 4, rate: 0.75 },
      verified: { count: 2, total: 3, rate: 2 / 3 },
      failed: { count: 1, total: 4, rate: 0.25 },
    },
  });
  assert.equal(body.templates.java.verified, 2);
  const totalsCutoff = db.bound.find(statement => statement.sql.includes('testdata_quality_totals')).values[0];
  assert.match(totalsCutoff, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  for (const statement of db.bound.filter(item => item.sql.includes('FROM testdata_runs WHERE'))) {
    assert.match(statement.sql, /WHERE received_at >= \?/);
    assert.doesNotMatch(statement.sql, /WHERE started_at >= \?/);
  }
  for (const marker of [
    'testdata_quality_outcomes', 'testdata_quality_failures',
    'testdata_quality_stages', 'testdata_quality_artifacts',
    'testdata_quality_stage_latency',
  ]) {
    const receivedAtCutoff = db.bound.find(statement => statement.sql.includes(marker)).values[0];
    assert.match(receivedAtCutoff, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  }
  const serialized = JSON.stringify(body);
  for (const forbidden of ['instance_id', 'run_id', 'event_id', 'timeline', 'metadata']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('GET dashboard returns null rates and empty distributions for zero data', async () => {
  const db = new FakeDb();
  const response = await worker.fetch(new Request(
    'https://stats.example/api/dashboard/testdata-quality',
    { headers: { Authorization: 'Bearer dashboard-secret' } },
  ), { DB: db, DASHBOARD_TOKEN: 'dashboard-secret' });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.metrics.pipeline_completion, { count: 0, total: 0, rate: null });
  assert.deepEqual(body.metrics.verified, { count: 0, total: 0, rate: null });
  assert.deepEqual(body.failure_codes, []);
  assert.deepEqual(body.failure_artifacts, []);
  assert.deepEqual(body.stage_latency, []);
  assert.deepEqual(body.problem_spec.consensus_statuses, []);
  assert.deepEqual(body.mutation, {
    runs: 0,
    generated: 0,
    historical: 0,
    viable: 0,
    killed: 0,
    survived: 0,
    average_score: null,
  });
  assert.deepEqual(body.model_roles, {
    primary: {
      runs: 0,
      completed: { count: 0, total: 0, rate: null },
      verified: { count: 0, total: 0, rate: null },
      failed: { count: 0, total: 0, rate: null },
    },
    fallback: {
      runs: 0,
      completed: { count: 0, total: 0, rate: null },
      verified: { count: 0, total: 0, rate: null },
      failed: { count: 0, total: 0, rate: null },
    },
  });
});

test('GET dashboard rejects invalid days before querying D1', async () => {
  const db = new FakeDb();
  const response = await worker.fetch(new Request(
    'https://stats.example/api/dashboard/testdata-quality?days=0',
    { headers: { Authorization: 'Bearer dashboard-secret' } },
  ), { DB: db, DASHBOARD_TOKEN: 'dashboard-secret' });
  assert.equal(response.status, 400);
  assert.equal(db.executed.length, 0);
});

test('GET dashboard rejects non-GET methods', async () => {
  const db = new FakeDb();
  const response = await worker.fetch(new Request(
    'https://stats.example/api/dashboard/testdata-quality',
    { method: 'POST', headers: { Authorization: 'Bearer dashboard-secret' } },
  ), { DB: db, DASHBOARD_TOKEN: 'dashboard-secret' });
  assert.equal(response.status, 405);
  assert.equal(db.bound.length, 0);
});
