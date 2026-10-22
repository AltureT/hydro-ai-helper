import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTestdataModelRoleRows,
  buildTestdataQualityCards,
  buildTestdataStageLatencyRows,
  formatTestdataStageDuration,
  formatTestdataQualityRate,
} from './src/testdataQualityView.ts';

test('zero denominator is shown as unavailable instead of 100%', () => {
  assert.equal(formatTestdataQualityRate({ count: 0, total: 0, rate: null }), '暂无数据 (0/0)');
});

test('rates always show the explicit count and denominator', () => {
  assert.equal(formatTestdataQualityRate({ count: 3, total: 4, rate: 0.75 }), '75.0% (3/4)');
});

test('card view tolerates a partial aggregate fixture without deriving verified', () => {
  const cards = buildTestdataQualityCards({
    window_days: 30,
    total_runs: 2,
    metrics: {
      pipeline_completion: { count: 1, total: 2, rate: 0.5 },
      verified: { count: 1, total: 1, rate: 1 },
    },
  });

  assert.deepEqual(cards.slice(0, 3).map(card => card.value), [
    '2',
    '50.0% (1/2)',
    '100.0% (1/1)',
  ]);
  assert.equal(cards.find(card => card.key === 'would_block')?.value, '暂无数据 (0/0)');
});

test('model role rows preserve Worker counts and explicit denominators', () => {
  const rows = buildTestdataModelRoleRows({
    window_days: 30,
    total_runs: 10,
    model_roles: {
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
    },
  });

  assert.deepEqual(rows, [
    {
      role: 'primary', label: '首选模型', runs: 6,
      completed: '83.3% (5/6)', verified: '60.0% (3/5)', failed: '16.7% (1/6)',
    },
    {
      role: 'fallback', label: '后备模型', runs: 4,
      completed: '75.0% (3/4)', verified: '66.7% (2/3)', failed: '25.0% (1/4)',
    },
  ]);
});

test('stage latency rows tolerate an older Worker response', () => {
  assert.deepEqual(buildTestdataStageLatencyRows({ window_days: 30, total_runs: 2 }), []);
});

test('stage latency rows sort by p95 then stage and format durations', () => {
  const rows = buildTestdataStageLatencyRows({
    window_days: 30,
    total_runs: 10,
    stage_latency: [
      { stage: 'blueprint', runs: 10, p50Ms: 3000, p95Ms: 30000 },
      { stage: 'sandbox_check', runs: 10, p50Ms: 1000, p95Ms: 300000 },
      { stage: 'mutation_testing', runs: 3, p50Ms: 300000, p95Ms: 300000 },
      { stage: 'unknown_latency', runs: 1, p50Ms: null, p95Ms: null },
    ],
  });

  assert.deepEqual(rows, [
    { stage: 'mutation_testing', runs: 3, p50: '5.0 分钟', p95: '5.0 分钟' },
    { stage: 'sandbox_check', runs: 10, p50: '1.0 秒', p95: '5.0 分钟' },
    { stage: 'blueprint', runs: 10, p50: '3.0 秒', p95: '30.0 秒' },
    { stage: 'unknown_latency', runs: 1, p50: '暂无数据', p95: '暂无数据' },
  ]);
});

test('stage duration formatter uses compact units without inventing missing values', () => {
  assert.equal(formatTestdataStageDuration(800), '800 ms');
  assert.equal(formatTestdataStageDuration(7200000), '2.0 小时');
  assert.equal(formatTestdataStageDuration(null), '暂无数据');
});
