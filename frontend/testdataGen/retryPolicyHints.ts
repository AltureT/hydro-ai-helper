import React from 'react';

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

/** The server emits this code only for a confirmable medium-risk direct path. */
export function shouldOfferTestdataDirectFallbackConfirmation(
  failureCode: string | undefined,
): boolean {
  return failureCode === 'DIRECT_FALLBACK_CONFIRMATION_REQUIRED';
}

export function resolveTestdataGenerationFailureUi(
  failureCode: string | undefined,
  retryPolicy: string | undefined,
): { showDirectFallbackConfirmation: boolean; retryGuidance: TestdataRetryGuidance } {
  return {
    showDirectFallbackConfirmation: shouldOfferTestdataDirectFallbackConfirmation(failureCode),
    retryGuidance: resolveTestdataRetryGuidance(retryPolicy),
  };
}

export interface TestdataGenerationFailureAdapterInput {
  failureCode?: string;
  retryPolicy?: string;
}

/** Background jobs carry a persisted failure envelope. */
export function adaptBackgroundTestdataGenerationFailure(
  input: TestdataGenerationFailureAdapterInput,
): { showDirectFallbackConfirmation: boolean; retryGuidance: TestdataRetryGuidance } {
  return resolveTestdataGenerationFailureUi(input.failureCode, input.retryPolicy);
}

/** Synchronous creation failures carry the equivalent request-error envelope. */
export function adaptSynchronousTestdataGenerationFailure(
  input: TestdataGenerationFailureAdapterInput,
): { showDirectFallbackConfirmation: boolean; retryGuidance: TestdataRetryGuidance } {
  return resolveTestdataGenerationFailureUi(input.failureCode, input.retryPolicy);
}

export function buildTestdataDirectFallbackRetryPayload(): { confirmDirectFallback: true } {
  return { confirmDirectFallback: true };
}

export function DirectFallbackConfirmationView(props: {
  visible: boolean;
  message: string;
  actionLabel: string;
  containerStyle?: React.CSSProperties;
  buttonStyle?: React.CSSProperties;
  onConfirm: (payload: { confirmDirectFallback: true }) => void;
}): React.ReactElement | null {
  if (!props.visible) return null;
  return React.createElement(
    'div',
    { style: props.containerStyle },
    React.createElement('div', null, props.message),
    React.createElement(
      'button',
      {
        type: 'button',
        style: props.buttonStyle,
        onClick: () => props.onConfirm(buildTestdataDirectFallbackRetryPayload()),
      },
      props.actionLabel,
    ),
  );
}
