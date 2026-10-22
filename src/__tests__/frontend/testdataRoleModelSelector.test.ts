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

it('keeps inline recommendations separate from saved model chains', () => {
  const onChange = jest.fn();
  const roles = ['specPrimary', 'specCritic', 'oracle', 'artifacts', 'verifier', 'adjudicator'];
  const roleModels = Object.fromEntries(roles.map(role => [role, []]));
  const tree = TestdataRoleModelSelector({
    endpoints: [{ id: 'ep', name: 'Example', models: ['custom-model'], enabled: true }],
    fallbackModels: [{ endpointId: 'ep', modelName: 'custom-model' }],
    roleModels, onChange, disabled: false,
  });
  const elements: React.ReactElement[] = [];
  const visit = (element: React.ReactNode) => {
    if (!React.isValidElement(element)) return;
    elements.push(element);
    React.Children.forEach(element.props.children, visit);
  };
  visit(tree);
  expect(onChange).not.toHaveBeenCalled();
  const recommendations = elements.filter(element => element.props.className === 'role-model-recommendation');
  expect(recommendations).toHaveLength(6);
  expect(renderToStaticMarkup(tree)).not.toContain('role-model-example');
  expect(elements.filter(element => element.type === 'option' && element.props.value)).toHaveLength(6);
  const select = elements.find(element => element.type === 'select');
  select?.props.onChange({ currentTarget: { value: 'ep::custom-model' } });
  expect(onChange).toHaveBeenCalledWith('specPrimary', [{ endpointId: 'ep', modelName: 'custom-model' }]);
  expect(roleModels.specPrimary).toEqual([]);
});
