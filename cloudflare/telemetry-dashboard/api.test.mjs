import test from 'node:test';
import assert from 'node:assert/strict';

import { configure, getTestdataQuality } from './src/api.ts';

test('test-data quality API requests the bounded window and preserves model-role aggregates', async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  let capturedAuthorization = '';
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedAuthorization = init?.headers?.Authorization || '';
    return new Response(JSON.stringify({
      window_days: 90,
      total_runs: 2,
      problem_spec: {
        extraction_succeeded: { count: 2, total: 2, rate: 1 },
        constraint_count: 8,
        invariant_count: 2,
        uncertainty_count: 0,
        consensus_statuses: [
          { key: 'consensus', count: 1 },
          { key: 'adjudicated', count: 1 },
        ],
      },
      model_roles: {
        primary: {
          runs: 1,
          completed: { count: 1, total: 1, rate: 1 },
          verified: { count: 1, total: 1, rate: 1 },
          failed: { count: 0, total: 1, rate: 0 },
        },
        fallback: {
          runs: 1,
          completed: { count: 0, total: 1, rate: 0 },
          verified: { count: 0, total: 0, rate: null },
          failed: { count: 1, total: 1, rate: 1 },
        },
      },
      mutation: {
        runs: 1,
        generated: 2,
        historical: 1,
        viable: 3,
        killed: 2,
        survived: 1,
        average_score: 2 / 3,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    configure('https://stats.example/', 'dashboard-secret');
    const response = await getTestdataQuality(90);

    assert.equal(capturedUrl, 'https://stats.example/api/dashboard/testdata-quality?days=90');
    assert.equal(capturedAuthorization, 'Bearer dashboard-secret');
    assert.equal(response.model_roles?.fallback.failed.total, 1);
    assert.deepEqual(response.problem_spec?.consensus_statuses, [
      { key: 'consensus', count: 1 },
      { key: 'adjudicated', count: 1 },
    ]);
    assert.deepEqual(response.mutation, {
      runs: 1,
      generated: 2,
      historical: 1,
      viable: 3,
      killed: 2,
      survived: 1,
      average_score: 2 / 3,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
