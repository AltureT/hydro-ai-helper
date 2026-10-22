import React from 'react';
import { SPACING, getAlertStyle } from '../utils/styles';

export interface TestdataRiskAssessment {
  tier: 'low' | 'medium' | 'high' | 'blocked';
  score: number;
  reasons: Array<{ code: string; weight: number; messageKey: string }>;
  requiresSandbox: boolean;
  requiresSpecConsensus: boolean;
  requiresIndependentModels: boolean;
  allowsDirectFallback: boolean;
  wouldBlock?: boolean;
}

interface TestdataRiskSummaryViewProps {
  risk: TestdataRiskAssessment;
  reliabilityMode: 'legacy' | 'observe' | 'enforce';
  translate: (key: string, ...args: Array<string | number>) => string;
}

export function TestdataRiskSummaryView({
  risk,
  reliabilityMode,
  translate,
}: TestdataRiskSummaryViewProps): React.ReactElement {
  const yesNo = (value: boolean) => translate(value
    ? 'ai_helper_testdata_risk_yes'
    : 'ai_helper_testdata_risk_no');
  const details = [
    `${translate('ai_helper_testdata_risk_requires_sandbox')}: ${yesNo(risk.requiresSandbox)}`,
    `${translate('ai_helper_testdata_risk_direct_allowed')}: ${yesNo(risk.allowsDirectFallback)}`,
    `${translate('ai_helper_testdata_risk_requires_consensus')}: ${yesNo(risk.requiresSpecConsensus)}`,
    `${translate('ai_helper_testdata_risk_requires_independent_models')}: ${yesNo(risk.requiresIndependentModels)}`,
    `${translate('ai_helper_testdata_risk_mode')}: ${reliabilityMode}`,
    ...(risk.wouldBlock ? [translate('ai_helper_testdata_risk_would_block')] : []),
  ].join(' · ');

  return React.createElement(
    'div',
    { style: {
      ...getAlertStyle(risk.wouldBlock ? 'warning' : 'info'),
      marginBottom: SPACING.md,
    } },
    React.createElement(
      'div',
      { style: { fontWeight: 600, marginBottom: SPACING.xs } },
      `${translate('ai_helper_testdata_risk_title')}: `,
      `${translate(`ai_helper_testdata_risk_tier_${risk.tier}`)} · ${risk.score}`,
    ),
    React.createElement('div', { style: { fontSize: '13px' } }, details),
    React.createElement(
      'ul',
      { style: { margin: `${SPACING.xs} 0 0`, paddingLeft: SPACING.lg } },
      ...risk.reasons.map(reason => React.createElement(
        'li',
        { key: reason.code, style: { fontSize: '13px' } },
        `${translate(reason.messageKey)} (+${reason.weight})`,
      )),
    ),
  );
}
