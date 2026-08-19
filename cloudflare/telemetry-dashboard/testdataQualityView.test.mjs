import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTestdataQualityCards,
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
