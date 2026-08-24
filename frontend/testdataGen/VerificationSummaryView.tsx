import React from 'react';
import { i18n } from '../utils/i18n';

export interface VerificationSummaryData {
  verified?: boolean;
  wouldBlock?: boolean;
  templateLanguages?: Array<'py' | 'java' | 'cc'>;
  templateChecks?: Partial<Record<'py' | 'java' | 'cc', {
    compiled: boolean;
    executed: boolean;
    total: number;
    passed: number;
    failureKind?: string;
  }>>;
  checkerCheck?: {
    configured: boolean;
    read: boolean;
    compiled: boolean;
    executed: boolean;
    total: number;
    passed: number;
    infraFailures: number;
    failureKind?: string;
  };
  validator?: {
    ran: boolean;
    casesChecked: number;
    validAccepted?: number;
    invalidRejected?: number;
    invalidAccepted?: number;
    coveredConstraintIds?: string[];
    missingConstraintIds?: string[];
  };
  mutation?: unknown;
}

interface TrustedMutationSummary {
  mode: 'off' | 'observe' | 'enforce';
  status: 'completed' | 'partial' | 'skipped';
  generated: number;
  historical: number;
  viable: number;
  killed: number;
  survived: number;
  score?: number;
  operators: Array<{
    id: 'comparison-boundary' | 'equality-negation' | 'logical-connector'
      | 'arithmetic-operator' | 'constant-off-by-one' | 'historical-submission';
    viable: number;
    killed: number;
  }>;
  skippedReason?: 'gate-off' | 'sandbox-unavailable' | 'unsupported-source'
    | 'no-candidates' | 'no-viable-candidates' | 'checker-infra'
    | 'sandbox-infra' | 'budget-exhausted';
}

type Translate = (key: string, ...args: Array<string | number>) => string;

const LANGUAGE_ORDER = ['py', 'java', 'cc'] as const;
const TEMPLATE_FAILURE_KINDS = new Set([
  'compile', 'runtime', 'budget', 'mismatch', 'checker-infra',
]);
const CHECKER_FAILURE_KINDS = new Set([
  'unavailable', 'compile', 'infra', 'budget', 'reject',
]);
const MUTATION_MODES = new Set(['off', 'observe', 'enforce']);
const MUTATION_STATUSES = new Set(['completed', 'partial', 'skipped']);
const MUTATION_SKIP_REASONS = new Set([
  'gate-off', 'sandbox-unavailable', 'unsupported-source', 'no-candidates',
  'no-viable-candidates', 'checker-infra', 'sandbox-infra', 'budget-exhausted',
]);
const MUTATION_OPERATOR_IDS = new Set([
  'comparison-boundary', 'equality-negation', 'logical-connector',
  'arithmetic-operator', 'constant-off-by-one', 'historical-submission',
]);
const MUTATION_SUMMARY_KEYS = new Set([
  'mode', 'status', 'generated', 'historical', 'viable', 'killed', 'survived',
  'score', 'operators', 'skippedReason',
]);
const VALIDATOR_EVIDENCE_ID_MAX_LENGTH = 64;
const VALIDATOR_EVIDENCE_TARGET_MAX_COUNT = 768;

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isTrustedMutationSummary(value: unknown): value is TrustedMutationSummary {
  if (!isRecord(value)
    || Object.keys(value).some(key => !MUTATION_SUMMARY_KEYS.has(key))
    || typeof value.mode !== 'string' || !MUTATION_MODES.has(value.mode)
    || typeof value.status !== 'string' || !MUTATION_STATUSES.has(value.status)) return false;
  if (value.status === 'completed') {
    if (value.skippedReason !== undefined) return false;
  } else if (typeof value.skippedReason !== 'string'
    || !MUTATION_SKIP_REASONS.has(value.skippedReason)) return false;

  const counts = [value.generated, value.historical, value.viable, value.killed, value.survived];
  if (counts.some(count => !Number.isSafeInteger(count) || (count as number) < 0
    || (count as number) > 20)) return false;
  const [generated, historical, viable, killed, survived] = counts as number[];
  if (generated + historical > 20 || viable > generated + historical
    || killed + survived !== viable) return false;
  if (viable === 0) {
    if (value.score !== undefined) return false;
  } else if (typeof value.score !== 'number' || !Number.isFinite(value.score)
    || value.score < 0 || value.score > 1
    || Math.abs(value.score - killed / viable) > Number.EPSILON) return false;

  if (!Array.isArray(value.operators) || value.operators.length > MUTATION_OPERATOR_IDS.size) {
    return false;
  }
  const seen = new Set<string>();
  let operatorViable = 0;
  let operatorKilled = 0;
  for (let index = 0; index < value.operators.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value.operators, index)) return false;
    const operator = value.operators[index];
    if (!isRecord(operator) || Object.keys(operator).length !== 3
      || Object.keys(operator).some(key => !['id', 'viable', 'killed'].includes(key))
      || typeof operator.id !== 'string' || !MUTATION_OPERATOR_IDS.has(operator.id)
      || seen.has(operator.id)
      || !Number.isSafeInteger(operator.viable) || (operator.viable as number) < 0
      || (operator.viable as number) > 20
      || !Number.isSafeInteger(operator.killed) || (operator.killed as number) < 0
      || (operator.killed as number) > (operator.viable as number)) return false;
    seen.add(operator.id);
    operatorViable += operator.viable as number;
    operatorKilled += operator.killed as number;
  }
  return operatorViable === viable && operatorKilled === killed;
}

function isBoundedValidatorIdArray(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > VALIDATOR_EVIDENCE_TARGET_MAX_COUNT) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
    const item = value[index];
    if (typeof item !== 'string'
      || item.length === 0
      || item.length > VALIDATOR_EVIDENCE_ID_MAX_LENGTH) return false;
  }
  return true;
}

function areConsistentValidatorIdArrays(covered: unknown, missing: unknown): boolean {
  if (!isBoundedValidatorIdArray(covered)
    || !isBoundedValidatorIdArray(missing)
    || covered.length + missing.length > VALIDATOR_EVIDENCE_TARGET_MAX_COUNT) return false;
  const seen = new Set<string>();
  for (const id of [...covered, ...missing]) {
    if (seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}

function booleanEvidence(label: string, value: boolean, translate: Translate): React.ReactElement {
  const state = translate(value
    ? 'ai_helper_testdata_verify_yes'
    : 'ai_helper_testdata_verify_no');
  return React.createElement(
    'span',
    { 'aria-label': `${label}: ${state}` },
    `${label}: `,
    React.createElement('strong', null, state),
  );
}

function boundedFailure(
  failureKind: string | undefined,
  allowedKinds: Set<string>,
  translate: Translate,
): React.ReactElement | null {
  if (!failureKind || !allowedKinds.has(failureKind)) return null;
  const label = translate('ai_helper_testdata_verify_failure');
  const localizedKind = translate(
    `ai_helper_testdata_verify_failure_${failureKind.replace('-', '_')}`,
  );
  return React.createElement('span', null, `${label}: ${localizedKind}`);
}

function evidenceRow(children: React.ReactNode[]): React.ReactElement {
  return React.createElement(
    'div',
    {
      style: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: '4px 12px',
        marginTop: '4px',
        fontSize: '13px',
      },
    },
    ...children,
  );
}

export function VerificationSummaryView(props: {
  verification: VerificationSummaryData;
  translate?: Translate;
}): React.ReactElement {
  const translate = props.translate ?? i18n;
  const { verification } = props;
  const statusKey = verification.verified === true
    ? 'ai_helper_testdata_verify_status_verified'
    : verification.wouldBlock === true
      ? 'ai_helper_testdata_verify_status_would_block'
      : 'ai_helper_testdata_verify_status_unverified';
  const status = translate(statusKey);

  const rows: React.ReactElement[] = [
    React.createElement(
      'div',
      {
        key: 'status',
        role: 'status',
        style: { fontWeight: 600 },
      },
      status,
    ),
  ];

  const templateLanguages = verification.templateLanguages
    ? LANGUAGE_ORDER.filter(language => verification.templateLanguages?.includes(language))
    : LANGUAGE_ORDER.filter(language => !!verification.templateChecks?.[language]);
  for (const language of templateLanguages) {
    const check = verification.templateChecks?.[language] ?? {
      compiled: false,
      executed: false,
      total: 0,
      passed: 0,
    };
    const languageLabel = translate(`ai_helper_testdata_verify_language_${language}`);
    rows.push(React.createElement(
      'div',
      { key: language, 'aria-label': languageLabel },
      React.createElement('div', { style: { fontWeight: 600, marginTop: '6px' } }, languageLabel),
      evidenceRow([
        booleanEvidence(translate('ai_helper_testdata_verify_compiled'), check.compiled, translate),
        booleanEvidence(translate('ai_helper_testdata_verify_executed'), check.executed, translate),
        React.createElement(
          'span',
          { key: 'passed' },
          `${translate('ai_helper_testdata_verify_passed')}: ${check.passed}/${check.total}`,
        ),
        boundedFailure(check.failureKind, TEMPLATE_FAILURE_KINDS, translate),
      ].filter((item): item is React.ReactElement => item !== null)),
    ));
  }

  const checker = verification.checkerCheck;
  if (checker) {
    const checkerLabel = translate('ai_helper_testdata_verify_checker');
    rows.push(React.createElement(
      'div',
      { key: 'checker', 'aria-label': checkerLabel },
      React.createElement('div', { style: { fontWeight: 600, marginTop: '6px' } }, checkerLabel),
      evidenceRow([
        booleanEvidence(translate('ai_helper_testdata_verify_checker_configured'), checker.configured, translate),
        booleanEvidence(translate('ai_helper_testdata_verify_checker_read'), checker.read, translate),
        booleanEvidence(translate('ai_helper_testdata_verify_compiled'), checker.compiled, translate),
        booleanEvidence(translate('ai_helper_testdata_verify_executed'), checker.executed, translate),
        React.createElement(
          'span',
          { key: 'passed' },
          `${translate('ai_helper_testdata_verify_passed')}: ${checker.passed}/${checker.total}`,
        ),
        React.createElement(
          'span',
          { key: 'infra' },
          `${translate('ai_helper_testdata_verify_infra_failures')}: ${checker.infraFailures}`,
        ),
        boundedFailure(checker.failureKind, CHECKER_FAILURE_KINDS, translate),
      ].filter((item): item is React.ReactElement => item !== null)),
    ));
  }

  const validator = verification.validator;
  if (validator) {
    const validatorLabel = translate('ai_helper_testdata_verify_validator');
    const hasExpandedEvidence = validator.ran === true
      && isNonNegativeSafeInteger(validator.casesChecked)
      && isNonNegativeSafeInteger(validator.validAccepted)
      && isNonNegativeSafeInteger(validator.invalidRejected)
      && isNonNegativeSafeInteger(validator.invalidAccepted)
      && areConsistentValidatorIdArrays(
        validator.coveredConstraintIds,
        validator.missingConstraintIds,
      );
    let validatorEvidence: React.ReactElement[];

    if (hasExpandedEvidence) {
      const coveredIds = new Set(validator.coveredConstraintIds);
      const allIds = new Set([
        ...validator.coveredConstraintIds,
        ...validator.missingConstraintIds,
      ]);
      validatorEvidence = [
        React.createElement(
          'span',
          { key: 'legal' },
          `${translate('ai_helper_testdata_verify_validator_legal')}: ${validator.validAccepted}/${validator.casesChecked}`,
        ),
        React.createElement(
          'span',
          { key: 'invalid-rejected' },
          `${translate('ai_helper_testdata_verify_validator_invalid_rejected')}: ${validator.invalidRejected}`,
        ),
        React.createElement(
          'span',
          { key: 'invalid-accepted' },
          `${translate('ai_helper_testdata_verify_validator_invalid_accepted')}: ${validator.invalidAccepted}`,
        ),
        React.createElement(
          'span',
          { key: 'coverage' },
          `${translate('ai_helper_testdata_verify_validator_coverage')}: ${coveredIds.size}/${allIds.size}`,
        ),
      ];
    } else {
      validatorEvidence = [React.createElement(
        'span',
        { key: 'legacy' },
        validator.ran === true && isNonNegativeSafeInteger(validator.casesChecked)
          ? String(validator.casesChecked)
          : translate('ai_helper_testdata_verify_validator_none'),
      )];
    }

    rows.push(React.createElement(
      'div',
      { key: 'validator', 'aria-label': validatorLabel },
      React.createElement('div', { style: { fontWeight: 600, marginTop: '6px' } }, validatorLabel),
      evidenceRow(validatorEvidence),
    ));
  }

  if (verification.mutation !== undefined) {
    const mutationLabel = translate('ai_helper_testdata_mutation_title');
    const mutation = isTrustedMutationSummary(verification.mutation)
      ? verification.mutation
      : undefined;
    const mutationEvidence = mutation ? [
      React.createElement(
        'span',
        { key: 'mode' },
        `${translate('ai_helper_testdata_mutation_mode')}: ${translate(`ai_helper_testdata_mutation_mode_${mutation.mode}`)}`,
      ),
      React.createElement(
        'span',
        { key: 'status' },
        `${translate('ai_helper_testdata_mutation_status')}: ${translate(`ai_helper_testdata_mutation_status_${mutation.status}`)}`,
      ),
      React.createElement(
        'strong',
        { key: 'score' },
        mutation.score === undefined
          ? translate('ai_helper_testdata_mutation_unavailable')
          : `${mutation.killed}/${mutation.viable} (${Math.round(mutation.score * 100)}%)`,
      ),
      React.createElement(
        'span',
        { key: 'generated' },
        `${translate('ai_helper_testdata_mutation_generated')}: ${mutation.generated}`,
      ),
      React.createElement(
        'span',
        { key: 'historical' },
        `${translate('ai_helper_testdata_mutation_historical')}: ${mutation.historical}`,
      ),
      React.createElement(
        'span',
        { key: 'viable' },
        `${translate('ai_helper_testdata_mutation_viable')}: ${mutation.viable}`,
      ),
      React.createElement(
        'span',
        { key: 'killed' },
        `${translate('ai_helper_testdata_mutation_killed')}: ${mutation.killed}`,
      ),
      React.createElement(
        'span',
        { key: 'survived' },
        `${translate('ai_helper_testdata_mutation_survived')}: ${mutation.survived}`,
      ),
      ...(mutation.skippedReason ? [React.createElement(
        'span',
        { key: 'skip' },
        `${translate('ai_helper_testdata_mutation_skip_reason')}: ${translate(`ai_helper_testdata_mutation_skip_${mutation.skippedReason.replace(/-/g, '_')}`)}`,
      )] : []),
      ...mutation.operators.map(operator => React.createElement(
        'span',
        { key: operator.id },
        `${translate(`ai_helper_testdata_mutation_operator_${operator.id.replace(/-/g, '_')}`)}: ${operator.killed}/${operator.viable}`,
      )),
    ] : [React.createElement(
      'strong',
      { key: 'unavailable' },
      translate('ai_helper_testdata_mutation_unavailable'),
    )];
    rows.push(React.createElement(
      'div',
      { key: 'mutation', 'aria-label': mutationLabel },
      React.createElement('div', { style: { fontWeight: 600, marginTop: '6px' } }, mutationLabel),
      evidenceRow(mutationEvidence),
    ));
  }

  return React.createElement(
    'section',
    { 'aria-label': translate('ai_helper_testdata_verify_evidence') },
    ...rows,
  );
}
