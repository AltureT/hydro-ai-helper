import React from 'react';
import { i18n } from '../utils/i18n';
import { COLORS, RADIUS, SPACING } from '../utils/styles';

export interface ProblemSpecSummaryData {
  statementHash: string;
  constraintCount: number;
  invariantCount: number;
  unresolvedUncertainties: number;
}

interface ProblemSpecSummaryViewProps {
  specSchemaVersion?: number;
  summary?: ProblemSpecSummaryData;
  translate?: (key: string, ...args: Array<string | number>) => string;
}

export function ProblemSpecSummaryView({
  specSchemaVersion,
  summary,
  translate = i18n,
}: ProblemSpecSummaryViewProps): React.ReactElement | null {
  if (specSchemaVersion === undefined) return null;
  const unavailable = translate('ai_helper_testdata_spec_unavailable');
  const rows: Array<[string, string | number]> = [
    [translate('ai_helper_testdata_spec_schema_version'), specSchemaVersion],
    [
      translate('ai_helper_testdata_spec_statement_hash'),
      summary ? `${summary.statementHash.slice(0, 12)}…` : unavailable,
    ],
    [translate('ai_helper_testdata_spec_constraint_count'), summary?.constraintCount ?? unavailable],
    [translate('ai_helper_testdata_spec_invariant_count'), summary?.invariantCount ?? unavailable],
    [
      translate('ai_helper_testdata_spec_uncertainty_count'),
      summary?.unresolvedUncertainties ?? unavailable,
    ],
    [
      translate('ai_helper_testdata_spec_evidence_validated'),
      translate(summary ? 'ai_helper_testdata_spec_yes' : 'ai_helper_testdata_spec_no'),
    ],
  ];

  const rowElements = rows.flatMap(([label, value]) => [
    React.createElement('dt', { key: `${label}-label`, style: { color: COLORS.textMuted } }, label),
    React.createElement('dd', {
      key: `${label}-value`,
      style: { margin: 0, color: COLORS.textPrimary, overflowWrap: 'anywhere' },
    }, value),
  ]);
  return React.createElement(
    'details',
    {
      style: {
        marginBottom: SPACING.md,
        padding: `${SPACING.sm} ${SPACING.md}`,
        border: `1px solid ${COLORS.border}`,
        borderRadius: RADIUS.md,
        backgroundColor: COLORS.bgHover,
        fontSize: '13px',
      },
    },
    React.createElement(
      'summary',
      { style: { cursor: 'pointer', fontWeight: 600, color: COLORS.textPrimary } },
      translate('ai_helper_testdata_spec_summary_title'),
    ),
    React.createElement('dl', {
      style: {
        display: 'grid',
        gridTemplateColumns: 'minmax(150px, auto) 1fr',
        gap: `${SPACING.xs} ${SPACING.md}`,
        margin: `${SPACING.sm} 0 0`,
      },
    }, ...rowElements),
  );
}
