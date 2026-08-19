import {
  resolveTestdataRetryGuidance,
} from '../../../frontend/testdataGen/retryPolicyHints';

describe('test-data retry-policy guidance', () => {
  it.each([
    ['no-retry', 'none'],
    ['adjudicate', 'manual-review'],
    ['manual-review', 'manual-review'],
    ['switch-model', 'switch-model'],
    ['repair-artifact', 'retry'],
    ['rerun-spec', 'none'],
    [undefined, 'none'],
  ] as const)('maps %s to %s', (retryPolicy, expected) => {
    expect(resolveTestdataRetryGuidance(retryPolicy)).toBe(expected);
  });
});
