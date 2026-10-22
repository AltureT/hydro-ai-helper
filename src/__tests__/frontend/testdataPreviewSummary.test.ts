import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getPreviewReviewMessages, TestdataPreviewSummary } from '../../../frontend/testdataGen/TestdataPreviewSummary';

jest.mock('../../../frontend/utils/i18n', () => ({
  i18n: (key: string, ...args: unknown[]) => `${key}${args.length ? `:${args.join(',')}` : ''}`,
}));

const checkedPlan = {
  problemType: 'traditional' as const,
  caseCount: 2,
  verification: { mode: 'sandbox' as const, verified: true },
};

describe('test data preview review status', () => {
  it('requires a completed execution check before displaying completion', () => {
    expect(getPreviewReviewMessages(checkedPlan)).toEqual([]);
    for (const verification of [undefined, { mode: 'sandbox' as const },
      { mode: 'sandbox' as const, verified: false },
      { mode: 'sandbox' as const, verified: true, wouldBlock: true }]) {
      expect(getPreviewReviewMessages({ ...checkedPlan, verification })).toEqual(['incomplete']);
    }
    expect(getPreviewReviewMessages({ ...checkedPlan, verification: { mode: 'direct', verified: true } })).toEqual(['direct']);
  });

  it.each([
    { risk: { tier: 'blocked' } },
    { risk: { tier: 'medium', wouldBlock: true } },
    { notesStructured: { warnings: ['SPEC_ROLE_IDENTITY_CONFLICT'] } },
  ])('does not conceal review requirements in an otherwise checked plan: %j', override => {
    expect(getPreviewReviewMessages({ ...checkedPlan, ...override })).toEqual(['incomplete']);
  });

  it('turns incomplete input and coverage evidence into actionable reminders', () => {
    expect(getPreviewReviewMessages({ ...checkedPlan, verification: {
      ...checkedPlan.verification,
      validator: { ran: true, casesChecked: 2, invalidAccepted: 0, missingConstraintIds: ['internal-id'] },
      coverage: { mode: 'trusted-dsl', matrix: [], totalTargets: 1, passedTargets: 0, criticalMissing: 1 },
    } })).toEqual(['inputs', 'coverage']);
  });

  it('preserves statement, output, template, and checker failures', () => {
    expect(getPreviewReviewMessages({ ...checkedPlan, specConsensusStatus: 'unresolved', verification: {
      ...checkedPlan.verification,
      sampleCheck: { total: 2, passed: 1 },
      templateLanguages: ['py'],
      templateChecks: { py: { compiled: true, executed: false, total: 2, passed: 0 } },
    } })).toEqual(['statement', 'answers', 'files']);
    expect(getPreviewReviewMessages({ ...checkedPlan, verification: {
      ...checkedPlan.verification,
      checkerCheck: { configured: true, read: true, compiled: true, executed: true,
        total: 2, passed: 1, infraFailures: 0 },
    } })).toEqual(['files']);
  });

  it('presents planned coverage without exposing diagnostic prose or certifying the plan', () => {
    const plan = { ...checkedPlan,
      analysis: 'PRIVATE_ANALYSIS', notes: 'PRIVATE_NOTES', usedModel: 'PRIVATE_MODEL',
      notesStructured: { warnings: ['SPEC_ROLE_IDENTITY_CONFLICT'], system: ['INTERNAL_LOG'], ai: 'AI_PROSE' },
      problemSpecSummary: { statementHash: 'INTERNAL_HASH' },
      caseCoverage: [{ caseNumber: 1, fileNumber: 7, dataScale: 'small' as const, target: '<script>boundary</script>' }],
    };
    const markup = renderToStaticMarkup(React.createElement(TestdataPreviewSummary, { plan }));
    for (const internal of ['PRIVATE_ANALYSIS', 'PRIVATE_NOTES', 'PRIVATE_MODEL', 'SPEC_ROLE_IDENTITY_CONFLICT', 'INTERNAL_LOG', 'AI_PROSE', 'INTERNAL_HASH']) {
      expect(markup).not.toContain(internal);
    }
    expect(markup).toContain('ai_helper_testdata_result_review_incomplete');
    expect(markup).not.toContain('ai_helper_testdata_result_checked');
    expect(markup).toContain('ai_helper_testdata_coverage_plan_hint');
    expect(markup).toContain('ai_helper_testdata_coverage_case:7');
    expect(markup).toContain('&lt;script&gt;boundary&lt;/script&gt;');
  });
});

 it('distinguishes inherent risk from an incomplete check', () => {
   expect(getPreviewReviewMessages({ ...checkedPlan, risk: { tier: 'high' } })).toEqual([]);
 });
 it('does not let configuration guidance conceal incomplete verification', () => {
   expect(getPreviewReviewMessages({ ...checkedPlan, requiresConfigReview: true,
     verification: { mode: 'sandbox', verified: false, wouldBlock: true },
   })).toEqual(['config', 'incomplete']);
   expect(getPreviewReviewMessages({ ...checkedPlan, requiresConfigReview: true })).toEqual(['config']);
 });
 it('keeps skeleton and subtask configuration guidance, including persisted older plans', () => {
   expect(getPreviewReviewMessages({ ...checkedPlan, isSkeleton: true, requiresConfigReview: true })).toEqual(['skeleton', 'config']);
   expect(getPreviewReviewMessages({ ...checkedPlan, problemType: 'function', analysis: '骨架模式：旧结果', notes: '既有子任务需要复核' })).toEqual(['skeleton_function', 'config']);
   const markup = renderToStaticMarkup(React.createElement(TestdataPreviewSummary, {plan: {...checkedPlan, isSkeleton: true}}));
   expect(markup).toContain('ai_helper_testdata_result_skeleton_title');
   expect(markup).not.toContain('ai_helper_testdata_result_title:');
 });
 it('does not describe previously written files as unwritten after returning to preview', () => {
   const markup = renderToStaticMarkup(React.createElement(TestdataPreviewSummary, {plan: checkedPlan, hasWrittenFiles: true}));
   expect(markup).toContain('ai_helper_testdata_result_partly_written');
   expect(markup).not.toContain('ai_helper_testdata_result_not_written');
 });
