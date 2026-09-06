import React from 'react';
import { i18n } from '../utils/i18n';
import { COLORS, SPACING, getAlertStyle } from '../utils/styles';
import type { VerificationSummaryData } from './VerificationSummaryView';
import type { CoverageSummaryData } from './CoverageSummaryView';

interface PreviewSummaryPlan {
  problemType: 'function' | 'traditional';
  isFillIn?: boolean;
  caseCount: number;
  totalCaseCount?: number;
  isSkeleton?: boolean;
  requiresConfigReview?: boolean;
  analysis?: string;
  notes?: string;
  specConsensusStatus?: string;
  unresolvedConflictCount?: number;
  notesStructured?: { warnings: string[]; system?: string[] };
  risk?: { tier: string; wouldBlock?: boolean };
  verification?: VerificationSummaryData & {
    mode: 'sandbox' | 'direct';
    sampleCheck?: { total: number; passed: number };
    bruteCheck?: { disagreed: number[] };
    stressCheck?: { compared: number; agreed: number };
    coverage?: CoverageSummaryData;
  };
  caseCoverage?: Array<{
    caseNumber: number;
    fileNumber: number;
    dataScale: 'small' | 'medium' | 'large';
    subtaskId?: number;
    target: string;
  }>;
}

function isSkeletonPlan(plan: PreviewSummaryPlan): boolean {
  // Persisted plans created before the presentation fields were introduced.
  return plan.isSkeleton ?? (plan.analysis?.startsWith('骨架模式：') === true
    || plan.notes?.includes('骨架模式（未调用 AI）') === true);
}

// Use recorded checks for status. AI prose and coverage plans never certify a result.
export function getPreviewReviewMessages(plan: PreviewSummaryPlan): string[] {
  const verification = plan.verification;
  const messages: string[] = [];
  if (isSkeletonPlan(plan)) messages.push(plan.problemType === 'function' ? 'skeleton_function' : 'skeleton');
  const legacyNotes = [plan.notes, ...(plan.notesStructured?.warnings || []), ...(plan.notesStructured?.system || [])];
  if (plan.requiresConfigReview ?? legacyNotes.some(note => note?.includes('子任务'))) messages.push('config');
  if (verification?.mode === 'direct') messages.push('direct');
  if (plan.specConsensusStatus === 'unresolved' || (plan.unresolvedConflictCount ?? 0) > 0) {
    messages.push('statement');
  }
  if ((verification?.sampleCheck && verification.sampleCheck.passed < verification.sampleCheck.total)
    || (verification?.bruteCheck?.disagreed.length ?? 0) > 0
    || (verification?.stressCheck && verification.stressCheck.agreed < verification.stressCheck.compared)) {
    messages.push('answers');
  }
  if ((verification?.validator?.invalidAccepted ?? 0) > 0
    || (verification?.validator?.missingConstraintIds?.length ?? 0) > 0) messages.push('inputs');
  if ((verification?.coverage?.criticalMissing ?? 0) > 0) messages.push('coverage');
  const templateFailed = verification?.templateLanguages?.some(language => {
    const check = verification.templateChecks?.[language];
    return !check?.compiled || !check.executed || check.passed !== check.total;
  });
  const checker = verification?.checkerCheck;
  if (templateFailed || (checker && (!checker.compiled || !checker.executed
    || checker.infraFailures > 0 || checker.passed !== checker.total))) messages.push('files');
  const hasCheckMessage = messages.some(message => ['direct', 'statement', 'answers', 'inputs', 'coverage', 'files'].includes(message));
  if (!isSkeletonPlan(plan) && !hasCheckMessage && (
    verification?.verified !== true || verification.mode !== 'sandbox'
    || verification.wouldBlock || plan.risk?.wouldBlock
    || plan.risk?.tier === 'blocked'
    || (plan.notesStructured?.warnings.length ?? 0) > 0
  )) messages.push('incomplete');
  return messages;
}

const previewStyles = `
  .testdata-preview-summary { color: ${COLORS.textPrimary}; margin-bottom: 24px; }
  .testdata-preview-summary h3 { margin: 0 0 4px; font-size: 18px; line-height: 1.5; }
  .testdata-preview-summary p { margin: 0; line-height: 1.6; font-size: 13px; }
  .testdata-preview-coverage { margin-top: 24px; }
  .testdata-preview-coverage h4 { margin: 0 0 4px; font-size: 14px; }
  .testdata-preview-coverage ol { list-style: none; padding: 0; margin: 12px 0 0; }
  .testdata-preview-coverage li { display: grid; grid-template-columns: 80px 76px minmax(0, 1fr);
    gap: 8px 12px; padding: 9px 0; border-bottom: 1px solid ${COLORS.border};
    font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
  .testdata-preview-coverage .coverage-scale { color: ${COLORS.textSecondary}; }
  @media (max-width: 480px) {
    .testdata-preview-coverage li { grid-template-columns: 80px minmax(0, 1fr); gap: 4px 12px; }
    .testdata-preview-coverage .coverage-target { grid-column: 1 / -1; }
  }
`;

export function TestdataPreviewSummary({ plan, hasWrittenFiles = false }: {
  plan: PreviewSummaryPlan;
  hasWrittenFiles?: boolean;
}): React.ReactElement {
  const messages = getPreviewReviewMessages(plan);
  const title = i18n(isSkeletonPlan(plan) ? 'ai_helper_testdata_result_skeleton_title' : 'ai_helper_testdata_result_title', plan.caseCount);
  return <section className="testdata-preview-summary" aria-label={title}>
    <style>{previewStyles}</style>
    <h3>{title}</h3>
    <p style={{ color: COLORS.textSecondary }}>
      {i18n(plan.problemType === 'function' ? 'ai_helper_testdata_type_function' : 'ai_helper_testdata_type_traditional')}
      {plan.isFillIn ? ` · ${i18n('ai_helper_testdata_type_fill_in')}` : ''}
      {plan.totalCaseCount && plan.totalCaseCount !== plan.caseCount
        ? ` · ${i18n('ai_helper_testdata_total_case_count', plan.totalCaseCount)}` : ''}
      {' · '}{i18n(hasWrittenFiles ? 'ai_helper_testdata_result_partly_written' : 'ai_helper_testdata_result_not_written')}
    </p>
    <div style={{ ...getAlertStyle(messages.length ? 'warning' : 'success'), marginTop: SPACING.md }}>
      <strong style={{ display: 'block', marginBottom: SPACING.xs, fontSize: '14px' }}>
        {i18n(messages.length ? 'ai_helper_testdata_result_review' : 'ai_helper_testdata_result_checked')}
      </strong>
      {messages.map(message => <p key={message}>{i18n(`ai_helper_testdata_result_review_${message}`)}</p>)}
      <p>{i18n('ai_helper_testdata_result_review_next')}</p>
    </div>
    {!!plan.caseCoverage?.length && <section className="testdata-preview-coverage" aria-label={i18n('ai_helper_testdata_coverage_title')}>
      <h4>{i18n('ai_helper_testdata_coverage_title')}</h4>
      <p style={{ color: COLORS.textSecondary }}>{i18n('ai_helper_testdata_coverage_plan_hint')}</p>
      <ol>
        {plan.caseCoverage.map(item => <li key={item.caseNumber}>
          <span>{i18n('ai_helper_testdata_coverage_case', item.fileNumber)}</span>
          <span className="coverage-scale">{item.subtaskId !== undefined
            ? i18n('ai_helper_testdata_subtask_label', item.subtaskId)
            : i18n(`ai_helper_testdata_coverage_scale_${item.dataScale}`)}</span>
          <span className="coverage-target">{item.target}</span>
        </li>)}
      </ol>
    </section>}
  </section>;
}
