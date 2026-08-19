export type TestdataRetryGuidance = 'none' | 'retry' | 'manual-review' | 'switch-model';

/**
 * Failure guidance is a direct projection of the server retry policy. Keeping
 * this pure lets job polling and synchronous start failures share one contract.
 */
export function resolveTestdataRetryGuidance(
  retryPolicy: string | undefined,
): TestdataRetryGuidance {
  if (retryPolicy === 'repair-artifact') return 'retry';
  if (retryPolicy === 'adjudicate' || retryPolicy === 'manual-review') {
    return 'manual-review';
  }
  if (retryPolicy === 'switch-model') return 'switch-model';
  return 'none';
}
