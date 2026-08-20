import React from 'react';
import { i18n } from '../utils/i18n';
import {
  COLORS, RADIUS, SPACING, getBadgeStyle, getButtonStyle, getInputStyle,
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
  const summarize = (chain: SelectedModel[]) => chain.map(item => item.modelName).join(' → ');

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
    React.createElement('span', { style: { flex: 1 } }, `${index + 1}. ${item.modelName}`),
    ...(['up', 'down', 'remove'] as const).map(action => React.createElement('button', {
      key: action,
      type: 'button',
      disabled: disabled || (action === 'up' && index === 0)
        || (action === 'down' && index === chain.length - 1),
      style: { ...getButtonStyle(action === 'remove' ? 'danger' : 'ghost'), padding: '2px 6px' },
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
    return React.createElement('div', {
      key: role,
      style: { padding: SPACING.sm, border: `1px solid ${COLORS.border}`, borderRadius: RADIUS.sm },
    },
    React.createElement('div', {
      style: { display: 'flex', alignItems: 'center', gap: SPACING.sm, flexWrap: 'wrap' },
    },
    React.createElement('span', { style: { fontSize: '13px', fontWeight: 600 } },
      i18n(`ai_helper_admin_testdata_role_${LABEL_SUFFIX[role]}`)),
    React.createElement('span', { style: getBadgeStyle(inherited ? 'info' : 'success') },
      inherited
        ? i18n('ai_helper_admin_testdata_role_inherited')
        : i18n('ai_helper_admin_scenario_custom')),
    !inherited ? React.createElement('button', {
      type: 'button',
      onClick: () => onChange(role, []),
      disabled,
      style: { ...getButtonStyle('ghost'), padding: '2px 8px', marginLeft: 'auto' },
    }, i18n('ai_helper_admin_scenario_reset')) : null),
    React.createElement('div', {
      style: { margin: `${SPACING.xs} 0`, fontSize: '12px', color: COLORS.textMuted },
    }, summarize(inherited ? fallbackModels : chain)
      || i18n('ai_helper_admin_scenario_global_empty')),
    ...chainElements,
    React.createElement('select', {
      value: '',
      disabled: disabled || options.length === 0,
      style: { ...getInputStyle(), maxWidth: '420px' },
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
      i18n('ai_helper_admin_testdata_role_add_model')), ...optionElements));
  });

  return React.createElement('details', { style: { marginTop: SPACING.md } },
    React.createElement('summary', {
      style: { cursor: 'pointer', fontWeight: 600, color: COLORS.textPrimary },
    }, i18n('ai_helper_admin_testdata_roles_title')),
    React.createElement('p', { style: { fontSize: '12px', color: COLORS.textMuted } },
      i18n('ai_helper_admin_testdata_roles_desc')),
    React.createElement('div', { style: { display: 'grid', gap: SPACING.sm } }, ...roleElements));
};
