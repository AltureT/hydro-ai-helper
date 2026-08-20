import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

jest.mock('../../../frontend/utils/i18n', () => ({
  i18n: (key: string) => key,
}));

type VerificationSummaryData = {
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
};

const { VerificationSummaryView } = require(
  '../../../frontend/testdataGen/VerificationSummaryView',
) as {
  VerificationSummaryView: (props: {
    verification: VerificationSummaryData;
    translate?: (key: string, ...args: Array<string | number>) => string;
  }) => React.ReactElement;
};

const translations: Record<string, string> = {
  ai_helper_testdata_verify_evidence: 'Hard verification evidence',
  ai_helper_testdata_verify_status_verified: 'Verified',
  ai_helper_testdata_verify_status_unverified: 'Unverified',
  ai_helper_testdata_verify_status_would_block: 'Would block',
  ai_helper_testdata_verify_language_py: 'Python',
  ai_helper_testdata_verify_language_java: 'Java',
  ai_helper_testdata_verify_language_cc: 'C++',
  ai_helper_testdata_verify_compiled: 'Compiled',
  ai_helper_testdata_verify_executed: 'Executed',
  ai_helper_testdata_verify_checker: 'Checker',
  ai_helper_testdata_verify_checker_configured: 'Configured',
  ai_helper_testdata_verify_checker_read: 'Read',
  ai_helper_testdata_verify_passed: 'Passed',
  ai_helper_testdata_verify_infra_failures: 'Infrastructure failures',
  ai_helper_testdata_verify_failure: 'Failure',
  ai_helper_testdata_verify_failure_infra: 'infra',
  ai_helper_testdata_verify_validator: 'Input validation',
  ai_helper_testdata_verify_validator_none: 'No validator provided',
  ai_helper_testdata_verify_validator_legal: 'Legal inputs accepted',
  ai_helper_testdata_verify_validator_invalid_rejected: 'Invalid inputs rejected',
  ai_helper_testdata_verify_validator_invalid_accepted: 'Invalid inputs accepted',
  ai_helper_testdata_verify_validator_coverage: 'Constraint coverage',
  ai_helper_testdata_verify_yes: 'Yes',
  ai_helper_testdata_verify_no: 'No',
};

function translate(key: string, ...args: Array<string | number>): string {
  let value = translations[key] ?? key;
  args.forEach((arg, index) => {
    value = value.replace(`{${index}}`, String(arg));
  });
  return value;
}

function render(verification: VerificationSummaryData): string {
  return renderToStaticMarkup(React.createElement(VerificationSummaryView, {
    verification,
    translate,
  }));
}

const expandedValidatorLabels = [
  'Legal inputs accepted',
  'Invalid inputs rejected',
  'Invalid inputs accepted',
  'Constraint coverage',
];

function expectNoExpandedValidatorEvidence(markup: string): void {
  for (const label of expandedValidatorLabels) {
    expect(markup).not.toContain(label);
  }
}

describe('VerificationSummaryView', () => {
  it('renders authoritative success with stable per-language and checker evidence', () => {
    const markup = render({
      verified: true,
      wouldBlock: false,
      templateChecks: {
        cc: { compiled: true, executed: true, total: 4, passed: 4 },
        py: { compiled: true, executed: true, total: 4, passed: 4 },
        java: { compiled: true, executed: true, total: 4, passed: 4 },
      },
      checkerCheck: {
        configured: true,
        read: true,
        compiled: true,
        executed: true,
        total: 12,
        passed: 12,
        infraFailures: 0,
      },
    });

    expect(markup).toContain('Verified');
    expect(markup.indexOf('Python')).toBeLessThan(markup.indexOf('Java'));
    expect(markup.indexOf('Java')).toBeLessThan(markup.indexOf('C++'));
    expect(markup.match(/Compiled[^<]*<[^>]+>Yes/g)?.length).toBeGreaterThanOrEqual(4);
    expect(markup.match(/Executed[^<]*<[^>]+>Yes/g)?.length).toBeGreaterThanOrEqual(4);
    expect(markup.match(/4\/4/g)).toHaveLength(3);
    expect(markup).toContain('Read');
    expect(markup).toContain('12/12');
  });

  it('renders observe-mode infrastructure evidence as would-block and never verified', () => {
    const markup = render({
      verified: false,
      wouldBlock: true,
      checkerCheck: {
        configured: true,
        read: true,
        compiled: true,
        executed: false,
        total: 4,
        passed: 0,
        infraFailures: 4,
        failureKind: 'infra',
      },
    });

    expect(markup).toContain('Would block');
    expect(markup).not.toContain('Verified');
    expect(markup).toContain('Infrastructure failures');
    expect(markup).toContain('4');
    expect(markup).toContain('infra');
    expect(markup).not.toContain('Python');
    expect(markup).not.toContain('Java');
    expect(markup).not.toContain('C++');
  });

  it.each([
    ['direct', undefined],
    ['incomplete sandbox', {
      py: { compiled: true, executed: true, total: 4, passed: 4 },
    }],
  ])('renders a fail-closed row for every selected language in %s evidence', (_label, templateChecks) => {
    const markup = render({
      verified: false,
      wouldBlock: true,
      templateLanguages: ['cc', 'py', 'java', 'py'],
      templateChecks,
    });

    expect(markup.indexOf('Python')).toBeLessThan(markup.indexOf('Java'));
    expect(markup.indexOf('Java')).toBeLessThan(markup.indexOf('C++'));
    expect(markup.match(/aria-label="Python"/g)).toHaveLength(1);
    expect(markup.match(/aria-label="Java"/g)).toHaveLength(1);
    expect(markup.match(/aria-label="C\+\+"/g)).toHaveLength(1);
    if (templateChecks) {
      expect(markup).toContain('4/4');
      expect(markup.match(/0\/0/g)).toHaveLength(2);
    } else {
      expect(markup.match(/0\/0/g)).toHaveLength(3);
    }
  });

  it('fails closed for legacy verification data without authoritative evidence', () => {
    const markup = render({ mode: 'sandbox' } as unknown as VerificationSummaryData);

    expect(markup).toContain('Unverified');
    expect(markup).not.toContain('Verified');
    expect(markup).not.toContain('Would block');
  });

  it('does not render unrecognized failure details', () => {
    const markup = render({
      verified: false,
      templateChecks: {
        py: {
          compiled: false,
          executed: false,
          total: 4,
          passed: 0,
          failureKind: '/private/checker/source.cc',
        },
      },
    });

    expect(markup).toContain('Python');
    expect(markup).not.toContain('/private/checker/source.cc');
  });

  it('renders server-owned validator acceptance, rejection, and coverage', () => {
    const markup = render({
      verified: false,
      wouldBlock: true,
      validator: {
        ran: true,
        casesChecked: 12,
        validAccepted: 12,
        invalidRejected: 4,
        invalidAccepted: 1,
        coveredConstraintIds: ['C1', 'I1'],
        missingConstraintIds: ['C2'],
      },
    });

    expect(markup).toContain('12/12');
    expect(markup).toContain('4');
    expect(markup).toContain('1');
    expect(markup).toContain('2/3');
    expect(markup).not.toContain('C1');
    expect(markup).not.toContain('C2');
    expect(markup).not.toContain('I1');
  });

  it('deduplicates validator target IDs only for the coverage total', () => {
    const markup = render({
      validator: {
        ran: true,
        casesChecked: 2,
        validAccepted: 2,
        invalidRejected: 1,
        invalidAccepted: 0,
        coveredConstraintIds: ['C1', 'C1'],
        missingConstraintIds: ['C2', 'C2'],
      },
    });

    expect(markup).toContain('1/2');
    expect(markup).not.toContain('C1');
    expect(markup).not.toContain('C2');
  });

  it('deduplicates an ID that appears in both covered and missing totals', () => {
    const markup = render({
      validator: {
        ran: true,
        casesChecked: 2,
        validAccepted: 2,
        invalidRejected: 1,
        invalidAccepted: 0,
        coveredConstraintIds: ['C1'],
        missingConstraintIds: ['C1', 'C2'],
      },
    });

    expect(markup).toContain('1/2');
    expect(markup).not.toContain('C1');
    expect(markup).not.toContain('C2');
  });

  it('does not claim expanded evidence when the validator did not run', () => {
    const markup = render({
      validator: {
        ran: false,
        casesChecked: 12,
        validAccepted: 12,
        invalidRejected: 4,
        invalidAccepted: 0,
        coveredConstraintIds: ['C1'],
        missingConstraintIds: [],
      },
    });

    expect(markup).toContain('No validator provided');
    expect(markup).not.toContain('12/12');
    expectNoExpandedValidatorEvidence(markup);
  });

  describe.each([
    'casesChecked',
    'validAccepted',
    'invalidRejected',
    'invalidAccepted',
  ] as const)('%s count validation', field => {
    it.each([
      ['negative', -1],
      ['NaN', Number.NaN],
      ['fractional', 1.5],
      ['unsafe', Number.MAX_SAFE_INTEGER + 1],
    ])('does not render %s evidence', (_label, invalidValue) => {
      const markup = render({
        validator: {
          ran: true,
          casesChecked: 12,
          validAccepted: 12,
          invalidRejected: 4,
          invalidAccepted: 0,
          coveredConstraintIds: ['C1'],
          missingConstraintIds: [],
          [field]: invalidValue,
        },
      });

      expectNoExpandedValidatorEvidence(markup);
      expect(markup).not.toContain(String(invalidValue));
      if (field === 'casesChecked') {
        expect(markup).toContain('No validator provided');
      } else {
        expect(markup).toContain('12');
        expect(markup).not.toContain('No validator provided');
      }
    });
  });

  it.each([
    ['covered is not an array', { coveredConstraintIds: null }],
    ['missing is not an array', { missingConstraintIds: {} }],
    ['covered contains a non-string', { coveredConstraintIds: [1] }],
    ['missing contains a non-string', { missingConstraintIds: [false] }],
    ['covered contains an empty ID', { coveredConstraintIds: [''] }],
    ['missing contains an overlong ID', { missingConstraintIds: ['X'.repeat(65)] }],
  ])('falls back without expanded labels when %s', (_label, malformed) => {
    const markup = render({
      validator: {
        ran: true,
        casesChecked: 12,
        validAccepted: 12,
        invalidRejected: 4,
        invalidAccepted: 0,
        coveredConstraintIds: ['C1'],
        missingConstraintIds: [],
        ...malformed,
      } as unknown as NonNullable<VerificationSummaryData['validator']>,
    });

    expect(markup).toContain('12');
    expectNoExpandedValidatorEvidence(markup);
    expect(markup).not.toContain('C1');
    expect(markup).not.toContain('X'.repeat(65));
  });

  it.each([
    ['covered', (() => {
      const ids = new Array<string>(2);
      ids[1] = 'C1';
      return { coveredConstraintIds: ids };
    })()],
    ['missing', (() => {
      const ids = new Array<string>(2);
      ids[1] = 'C2';
      return { missingConstraintIds: ids };
    })()],
  ])('falls back to valid legacy evidence for a sparse %s array', (_label, sparse) => {
    const markup = render({
      validator: {
        ran: true,
        casesChecked: 12,
        validAccepted: 12,
        invalidRejected: 4,
        invalidAccepted: 0,
        coveredConstraintIds: ['C1'],
        missingConstraintIds: [],
        ...sparse,
      },
    });

    expect(markup).toContain('12');
    expect(markup).not.toContain('No validator provided');
    expectNoExpandedValidatorEvidence(markup);
    expect(markup).not.toContain('C1');
    expect(markup).not.toContain('C2');
  });

  it('renders zero as valid expanded evidence', () => {
    const markup = render({
      validator: {
        ran: true,
        casesChecked: 0,
        validAccepted: 0,
        invalidRejected: 0,
        invalidAccepted: 0,
        coveredConstraintIds: [],
        missingConstraintIds: [],
      },
    });

    expect(markup).toContain('Legal inputs accepted');
    expect(markup).toContain('0/0');
    expect(markup).not.toContain('No validator provided');
  });

  it('falls back to ran and casesChecked for legacy validator evidence', () => {
    const markup = render({
      validator: { ran: true, casesChecked: 7 },
    });

    expect(markup).toContain('7');
    expectNoExpandedValidatorEvidence(markup);
  });
});
