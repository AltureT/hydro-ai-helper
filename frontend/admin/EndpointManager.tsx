import React, { useState } from 'react';
import {
  COLORS, SPACING, RADIUS, SHADOWS, TRANSITIONS,
  getInputStyle, getButtonStyle, getBadgeStyle,
} from '../utils/styles';
import type { Endpoint, SelectedModel } from './configTypes';

interface LegacyConfig {
  apiBaseUrl: string;
  modelName: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
  newApiKey: string;
  showApiKey: boolean;
  onApiBaseUrlChange: (value: string) => void;
  onModelNameChange: (value: string) => void;
  onNewApiKeyChange: (value: string) => void;
  onShowApiKeyToggle: () => void;
}

interface EndpointManagerProps {
  endpoints: Endpoint[];
  selectedModels: SelectedModel[];
  onUpdateEndpoint: (index: number, updates: Partial<Endpoint>) => void;
  onRemoveEndpoint: (index: number) => void;
  onAddEndpoint: () => void;
  onFetchModels: (index: number) => void;
  fetchingModels: string | null;
  onAddSelectedModel: (endpointId: string, modelName: string) => void;
  onRemoveSelectedModel: (index: number) => void;
  onMoveSelectedModel: (index: number, direction: 'up' | 'down') => void;
  disabled: boolean;
  legacy: LegacyConfig;
}

const sectionStyle: React.CSSProperties = {
  padding: '0', backgroundColor: 'transparent', borderRadius: '0', border: 'none',
};

export const EndpointManager: React.FC<EndpointManagerProps> = ({
  endpoints, selectedModels,
  onUpdateEndpoint, onRemoveEndpoint, onAddEndpoint, onFetchModels, fetchingModels,
  onAddSelectedModel, onRemoveSelectedModel, onMoveSelectedModel,
  disabled, legacy,
}) => {
  const isUsingNewConfig = endpoints.length > 0;
  const hasLegacyData = Boolean(legacy.apiBaseUrl || legacy.hasApiKey);
  const [legacyExpanded, setLegacyExpanded] = useState(hasLegacyData);

  return (
    <>
      <div style={{ ...sectionStyle, marginTop: '30px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <h2 style={{ margin: 0, fontSize: '18px', color: COLORS.textPrimary }}>API 端点配置</h2>
          {isUsingNewConfig && (
            <button
              onClick={onAddEndpoint}
              disabled={disabled}
              style={{
                ...getButtonStyle('primary'),
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.5 : 1,
              }}
            >
              + 添加端点
            </button>
          )}
        </div>

        {endpoints.length === 0 ? (
          <div style={{
            padding: SPACING.lg, backgroundColor: COLORS.bgCard, borderRadius: RADIUS.md,
            border: `1px solid ${COLORS.border}`,
          }}>
            <div style={{ textAlign: 'center', marginBottom: '20px' }}>
              <h3 style={{ margin: '0 0 8px', fontSize: '16px', color: COLORS.textPrimary }}>开始配置 AI 服务</h3>
              <p style={{ margin: 0, fontSize: '14px', color: COLORS.textMuted }}>配置 API 端点以启用 AI 学习助手功能</p>
            </div>

            <div style={{
              padding: SPACING.base, borderRadius: RADIUS.md,
              border: `2px solid ${COLORS.primary}`, backgroundColor: COLORS.primaryLight, marginBottom: SPACING.base,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: SPACING.sm, marginBottom: SPACING.sm }}>
                <span style={{
                  fontSize: '11px', fontWeight: 600, color: COLORS.primary,
                  backgroundColor: COLORS.bgCard, padding: '2px 8px', borderRadius: RADIUS.sm,
                }}>推荐</span>
                <span style={{ fontSize: '14px', fontWeight: 600, color: COLORS.textPrimary }}>多端点配置</span>
              </div>
              <p style={{ margin: '0 0 12px', fontSize: '13px', color: COLORS.textMuted }}>
                支持多端点、自动故障转移、模型选择
              </p>
              <button
                onClick={onAddEndpoint}
                disabled={disabled}
                style={{
                  ...getButtonStyle('primary'),
                  fontWeight: 500,
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  opacity: disabled ? 0.5 : 1,
                }}
              >
                添加第一个端点
              </button>
            </div>

            <div style={{ borderTop: `1px solid ${COLORS.border}`, paddingTop: SPACING.md }}>
              <button
                onClick={() => setLegacyExpanded(!legacyExpanded)}
                style={{
                  display: 'flex', alignItems: 'center', gap: '6px',
                  background: 'none', border: 'none', padding: '4px 0',
                  fontSize: '14px', color: COLORS.textPrimary, cursor: 'pointer', fontWeight: 500,
                }}
              >
                <span style={{
                  display: 'inline-block', transition: `transform ${TRANSITIONS.fast}`,
                  transform: legacyExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                }}>&#9654;</span>
                快速配置（单端点）
              </button>

              {legacyExpanded && (
                <div style={{ marginTop: SPACING.md, display: 'flex', flexDirection: 'column', gap: SPACING.md }}>
                  <div>
                    <label style={{ display: 'block', marginBottom: SPACING.xs, fontWeight: 500, fontSize: '14px', color: COLORS.textPrimary }}>
                      API Base URL <span style={{ color: COLORS.error }}>*</span>
                    </label>
                    <input
                      type="text"
                      value={legacy.apiBaseUrl}
                      onChange={(e) => legacy.onApiBaseUrlChange(e.target.value)}
                      placeholder="https://api.openai.com/v1"
                      disabled={disabled}
                      style={getInputStyle()}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: SPACING.xs, fontWeight: 500, fontSize: '14px', color: COLORS.textPrimary }}>
                      模型名称 <span style={{ color: COLORS.error }}>*</span>
                    </label>
                    <input
                      type="text"
                      value={legacy.modelName}
                      onChange={(e) => legacy.onModelNameChange(e.target.value)}
                      placeholder="gpt-4o-mini"
                      disabled={disabled}
                      style={getInputStyle()}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: SPACING.xs, fontWeight: 500, fontSize: '14px', color: COLORS.textPrimary }}>
                      API Key 状态
                    </label>
                    <div style={{
                      padding: SPACING.md,
                      backgroundColor: legacy.hasApiKey ? COLORS.successBg : COLORS.errorBg,
                      borderRadius: RADIUS.md, fontSize: '14px',
                      color: legacy.hasApiKey ? COLORS.successText : COLORS.errorText,
                    }}>
                      {legacy.hasApiKey ? `已配置：${legacy.apiKeyMasked}` : '尚未配置 API Key'}
                    </div>
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: SPACING.xs, fontWeight: 500, fontSize: '14px', color: COLORS.textPrimary }}>
                      新的 API Key（留空则不修改）
                    </label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <input
                        type={legacy.showApiKey ? 'text' : 'password'}
                        value={legacy.newApiKey}
                        onChange={(e) => legacy.onNewApiKeyChange(e.target.value)}
                        placeholder="sk-..."
                        disabled={disabled}
                        style={{ ...getInputStyle(), flex: 1, fontFamily: 'monospace' }}
                      />
                      <button
                        onClick={legacy.onShowApiKeyToggle}
                        disabled={disabled}
                        style={getButtonStyle('secondary')}
                      >
                        {legacy.showApiKey ? '隐藏' : '显示'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
            {endpoints.map((endpoint, index) => {
              const endpointKey = endpoint.id || `new-${index}`;
              const hasCredentials = Boolean(endpoint.apiBaseUrl && (endpoint.newApiKey || endpoint.hasApiKey));
              const hasModels = endpoint.models.length > 0;
              const hasSelectedModels = selectedModels.some(sm => sm.endpointId === endpoint.id);

              const stepCircle = (step: number, completed: boolean, active: boolean): React.CSSProperties => ({
                width: '28px', height: '28px', borderRadius: '50%',
                backgroundColor: completed ? COLORS.success : active ? COLORS.primary : COLORS.border,
                color: (completed || active) ? '#ffffff' : COLORS.textMuted,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontWeight: 600, fontSize: '14px', flexShrink: 0,
              });

              const step1Done = hasCredentials;
              const step2Done = hasModels;
              const step3Done = hasSelectedModels;
              const step1Active = !step1Done;
              const step2Active = step1Done && !step2Done;
              const step3Active = step1Done && step2Done && !step3Done;

              return (
                <div
                  key={endpointKey}
                  style={{
                    padding: '15px', backgroundColor: COLORS.bgCard, borderRadius: RADIUS.md,
                    border: endpoint.enabled ? `1px solid ${COLORS.border}` : `1px solid ${COLORS.errorBorder}`,
                    opacity: endpoint.enabled ? 1 : 0.7,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                    <input
                      type="text"
                      value={endpoint.name}
                      onChange={(e) => onUpdateEndpoint(index, { name: e.target.value })}
                      placeholder="端点名称"
                      style={{
                        fontSize: '16px', fontWeight: 500, border: 'none',
                        borderBottom: '1px solid transparent', backgroundColor: 'transparent',
                        padding: '4px 0', flex: 1, color: COLORS.textPrimary,
                      }}
                      onFocus={(e) => e.target.style.borderBottomColor = COLORS.primary}
                      onBlur={(e) => e.target.style.borderBottomColor = 'transparent'}
                    />
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '14px', cursor: 'pointer', color: COLORS.textSecondary }}>
                        <input
                          type="checkbox"
                          checked={endpoint.enabled}
                          onChange={(e) => onUpdateEndpoint(index, { enabled: e.target.checked })}
                        />
                        启用
                      </label>
                      <button
                        onClick={() => onRemoveEndpoint(index)}
                        style={{
                          ...getButtonStyle('danger'),
                          padding: '4px 8px', fontSize: '12px',
                        }}
                      >
                        删除
                      </button>
                    </div>
                  </div>

                  {/* Step 1 */}
                  <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: '4px' }}>
                      <div style={stepCircle(1, step1Done, step1Active)}>
                        {step1Done ? '\u2713' : '1'}
                      </div>
                      <div style={{ width: '2px', height: '100%', minHeight: '20px', backgroundColor: step1Done ? COLORS.success : COLORS.border, marginTop: '4px' }} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: '13px', fontWeight: 600, color: step1Active ? COLORS.primary : COLORS.textPrimary, marginBottom: SPACING.sm }}>
                        填写端点信息
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                        <div>
                          <label style={{ display: 'block', marginBottom: SPACING.xs, fontSize: '13px', fontWeight: 500, color: COLORS.textSecondary }}>
                            API Base URL
                          </label>
                          <input
                            type="text"
                            value={endpoint.apiBaseUrl}
                            onChange={(e) => onUpdateEndpoint(index, { apiBaseUrl: e.target.value })}
                            placeholder="https://api.openai.com/v1"
                            style={getInputStyle()}
                          />
                        </div>
                        <div>
                          <label style={{ display: 'block', marginBottom: SPACING.xs, fontSize: '13px', fontWeight: 500, color: COLORS.textSecondary }}>
                            API Key {endpoint.hasApiKey && <span style={{ color: COLORS.success }}>(已配置: {endpoint.apiKeyMasked})</span>}
                          </label>
                          <input
                            type="password"
                            value={endpoint.newApiKey || ''}
                            onChange={(e) => onUpdateEndpoint(index, { newApiKey: e.target.value })}
                            placeholder={endpoint.hasApiKey ? '留空保持不变' : 'sk-...'}
                            style={getInputStyle()}
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Step 2 */}
                  <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start', marginTop: SPACING.md, opacity: hasCredentials ? 1 : 0.5 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: '4px' }}>
                      <div style={stepCircle(2, step2Done, step2Active)}>
                        {step2Done ? '\u2713' : '2'}
                      </div>
                      <div style={{ width: '2px', height: '100%', minHeight: '20px', backgroundColor: step2Done ? COLORS.success : COLORS.border, marginTop: '4px' }} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: '13px', fontWeight: 600, color: step2Active ? COLORS.primary : COLORS.textPrimary, marginBottom: SPACING.sm }}>
                        获取可用模型
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '5px', flexWrap: 'wrap' }}>
                        <button
                          onClick={() => onFetchModels(index)}
                          disabled={fetchingModels !== null || !hasCredentials}
                          style={{
                            ...getButtonStyle(step2Active ? 'primary' : 'secondary'),
                            padding: '6px 16px', fontSize: '13px',
                            opacity: (fetchingModels !== null || !hasCredentials) ? 0.5 : 1,
                            cursor: (fetchingModels !== null || !hasCredentials) ? 'not-allowed' : 'pointer',
                            boxShadow: step2Active ? SHADOWS.focus : 'none',
                          }}
                        >
                          {fetchingModels === endpointKey ? '获取中...' : hasModels ? '重新获取' : '获取模型列表'}
                        </button>
                        {step2Active && !hasModels && (
                          <span style={{ fontSize: '13px', color: COLORS.primary, fontWeight: 500 }}>
                            ← 点击获取 API 支持的模型
                          </span>
                        )}
                        {hasModels && (
                          <span style={getBadgeStyle('success')}>
                            {'\u2713'} 已获取 {endpoint.models.length} 个模型
                          </span>
                        )}
                        {endpoint.modelsLastFetched && (
                          <span style={{ fontSize: '12px', color: COLORS.textMuted, marginLeft: 'auto' }}>
                            上次获取: {new Date(endpoint.modelsLastFetched).toLocaleString()}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Step 3 */}
                  <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start', marginTop: SPACING.md, opacity: hasModels ? 1 : 0.5 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: '4px' }}>
                      <div style={stepCircle(3, step3Done, step3Active)}>
                        {step3Done ? '\u2713' : '3'}
                      </div>
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: '13px', fontWeight: 600, color: step3Active ? COLORS.primary : COLORS.textPrimary, marginBottom: SPACING.sm }}>
                        选择启用的模型
                        <span style={{ fontSize: '12px', fontWeight: 400, color: COLORS.textMuted, marginLeft: SPACING.sm }}>
                          ({endpoint.models.length} 个可用)
                        </span>
                      </div>
                      {hasModels ? (
                        <>
                          {step3Active && !hasSelectedModels && (
                            <div style={{
                              padding: `${SPACING.sm} ${SPACING.md}`, marginBottom: SPACING.sm,
                              backgroundColor: COLORS.warningBg, borderRadius: RADIUS.sm,
                              fontSize: '13px', color: COLORS.warningText,
                            }}>
                              请至少点击一个模型以供学生使用
                            </div>
                          )}
                          <div style={{
                            maxHeight: '120px', overflowY: 'auto', padding: SPACING.sm,
                            backgroundColor: COLORS.bgPage, borderRadius: RADIUS.sm, border: `1px solid ${COLORS.border}`,
                          }}>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                              {endpoint.models.map((model) => {
                                const isSelected = selectedModels.some(sm => sm.endpointId === endpoint.id && sm.modelName === model);
                                return (
                                  <button
                                    key={model}
                                    onClick={() => endpoint.id && onAddSelectedModel(endpoint.id, model)}
                                    disabled={!endpoint.id}
                                    style={{
                                      padding: '4px 8px',
                                      backgroundColor: isSelected ? COLORS.primaryLight : COLORS.bgCard,
                                      border: isSelected ? `1px solid ${COLORS.primary}` : `1px solid ${COLORS.border}`,
                                      color: isSelected ? COLORS.primary : COLORS.textPrimary,
                                      borderRadius: RADIUS.sm,
                                      fontSize: '12px', fontWeight: isSelected ? 500 : 400,
                                      cursor: endpoint.id ? 'pointer' : 'not-allowed',
                                    }}
                                    title={endpoint.id ? (isSelected ? '已选中' : '点击添加到选中模型') : '请先保存端点'}
                                  >
                                    {model}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        </>
                      ) : (
                        <div style={{
                          padding: SPACING.md, backgroundColor: COLORS.bgPage, borderRadius: RADIUS.sm,
                          border: `1px dashed ${COLORS.border}`, color: COLORS.textMuted, fontSize: '13px', textAlign: 'center',
                        }}>
                          请先完成第 2 步
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {isUsingNewConfig && (
        <div style={{ ...sectionStyle, marginTop: '20px' }}>
          <h2 style={{ marginTop: 0, marginBottom: '15px', fontSize: '18px', color: COLORS.textPrimary }}>
            模型优先级（按顺序 Fallback）
          </h2>
          <p style={{ fontSize: '13px', color: COLORS.textMuted, marginBottom: '15px' }}>
            调用时将按以下顺序尝试模型，如果第一个失败则自动切换到下一个。
          </p>

          {selectedModels.length === 0 ? (
            <div style={{
              padding: '20px', backgroundColor: COLORS.bgCard, borderRadius: RADIUS.md,
              border: `1px dashed ${COLORS.border}`, color: COLORS.textMuted, textAlign: 'center',
            }}>
              尚未选择模型。请在上方端点的可用模型列表中点击添加。
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: SPACING.sm }}>
              {selectedModels.map((sm, index) => {
                const ep = endpoints.find(e => e.id === sm.endpointId);
                return (
                  <div
                    key={`${sm.endpointId}-${sm.modelName}`}
                    style={{
                      display: 'flex', alignItems: 'center', padding: '10px 15px',
                      backgroundColor: COLORS.bgCard, borderRadius: RADIUS.md, border: `1px solid ${COLORS.border}`,
                    }}
                  >
                    <span style={{
                      width: '24px', height: '24px', borderRadius: '50%',
                      backgroundColor: COLORS.primaryLight, color: COLORS.primary,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '12px', fontWeight: 600, marginRight: SPACING.md,
                    }}>
                      {index + 1}
                    </span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: '14px', fontWeight: 500, color: COLORS.textPrimary }}>{sm.modelName}</div>
                      <div style={{ fontSize: '12px', color: COLORS.textMuted }}>{ep?.name || '未知端点'}</div>
                    </div>
                    <div style={{ display: 'flex', gap: '4px' }}>
                      <button
                        onClick={() => onMoveSelectedModel(index, 'up')}
                        disabled={index === 0}
                        style={{
                          ...getButtonStyle('ghost'),
                          padding: '4px 8px',
                          backgroundColor: index === 0 ? COLORS.bgDisabled : COLORS.bgHover,
                          cursor: index === 0 ? 'not-allowed' : 'pointer',
                        }}
                      >
                        ↑
                      </button>
                      <button
                        onClick={() => onMoveSelectedModel(index, 'down')}
                        disabled={index === selectedModels.length - 1}
                        style={{
                          ...getButtonStyle('ghost'),
                          padding: '4px 8px',
                          backgroundColor: index === selectedModels.length - 1 ? COLORS.bgDisabled : COLORS.bgHover,
                          cursor: index === selectedModels.length - 1 ? 'not-allowed' : 'pointer',
                        }}
                      >
                        ↓
                      </button>
                      <button
                        onClick={() => onRemoveSelectedModel(index)}
                        style={{
                          ...getButtonStyle('danger'),
                          padding: '4px 8px', fontSize: '12px',
                        }}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

    </>
  );
};
