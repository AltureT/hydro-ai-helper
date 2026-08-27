import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

jest.mock('../../../frontend/utils/i18n', () => ({
  i18n: (key: string) => key,
}));

const { TestdataRoleModelSelector } = require(
  '../../../frontend/admin/TestdataRoleModelSelector',
) as {
  TestdataRoleModelSelector: (props: Record<string, unknown>) => React.ReactElement;
};

describe('TestdataRoleModelSelector', () => {
  it('renders six roles inside one collapsed advanced section without endpoint URLs or keys', () => {
    const markup = renderToStaticMarkup(React.createElement(TestdataRoleModelSelector, {
      endpoints: [{
        id: 'ep-1', name: 'Private endpoint', apiBaseUrl: 'https://private.example/v1',
        newApiKey: 'sk-private', models: ['model-a'], enabled: true,
      }],
      fallbackModels: [{ endpointId: 'ep-1', modelName: 'model-a' }],
      roleModels: {
        specPrimary: [], specCritic: [], oracle: [], artifacts: [], verifier: [], adjudicator: [],
      },
      onChange: jest.fn(),
      disabled: false,
    }));

    expect(markup).toContain('<details');
    expect(markup).toContain('ai_helper_admin_testdata_roles_title');
    for (const role of ['spec_primary', 'spec_critic', 'oracle', 'artifacts', 'verifier', 'adjudicator']) {
      expect(markup).toContain(`ai_helper_admin_testdata_role_${role}`);
    }
    expect(markup).not.toContain('https://private.example/v1');
    expect(markup).not.toContain('sk-private');
  });
});
