import React from 'react';
import { i18n } from '../utils/i18n';
import {
  COLORS, SPACING, RADIUS,
  getInputStyle, getButtonStyle, getBadgeStyle,
} from '../utils/styles';
import type { Endpoint, SelectedModel, AIScenarioKey, ScenarioModelsState } from './configTypes';
import { AI_SCENARIO_KEYS } from './configTypes';

interface ScenarioModelSelectorProps {
  endpoints: Endpoint[];
  /** 全局默认模型链（用于展示"跟随全局"场景当前实际生效的模型） */
  globalModels: SelectedModel[];
  scenarioModels: ScenarioModelsState;
  onChange: (scenario: AIScenarioKey, chain: SelectedModel[]) => void;
  disabled: boolean;
}

/** 把模型链概括成 "a → b → c" 的短文本（最多 3 个，多余折叠） */
function summarizeChain(chain: SelectedModel[]): string {
  const names = chain.map(sm => sm.modelName);
  const shown = names.slice(0, 3).join(' → ');
  return names.length > 3 ? `${shown} → +${names.length - 3}` : shown;
}

const SCENARIO_META: Record<AIScenarioKey, { labelKey: string; descKey: string; icon: string }> = {
  studentChat: {
    labelKey: 'ai_helper_admin_scenario_student_chat',
    descKey: 'ai_helper_admin_scenario_student_chat_desc',
    icon: '💬',
  },
  learningSummary: {
    labelKey: 'ai_helper_admin_scenario_learning_summary',
    descKey: 'ai_helper_admin_scenario_learning_summary_desc',
    icon: '📝',
  },
  teachingAnalysis: {
    labelKey: 'ai_helper_admin_scenario_teaching_analysis',
    descKey: 'ai_helper_admin_scenario_teaching_analysis_desc',
    icon: '📊',
  },
};

const OPTION_SEPARATOR = '::';

export const ScenarioModelSelector: React.FC<ScenarioModelSelectorProps> = ({
  endpoints, globalModels, scenarioModels, onChange, disabled,
}) => {
  // 可供选择的 端点×模型 组合（未保存端点的临时 ID 会在保存时由后端重映射为真实 ID）
  const modelOptions: Array<{ endpointId: string; endpointName: string; modelName: string }> = [];
  for (const ep of endpoints) {
    if (!ep.id || !ep.enabled) continue;
    for (const model of ep.models) {
      modelOptions.push({ endpointId: ep.id, endpointName: ep.name, modelName: model });
    }
  }

  const endpointName = (endpointId: string) =>
    endpoints.find(e => e.id === endpointId)?.name || i18n('ai_helper_admin_endpoint_unknown');

  const addModel = (scenario: AIScenarioKey, optionValue: string) => {
    if (!optionValue) return;
    const sepIndex = optionValue.indexOf(OPTION_SEPARATOR);
    if (sepIndex <= 0) return;
    const endpointId = optionValue.slice(0, sepIndex);
    const modelName = optionValue.slice(sepIndex + OPTION_SEPARATOR.length);
    const chain = scenarioModels[scenario];
    if (chain.some(sm => sm.endpointId === endpointId && sm.modelName === modelName)) return;
    onChange(scenario, [...chain, { endpointId, modelName }]);
  };

  const removeModel = (scenario: AIScenarioKey, index: number) => {
    onChange(scenario, scenarioModels[scenario].filter((_, i) => i !== index));
  };

  const moveModel = (scenario: AIScenarioKey, index: number, direction: 'up' | 'down') => {
    const chain = [...scenarioModels[scenario]];
    const ni = direction === 'up' ? index - 1 : index + 1;
    if (ni < 0 || ni >= chain.length) return;
    [chain[index], chain[ni]] = [chain[ni], chain[index]];
    onChange(scenario, chain);
  };

  return (
    <div>
      <h2 style={{ marginTop: 0, marginBottom: SPACING.sm, fontSize: '18px', color: COLORS.textPrimary }}>
        {i18n('ai_helper_admin_scenario_title')}
      </h2>
      <p style={{ fontSize: '13px', color: COLORS.textMuted, marginTop: 0, marginBottom: SPACING.base }}>
        {i18n('ai_helper_admin_scenario_desc')}
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: SPACING.md }}>
        {AI_SCENARIO_KEYS.map((scenario) => {
          const meta = SCENARIO_META[scenario];
          const chain = scenarioModels[scenario];
          const isDefault = chain.length === 0;

          return (
            <div
              key={scenario}
              style={{
                padding: SPACING.base, backgroundColor: COLORS.bgCard,
                borderRadius: RADIUS.md, border: `1px solid ${COLORS.border}`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: SPACING.sm, marginBottom: SPACING.xs, flexWrap: 'wrap' }}>
                <span style={{ fontSize: '16px' }}>{meta.icon}</span>
                <span style={{ fontSize: '14px', fontWeight: 600, color: COLORS.textPrimary }}>{i18n(meta.labelKey)}</span>
                {isDefault ? (
                  <span style={getBadgeStyle('info')}>{i18n('ai_helper_admin_scenario_follow_global')}</span>
                ) : (
                  <span style={getBadgeStyle('success')}>{i18n('ai_helper_admin_scenario_custom')}</span>
                )}
                {!isDefault && (
                  <button
                    onClick={() => onChange(scenario, [])}
                    disabled={disabled}
                    style={{
                      ...getButtonStyle('ghost'),
                      padding: '2px 8px', fontSize: '12px', marginLeft: 'auto',
                      cursor: disabled ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {i18n('ai_helper_admin_scenario_reset')}
                  </button>
                )}
              </div>
              <p style={{ fontSize: '12px', color: COLORS.textMuted, margin: `0 0 ${SPACING.sm}` }}>
                {i18n(meta.descKey)}
              </p>

              {isDefault && (
                <div style={{
                  fontSize: '12px', marginBottom: SPACING.sm,
                  color: globalModels.length > 0 ? COLORS.textSecondary : COLORS.warningText,
                }}>
                  {globalModels.length > 0
                    ? i18n('ai_helper_admin_scenario_effective_global', summarizeChain(globalModels))
                    : i18n('ai_helper_admin_scenario_global_empty')}
                </div>
              )}

              {!isDefault && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: SPACING.xs, marginBottom: SPACING.sm }}>
                  {chain.map((sm, index) => (
                    <div
                      key={`${sm.endpointId}-${sm.modelName}`}
                      style={{
                        display: 'flex', alignItems: 'center', padding: `${SPACING.xs} ${SPACING.md}`,
                        backgroundColor: COLORS.bgPage, borderRadius: RADIUS.sm, border: `1px solid ${COLORS.border}`,
                      }}
                    >
                      <span style={{
                        width: '20px', height: '20px', borderRadius: '50%',
                        backgroundColor: COLORS.primaryLight, color: COLORS.primary,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: '11px', fontWeight: 600, marginRight: SPACING.sm, flexShrink: 0,
                      }}>
                        {index + 1}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ fontSize: '13px', fontWeight: 500, color: COLORS.textPrimary }}>{sm.modelName}</span>
                        <span style={{ fontSize: '12px', color: COLORS.textMuted, marginLeft: SPACING.sm }}>{endpointName(sm.endpointId)}</span>
                      </div>
                      <div style={{ display: 'flex', gap: '4px' }}>
                        <button
                          onClick={() => moveModel(scenario, index, 'up')}
                          disabled={disabled || index === 0}
                          style={{
                            ...getButtonStyle('ghost'), padding: '2px 6px', fontSize: '12px',
                            cursor: (disabled || index === 0) ? 'not-allowed' : 'pointer',
                            opacity: (disabled || index === 0) ? 0.5 : 1,
                          }}
                        >
                          ↑
                        </button>
                        <button
                          onClick={() => moveModel(scenario, index, 'down')}
                          disabled={disabled || index === chain.length - 1}
                          style={{
                            ...getButtonStyle('ghost'), padding: '2px 6px', fontSize: '12px',
                            cursor: (disabled || index === chain.length - 1) ? 'not-allowed' : 'pointer',
                            opacity: (disabled || index === chain.length - 1) ? 0.5 : 1,
                          }}
                        >
                          ↓
                        </button>
                        <button
                          onClick={() => removeModel(scenario, index)}
                          disabled={disabled}
                          style={{
                            ...getButtonStyle('danger'), padding: '2px 6px', fontSize: '12px',
                            cursor: disabled ? 'not-allowed' : 'pointer',
                          }}
                        >
                          ×
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {modelOptions.length > 0 ? (
                <select
                  value=""
                  onChange={(e) => addModel(scenario, e.target.value)}
                  disabled={disabled}
                  style={{ ...getInputStyle(), maxWidth: '420px', cursor: disabled ? 'not-allowed' : 'pointer' }}
                >
                  <option value="">
                    {isDefault
                      ? i18n('ai_helper_admin_scenario_add_model_override')
                      : i18n('ai_helper_admin_scenario_add_model')}
                  </option>
                  {modelOptions.map(opt => (
                    <option
                      key={`${opt.endpointId}${OPTION_SEPARATOR}${opt.modelName}`}
                      value={`${opt.endpointId}${OPTION_SEPARATOR}${opt.modelName}`}
                      disabled={chain.some(sm => sm.endpointId === opt.endpointId && sm.modelName === opt.modelName)}
                    >
                      {opt.modelName} — {opt.endpointName}
                    </option>
                  ))}
                </select>
              ) : (
                <div style={{ fontSize: '12px', color: COLORS.textMuted }}>
                  {i18n('ai_helper_admin_scenario_no_models')}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
