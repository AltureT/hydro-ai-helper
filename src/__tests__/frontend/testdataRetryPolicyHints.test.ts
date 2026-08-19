import {
  buildTestdataDirectFallbackRetryPayload,
  resolveTestdataGenerationFailureUi,
  resolveTestdataRetryGuidance,
  shouldOfferTestdataDirectFallbackConfirmation,
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

describe('test-data direct fallback confirmation UI', () => {
  it.each([
    ['DIRECT_FALLBACK_CONFIRMATION_REQUIRED', true],
    ['SANDBOX_REQUIRED', false],
    ['SANDBOX_UNAVAILABLE', false],
    ['CHECKER_REQUIRED_UNAVAILABLE', false],
    [undefined, false],
  ] as const)('offers confirmation for %s only when the server requests it', (failureCode, expected) => {
    expect(shouldOfferTestdataDirectFallbackConfirmation(failureCode)).toBe(expected);
  });

  it.each([
    ['background completion confirmation', 'DIRECT_FALLBACK_CONFIRMATION_REQUIRED', 'no-retry', true, 'none'],
    ['synchronous request confirmation', 'DIRECT_FALLBACK_CONFIRMATION_REQUIRED', 'no-retry', true, 'none'],
    ['high-risk denial', 'SANDBOX_REQUIRED', 'no-retry', false, 'none'],
    ['blocked checker denial', 'CHECKER_REQUIRED_UNAVAILABLE', 'manual-review', false, 'manual-review'],
  ] as const)('%s resolves rendering and retry guidance from the typed failure', (
    _label, failureCode, retryPolicy, showDirectFallbackConfirmation, retryGuidance,
  ) => {
    expect(resolveTestdataGenerationFailureUi(failureCode, retryPolicy)).toEqual({
      showDirectFallbackConfirmation,
      retryGuidance,
    });
  });

  it('builds the explicit confirmation payload used by the retry button', () => {
    expect(buildTestdataDirectFallbackRetryPayload()).toEqual({ confirmDirectFallback: true });
  });
});
