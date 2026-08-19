import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

jest.mock('../../../frontend/utils/i18n', () => ({
  i18n: (key: string) => key,
}));

type VerificationSummaryData = {
  verified?: boolean;
  wouldBlock?: boolean;
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
});
