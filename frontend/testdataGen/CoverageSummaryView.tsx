import React from 'react';
import { i18n } from '../utils/i18n';
import { COLORS, RADIUS, SPACING } from '../utils/styles';

const COVERAGE_TARGET_KEYS = [
  'size-min', 'size-mid', 'size-max',
  'value-min', 'value-max',
  'int32-min', 'int32-max', 'int64-min', 'int64-max',
  'ordered', 'reversed', 'all-equal', 'alternating',
  'tree-chain', 'tree-star', 'tree-balanced', 'tree-broom',
  'graph-sparse', 'graph-near-tree', 'graph-dense', 'graph-bridge', 'graph-cycle',
  'operation-add-delete-repeat', 'operation-nested-lifetime',
  'operation-query-between-updates', 'subtask-membership',
] as const;

type CoverageTargetKey = typeof COVERAGE_TARGET_KEYS[number];
type Translate = (key: string, ...args: Array<string | number>) => string;

export interface CoverageSummaryData {
  mode: 'trusted-dsl' | 'ai-generator-unverified';
  matrix: Array<{
    targetKey: string;
    required: number;
    actual: number;
    status: 'pass' | 'fail';
    critical: boolean;
    fieldId?: string;
    subtaskId?: number;
  }>;
  totalTargets: number;
  passedTargets: number;
  criticalMissing: number;
}

const TARGET_KEY_SET = new Set<string>(COVERAGE_TARGET_KEYS);
const MAX_MATRIX_ROWS = 1024;
const MAX_COUNT = 1_000_000;
const FIELD_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;

function isBoundedCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_COUNT;
}

function isTrustedCoverage(coverage: CoverageSummaryData): boolean {
  if (coverage.mode !== 'trusted-dsl'
    || !Array.isArray(coverage.matrix)
    || coverage.matrix.length > MAX_MATRIX_ROWS
    || !isBoundedCount(coverage.totalTargets)
    || !isBoundedCount(coverage.passedTargets)
    || !isBoundedCount(coverage.criticalMissing)) return false;
  let totalTargets = 0;
  let passedTargets = 0;
  let criticalMissing = 0;
  for (const row of coverage.matrix) {
    if (!row || !TARGET_KEY_SET.has(row.targetKey)
      || !isBoundedCount(row.required)
      || !isBoundedCount(row.actual)
      || (row.fieldId !== undefined && (
        typeof row.fieldId !== 'string' || !FIELD_ID_PATTERN.test(row.fieldId)
      ))
      || (row.subtaskId !== undefined && (
        !Number.isSafeInteger(row.subtaskId) || row.subtaskId < 1 || row.subtaskId > 100
      ))
      || typeof row.critical !== 'boolean'
      || (row.status !== 'pass' && row.status !== 'fail')
      || (row.status === 'pass') !== (row.actual >= row.required)) return false;
    totalTargets += row.required;
    passedTargets += Math.min(row.actual, row.required);
    if (row.critical) criticalMissing += Math.max(0, row.required - row.actual);
  }
  return totalTargets === coverage.totalTargets
    && passedTargets === coverage.passedTargets
    && criticalMissing === coverage.criticalMissing;
}

function targetLocaleKey(targetKey: CoverageTargetKey): string {
  return `ai_helper_testdata_semantic_coverage_target_${targetKey.replace(/-/g, '_')}`;
}

export function CoverageSummaryView(props: {
  coverage: CoverageSummaryData;
  translate?: Translate;
}): React.ReactElement {
  const translate = props.translate ?? i18n;
  const trusted = isTrustedCoverage(props.coverage);
  const heading = translate('ai_helper_testdata_semantic_coverage_title');
  const state = translate(trusted
    ? 'ai_helper_testdata_semantic_coverage_trusted'
    : 'ai_helper_testdata_semantic_coverage_unverified');
  const targetLabel = (row: CoverageSummaryData['matrix'][number]): string => {
    const scope = [
      row.fieldId,
      row.subtaskId === undefined
        ? undefined
        : translate('ai_helper_testdata_subtask_label', row.subtaskId),
    ].filter((item): item is string => item !== undefined);
    const label = translate(targetLocaleKey(row.targetKey as CoverageTargetKey));
    return scope.length === 0 ? label : `${label} (${scope.join(' · ')})`;
  };

  return React.createElement(
    'section',
    {
      'aria-label': heading,
      style: {
        marginBottom: SPACING.md,
        padding: SPACING.md,
        border: `1px solid ${COLORS.border}`,
        borderRadius: RADIUS.md,
        backgroundColor: COLORS.bgHover,
        overflowX: 'auto',
      },
    },
    React.createElement('div', {
      style: { fontWeight: 600, color: COLORS.textPrimary, marginBottom: SPACING.xs },
    }, heading),
    React.createElement('div', {
      role: 'status',
      style: { color: trusted ? COLORS.success : COLORS.textMuted, fontSize: '13px' },
    }, state),
    trusted && props.coverage.matrix.length > 0
      ? React.createElement(
        'table',
        {
          style: {
            width: '100%',
            marginTop: SPACING.sm,
            borderCollapse: 'collapse',
            fontSize: '13px',
            textAlign: 'left',
          },
        },
        React.createElement(
          'thead',
          null,
          React.createElement(
            'tr',
            null,
            ...[
              'target', 'required', 'actual', 'status',
            ].map(column => React.createElement('th', {
              key: column,
              style: { padding: `${SPACING.xs} ${SPACING.sm}`, color: COLORS.textMuted },
            }, translate(`ai_helper_testdata_semantic_coverage_${column}`))),
          ),
        ),
        React.createElement(
          'tbody',
          null,
          ...props.coverage.matrix.map((row, index) => React.createElement(
            'tr',
            {
              key: [row.targetKey, row.fieldId ?? '', row.subtaskId ?? 'global', index].join(':'),
            },
            React.createElement('td', {
              style: { padding: `${SPACING.xs} ${SPACING.sm}` },
            }, targetLabel(row)),
            React.createElement('td', {
              style: { padding: `${SPACING.xs} ${SPACING.sm}` },
            }, row.required),
            React.createElement('td', {
              style: { padding: `${SPACING.xs} ${SPACING.sm}` },
            }, row.actual),
            React.createElement('td', {
              style: {
                padding: `${SPACING.xs} ${SPACING.sm}`,
                color: row.status === 'pass' ? COLORS.success : COLORS.error,
                fontWeight: 600,
              },
            }, translate(`ai_helper_testdata_semantic_coverage_${row.status}`)),
          )),
        ),
      )
      : null,
  );
}
