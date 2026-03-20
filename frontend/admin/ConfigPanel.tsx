import React, { useState, useEffect, useCallback, useRef } from 'react';
import { VersionBadge } from './VersionBadge';
import { EndpointManager } from './EndpointManager';
import { BudgetConfigForm } from './BudgetConfigForm';
import { JailbreakLogsViewer } from './JailbreakLogsViewer';
import type {
  Endpoint, ConfigState, JailbreakLogPagination, APIConfigResponse,
} from './configTypes';

interface ConfigPanelProps {
  embedded?: boolean;
}

export const ConfigPanel: React.FC<ConfigPanelProps> = ({ embedded = false }) => {
  const [config, setConfig] = useState<ConfigState | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [fetchingModels, setFetchingModels] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const [newApiKey, setNewApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [builtinJailbreakPatterns, setBuiltinJailbreakPatterns] = useState<string[]>([]);
  const [logPagination, setLogPagination] = useState<JailbreakLogPagination>({
    logs: [], total: 0, page: 1, totalPages: 0,
  });
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showSuccess = (msg: string, durationMs = 3000) => {
    if (successTimerRef.current) clearTimeout(successTimerRef.current);
    setSuccessMessage(msg);
    successTimerRef.current = setTimeout(() => setSuccessMessage(null), durationMs);
  };

  useEffect(() => {
    return () => { if (successTimerRef.current) clearTimeout(successTimerRef.current); };
  }, []);

  useEffect(() => { loadConfig(); }, []);

  const loadConfig = useCallback(async (page: number = 1) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/ai-helper/admin/config?page=${page}&limit=20`, {
        method: 'GET', credentials: 'include',
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `加载配置失败: ${res.status}`);
      }
      const json: APIConfigResponse = await res.json();
      setBuiltinJailbreakPatterns(json.builtinJailbreakPatterns || []);

      if (json.jailbreakLogs) {
        setLogPagination(json.jailbreakLogs);
      } else if (json.recentJailbreakLogs) {
        setLogPagination({ logs: json.recentJailbreakLogs, total: json.recentJailbreakLogs.length, page: 1, totalPages: 1 });
      }

      if (json.config == null) {
        setConfig({
          endpoints: [], selectedModels: [],
          apiBaseUrl: '', modelName: '',
          rateLimitPerMinute: 5, timeoutSeconds: 30,
          systemPromptTemplate: '', extraJailbreakPatternsText: '',
          apiKeyMasked: '', hasApiKey: false,
          budgetConfig: { dailyTokenLimitPerUser: '', dailyTokenLimitPerDomain: '', monthlyTokenLimitPerDomain: '', softLimitPercent: 80 },
        });
      } else {
        setConfig({
          endpoints: (json.config.endpoints || []).map((ep) => ({ ...ep, newApiKey: '' })),
          selectedModels: json.config.selectedModels || [],
          apiBaseUrl: json.config.apiBaseUrl || '',
          modelName: json.config.modelName || '',
          rateLimitPerMinute: json.config.rateLimitPerMinute ?? 5,
          timeoutSeconds: json.config.timeoutSeconds ?? 30,
          systemPromptTemplate: json.config.systemPromptTemplate || '',
          extraJailbreakPatternsText: json.config.extraJailbreakPatternsText || '',
          apiKeyMasked: json.config.apiKeyMasked || '',
          hasApiKey: Boolean(json.config.hasApiKey),
          budgetConfig: {
            dailyTokenLimitPerUser: json.config.budgetConfig?.dailyTokenLimitPerUser || '',
            dailyTokenLimitPerDomain: json.config.budgetConfig?.dailyTokenLimitPerDomain || '',
            monthlyTokenLimitPerDomain: json.config.budgetConfig?.monthlyTokenLimitPerDomain || '',
            softLimitPercent: json.config.budgetConfig?.softLimitPercent ?? 80,
          },
        });
      }
    } catch (err: any) {
      console.error('Load config error:', err);
      setError(err.message || '加载配置失败');
    } finally {
      setLoading(false);
    }
  }, []);

  const saveConfig = async () => {
    if (!config) return;
    setError(null);
    setSuccessMessage(null);
    setSaving(true);
    try {
      const body: any = {
        rateLimitPerMinute: Number(config.rateLimitPerMinute) || 5,
        timeoutSeconds: Number(config.timeoutSeconds) || 30,
        systemPromptTemplate: config.systemPromptTemplate,
        extraJailbreakPatternsText: config.extraJailbreakPatternsText,
        budgetConfig: {
          dailyTokenLimitPerUser: Number(config.budgetConfig.dailyTokenLimitPerUser) || 0,
          dailyTokenLimitPerDomain: Number(config.budgetConfig.dailyTokenLimitPerDomain) || 0,
          monthlyTokenLimitPerDomain: Number(config.budgetConfig.monthlyTokenLimitPerDomain) || 0,
          softLimitPercent: Number(config.budgetConfig.softLimitPercent) || 80,
        },
      };
      if (config.endpoints.length > 0) {
        body.endpoints = config.endpoints.map(ep => ({
          id: ep.isNew ? undefined : ep.id,
          name: ep.name, apiBaseUrl: ep.apiBaseUrl,
          apiKey: ep.newApiKey || undefined, models: ep.models, enabled: ep.enabled,
        }));
        body.selectedModels = config.selectedModels;
      } else {
        body.apiBaseUrl = config.apiBaseUrl.trim();
        body.modelName = config.modelName.trim();
        if (newApiKey.trim()) body.apiKey = newApiKey.trim();
      }

      const res = await fetch('/ai-helper/admin/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errorJson = await res.json();
        throw new Error(errorJson.error || `保存失败: ${res.status}`);
      }
      const json: APIConfigResponse = await res.json();
      if (json.config) {
        setConfig({
          endpoints: (json.config.endpoints || []).map((ep) => ({ ...ep, newApiKey: '' })),
          selectedModels: json.config.selectedModels || [],
          apiBaseUrl: json.config.apiBaseUrl || '',
          modelName: json.config.modelName || '',
          rateLimitPerMinute: json.config.rateLimitPerMinute ?? 5,
          timeoutSeconds: json.config.timeoutSeconds ?? 30,
          systemPromptTemplate: json.config.systemPromptTemplate || '',
          extraJailbreakPatternsText: json.config.extraJailbreakPatternsText || '',
          apiKeyMasked: json.config.apiKeyMasked || '',
          hasApiKey: Boolean(json.config.hasApiKey),
          budgetConfig: {
            dailyTokenLimitPerUser: json.config.budgetConfig?.dailyTokenLimitPerUser || '',
            dailyTokenLimitPerDomain: json.config.budgetConfig?.dailyTokenLimitPerDomain || '',
            monthlyTokenLimitPerDomain: json.config.budgetConfig?.monthlyTokenLimitPerDomain || '',
            softLimitPercent: json.config.budgetConfig?.softLimitPercent ?? 80,
          },
        });
      }
      if (json.jailbreakLogs) setLogPagination(json.jailbreakLogs);
      setNewApiKey('');
      showSuccess('配置已保存');
    } catch (err: any) {
      console.error('Save config error:', err);
      setError(err.message || '保存配置失败');
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    setError(null);
    setSuccessMessage(null);
    setTesting(true);
    try {
      const res = await fetch('/ai-helper/admin/test-connection', {
        method: 'POST',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'include',
      });
      const json = await res.json();
      if (json.success) showSuccess('连接成功，AI 服务可用');
      else setError(json.message || '连接失败，AI 服务不可用');
    } catch (err: any) {
      console.error('Test connection error:', err);
      setError(err.message || '连接测试失败');
    } finally {
      setTesting(false);
    }
  };

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
        body = { endpointId: endpoint.id };
      } else {
        if (!endpoint.apiBaseUrl || !endpoint.newApiKey) throw new Error('请先填写 API Base URL 和 API Key');
        body = { apiBaseUrl: endpoint.apiBaseUrl, apiKey: endpoint.newApiKey };
      }
      const res = await fetch('/ai-helper/admin/fetch-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (json.success) {
        const newEndpoints = [...config.endpoints];
        newEndpoints[endpointIndex] = { ...newEndpoints[endpointIndex], models: json.models || [], modelsLastFetched: new Date().toISOString() };
        setConfig({ ...config, endpoints: newEndpoints });
        showSuccess(`获取到 ${json.models?.length || 0} 个可用模型`);
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

  const addEndpoint = useCallback(() => {
    setConfig(prev => {
      if (!prev) return prev;
      return { ...prev, endpoints: [...prev.endpoints, { name: `端点 ${prev.endpoints.length + 1}`, apiBaseUrl: '', models: [], enabled: true, isNew: true, newApiKey: '' }] };
    });
  }, []);

  const removeEndpoint = useCallback((index: number) => {
    setConfig(prev => {
      if (!prev) return prev;
      const ep = prev.endpoints[index];
      return {
        ...prev,
        endpoints: prev.endpoints.filter((_, i) => i !== index),
        selectedModels: ep?.id ? prev.selectedModels.filter(sm => sm.endpointId !== ep.id) : prev.selectedModels,
      };
    });
  }, []);

  const updateEndpoint = useCallback((index: number, updates: Partial<Endpoint>) => {
    setConfig(prev => {
      if (!prev) return prev;
      const newEndpoints = [...prev.endpoints];
      newEndpoints[index] = { ...newEndpoints[index], ...updates };
      return { ...prev, endpoints: newEndpoints };
    });
  }, []);

  const addSelectedModel = useCallback((endpointId: string, modelName: string) => {
    setConfig(prev => {
      if (!prev) return prev;
      if (prev.selectedModels.some(sm => sm.endpointId === endpointId && sm.modelName === modelName)) return prev;
      return { ...prev, selectedModels: [...prev.selectedModels, { endpointId, modelName }] };
    });
  }, []);

  const removeSelectedModel = useCallback((index: number) => {
    setConfig(prev => {
      if (!prev) return prev;
      return { ...prev, selectedModels: prev.selectedModels.filter((_, i) => i !== index) };
    });
  }, []);

  const moveSelectedModel = useCallback((index: number, direction: 'up' | 'down') => {
    setConfig(prev => {
      if (!prev) return prev;
      const ni = direction === 'up' ? index - 1 : index + 1;
      if (ni < 0 || ni >= prev.selectedModels.length) return prev;
      const arr = [...prev.selectedModels];
      [arr[index], arr[ni]] = [arr[ni], arr[index]];
      return { ...prev, selectedModels: arr };
    });
  }, []);

  const changePage = (newPage: number) => {
    if (newPage < 1 || newPage > logPagination.totalPages) return;
    loadConfig(newPage);
  };

  const copyToClipboard = async (text: string) => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        showSuccess('已复制到剪贴板', 2000);
      } else {
        window.prompt('请复制以下内容', text);
      }
    } catch (err) {
      console.error('Copy to clipboard failed:', err);
      window.prompt('复制失败，请手动复制：', text);
    }
  };

  const appendPatternToCustomRules = (pattern: string) => {
    setConfig(prev => {
      if (!prev) return prev;
      const np = pattern.trim();
      if (!np) return prev;
      const existing = prev.extraJailbreakPatternsText || '';
      const prefix = existing.length > 0 ? `${existing}${existing.endsWith('\n') ? '' : '\n'}` : '';
      return { ...prev, extraJailbreakPatternsText: `${prefix}${np}` };
    });
  };

  const isBusy = saving || testing;
  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px', borderRadius: '6px',
    border: '1px solid #d1d5db', fontSize: '14px', boxSizing: 'border-box',
  };
  const cardStyle: React.CSSProperties = {
    backgroundColor: '#ffffff', borderRadius: '12px',
    boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06)',
    padding: '24px', border: '1px solid #e5e7eb',
  };
  const cardTitleStyle: React.CSSProperties = {
    fontSize: '18px', fontWeight: 600, color: '#111827',
    marginTop: 0, marginBottom: '16px',
    borderBottom: '1px solid #f3f4f6', paddingBottom: '12px',
  };

  const outerStyle: React.CSSProperties = {
    padding: embedded ? '24px' : '32px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    maxWidth: embedded ? 'none' : '960px',
    margin: embedded ? '0' : '40px auto',
    boxSizing: 'border-box',
  };

  if (loading) {
    return (
      <div style={outerStyle}>
        {!embedded && <h1 style={{ fontSize: '28px', fontWeight: 700, color: '#111827', letterSpacing: '-0.025em' }}>AI 学习助手配置</h1>}
        <div style={{ ...cardStyle, marginTop: '20px', textAlign: 'center', color: '#6b7280' }}>
          正在加载配置...
        </div>
      </div>
    );
  }

  if (!config) return null;

  return (
    <div style={outerStyle}>
      {!embedded && (
        <div style={{ marginBottom: '32px' }}>
          <h1 style={{ fontSize: '28px', fontWeight: 700, color: '#111827', marginBottom: '8px', letterSpacing: '-0.025em' }}>AI 学习助手配置</h1>
          <p style={{ fontSize: '15px', color: '#6b7280', margin: 0 }}>管理 API 端点、模型选择与安全策略</p>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
        {/* Version Badge */}
        <VersionBadge />

        {/* Endpoint Manager */}
        <div style={cardStyle}>
          <EndpointManager
            endpoints={config.endpoints}
            selectedModels={config.selectedModels}
            onUpdateEndpoint={updateEndpoint}
            onRemoveEndpoint={removeEndpoint}
            onAddEndpoint={addEndpoint}
            onFetchModels={fetchModelsForEndpoint}
            fetchingModels={fetchingModels}
            onAddSelectedModel={addSelectedModel}
            onRemoveSelectedModel={removeSelectedModel}
            onMoveSelectedModel={moveSelectedModel}
            disabled={isBusy}
            legacy={{
              apiBaseUrl: config.apiBaseUrl,
              modelName: config.modelName,
              apiKeyMasked: config.apiKeyMasked,
              hasApiKey: config.hasApiKey,
              newApiKey,
              showApiKey,
              onApiBaseUrlChange: (v) => setConfig({ ...config, apiBaseUrl: v }),
              onModelNameChange: (v) => setConfig({ ...config, modelName: v }),
              onNewApiKeyChange: setNewApiKey,
              onShowApiKeyToggle: () => setShowApiKey(prev => !prev),
            }}
          />
        </div>

        {/* General Settings */}
        <div style={cardStyle}>
          <h2 style={cardTitleStyle}>通用设置</h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
            <div>
              <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500 }}>超时时间（秒）</label>
              <input
                type="number"
                value={config.timeoutSeconds}
                onChange={(e) => setConfig({ ...config, timeoutSeconds: e.target.value === '' ? '' : Number(e.target.value) })}
                placeholder="30" min="1" disabled={isBusy} style={inputStyle}
              />
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500 }}>每分钟最大请求数</label>
              <input
                type="number"
                value={config.rateLimitPerMinute}
                onChange={(e) => setConfig({ ...config, rateLimitPerMinute: e.target.value === '' ? '' : Number(e.target.value) })}
                placeholder="5" min="1" disabled={isBusy} style={inputStyle}
              />
            </div>
          </div>
        </div>

        {/* Budget Config */}
        <BudgetConfigForm
          budgetConfig={config.budgetConfig}
          onChange={(updates) => setConfig({ ...config, budgetConfig: { ...config.budgetConfig, ...updates } })}
          disabled={isBusy}
        />

        {/* Advanced Settings */}
        <div style={cardStyle}>
          <h2 style={cardTitleStyle}>高级设置</h2>
          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500 }}>System Prompt 模板</label>
            <textarea
              value={config.systemPromptTemplate}
              onChange={(e) => setConfig({ ...config, systemPromptTemplate: e.target.value })}
              placeholder="你是一位耐心的算法学习导师..."
              disabled={isBusy} rows={6}
              style={{ ...inputStyle, fontFamily: 'monospace', resize: 'vertical' }}
            />
          </div>
          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500 }}>内置越狱规则（只读）</label>
            <div style={{ maxHeight: '200px', overflowY: 'auto', padding: '12px', borderRadius: '6px', border: '1px solid #d1d5db', backgroundColor: '#f9fafb' }}>
              {builtinJailbreakPatterns.length === 0 ? (
                <div style={{ color: '#6b7280', fontSize: '13px' }}>暂无内置规则</div>
              ) : (
                <ul style={{ margin: 0, paddingLeft: '20px' }}>
                  {builtinJailbreakPatterns.map((pattern, index) => (
                    <li key={`${pattern}-${index}`} style={{ marginBottom: '6px', fontFamily: 'monospace', fontSize: '13px' }}>{pattern}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500 }}>自定义越狱规则（每行一个正则表达式）</label>
            <textarea
              value={config.extraJailbreakPatternsText}
              onChange={(e) => setConfig({ ...config, extraJailbreakPatternsText: e.target.value })}
              placeholder="忽略.*提示词"
              disabled={isBusy} rows={5}
              style={{ ...inputStyle, fontFamily: 'monospace', resize: 'vertical' }}
            />
          </div>
        </div>

        {/* Jailbreak Logs */}
        <JailbreakLogsViewer
          logPagination={logPagination}
          loading={loading}
          onChangePage={changePage}
          onCopyToClipboard={copyToClipboard}
          onAppendPattern={appendPatternToCustomRules}
        />
      </div>

      {/* Spacer for floating buttons */}
      <div style={{ height: '60px' }} />

      {/* Floating Action Buttons - bottom right */}
      <div style={{
        position: 'fixed',
        bottom: '32px',
        right: '32px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: '12px',
        zIndex: 1000,
      }}>
        {/* Toast notifications */}
        {error && (
          <div style={{
            padding: '12px 16px', backgroundColor: '#fee2e2',
            borderLeft: '4px solid #ef4444', borderRadius: '8px', color: '#991b1b',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.12)',
            fontSize: '14px', maxWidth: '350px', wordBreak: 'break-word',
          }}>
            <strong>错误：</strong>{error}
          </div>
        )}
        {successMessage && (
          <div style={{
            padding: '12px 16px', backgroundColor: '#d1fae5',
            borderLeft: '4px solid #10b981', borderRadius: '8px', color: '#065f46',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.12)',
            fontSize: '14px', maxWidth: '350px', wordBreak: 'break-word',
          }}>
            <strong>成功：</strong>{successMessage}
          </div>
        )}

        {/* Button group */}
        <div style={{
          display: 'flex', gap: '10px', padding: '10px',
          backgroundColor: '#ffffff', borderRadius: '12px',
          boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.15), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
          border: '1px solid #f3f4f6',
        }}>
          <button
            onClick={testConnection}
            disabled={isBusy || loading}
            style={{
              padding: '10px 20px',
              backgroundColor: isBusy || loading ? '#f3f4f6' : '#ffffff',
              color: isBusy || loading ? '#9ca3af' : '#374151',
              border: '1px solid #d1d5db', borderRadius: '8px',
              fontSize: '14px', fontWeight: 500,
              cursor: isBusy || loading ? 'not-allowed' : 'pointer',
            }}
          >
            {testing ? '测试中...' : '测试连接'}
          </button>
          <button
            onClick={saveConfig}
            disabled={isBusy || loading}
            style={{
              padding: '10px 24px',
              backgroundColor: isBusy || loading ? '#9ca3af' : '#6366f1',
              color: '#ffffff', border: 'none', borderRadius: '8px',
              fontSize: '14px', fontWeight: 500,
              boxShadow: isBusy || loading ? 'none' : '0 1px 3px rgba(99, 102, 241, 0.3)',
              cursor: isBusy || loading ? 'not-allowed' : 'pointer',
            }}
          >
            {saving ? '保存中...' : '保存配置'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfigPanel;
