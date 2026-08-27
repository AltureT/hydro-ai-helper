import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

jest.mock('../../../frontend/utils/i18n', () => ({
  i18n: (key: string) => key,
}));

const { ProblemSpecSummaryView } = require(
  '../../../frontend/testdataGen/ProblemSpecSummaryView',
) as {
  ProblemSpecSummaryView: (props: {
    specSchemaVersion?: number;
    summary?: {
      statementHash: string;
      constraintCount: number;
      invariantCount: number;
      unresolvedUncertainties: number;
    };
    consensusStatus?: 'consensus' | 'adjudicated' | 'unresolved';
    conflictCount?: number;
    unresolvedConflictCount?: number;
    rolesUsed?: string[];
    translate?: (key: string, ...args: Array<string | number>) => string;
  }) => React.ReactElement | null;
};

const translations: Record<string, string> = {
  ai_helper_testdata_spec_summary_title: 'Problem specification summary',
  ai_helper_testdata_spec_schema_version: 'Spec schema version',
  ai_helper_testdata_spec_statement_hash: 'Statement hash',
  ai_helper_testdata_spec_constraint_count: 'Constraints',
  ai_helper_testdata_spec_invariant_count: 'Invariants',
  ai_helper_testdata_spec_uncertainty_count: 'Unresolved uncertainties',
  ai_helper_testdata_spec_evidence_validated: 'Evidence validated',
  ai_helper_testdata_spec_yes: 'Yes',
  ai_helper_testdata_spec_no: 'No',
  ai_helper_testdata_spec_unavailable: 'Unavailable',
};

function translate(key: string): string {
  return translations[key] ?? key;
}

describe('ProblemSpecSummaryView', () => {
  it('renders a collapsed evidence-validated summary with only a short hash prefix and counts', () => {
    const fullHash = '1234567890abcdef'.repeat(4);
    const markup = renderToStaticMarkup(React.createElement(ProblemSpecSummaryView, {
      specSchemaVersion: 1,
      summary: {
        statementHash: fullHash,
        constraintCount: 7,
        invariantCount: 3,
        unresolvedUncertainties: 2,
      },
      consensusStatus: 'adjudicated',
      conflictCount: 2,
      unresolvedConflictCount: 0,
      rolesUsed: ['specPrimary', 'specCritic', 'adjudicator'],
      translate,
    }));

    expect(markup).toContain('<details');
    expect(markup).toContain('<summary');
    expect(markup).toContain('Spec schema version');
    expect(markup).toContain('1');
    expect(markup).toContain('1234567890ab');
    expect(markup).not.toContain(fullHash);
    expect(markup).toContain('Constraints');
    expect(markup).toContain('7');
    expect(markup).toContain('Invariants');
    expect(markup).toContain('3');
    expect(markup).toContain('Unresolved uncertainties');
    expect(markup).toContain('2');
    expect(markup).toContain('Evidence validated');
    expect(markup).toContain('Yes');
    expect(markup).toContain('ai_helper_testdata_spec_consensus_status_adjudicated');
    expect(markup).toContain('ai_helper_testdata_spec_conflict_count');
    expect(markup).toContain('2');
    expect(markup).toContain('specPrimary');
    expect(markup).toContain('specCritic');
    expect(markup).toContain('adjudicator');
  });

  it('fails closed when extraction ran but no evidence-validated summary exists', () => {
    const markup = renderToStaticMarkup(React.createElement(ProblemSpecSummaryView, {
      specSchemaVersion: 1,
      translate,
    }));

    expect(markup).toContain('Spec schema version');
    expect(markup).toContain('Unavailable');
    expect(markup).toContain('Evidence validated');
    expect(markup).toContain('No');
  });

  it('renders nothing when the legacy path did not run extraction', () => {
    const markup = renderToStaticMarkup(React.createElement(ProblemSpecSummaryView, {
      translate,
    }));

    expect(markup).toBe('');
  });
});
