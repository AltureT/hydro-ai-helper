import React from 'react';
import { i18n } from '../utils/i18n';
import {
  COLORS, SPACING, getButtonStyle, getInputStyle,
} from '../utils/styles';
import {
  TESTDATA_MODEL_ROLES,
  type Endpoint,
  type SelectedModel,
  type TestdataModelRole,
  type TestdataRoleModelsState,
} from './configTypes';

interface TestdataRoleModelSelectorProps {
  endpoints: Endpoint[];
  fallbackModels: SelectedModel[];
  roleModels: TestdataRoleModelsState;
  onChange: (role: TestdataModelRole, chain: SelectedModel[]) => void;
  disabled: boolean;
}

const LABEL_SUFFIX: Record<TestdataModelRole, string> = {
  specPrimary: 'spec_primary',
  specCritic: 'spec_critic',
  oracle: 'oracle',
  artifacts: 'artifacts',
  verifier: 'verifier',
  adjudicator: 'adjudicator',
};

const SEPARATOR = '::';

const roleStyles = `
  .testdata-model-roles { margin-top: 20px; border-top: 1px solid ${COLORS.border}; padding-top: 16px; }
  .testdata-model-roles summary { cursor: pointer; }
  .testdata-model-roles summary:focus-visible, .testdata-model-roles button:focus-visible,
  .testdata-model-roles select:focus-visible { outline: 2px solid ${COLORS.primary}; outline-offset: 3px; }
  .testdata-model-role { border-top: 1px solid ${COLORS.border}; }
  .testdata-model-role:last-child { border-bottom: 1px solid ${COLORS.border}; }
  .testdata-model-role > summary { display: grid; grid-template-columns: 132px minmax(0, 1fr) auto;
    align-items: center; gap: 12px; padding: 13px 4px; list-style: none; font-size: 13px; }
  .testdata-model-role > summary::-webkit-details-marker { display: none; }
  .testdata-model-role > summary:hover { background: ${COLORS.bgPage}; }
  .testdata-model-role .role-model-summary { min-width: 0; overflow-wrap: anywhere; color: ${COLORS.textSecondary}; }
  .testdata-model-role .role-model-source { display: block; font-size: 12px; margin-top: 2px; color: ${COLORS.secondary}; }
  .testdata-model-role .role-model-edit { color: ${COLORS.primary}; font-size: 12px; white-space: nowrap; }
  .testdata-model-role[open] .role-model-edit { color: ${COLORS.textSecondary}; }
  .testdata-model-role .role-model-editor { padding: 4px 4px 16px 148px; max-width: 720px; }
  @media (max-width: 600px) {
    .testdata-model-role > summary { grid-template-columns: minmax(0, 1fr) auto; gap: 4px 12px; }
    .testdata-model-role .role-model-summary { grid-row: 2; }
    .testdata-model-role .role-model-edit { grid-column: 2; grid-row: 1 / span 2; }
    .testdata-model-role .role-model-editor { padding-left: 4px; }
  }
`;

export const TestdataRoleModelSelector: React.FC<TestdataRoleModelSelectorProps> = ({
  endpoints, fallbackModels, roleModels, onChange, disabled,
}) => {
  const options = endpoints.flatMap(endpoint => (
    endpoint.id && endpoint.enabled
      ? endpoint.models.map(modelName => ({
        endpointId: endpoint.id as string,
        endpointName: endpoint.name,
        modelName,
      }))
      : []
  ));
  const summarize = (chain: SelectedModel[]) => chain.map(item => {
    const endpoint = endpoints.find(candidate => candidate.id === item.endpointId);
    return `${item.modelName}${endpoint ? ` (${endpoint.name})` : ''}`;
  }).join(' → ');

  const roleElements = TESTDATA_MODEL_ROLES.map(role => {
    const chain = roleModels[role] || [];
    const inherited = chain.length === 0;
    const chainElements = chain.map((item, index) => React.createElement('div', {
      key: `${role}-${item.endpointId}-${item.modelName}`,
      style: {
        display: 'flex', alignItems: 'center', gap: SPACING.xs,
        marginTop: SPACING.xs, fontSize: '12px', color: COLORS.textPrimary,
      },
    },
    React.createElement('span', { style: { flex: 1, minWidth: 0, overflowWrap: 'anywhere' } }, `${index + 1}. ${item.modelName}`),
    ...(['up', 'down', 'remove'] as const).map(action => React.createElement('button', {
      key: action,
      type: 'button',
      'aria-label': `${i18n(`ai_helper_admin_model_${action}`)} ${item.modelName}`,
      disabled: disabled || (action === 'up' && index === 0)
        || (action === 'down' && index === chain.length - 1),
      style: { ...getButtonStyle('ghost'), padding: '4px 8px', minHeight: '32px' },
      onClick: () => {
        if (action === 'remove') {
          onChange(role, chain.filter((_, itemIndex) => itemIndex !== index));
          return;
        }
        const target = action === 'up' ? index - 1 : index + 1;
        if (target < 0 || target >= chain.length) return;
        const moved = [...chain];
        [moved[index], moved[target]] = [moved[target], moved[index]];
        onChange(role, moved);
      },
    }, action === 'up' ? '↑' : action === 'down' ? '↓' : '×'))));
    const optionElements = options.map(option => React.createElement('option', {
      key: `${role}-${option.endpointId}-${option.modelName}`,
      value: `${option.endpointId}${SEPARATOR}${option.modelName}`,
      disabled: chain.some(item => item.endpointId === option.endpointId
        && item.modelName === option.modelName),
    }, `${option.modelName} — ${option.endpointName}`));
    const roleLabel = i18n(`ai_helper_admin_testdata_role_${LABEL_SUFFIX[role]}`);
    return React.createElement('details', {
      key: role,
      className: 'testdata-model-role',
    },
    React.createElement('summary', null,
      React.createElement('span', { style: { fontWeight: 600, color: COLORS.textPrimary } }, roleLabel),
      React.createElement('span', { className: 'role-model-summary' },
        summarize(inherited ? fallbackModels : chain) || i18n('ai_helper_admin_testdata_role_no_model'),
        React.createElement('span', { className: 'role-model-source' },
      inherited
        ? i18n('ai_helper_admin_testdata_role_inherited')
        : i18n('ai_helper_admin_scenario_custom'))),
      React.createElement('span', { className: 'role-model-edit' }, i18n('ai_helper_admin_testdata_role_configure'))),
    React.createElement('div', { className: 'role-model-editor' },
    !inherited ? React.createElement('button', {
      type: 'button',
      onClick: () => onChange(role, []),
      disabled,
      style: { ...getButtonStyle('ghost'), padding: '4px 0', fontSize: '12px' },
    }, i18n('ai_helper_admin_testdata_role_reset')) : null,
    ...chainElements,
    React.createElement('select', {
      value: '',
      'aria-label': `${roleLabel}: ${i18n('ai_helper_admin_testdata_role_add_model')}`,
      disabled: disabled || options.length === 0,
      style: { ...getInputStyle(), fontSize: '13px', marginTop: SPACING.sm },
      onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
        const value = (event.currentTarget as unknown as { value: string }).value;
        const split = value.indexOf(SEPARATOR);
        if (split <= 0) return;
        const selected = {
          endpointId: value.slice(0, split),
          modelName: value.slice(split + SEPARATOR.length),
        };
        if (!chain.some(item => item.endpointId === selected.endpointId
          && item.modelName === selected.modelName)) onChange(role, [...chain, selected]);
      },
    }, React.createElement('option', { value: '' },
      i18n('ai_helper_admin_testdata_role_add_model')), ...optionElements)));
  });

  return React.createElement('details', { className: 'testdata-model-roles' },
    React.createElement('style', null, roleStyles),
    React.createElement('summary', {
      style: { cursor: 'pointer', fontWeight: 600, color: COLORS.textPrimary },
    }, i18n('ai_helper_admin_testdata_roles_title')),
    React.createElement('p', { style: { fontSize: '13px', color: COLORS.textSecondary, margin: '8px 0 16px' } },
      i18n('ai_helper_admin_testdata_roles_desc')),
    React.createElement('div', null, ...roleElements));
};
