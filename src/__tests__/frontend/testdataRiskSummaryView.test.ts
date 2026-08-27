import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

type TestdataRiskAssessment = {
  tier: 'low' | 'medium' | 'high' | 'blocked';
  score: number;
  reasons: Array<{ code: string; weight: number; messageKey: string }>;
  requiresSandbox: boolean;
  requiresSpecConsensus: boolean;
  requiresIndependentModels: boolean;
  allowsDirectFallback: boolean;
  wouldBlock?: boolean;
};

const { TestdataRiskSummaryView } = require(
  '../../../frontend/testdataGen/TestdataRiskSummaryView',
) as {
  TestdataRiskSummaryView: (props: {
    risk: TestdataRiskAssessment;
    reliabilityMode: 'legacy' | 'observe' | 'enforce';
    translate: (key: string) => string;
  }) => React.ReactElement;
};

const translations: Record<string, string> = {
  ai_helper_testdata_risk_title: 'Risk',
  ai_helper_testdata_risk_tier_low: 'Low',
  ai_helper_testdata_risk_requires_sandbox: 'Sandbox',
  ai_helper_testdata_risk_direct_allowed: 'Direct',
  ai_helper_testdata_risk_requires_consensus: 'Consensus',
  ai_helper_testdata_risk_requires_independent_models: 'Independent models',
  ai_helper_testdata_risk_mode: 'Mode',
  ai_helper_testdata_risk_yes: 'Yes',
  ai_helper_testdata_risk_no: 'No',
  ai_helper_testdata_risk_would_block: 'This run would be blocked',
};

function translate(key: string): string {
  return translations[key] ?? key;
}

function risk(wouldBlock?: boolean): TestdataRiskAssessment {
  return {
    tier: 'low',
    score: 0,
    reasons: [],
    requiresSandbox: false,
    requiresSpecConsensus: false,
    requiresIndependentModels: false,
    allowsDirectFallback: true,
    ...(wouldBlock === undefined ? {} : { wouldBlock }),
  };
}

function render(wouldBlock?: boolean): string {
  return renderToStaticMarkup(React.createElement(TestdataRiskSummaryView, {
    risk: risk(wouldBlock),
    reliabilityMode: 'observe',
    translate,
  }));
}

describe('TestdataRiskSummaryView', () => {
  it('shows the enforce-blocking banner only for an actual runtime event', () => {
    expect(render(true)).toContain('This run would be blocked');
    expect(render(false)).not.toContain('This run would be blocked');
    expect(render()).not.toContain('This run would be blocked');
  });
});
