/**
 * AI 配置页面
 * 管理员配置 AI 学习助手相关参数
 * 支持多 API 端点配置、模型自动获取、Fallback 机制
 */

import React, { useState, useEffect, useCallback } from 'react';
import { VersionBadge } from './VersionBadge';

/**
 * API 端点接口
 */
interface Endpoint {
  id?: string;
  name: string;
  apiBaseUrl: string;
  apiKeyMasked?: string;
  hasApiKey?: boolean;
  newApiKey?: string; // 用于输入新 API Key
  models: string[];
  modelsLastFetched?: string;
  enabled: boolean;
  isNew?: boolean; // 标记是否是新创建的
}

/**
 * 选中的模型
 */
interface SelectedModel {
  endpointId: string;
  modelName: string;
}

/**
 * 配置状态接口
 */
interface ConfigState {
  endpoints: Endpoint[];
  selectedModels: SelectedModel[];
  // 旧版字段（向后兼容）
  apiBaseUrl: string;
  modelName: string;
  rateLimitPerMinute: number | '';
  timeoutSeconds: number | '';
  systemPromptTemplate: string;
  extraJailbreakPatternsText: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
}

interface JailbreakLogEntry {
  id: string;
  userId?: number;
  problemId?: string;
  conversationId?: string;
  questionType?: string;
  matchedPattern: string;
  matchedText: string;
  createdAt: string;
}

interface JailbreakLogPagination {
  logs: JailbreakLogEntry[];
  total: number;
  page: number;
  totalPages: number;
}

/**
 * API 响应接口（提高类型安全）
 */
interface APIConfigResponse {
  config: {
    endpoints?: Array<Omit<Endpoint, 'newApiKey' | 'isNew'> & { apiKeyMasked?: string; hasApiKey?: boolean }>;
    selectedModels?: SelectedModel[];
    apiBaseUrl?: string;
    modelName?: string;
    rateLimitPerMinute?: number;
    timeoutSeconds?: number;
    systemPromptTemplate?: string;
    extraJailbreakPatternsText?: string;
    apiKeyMasked?: string;
    hasApiKey?: boolean;
  } | null;
  builtinJailbreakPatterns?: string[];
  jailbreakLogs?: JailbreakLogPagination;
  recentJailbreakLogs?: JailbreakLogEntry[];
}

/**
 * ConfigPanel 组件
 */
export const ConfigPanel: React.FC = () => {
  // 状态管理
  const [config, setConfig] = useState<ConfigState | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [testing, setTesting] = useState<boolean>(false);
  const [fetchingModels, setFetchingModels] = useState<string | null>(null); // 正在获取模型的端点 ID
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const [newApiKey, setNewApiKey] = useState<string>('');
  const [showApiKey, setShowApiKey] = useState<boolean>(false);
  const [builtinJailbreakPatterns, setBuiltinJailbreakPatterns] = useState<string[]>([]);
  const [logPagination, setLogPagination] = useState<JailbreakLogPagination>({
    logs: [],
    total: 0,
    page: 1,
    totalPages: 0
  });

  /**
   * 初始化：加载配置
   */
  useEffect(() => {
    loadConfig();
  }, []);

  /**
   * 加载配置
   */
  const loadConfig = useCallback(async (page: number = 1) => {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/ai-helper/admin/config?page=${page}&limit=20`, {
        method: 'GET',
        credentials: 'include',
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `加载配置失败: ${res.status}`);
      }

      const json: APIConfigResponse = await res.json();

      const builtinPatterns: string[] = json.builtinJailbreakPatterns || [];
      setBuiltinJailbreakPatterns(builtinPatterns);

      // 处理分页数据
      if (json.jailbreakLogs) {
        setLogPagination(json.jailbreakLogs);
      } else if (json.recentJailbreakLogs) {
        setLogPagination({
          logs: json.recentJailbreakLogs,
          total: json.recentJailbreakLogs.length,
          page: 1,
          totalPages: 1
        });
      }

      if (json.config == null) {
        // 使用默认值
        setConfig({
          endpoints: [],
          selectedModels: [],
          apiBaseUrl: '',
          modelName: '',
          rateLimitPerMinute: 5,
          timeoutSeconds: 30,
          systemPromptTemplate: '',
          extraJailbreakPatternsText: '',
          apiKeyMasked: '',
          hasApiKey: false,
        });
      } else {
        setConfig({
          endpoints: (json.config.endpoints || []).map((ep) => ({
            ...ep,
            newApiKey: '',
          })),
          selectedModels: json.config.selectedModels || [],
          apiBaseUrl: json.config.apiBaseUrl || '',
          modelName: json.config.modelName || '',
          rateLimitPerMinute: json.config.rateLimitPerMinute ?? 5,
          timeoutSeconds: json.config.timeoutSeconds ?? 30,
          systemPromptTemplate: json.config.systemPromptTemplate || '',
          extraJailbreakPatternsText: json.config.extraJailbreakPatternsText || '',
          apiKeyMasked: json.config.apiKeyMasked || '',
          hasApiKey: Boolean(json.config.hasApiKey),
        });
      }
    } catch (err: any) {
      console.error('Load config error:', err);
      setError(err.message || '加载配置失败');
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * 保存配置
   */
  const saveConfig = async () => {
    if (!config) return;

    setError(null);
    setSuccessMessage(null);
    setSaving(true);

    try {
      // 构造请求体
      const body: any = {
        rateLimitPerMinute: Number(config.rateLimitPerMinute) || 5,
        timeoutSeconds: Number(config.timeoutSeconds) || 30,
        systemPromptTemplate: config.systemPromptTemplate,
        extraJailbreakPatternsText: config.extraJailbreakPatternsText,
      };

      // 新版多端点配置
      if (config.endpoints.length > 0) {
        body.endpoints = config.endpoints.map(ep => ({
          id: ep.isNew ? undefined : ep.id,
          name: ep.name,
          apiBaseUrl: ep.apiBaseUrl,
          apiKey: ep.newApiKey || undefined,
          models: ep.models,
          enabled: ep.enabled,
        }));
        body.selectedModels = config.selectedModels;
      } else {
        // 旧版单端点配置
        body.apiBaseUrl = config.apiBaseUrl.trim();
        body.modelName = config.modelName.trim();
        if (newApiKey.trim()) {
          body.apiKey = newApiKey.trim();
        }
      }

      const res = await fetch('/ai-helper/admin/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errorJson = await res.json();
        throw new Error(errorJson.error || `保存失败: ${res.status}`);
      }

      const json: APIConfigResponse = await res.json();

      // 更新配置状态
      if (json.config) {
        setConfig({
          endpoints: (json.config.endpoints || []).map((ep) => ({
            ...ep,
            newApiKey: '',
          })),
          selectedModels: json.config.selectedModels || [],
          apiBaseUrl: json.config.apiBaseUrl || '',
          modelName: json.config.modelName || '',
          rateLimitPerMinute: json.config.rateLimitPerMinute ?? 5,
          timeoutSeconds: json.config.timeoutSeconds ?? 30,
          systemPromptTemplate: json.config.systemPromptTemplate || '',
          extraJailbreakPatternsText: json.config.extraJailbreakPatternsText || '',
          apiKeyMasked: json.config.apiKeyMasked || '',
          hasApiKey: Boolean(json.config.hasApiKey),
        });
      }

      if (json.jailbreakLogs) {
        setLogPagination(json.jailbreakLogs);
      }

      setNewApiKey('');
      setSuccessMessage('配置已保存');
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err: any) {
      console.error('Save config error:', err);
      setError(err.message || '保存配置失败');
    } finally {
      setSaving(false);
    }
  };

  /**
   * 测试连接
   */
  const testConnection = async () => {
    setError(null);
    setSuccessMessage(null);
    setTesting(true);

    try {
      const res = await fetch('/ai-helper/admin/test-connection', {
        method: 'POST',
        credentials: 'include',
      });

      const json = await res.json();

      if (json.success) {
        setSuccessMessage('连接成功，AI 服务可用');
        setTimeout(() => setSuccessMessage(null), 3000);
      } else {
        setError(json.message || '连接失败，AI 服务不可用');
      }
    } catch (err: any) {
      console.error('Test connection error:', err);
      setError(err.message || '连接测试失败');
    } finally {
      setTesting(false);
    }
  };

  /**
   * 获取端点的可用模型
   */
  const fetchModelsForEndpoint = async (endpointIndex: number) => {
    if (!config) return;
    const endpoint = config.endpoints[endpointIndex];
    if (!endpoint) return;

    const endpointId = endpoint.id || `new-${endpointIndex}`;
    setFetchingModels(endpointId);
    setError(null);

    try {
      let body: any;
      if (endpoint.id && !endpoint.isNew) {
        // 已保存的端点，使用 endpointId
        body = { endpointId: endpoint.id };
      } else {
        // 新端点，使用 URL 和 Key
        if (!endpoint.apiBaseUrl || !endpoint.newApiKey) {
          throw new Error('请先填写 API Base URL 和 API Key');
        }
        body = {
          apiBaseUrl: endpoint.apiBaseUrl,
          apiKey: endpoint.newApiKey,
        };
      }

      const res = await fetch('/ai-helper/admin/fetch-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });

      const json = await res.json();

      if (json.success) {
        // 更新端点的模型列表
        const newEndpoints = [...config.endpoints];
        newEndpoints[endpointIndex] = {
          ...newEndpoints[endpointIndex],
          models: json.models || [],
          modelsLastFetched: new Date().toISOString(),
        };
        setConfig({ ...config, endpoints: newEndpoints });
        setSuccessMessage(`获取到 ${json.models?.length || 0} 个可用模型`);
        setTimeout(() => setSuccessMessage(null), 3000);
      } else {
        setError(json.error || '获取模型列表失败');
      }
    } catch (err: any) {
      console.error('Fetch models error:', err);
      setError(err.message || '获取模型列表失败');
    } finally {
      setFetchingModels(null);
    }
  };

  /**
   * 添加新端点
   */
  const addEndpoint = useCallback(() => {
    setConfig(prev => {
      if (!prev) return prev;
      const newEndpoint: Endpoint = {
        name: `端点 ${prev.endpoints.length + 1}`,
        apiBaseUrl: '',
        models: [],
        enabled: true,
        isNew: true,
        newApiKey: '',
      };
      return {
        ...prev,
        endpoints: [...prev.endpoints, newEndpoint],
      };
    });
  }, []);

  /**
   * 删除端点
   */
  const removeEndpoint = useCallback((index: number) => {
    setConfig(prev => {
      if (!prev) return prev;
      const endpoint = prev.endpoints[index];
      const newEndpoints = prev.endpoints.filter((_, i) => i !== index);
      // 同时移除引用该端点的选中模型（仅当端点有 ID 时）
      const newSelectedModels = endpoint?.id
        ? prev.selectedModels.filter(sm => sm.endpointId !== endpoint.id)
        : prev.selectedModels;
      return {
        ...prev,
        endpoints: newEndpoints,
        selectedModels: newSelectedModels,
      };
    });
  }, []);

  /**
   * 更新端点
   */
  const updateEndpoint = useCallback((index: number, updates: Partial<Endpoint>) => {
    setConfig(prev => {
      if (!prev) return prev;
      const newEndpoints = [...prev.endpoints];
      newEndpoints[index] = { ...newEndpoints[index], ...updates };
      return { ...prev, endpoints: newEndpoints };
    });
  }, []);

  /**
   * 添加选中的模型
   */
  const addSelectedModel = useCallback((endpointId: string, modelName: string) => {
    setConfig(prev => {
      if (!prev) return prev;
      // 检查是否已存在
      const exists = prev.selectedModels.some(
        sm => sm.endpointId === endpointId && sm.modelName === modelName
      );
      if (exists) return prev;

      return {
        ...prev,
        selectedModels: [...prev.selectedModels, { endpointId, modelName }],
      };
    });
  }, []);

  /**
   * 移除选中的模型
   */
  const removeSelectedModel = useCallback((index: number) => {
    setConfig(prev => {
      if (!prev) return prev;
      const newSelectedModels = prev.selectedModels.filter((_, i) => i !== index);
      return { ...prev, selectedModels: newSelectedModels };
    });
  }, []);

  /**
   * 移动选中的模型（调整顺序）
   */
  const moveSelectedModel = useCallback((index: number, direction: 'up' | 'down') => {
    setConfig(prev => {
      if (!prev) return prev;
      const newIndex = direction === 'up' ? index - 1 : index + 1;
      if (newIndex < 0 || newIndex >= prev.selectedModels.length) return prev;

      const newSelectedModels = [...prev.selectedModels];
      [newSelectedModels[index], newSelectedModels[newIndex]] =
        [newSelectedModels[newIndex], newSelectedModels[index]];
      return { ...prev, selectedModels: newSelectedModels };
    });
  }, []);

  /**
   * 切换分页
   */
  const changePage = (newPage: number) => {
    if (newPage < 1 || newPage > logPagination.totalPages) return;
    loadConfig(newPage);
  };

  const copyToClipboard = async (text: string) => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        setSuccessMessage('已复制到剪贴板');
        setTimeout(() => setSuccessMessage(null), 2000);
      } else {
        window.prompt('请复制以下内容', text);
      }
    } catch (err) {
      console.error('Copy to clipboard failed:', err);
      window.prompt('复制失败，请手动复制：', text);
    }
  };

  const appendPatternToCustomRules = (pattern: string) => {
    setConfig((prev) => {
      if (!prev) return prev;
      const existing = prev.extraJailbreakPatternsText || '';
      const normalizedPattern = pattern.trim();
      if (!normalizedPattern) {
        return prev;
      }
      const prefix = existing.length > 0 ? `${existing}${existing.endsWith('\n') ? '' : '\n'}` : '';
      const updated = `${prefix}${normalizedPattern}`;
      return {
        ...prev,
        extraJailbreakPatternsText: updated,
      };
    });
  };

  /**
   * 渲染加载状态
   */
  if (loading) {
    return (
      <div style={{ padding: '20px', fontFamily: 'sans-serif', maxWidth: '900px', margin: '40px auto 20px' }}>
        <h1>AI 学习助手配置</h1>
        <div style={{
          marginTop: '20px',
          padding: '20px',
          textAlign: 'center',
          color: '#6b7280',
          backgroundColor: '#f9fafb',
          borderRadius: '8px'
        }}>
          正在加载配置...
        </div>
      </div>
    );
  }

  if (!config) {
    return null;
  }

  const isUsingNewConfig = config.endpoints.length > 0;

  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif', maxWidth: '900px', margin: '40px auto 20px' }}>
      <h1>AI 学习助手配置</h1>

      {/* T056: 版本信息徽章 */}
      <VersionBadge />

      {/* 错误提示 */}
      {error && (
        <div style={{
          marginTop: '20px',
          padding: '15px',
          backgroundColor: '#fee2e2',
          border: '1px solid #ef4444',
          borderRadius: '8px',
          color: '#991b1b'
        }}>
          <strong>错误：</strong> {error}
        </div>
      )}

      {/* 成功提示 */}
      {successMessage && (
        <div style={{
          marginTop: '20px',
          padding: '15px',
          backgroundColor: '#d1fae5',
          border: '1px solid #10b981',
          borderRadius: '8px',
          color: '#065f46'
        }}>
          <strong>成功：</strong> {successMessage}
        </div>
      )}

      {/* API 端点配置 */}
      <div style={{
        marginTop: '30px',
        padding: '20px',
        backgroundColor: '#f9fafb',
        borderRadius: '8px',
        border: '1px solid #e5e7eb'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <h2 style={{ margin: 0, fontSize: '18px' }}>API 端点配置</h2>
          <button
            onClick={addEndpoint}
            disabled={saving}
            style={{
              padding: '8px 16px',
              backgroundColor: '#3b82f6',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              fontSize: '14px',
              cursor: saving ? 'not-allowed' : 'pointer',
            }}
          >
            + 添加端点
          </button>
        </div>

        {config.endpoints.length === 0 ? (
          <div style={{
            padding: '20px',
            backgroundColor: '#fff',
            borderRadius: '6px',
            border: '1px dashed #d1d5db',
            color: '#6b7280',
            textAlign: 'center'
          }}>
            暂无 API 端点配置。点击"添加端点"开始配置，或使用下方的单端点兼容模式。
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
            {config.endpoints.map((endpoint, index) => (
              <div
                key={endpoint.id || `new-${index}`}
                style={{
                  padding: '15px',
                  backgroundColor: '#fff',
                  borderRadius: '8px',
                  border: endpoint.enabled ? '1px solid #e5e7eb' : '1px solid #fca5a5',
                  opacity: endpoint.enabled ? 1 : 0.7,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                  <input
                    type="text"
                    value={endpoint.name}
                    onChange={(e) => updateEndpoint(index, { name: e.target.value })}
                    placeholder="端点名称"
                    style={{
                      fontSize: '16px',
                      fontWeight: 500,
                      border: 'none',
                      borderBottom: '1px solid transparent',
                      backgroundColor: 'transparent',
                      padding: '4px 0',
                      flex: 1,
                    }}
                    onFocus={(e) => e.target.style.borderBottomColor = '#3b82f6'}
                    onBlur={(e) => e.target.style.borderBottomColor = 'transparent'}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '14px', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={endpoint.enabled}
                        onChange={(e) => updateEndpoint(index, { enabled: e.target.checked })}
                      />
                      启用
                    </label>
                    <button
                      onClick={() => removeEndpoint(index)}
                      style={{
                        padding: '4px 8px',
                        backgroundColor: '#fee2e2',
                        color: '#991b1b',
                        border: 'none',
                        borderRadius: '4px',
                        fontSize: '12px',
                        cursor: 'pointer',
                      }}
                    >
                      删除
                    </button>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                  <div>
                    <label style={{ display: 'block', marginBottom: '5px', fontSize: '13px', fontWeight: 500 }}>
                      API Base URL
                    </label>
                    <input
                      type="text"
                      value={endpoint.apiBaseUrl}
                      onChange={(e) => updateEndpoint(index, { apiBaseUrl: e.target.value })}
                      placeholder="https://api.openai.com/v1"
                      style={{
                        width: '100%',
                        padding: '8px',
                        borderRadius: '4px',
                        border: '1px solid #d1d5db',
                        fontSize: '14px',
                        boxSizing: 'border-box',
                      }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: '5px', fontSize: '13px', fontWeight: 500 }}>
                      API Key {endpoint.hasApiKey && <span style={{ color: '#10b981' }}>(已配置: {endpoint.apiKeyMasked})</span>}
                    </label>
                    <input
                      type="password"
                      value={endpoint.newApiKey || ''}
                      onChange={(e) => updateEndpoint(index, { newApiKey: e.target.value })}
                      placeholder={endpoint.hasApiKey ? '留空保持不变' : 'sk-...'}
                      style={{
                        width: '100%',
                        padding: '8px',
                        borderRadius: '4px',
                        border: '1px solid #d1d5db',
                        fontSize: '14px',
                        boxSizing: 'border-box',
                      }}
                    />
                  </div>
                </div>

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
                      onClick={() => fetchModelsForEndpoint(index)}
                      disabled={fetchingModels !== null}
                      style={{
                        padding: '4px 12px',
                        backgroundColor: fetchingModels === (endpoint.id || `new-${index}`) ? '#9ca3af' : '#e0e7ff',
                        color: '#4338ca',
                        border: 'none',
                        borderRadius: '4px',
                        fontSize: '12px',
                        cursor: fetchingModels !== null ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {fetchingModels === (endpoint.id || `new-${index}`) ? '获取中...' : '获取模型'}
                    </button>
                  </div>
                  {endpoint.models.length > 0 ? (
                    <div style={{
                      maxHeight: '120px',
                      overflowY: 'auto',
                      padding: '8px',
                      backgroundColor: '#f9fafb',
                      borderRadius: '4px',
                      border: '1px solid #e5e7eb',
                    }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                        {endpoint.models.map((model) => (
                          <button
                            key={model}
                            onClick={() => endpoint.id && addSelectedModel(endpoint.id, model)}
                            disabled={!endpoint.id}
                            style={{
                              padding: '4px 8px',
                              backgroundColor: '#fff',
                              border: '1px solid #d1d5db',
                              borderRadius: '4px',
                              fontSize: '12px',
                              cursor: endpoint.id ? 'pointer' : 'not-allowed',
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
                      padding: '12px',
                      backgroundColor: '#f9fafb',
                      borderRadius: '4px',
                      border: '1px dashed #d1d5db',
                      color: '#6b7280',
                      fontSize: '13px',
                      textAlign: 'center',
                    }}>
                      点击"获取模型"自动加载，或手动在下方添加
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 选中的模型（Fallback 顺序） */}
      {config.endpoints.length > 0 && (
        <div style={{
          marginTop: '20px',
          padding: '20px',
          backgroundColor: '#f9fafb',
          borderRadius: '8px',
          border: '1px solid #e5e7eb'
        }}>
          <h2 style={{ marginTop: 0, marginBottom: '15px', fontSize: '18px' }}>
            模型优先级（按顺序 Fallback）
          </h2>
          <p style={{ fontSize: '13px', color: '#6b7280', marginBottom: '15px' }}>
            调用时将按以下顺序尝试模型，如果第一个失败则自动切换到下一个。
          </p>

          {config.selectedModels.length === 0 ? (
            <div style={{
              padding: '20px',
              backgroundColor: '#fff',
              borderRadius: '6px',
              border: '1px dashed #d1d5db',
              color: '#6b7280',
              textAlign: 'center'
            }}>
              尚未选择模型。请在上方端点的可用模型列表中点击添加。
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {config.selectedModels.map((sm, index) => {
                const endpoint = config.endpoints.find(ep => ep.id === sm.endpointId);
                return (
                  <div
                    key={`${sm.endpointId}-${sm.modelName}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      padding: '10px 15px',
                      backgroundColor: '#fff',
                      borderRadius: '6px',
                      border: '1px solid #e5e7eb',
                    }}
                  >
                    <span style={{
                      width: '24px',
                      height: '24px',
                      borderRadius: '50%',
                      backgroundColor: '#e0e7ff',
                      color: '#4338ca',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '12px',
                      fontWeight: 600,
                      marginRight: '12px',
                    }}>
                      {index + 1}
                    </span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: '14px', fontWeight: 500 }}>{sm.modelName}</div>
                      <div style={{ fontSize: '12px', color: '#6b7280' }}>
                        {endpoint?.name || '未知端点'}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '4px' }}>
                      <button
                        onClick={() => moveSelectedModel(index, 'up')}
                        disabled={index === 0}
                        style={{
                          padding: '4px 8px',
                          backgroundColor: index === 0 ? '#f3f4f6' : '#e5e7eb',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: index === 0 ? 'not-allowed' : 'pointer',
                        }}
                      >
                        ↑
                      </button>
                      <button
                        onClick={() => moveSelectedModel(index, 'down')}
                        disabled={index === config.selectedModels.length - 1}
                        style={{
                          padding: '4px 8px',
                          backgroundColor: index === config.selectedModels.length - 1 ? '#f3f4f6' : '#e5e7eb',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: index === config.selectedModels.length - 1 ? 'not-allowed' : 'pointer',
                        }}
                      >
                        ↓
                      </button>
                      <button
                        onClick={() => removeSelectedModel(index)}
                        style={{
                          padding: '4px 8px',
                          backgroundColor: '#fee2e2',
                          color: '#991b1b',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: 'pointer',
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

      {/* 兼容模式：单端点配置 */}
      {config.endpoints.length === 0 && (
        <div style={{
          marginTop: '20px',
          padding: '20px',
          backgroundColor: '#fef3c7',
          borderRadius: '8px',
          border: '1px solid #f59e0b'
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
              value={config.apiBaseUrl}
              onChange={(e) => setConfig({ ...config, apiBaseUrl: e.target.value })}
              placeholder="https://api.openai.com/v1"
              disabled={saving || testing}
              style={{
                width: '100%',
                padding: '10px',
                borderRadius: '6px',
                border: '1px solid #d1d5db',
                fontSize: '14px',
                boxSizing: 'border-box'
              }}
            />
          </div>

          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500 }}>
              模型名称 <span style={{ color: '#ef4444' }}>*</span>
            </label>
            <input
              type="text"
              value={config.modelName}
              onChange={(e) => setConfig({ ...config, modelName: e.target.value })}
              placeholder="gpt-4o-mini"
              disabled={saving || testing}
              style={{
                width: '100%',
                padding: '10px',
                borderRadius: '6px',
                border: '1px solid #d1d5db',
                fontSize: '14px',
                boxSizing: 'border-box'
              }}
            />
          </div>

          {/* API Key 设置 */}
          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500 }}>
              API Key 状态
            </label>
            <div style={{
              padding: '12px',
              backgroundColor: config.hasApiKey ? '#d1fae5' : '#fee2e2',
              borderRadius: '6px',
              fontSize: '14px',
              color: config.hasApiKey ? '#065f46' : '#991b1b'
            }}>
              {config.hasApiKey ? `已配置：${config.apiKeyMasked}` : '尚未配置 API Key'}
            </div>
          </div>

          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500 }}>
              新的 API Key（留空则不修改）
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <input
                type={showApiKey ? 'text' : 'password'}
                value={newApiKey}
                onChange={(e) => setNewApiKey(e.target.value)}
                placeholder="sk-..."
                disabled={saving || testing}
                style={{
                  flex: 1,
                  padding: '10px',
                  borderRadius: '6px',
                  border: '1px solid #d1d5db',
                  fontSize: '14px',
                  fontFamily: 'monospace'
                }}
              />
              <button
                onClick={() => setShowApiKey(!showApiKey)}
                disabled={saving || testing}
                style={{
                  padding: '10px 16px',
                  backgroundColor: '#f3f4f6',
                  border: '1px solid #d1d5db',
                  borderRadius: '6px',
                  fontSize: '14px',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap'
                }}
              >
                {showApiKey ? '隐藏' : '显示'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 通用设置 */}
      <div style={{
        marginTop: '20px',
        padding: '20px',
        backgroundColor: '#f9fafb',
        borderRadius: '8px',
        border: '1px solid #e5e7eb'
      }}>
        <h2 style={{ marginTop: 0, marginBottom: '20px', fontSize: '18px' }}>通用设置</h2>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
          <div>
            <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500 }}>
              超时时间（秒）
            </label>
            <input
              type="number"
              value={config.timeoutSeconds}
              onChange={(e) => setConfig({ ...config, timeoutSeconds: e.target.value === '' ? '' : Number(e.target.value) })}
              placeholder="30"
              min="1"
              disabled={saving || testing}
              style={{
                width: '100%',
                padding: '10px',
                borderRadius: '6px',
                border: '1px solid #d1d5db',
                fontSize: '14px',
                boxSizing: 'border-box'
              }}
            />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500 }}>
              每分钟最大请求数
            </label>
            <input
              type="number"
              value={config.rateLimitPerMinute}
              onChange={(e) => setConfig({ ...config, rateLimitPerMinute: e.target.value === '' ? '' : Number(e.target.value) })}
              placeholder="5"
              min="1"
              disabled={saving || testing}
              style={{
                width: '100%',
                padding: '10px',
                borderRadius: '6px',
                border: '1px solid #d1d5db',
                fontSize: '14px',
                boxSizing: 'border-box'
              }}
            />
          </div>
        </div>
      </div>

      {/* 高级设置 */}
      <div style={{
        marginTop: '20px',
        padding: '20px',
        backgroundColor: '#f9fafb',
        borderRadius: '8px',
        border: '1px solid #e5e7eb'
      }}>
        <h2 style={{ marginTop: 0, marginBottom: '20px', fontSize: '18px' }}>高级设置</h2>

        <div style={{ marginBottom: '15px' }}>
          <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500 }}>
            System Prompt 模板
          </label>
          <textarea
            value={config.systemPromptTemplate}
            onChange={(e) => setConfig({ ...config, systemPromptTemplate: e.target.value })}
            placeholder="你是一位耐心的算法学习导师..."
            disabled={saving || testing}
            rows={6}
            style={{
              width: '100%',
              padding: '10px',
              borderRadius: '6px',
              border: '1px solid #d1d5db',
              fontSize: '14px',
              fontFamily: 'monospace',
              resize: 'vertical',
              boxSizing: 'border-box'
            }}
          />
        </div>

        <div style={{ marginBottom: '15px' }}>
          <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500 }}>
            内置越狱规则（只读）
          </label>
          <div style={{
            maxHeight: '200px',
            overflowY: 'auto',
            padding: '12px',
            borderRadius: '6px',
            border: '1px solid #d1d5db',
            backgroundColor: '#fff'
          }}>
            {builtinJailbreakPatterns.length === 0 ? (
              <div style={{ color: '#6b7280', fontSize: '13px' }}>暂无内置规则</div>
            ) : (
              <ul style={{ margin: 0, paddingLeft: '20px' }}>
                {builtinJailbreakPatterns.map((pattern, index) => (
                  <li key={`${pattern}-${index}`} style={{ marginBottom: '6px', fontFamily: 'monospace', fontSize: '13px' }}>
                    {pattern}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div style={{ marginBottom: '15px' }}>
          <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500 }}>
            自定义越狱规则（每行一个正则表达式）
          </label>
          <textarea
            value={config.extraJailbreakPatternsText}
            onChange={(e) => setConfig({ ...config, extraJailbreakPatternsText: e.target.value })}
            placeholder="忽略.*提示词"
            disabled={saving || testing}
            rows={5}
            style={{
              width: '100%',
              padding: '10px',
              borderRadius: '6px',
              border: '1px solid #d1d5db',
              fontSize: '14px',
              fontFamily: 'monospace',
              resize: 'vertical',
              boxSizing: 'border-box'
            }}
          />
        </div>
      </div>

      {/* 越狱尝试记录（分页） */}
      <div style={{
        marginTop: '20px',
        padding: '20px',
        backgroundColor: '#f9fafb',
        borderRadius: '8px',
        border: '1px solid #e5e7eb'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <h2 style={{ margin: 0, fontSize: '18px' }}>越狱尝试记录</h2>
          {logPagination.total > 0 && (
            <span style={{ fontSize: '13px', color: '#6b7280' }}>
              共 {logPagination.total} 条记录
            </span>
          )}
        </div>

        {logPagination.logs.length === 0 ? (
          <div style={{
            padding: '15px',
            backgroundColor: '#fff',
            borderRadius: '6px',
            border: '1px dashed #d1d5db',
            color: '#6b7280',
            fontSize: '14px'
          }}>
            暂无命中记录，说明最近没有学生尝试修改系统提示词。
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              {logPagination.logs.map((log) => {
                const contextPieces: string[] = [];
                if (log.userId !== undefined) {
                  contextPieces.push(`用户 ID：${log.userId}`);
                }
                if (log.problemId) {
                  contextPieces.push(`题目 ID：${log.problemId}`);
                }
                if (log.conversationId) {
                  contextPieces.push(`会话 ID：${log.conversationId}`);
                }
                if (log.questionType) {
                  contextPieces.push(`问题类型：${log.questionType}`);
                }
                const contextText = contextPieces.join(' · ');
                return (
                  <div key={log.id} style={{
                    padding: '15px',
                    backgroundColor: '#fff',
                    borderRadius: '8px',
                    border: '1px solid #e5e7eb'
                  }}>
                    <div style={{ fontSize: '14px', color: '#111827', fontWeight: 500 }}>
                      时间：{new Date(log.createdAt).toLocaleString()}
                    </div>
                    <div style={{ marginTop: '6px', fontSize: '13px', color: '#4b5563' }}>
                      命中规则：<code style={{ fontFamily: 'monospace' }}>{log.matchedPattern}</code>
                    </div>
                    <pre style={{
                      marginTop: '10px',
                      padding: '12px',
                      backgroundColor: '#1f2937',
                      color: '#f9fafb',
                      borderRadius: '6px',
                      fontSize: '13px',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word'
                    }}>
                      {log.matchedText}
                    </pre>
                    {contextText && (
                      <div style={{ marginTop: '6px', fontSize: '12px', color: '#6b7280' }}>
                        {contextText}
                      </div>
                    )}
                    <div style={{
                      marginTop: '10px',
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: '10px'
                    }}>
                      <button
                        type="button"
                        onClick={() => copyToClipboard(log.matchedText)}
                        style={{
                          padding: '8px 12px',
                          backgroundColor: '#e5e7eb',
                          border: '1px solid #d1d5db',
                          borderRadius: '6px',
                          fontSize: '13px',
                          cursor: 'pointer'
                        }}
                      >
                        复制命中文本
                      </button>
                      <button
                        type="button"
                        onClick={() => copyToClipboard(log.matchedPattern)}
                        style={{
                          padding: '8px 12px',
                          backgroundColor: '#e5e7eb',
                          border: '1px solid #d1d5db',
                          borderRadius: '6px',
                          fontSize: '13px',
                          cursor: 'pointer'
                        }}
                      >
                        复制命中正则
                      </button>
                      <button
                        type="button"
                        onClick={() => appendPatternToCustomRules(log.matchedPattern)}
                        style={{
                          padding: '8px 12px',
                          backgroundColor: '#eef2ff',
                          border: '1px solid #c7d2fe',
                          borderRadius: '6px',
                          fontSize: '13px',
                          cursor: 'pointer'
                        }}
                      >
                        追加到自定义规则
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 分页控件 */}
            {logPagination.totalPages > 1 && (
              <div style={{
                marginTop: '20px',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                gap: '10px'
              }}>
                <button
                  onClick={() => changePage(logPagination.page - 1)}
                  disabled={logPagination.page <= 1 || loading}
                  style={{
                    padding: '8px 16px',
                    backgroundColor: logPagination.page <= 1 ? '#f3f4f6' : '#e5e7eb',
                    border: '1px solid #d1d5db',
                    borderRadius: '6px',
                    fontSize: '14px',
                    cursor: logPagination.page <= 1 ? 'not-allowed' : 'pointer'
                  }}
                >
                  上一页
                </button>
                <span style={{ fontSize: '14px', color: '#4b5563' }}>
                  第 {logPagination.page} / {logPagination.totalPages} 页
                </span>
                <button
                  onClick={() => changePage(logPagination.page + 1)}
                  disabled={logPagination.page >= logPagination.totalPages || loading}
                  style={{
                    padding: '8px 16px',
                    backgroundColor: logPagination.page >= logPagination.totalPages ? '#f3f4f6' : '#e5e7eb',
                    border: '1px solid #d1d5db',
                    borderRadius: '6px',
                    fontSize: '14px',
                    cursor: logPagination.page >= logPagination.totalPages ? 'not-allowed' : 'pointer'
                  }}
                >
                  下一页
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* 底部按钮区域 */}
      <div style={{
        marginTop: '30px',
        display: 'flex',
        justifyContent: 'space-between',
        gap: '15px'
      }}>
        {/* 测试连接按钮 */}
        <button
          onClick={testConnection}
          disabled={saving || testing || loading}
          style={{
            padding: '12px 24px',
            backgroundColor: testing || saving || loading ? '#9ca3af' : '#f3f4f6',
            color: testing || saving || loading ? '#ffffff' : '#374151',
            border: '1px solid #d1d5db',
            borderRadius: '6px',
            fontSize: '14px',
            fontWeight: 500,
            cursor: testing || saving || loading ? 'not-allowed' : 'pointer'
          }}
        >
          {testing ? '测试中...' : '测试连接'}
        </button>

        {/* 保存配置按钮 */}
        <button
          onClick={saveConfig}
          disabled={saving || testing || loading}
          style={{
            padding: '12px 32px',
            backgroundColor: saving || testing || loading ? '#9ca3af' : '#6366f1',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            fontSize: '14px',
            fontWeight: 500,
            cursor: saving || testing || loading ? 'not-allowed' : 'pointer'
          }}
        >
          {saving ? '保存中...' : '保存配置'}
        </button>
      </div>
    </div>
  );
};

export default ConfigPanel;
