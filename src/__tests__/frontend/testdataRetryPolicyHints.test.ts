import {
  resolveTestdataRetryGuidance,
} from '../../../frontend/testdataGen/retryPolicyHints';
import { readFileSync } from 'fs';
import { resolve } from 'path';

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

describe('test-data direct fallback confirmation UI', () => {
  it('only offers a confirmation action for medium risk', () => {
    const panel = readFileSync(resolve(process.cwd(), 'frontend/testdataGen/TestdataGenPanel.tsx'), 'utf8');
    expect(panel).toContain("risk?.tier === 'medium'");
    expect(panel).toContain('confirmDirectFallback');
    expect(panel).not.toContain("risk.tier === 'high' && risk.allowsDirectFallback");
    expect(panel).not.toContain("risk.tier === 'blocked' && risk.allowsDirectFallback");
  });
});
