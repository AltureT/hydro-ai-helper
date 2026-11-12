import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALIVE_HOURS,
  classifyInstance,
  isLegacySharedId,
  parseStatusFilter,
} from './instanceStatus.mjs';

const NOW = Date.parse('2026-11-12T08:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600_000).toISOString();

test('an instance on the old 48h heartbeat cadence still counts as active', () => {
  assert.ok(ALIVE_HOURS > 48);
  assert.equal(classifyInstance({ last_report_at: hoursAgo(47), installed_at: hoursAgo(2000) }, NOW), 'active');
});

test('an install that never sent a regular heartbeat is one_shot', () => {
  assert.equal(
    classifyInstance({ installed_at: hoursAgo(24 * 30), last_report_at: hoursAgo(24 * 30 - 20) }, NOW),
    'one_shot',
  );
});

test('an instance that reported for a while and then stopped is stale', () => {
  assert.equal(
    classifyInstance({ installed_at: hoursAgo(24 * 60), last_report_at: hoursAgo(24 * 10) }, NOW),
    'stale',
  );
});

test('pre-v2.0.6 hashed IDs are flagged as shared, UUIDs are not', () => {
  assert.equal(isLegacySharedId('b87d1d5bb0c6207c9e2aabf5691e06752af68a958722adac14252f02687292ee'), true);
  assert.equal(isLegacySharedId('9f0c3b7e-1a2b-4c3d-8e9f-0a1b2c3d4e5f'), false);
});

test('unknown status filters fall back to all', () => {
  assert.equal(parseStatusFilter('active'), 'active');
  assert.equal(parseStatusFilter('one_shot'), 'one_shot');
  assert.equal(parseStatusFilter("x' OR 1=1"), 'all');
  assert.equal(parseStatusFilter(null), 'all');
});
