import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SummaryCard } from '../../../frontend/batchSummary/SummaryCard';

jest.mock('../../../frontend/utils/i18n', () => ({ i18n: (key: string) => `translated:${key}` }));

function render(error?: string) {
  return renderToStaticMarkup(React.createElement(SummaryCard, {
    userId: 1, userName: 'Synthetic student', status: 'failed', publishStatus: 'draft',
    summary: null, error, domainId: 'test', isTeacher: true,
  }));
}

it('translates a saved learning-summary failure category', () => {
  expect(render('ai_helper_err_ai_timeout')).toContain('translated:ai_helper_err_ai_timeout');
});

it.each([undefined, 'private provider diagnostic', 'ai_helper_err_ai_unknown private text'])(
  'shows a safe fallback for legacy or unrecognized errors: %s', error => {
    const html = render(error);
    expect(html).toContain('translated:ai_helper_batch_summary_failed');
    expect(html).not.toContain('private');
  },
);
