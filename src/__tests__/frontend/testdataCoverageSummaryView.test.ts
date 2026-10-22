import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

jest.mock('../../../frontend/utils/i18n', () => ({
  i18n: (key: string) => key,
}));

const { CoverageSummaryView } = require(
  '../../../frontend/testdataGen/CoverageSummaryView',
) as {
  CoverageSummaryView: (props: {
    coverage: {
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
    };
    translate?: (key: string, ...args: Array<string | number>) => string;
  }) => React.ReactElement;
};

const translations: Record<string, string> = {
  ai_helper_testdata_semantic_coverage_title: 'Semantic coverage',
  ai_helper_testdata_semantic_coverage_trusted: 'Server verified from structured values',
  ai_helper_testdata_semantic_coverage_unverified: 'AI generator coverage is unverified',
  ai_helper_testdata_semantic_coverage_target: 'Target',
  ai_helper_testdata_semantic_coverage_required: 'Required',
  ai_helper_testdata_semantic_coverage_actual: 'Actual',
  ai_helper_testdata_semantic_coverage_status: 'Status',
  ai_helper_testdata_semantic_coverage_pass: 'PASS',
  ai_helper_testdata_semantic_coverage_fail: 'FAIL',
  ai_helper_testdata_semantic_coverage_target_size_min: 'Minimum size',
  ai_helper_testdata_semantic_coverage_target_tree_chain: 'Chain tree',
  ai_helper_testdata_subtask_label: 'Subtask {0}',
};

function translate(key: string, ...args: Array<string | number>): string {
  return (translations[key] ?? key).replace(/\{(\d+)\}/g, (_match, index: string) => (
    String(args[Number(index)] ?? '')
  ));
}

describe('CoverageSummaryView', () => {
  it('renders a localized required/actual/status matrix for trusted structured coverage', () => {
    const markup = renderToStaticMarkup(React.createElement(CoverageSummaryView, {
      translate,
      coverage: {
        mode: 'trusted-dsl',
        totalTargets: 2,
        passedTargets: 1,
        criticalMissing: 1,
        matrix: [
          {
            targetKey: 'size-min', required: 1, actual: 1, status: 'pass', critical: true,
          },
          {
            targetKey: 'tree-chain', required: 1, actual: 0, status: 'fail', critical: true,
          },
        ],
      },
    }));

    expect(markup).toContain('Semantic coverage');
    expect(markup).toContain('Server verified from structured values');
    expect(markup).toContain('Minimum size');
    expect(markup).toContain('Chain tree');
    expect(markup).toContain('PASS');
    expect(markup).toContain('FAIL');
    expect(markup).toContain('>1<');
    expect(markup).toContain('>0<');
  });

  it('shows an honest unverified state without rendering model-claimed rows', () => {
    const markup = renderToStaticMarkup(React.createElement(CoverageSummaryView, {
      translate,
      coverage: {
        mode: 'ai-generator-unverified',
        totalTargets: 0,
        passedTargets: 0,
        criticalMissing: 0,
        matrix: [{
          targetKey: 'model-claims-covered', required: 1, actual: 1,
          status: 'pass', critical: false,
        }],
      },
    }));

    expect(markup).toContain('AI generator coverage is unverified');
    expect(markup).not.toContain('model-claims-covered');
    expect(markup).not.toContain('<table');
  });

  it('fails closed to unverified for unknown target keys and impossible counts', () => {
    const markup = renderToStaticMarkup(React.createElement(CoverageSummaryView, {
      translate,
      coverage: {
        mode: 'trusted-dsl',
        totalTargets: 1,
        passedTargets: 1,
        criticalMissing: 0,
        matrix: [{
          targetKey: '/private/problem-statement', required: 1, actual: 2,
          status: 'pass', critical: true,
        }],
      },
    }));

    expect(markup).toContain('AI generator coverage is unverified');
    expect(markup).not.toContain('/private/problem-statement');
  });

  it('renders validated field and subtask scope without ambiguous duplicate row keys', () => {
    const markup = renderToStaticMarkup(React.createElement(CoverageSummaryView, {
      translate,
      coverage: {
        mode: 'trusted-dsl',
        totalTargets: 2,
        passedTargets: 1,
        criticalMissing: 1,
        matrix: [
          {
            targetKey: 'size-min', fieldId: 'n', subtaskId: 1,
            required: 1, actual: 1, status: 'pass', critical: true,
          },
          {
            targetKey: 'size-min', fieldId: 'n', subtaskId: 2,
            required: 1, actual: 0, status: 'fail', critical: true,
          },
        ],
      },
    }));

    expect(markup).toContain('Minimum size');
    expect(markup).toContain('n · Subtask 1');
    expect(markup).toContain('n · Subtask 2');
  });

  it.each([
    [{ fieldId: '<script>' }],
    [{ subtaskId: 0 }],
    [{ subtaskId: 1.5 }],
  ])('fails closed for invalid scoped row metadata: %j', scope => {
    const markup = renderToStaticMarkup(React.createElement(CoverageSummaryView, {
      translate,
      coverage: {
        mode: 'trusted-dsl',
        totalTargets: 1,
        passedTargets: 1,
        criticalMissing: 0,
        matrix: [{
          targetKey: 'size-min', required: 1, actual: 1,
          status: 'pass', critical: true, ...scope,
        }],
      },
    }));

    expect(markup).toContain('AI generator coverage is unverified');
    expect(markup).not.toContain('<table');
  });
});
