import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

jest.mock('../../../frontend/utils/i18n', () => ({
  i18n: (key: string, ...params: unknown[]) => (params.length ? `${key}(${params.join(',')})` : key),
}));

const { ScenarioModelSelector } = require('../../../frontend/admin/ScenarioModelSelector') as {
  ScenarioModelSelector: (props: Record<string, unknown>) => React.ReactElement;
};

const EMPTY_ROLES = { specPrimary: [], specCritic: [], oracle: [], artifacts: [], verifier: [], adjudicator: [] };
const EMPTY_SCENARIOS = { studentChat: [], learningSummary: [], teachingAnalysis: [], testdataGeneration: [], aiReview: [] };

const endpoints = [
  { id: 'ep-old', name: 'Old endpoint', apiBaseUrl: '', models: ['old-model'], enabled: false },
  { id: 'ep-new', name: 'New endpoint', apiBaseUrl: '', models: ['new-model'], enabled: true },
];

function render(overrides: Record<string, unknown>) {
  return renderToStaticMarkup(React.createElement(ScenarioModelSelector, {
    endpoints,
    globalModels: [],
    scenarioModels: EMPTY_SCENARIOS,
    onChange: jest.fn(),
    testdataRoleModels: EMPTY_ROLES,
    onTestdataRoleChange: jest.fn(),
    disabled: false,
    ...overrides,
  }));
}

describe('ScenarioModelSelector with a disabled endpoint', () => {
  it('shows a custom chain on a disabled endpoint as skipped and the scenario as following global', () => {
    const html = render({
      globalModels: [{ endpointId: 'ep-new', modelName: 'new-model' }],
      scenarioModels: { ...EMPTY_SCENARIOS, studentChat: [{ endpointId: 'ep-old', modelName: 'old-model' }] },
    });
    expect(html).toContain('ai_helper_admin_scenario_custom_unavailable');
    expect(html).toContain('ai_helper_admin_model_endpoint_disabled');
    expect(html).toContain('ai_helper_admin_scenario_effective_global(new-model)');
    // The reset button stays so the admin can clear the stale override.
    expect(html).toContain('ai_helper_admin_scenario_reset');
  });

  it('leaves disabled-endpoint models out of the effective global summary', () => {
    const html = render({
      globalModels: [
        { endpointId: 'ep-old', modelName: 'old-model' },
        { endpointId: 'ep-new', modelName: 'new-model' },
      ],
    });
    expect(html).toContain('ai_helper_admin_scenario_effective_global(new-model)');
    expect(html).not.toContain('old-model → new-model');
    // Disabled endpoints are not offered as new choices either.
    expect(html).not.toContain('value="ep-old::old-model"');
  });

  it('warns when every global model sits on a disabled endpoint', () => {
    const html = render({ globalModels: [{ endpointId: 'ep-old', modelName: 'old-model' }] });
    expect(html).toContain('ai_helper_admin_scenario_global_empty');
  });

  it('keeps a mixed chain customized and marks only the disabled entry', () => {
    const html = render({
      scenarioModels: {
        ...EMPTY_SCENARIOS,
        aiReview: [{ endpointId: 'ep-old', modelName: 'old-model' }, { endpointId: 'ep-new', modelName: 'new-model' }],
      },
    });
    expect(html).toContain('ai_helper_admin_scenario_custom<');
    expect(html).not.toContain('ai_helper_admin_scenario_custom_unavailable');
    expect(html.match(/ai_helper_admin_model_endpoint_disabled/g)).toHaveLength(1);
  });

  it('falls testdata roles back past a role chain whose endpoints are all disabled', () => {
    const html = render({
      globalModels: [{ endpointId: 'ep-new', modelName: 'new-model' }],
      testdataRoleModels: { ...EMPTY_ROLES, oracle: [{ endpointId: 'ep-old', modelName: 'old-model' }] },
    });
    expect(html).toContain('ai_helper_admin_testdata_role_custom_unavailable');
    expect(html).toContain('new-model (New endpoint)');
  });
});
