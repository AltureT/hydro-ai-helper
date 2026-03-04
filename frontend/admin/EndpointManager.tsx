import React from 'react';
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

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px', borderRadius: '4px',
  border: '1px solid #d1d5db', fontSize: '14px', boxSizing: 'border-box',
};

const sectionStyle: React.CSSProperties = {
  padding: '20px', backgroundColor: '#f9fafb', borderRadius: '8px', border: '1px solid #e5e7eb',
};

const legacyInputStyle: React.CSSProperties = {
  width: '100%', padding: '10px', borderRadius: '6px',
  border: '1px solid #d1d5db', fontSize: '14px', boxSizing: 'border-box',
};

export const EndpointManager: React.FC<EndpointManagerProps> = ({
  endpoints, selectedModels,
  onUpdateEndpoint, onRemoveEndpoint, onAddEndpoint, onFetchModels, fetchingModels,
  onAddSelectedModel, onRemoveSelectedModel, onMoveSelectedModel,
  disabled, legacy,
}) => {
  const isUsingNewConfig = endpoints.length > 0;

  return (
    <>
      {/* API Endpoints */}
      <div style={{ ...sectionStyle, marginTop: '30px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <h2 style={{ margin: 0, fontSize: '18px' }}>API 端点配置</h2>
          <button
            onClick={onAddEndpoint}
            disabled={disabled}
            style={{
              padding: '8px 16px', backgroundColor: '#3b82f6', color: 'white',
              border: 'none', borderRadius: '6px', fontSize: '14px',
              cursor: disabled ? 'not-allowed' : 'pointer',
            }}
          >
            + 添加端点
          </button>
        </div>

        {endpoints.length === 0 ? (
          <div style={{
            padding: '20px', backgroundColor: '#fff', borderRadius: '6px',
            border: '1px dashed #d1d5db', color: '#6b7280', textAlign: 'center',
          }}>
            暂无 API 端点配置。点击"添加端点"开始配置，或使用下方的单端点兼容模式。
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
            {endpoints.map((endpoint, index) => {
              const endpointKey = endpoint.id || `new-${index}`;
              return (
                <div
                  key={endpointKey}
                  style={{
                    padding: '15px', backgroundColor: '#fff', borderRadius: '8px',
                    border: endpoint.enabled ? '1px solid #e5e7eb' : '1px solid #fca5a5',
                    opacity: endpoint.enabled ? 1 : 0.7,
                  }}
                >
                  {/* Header: name + enabled + delete */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                    <input
                      type="text"
                      value={endpoint.name}
                      onChange={(e) => onUpdateEndpoint(index, { name: e.target.value })}
                      placeholder="端点名称"
                      style={{
                        fontSize: '16px', fontWeight: 500, border: 'none',
                        borderBottom: '1px solid transparent', backgroundColor: 'transparent',
                        padding: '4px 0', flex: 1,
                      }}
                      onFocus={(e) => e.target.style.borderBottomColor = '#3b82f6'}
                      onBlur={(e) => e.target.style.borderBottomColor = 'transparent'}
                    />
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '14px', cursor: 'pointer' }}>
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
                          padding: '4px 8px', backgroundColor: '#fee2e2', color: '#991b1b',
                          border: 'none', borderRadius: '4px', fontSize: '12px', cursor: 'pointer',
                        }}
                      >
                        删除
                      </button>
                    </div>
                  </div>

                  {/* URL + API Key */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                    <div>
                      <label style={{ display: 'block', marginBottom: '5px', fontSize: '13px', fontWeight: 500 }}>
                        API Base URL
                      </label>
                      <input
                        type="text"
                        value={endpoint.apiBaseUrl}
                        onChange={(e) => onUpdateEndpoint(index, { apiBaseUrl: e.target.value })}
                        placeholder="https://api.openai.com/v1"
                        style={inputStyle}
                      />
                    </div>
                    <div>
                      <label style={{ display: 'block', marginBottom: '5px', fontSize: '13px', fontWeight: 500 }}>
                        API Key {endpoint.hasApiKey && <span style={{ color: '#10b981' }}>(已配置: {endpoint.apiKeyMasked})</span>}
                      </label>
                      <input
                        type="password"
                        value={endpoint.newApiKey || ''}
                        onChange={(e) => onUpdateEndpoint(index, { newApiKey: e.target.value })}
                        placeholder={endpoint.hasApiKey ? '留空保持不变' : 'sk-...'}
                        style={inputStyle}
                      />
                    </div>
                  </div>

                  {/* Available models */}
                  <div style={{ marginTop: '15px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '5px' }}>
                      <label style={{ fontSize: '13px', fontWeight: 500 }}>
                        可用模型 ({endpoint.models.length})
                        {endpoint.modelsLastFetched && (
                          <span style={{ fontSize: '12px', color: '#6b7280', marginLeft: '8px' }}>
                            上次获取: {new Date(endpoint.modelsLastFetched).toLocaleString()}
                          </span>
                        )}
                      </label>
                      <button
                        onClick={() => onFetchModels(index)}
                        disabled={fetchingModels !== null}
                        style={{
                          padding: '4px 12px',
                          backgroundColor: fetchingModels === endpointKey ? '#9ca3af' : '#e0e7ff',
                          color: '#4338ca', border: 'none', borderRadius: '4px',
                          fontSize: '12px', cursor: fetchingModels !== null ? 'not-allowed' : 'pointer',
                        }}
                      >
                        {fetchingModels === endpointKey ? '获取中...' : '获取模型'}
                      </button>
                    </div>
                    {endpoint.models.length > 0 ? (
                      <div style={{
                        maxHeight: '120px', overflowY: 'auto', padding: '8px',
                        backgroundColor: '#f9fafb', borderRadius: '4px', border: '1px solid #e5e7eb',
                      }}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                          {endpoint.models.map((model) => (
                            <button
                              key={model}
                              onClick={() => endpoint.id && onAddSelectedModel(endpoint.id, model)}
                              disabled={!endpoint.id}
                              style={{
                                padding: '4px 8px', backgroundColor: '#fff',
                                border: '1px solid #d1d5db', borderRadius: '4px',
                                fontSize: '12px', cursor: endpoint.id ? 'pointer' : 'not-allowed',
                              }}
                              title={endpoint.id ? '点击添加到选中模型' : '请先保存端点'}
                            >
                              {model}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div style={{
                        padding: '12px', backgroundColor: '#f9fafb', borderRadius: '4px',
                        border: '1px dashed #d1d5db', color: '#6b7280', fontSize: '13px', textAlign: 'center',
                      }}>
                        点击"获取模型"自动加载，或手动在下方添加
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Selected Models / Fallback Order */}
      {isUsingNewConfig && (
        <div style={{ ...sectionStyle, marginTop: '20px' }}>
          <h2 style={{ marginTop: 0, marginBottom: '15px', fontSize: '18px' }}>
            模型优先级（按顺序 Fallback）
          </h2>
          <p style={{ fontSize: '13px', color: '#6b7280', marginBottom: '15px' }}>
            调用时将按以下顺序尝试模型，如果第一个失败则自动切换到下一个。
          </p>

          {selectedModels.length === 0 ? (
            <div style={{
              padding: '20px', backgroundColor: '#fff', borderRadius: '6px',
              border: '1px dashed #d1d5db', color: '#6b7280', textAlign: 'center',
            }}>
              尚未选择模型。请在上方端点的可用模型列表中点击添加。
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {selectedModels.map((sm, index) => {
                const ep = endpoints.find(e => e.id === sm.endpointId);
                return (
                  <div
                    key={`${sm.endpointId}-${sm.modelName}`}
                    style={{
                      display: 'flex', alignItems: 'center', padding: '10px 15px',
                      backgroundColor: '#fff', borderRadius: '6px', border: '1px solid #e5e7eb',
                    }}
                  >
                    <span style={{
                      width: '24px', height: '24px', borderRadius: '50%',
                      backgroundColor: '#e0e7ff', color: '#4338ca',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '12px', fontWeight: 600, marginRight: '12px',
                    }}>
                      {index + 1}
                    </span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: '14px', fontWeight: 500 }}>{sm.modelName}</div>
                      <div style={{ fontSize: '12px', color: '#6b7280' }}>{ep?.name || '未知端点'}</div>
                    </div>
                    <div style={{ display: 'flex', gap: '4px' }}>
                      <button
                        onClick={() => onMoveSelectedModel(index, 'up')}
                        disabled={index === 0}
                        style={{
                          padding: '4px 8px',
                          backgroundColor: index === 0 ? '#f3f4f6' : '#e5e7eb',
                          border: 'none', borderRadius: '4px',
                          cursor: index === 0 ? 'not-allowed' : 'pointer',
                        }}
                      >
                        ↑
                      </button>
                      <button
                        onClick={() => onMoveSelectedModel(index, 'down')}
                        disabled={index === selectedModels.length - 1}
                        style={{
                          padding: '4px 8px',
                          backgroundColor: index === selectedModels.length - 1 ? '#f3f4f6' : '#e5e7eb',
                          border: 'none', borderRadius: '4px',
                          cursor: index === selectedModels.length - 1 ? 'not-allowed' : 'pointer',
                        }}
                      >
                        ↓
                      </button>
                      <button
                        onClick={() => onRemoveSelectedModel(index)}
                        style={{
                          padding: '4px 8px', backgroundColor: '#fee2e2', color: '#991b1b',
                          border: 'none', borderRadius: '4px', cursor: 'pointer',
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

      {/* Legacy Single Endpoint */}
      {!isUsingNewConfig && (
        <div style={{
          marginTop: '20px', padding: '20px', backgroundColor: '#fef3c7',
          borderRadius: '8px', border: '1px solid #f59e0b',
        }}>
          <h2 style={{ marginTop: 0, marginBottom: '20px', fontSize: '18px' }}>
            兼容模式（单端点配置）
          </h2>
          <p style={{ fontSize: '13px', color: '#92400e', marginBottom: '15px' }}>
            推荐使用上方的多端点配置。此处的单端点模式仅用于向后兼容。
          </p>

          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500 }}>
              API Base URL <span style={{ color: '#ef4444' }}>*</span>
            </label>
            <input
              type="text"
              value={legacy.apiBaseUrl}
              onChange={(e) => legacy.onApiBaseUrlChange(e.target.value)}
              placeholder="https://api.openai.com/v1"
              disabled={disabled}
              style={legacyInputStyle}
            />
          </div>

          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500 }}>
              模型名称 <span style={{ color: '#ef4444' }}>*</span>
            </label>
            <input
              type="text"
              value={legacy.modelName}
              onChange={(e) => legacy.onModelNameChange(e.target.value)}
              placeholder="gpt-4o-mini"
              disabled={disabled}
              style={legacyInputStyle}
            />
          </div>

          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500 }}>
              API Key 状态
            </label>
            <div style={{
              padding: '12px',
              backgroundColor: legacy.hasApiKey ? '#d1fae5' : '#fee2e2',
              borderRadius: '6px', fontSize: '14px',
              color: legacy.hasApiKey ? '#065f46' : '#991b1b',
            }}>
              {legacy.hasApiKey ? `已配置：${legacy.apiKeyMasked}` : '尚未配置 API Key'}
            </div>
          </div>

          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500 }}>
              新的 API Key（留空则不修改）
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <input
                type={legacy.showApiKey ? 'text' : 'password'}
                value={legacy.newApiKey}
                onChange={(e) => legacy.onNewApiKeyChange(e.target.value)}
                placeholder="sk-..."
                disabled={disabled}
                style={{ ...legacyInputStyle, flex: 1, fontFamily: 'monospace' }}
              />
              <button
                onClick={legacy.onShowApiKeyToggle}
                disabled={disabled}
                style={{
                  padding: '10px 16px', backgroundColor: '#f3f4f6',
                  border: '1px solid #d1d5db', borderRadius: '6px',
                  fontSize: '14px', cursor: 'pointer', whiteSpace: 'nowrap',
                }}
              >
                {legacy.showApiKey ? '隐藏' : '显示'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
