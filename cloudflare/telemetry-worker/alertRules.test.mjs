import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFeatureDegradationCandidates,
  buildTestdataBurstCandidates,
} from './alertRules.mjs';

test('partial feature degradation alerts below 80% with enough volume', () => {
  const alerts = buildFeatureDegradationCandidates([
    { feature: 'testdata_generation', attempts: 23, successes: 14 },
  ]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].alert_key, 'feature_degraded:testdata_generation');
  assert.match(alerts[0].detail, /61%/);
});

test('partial degradation ignores low volume, outages, and healthy features', () => {
  const alerts = buildFeatureDegradationCandidates([
    { feature: 'low_volume', attempts: 9, successes: 1 },
    { feature: 'outage', attempts: 20, successes: 0 },
    { feature: 'healthy', attempts: 20, successes: 16 },
  ]);
  assert.deepEqual(alerts, []);
});

test('testdata burst alerts on three errors from one instance', () => {
  const rows = [{ instance_id: 'instance-1234567890abcdef', total: 3, fingerprints: 2, sample: 'GENERATOR failed' }];
  const alerts = buildTestdataBurstCandidates(rows);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].alert_key, /^testdata_burst:/);
  assert.doesNotMatch(alerts[0].alert_key, /instance-1234567890abcdef/);
  assert.match(alerts[0].detail, /3 次/);
  assert.equal(buildTestdataBurstCandidates(rows)[0].alert_key, alerts[0].alert_key, 'cooldown key is stable');
});

test('testdata burst ignores fewer than three occurrences', () => {
  assert.deepEqual(buildTestdataBurstCandidates([
    { instance_id: 'instance-a', total: 2, fingerprints: 2 },
  ]), []);
});
