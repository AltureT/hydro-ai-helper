import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as retryPolicyHints from '../../../frontend/testdataGen/retryPolicyHints';

type FailureUi = {
  showDirectFallbackConfirmation: boolean;
  retryGuidance: string;
};

const adaptBackgroundTestdataGenerationFailure = (
  retryPolicyHints as unknown as {
    adaptBackgroundTestdataGenerationFailure: (input: {
      failureCode?: string;
      retryPolicy?: string;
    }) => FailureUi;
  }
).adaptBackgroundTestdataGenerationFailure;
const adaptSynchronousTestdataGenerationFailure = (
  retryPolicyHints as unknown as {
    adaptSynchronousTestdataGenerationFailure: (input: {
      failureCode?: string;
      retryPolicy?: string;
    }) => FailureUi;
  }
).adaptSynchronousTestdataGenerationFailure;
const DirectFallbackConfirmationView = (
  retryPolicyHints as unknown as {
    DirectFallbackConfirmationView: (props: {
      visible: boolean;
      message: string;
      actionLabel: string;
      onConfirm: (payload: { confirmDirectFallback: true }) => void;
    }) => React.ReactElement | null;
  }
).DirectFallbackConfirmationView;

function renderConfirmation(
  failureUi: FailureUi,
  onConfirm = jest.fn(),
) {
  const props = {
    visible: failureUi.showDirectFallbackConfirmation,
    message: 'Confirmation required',
    actionLabel: 'Confirm direct fallback',
    onConfirm,
  };
  const element = React.createElement(DirectFallbackConfirmationView, props);
  return { element, props, onConfirm };
}

function invokeConfirmationButton(props: Parameters<typeof DirectFallbackConfirmationView>[0]) {
  const view = DirectFallbackConfirmationView(props) as React.ReactElement;
  const children = React.Children.toArray(view.props.children) as React.ReactElement[];
  const button = children.find(child => child.type === 'button');
  expect(button).toBeDefined();
  (button!.props as { onClick: () => void }).onClick();
}

describe('test-data direct fallback confirmation view', () => {
  it.each([
    ['background job failure', adaptBackgroundTestdataGenerationFailure],
    ['synchronous request failure', adaptSynchronousTestdataGenerationFailure],
  ] as const)('renders and confirms %s through the real view', (_label, adaptFailure) => {
    const failureUi = adaptFailure({
      failureCode: 'DIRECT_FALLBACK_CONFIRMATION_REQUIRED',
      retryPolicy: 'no-retry',
    });
    const { element, props, onConfirm } = renderConfirmation(failureUi);

    expect(renderToStaticMarkup(element)).toContain('Confirm direct fallback');
    invokeConfirmationButton(props);
    expect(onConfirm).toHaveBeenCalledWith({ confirmDirectFallback: true });
  });

  it.each([
    ['high risk', adaptBackgroundTestdataGenerationFailure, 'SANDBOX_REQUIRED', 'no-retry'],
    ['blocked checker', adaptBackgroundTestdataGenerationFailure, 'CHECKER_REQUIRED_UNAVAILABLE', 'manual-review'],
    ['high risk', adaptSynchronousTestdataGenerationFailure, 'SANDBOX_REQUIRED', 'no-retry'],
    ['blocked checker', adaptSynchronousTestdataGenerationFailure, 'CHECKER_REQUIRED_UNAVAILABLE', 'manual-review'],
  ] as const)('%s denial from its adapter renders no confirmation', (
    _label, adaptFailure, failureCode, retryPolicy,
  ) => {
    const failureUi = adaptFailure({ failureCode, retryPolicy });
    const { element } = renderConfirmation(failureUi);
    expect(renderToStaticMarkup(element)).toBe('');
  });
});
