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
}

type Translate = (key: string, ...args: Array<string | number>) => string;

const LANGUAGE_ORDER = ['py', 'java', 'cc'] as const;
const TEMPLATE_FAILURE_KINDS = new Set([
  'compile', 'runtime', 'budget', 'mismatch', 'checker-infra',
]);
const CHECKER_FAILURE_KINDS = new Set([
  'unavailable', 'compile', 'infra', 'budget', 'reject',
]);
const VALIDATOR_EVIDENCE_ID_MAX_LENGTH = 64;

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isBoundedValidatorIdArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
    const item = value[index];
    if (typeof item !== 'string'
      || item.length === 0
      || item.length > VALIDATOR_EVIDENCE_ID_MAX_LENGTH) return false;
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
      && isBoundedValidatorIdArray(validator.coveredConstraintIds)
      && isBoundedValidatorIdArray(validator.missingConstraintIds);
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

  return React.createElement(
    'section',
    { 'aria-label': translate('ai_helper_testdata_verify_evidence') },
    ...rows,
  );
}
