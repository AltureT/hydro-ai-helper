import React, { useState, useEffect, useCallback } from 'react';
import { i18n } from 'vj/utils';
import { VersionBadge } from './VersionBadge';
import { EndpointManager } from './EndpointManager';
import { BudgetConfigForm } from './BudgetConfigForm';
import { JailbreakLogsViewer } from './JailbreakLogsViewer';
import { TelemetrySettings } from './TelemetrySettings';
import { FeedbackForm } from './FeedbackForm';
import { useToast, Toast } from '../components/Toast';
import {
  COLORS, FONT_FAMILY, TYPOGRAPHY, SPACING, RADIUS, SHADOWS, TRANSITIONS,
  cardStyle as dsCardStyle, getInputStyle, getButtonStyle,
} from '../utils/styles';
import type {
  Endpoint, ConfigState, JailbreakLogPagination, APIConfigResponse, TelemetryStatus,
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

  const [newApiKey, setNewApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [builtinJailbreakPatterns, setBuiltinJailbreakPatterns] = useState<string[]>([]);
  const [logPagination, setLogPagination] = useState<JailbreakLogPagination>({
    logs: [], total: 0, page: 1, totalPages: 0,
  });

  const { toasts, showToast, dismissToast } = useToast();

  const [logsLoading, setLogsLoading] = useState(false);
  const [telemetry, setTelemetry] = useState<TelemetryStatus | null>(null);

  useEffect(() => { loadConfig(); loadJailbreakLogs(1); }, []);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/ai-helper/admin/config`, {
        method: 'GET', credentials: 'include',
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `${i18n('ai_helper_config_error_load_failed', res.status)}`);
      }
      const json: APIConfigResponse = await res.json();
      setBuiltinJailbreakPatterns(json.builtinJailbreakPatterns || []);
      if (json.telemetry) setTelemetry(json.telemetry);

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
      showToast(err.message || i18n('ai_helper_config_error_load_failed', ''), 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadJailbreakLogs = useCallback(async (page: number = 1) => {
    setLogsLoading(true);
    try {
      const res = await fetch(`/ai-helper/admin/jailbreak-logs?page=${page}&limit=20`, {
        method: 'GET', credentials: 'include',
      });
      if (!res.ok) throw new Error(`${i18n('ai_helper_admin_jailbreak_load_failed')}: ${res.status}`);
      const json: JailbreakLogPagination = await res.json();
      setLogPagination(json);
    } catch (err: any) {
      console.error('Load jailbreak logs error:', err);
      showToast(err.message || i18n('ai_helper_admin_jailbreak_load_failed'), 'error');
    } finally {
      setLogsLoading(false);
    }
  }, []);

  const saveConfig = async () => {
    if (!config) return;
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
          id: ep.id,
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
        throw new Error(errorJson.error || `${i18n('ai_helper_config_error_save_failed', res.status)}`);
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
      setNewApiKey('');
      showToast(i18n('ai_helper_config_save_success'), 'success');
    } catch (err: any) {
      console.error('Save config error:', err);
      showToast(err.message || i18n('ai_helper_config_error_save_failed', ''), 'error');
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    setTesting(true);
    try {
      const res = await fetch('/ai-helper/admin/test-connection', {
        method: 'POST',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'include',
      });
      const json = await res.json();
      if (json.success) showToast(i18n('ai_helper_config_test_success'), 'success');
      else showToast(json.message || i18n('ai_helper_config_test_failed'), 'error');
    } catch (err: any) {
      console.error('Test connection error:', err);
      showToast(err.message || i18n('ai_helper_config_error_test_failed', ''), 'error');
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
    try {
      let body: any;
      if (endpoint.id && !endpoint.isNew) {
        body = { endpointId: endpoint.id };
      } else {
        if (!endpoint.apiBaseUrl || !endpoint.newApiKey) throw new Error(i18n('ai_helper_admin_fetch_models_params_missing'));
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
        showToast(i18n('ai_helper_admin_endpoint_models_fetched', json.models?.length || 0), 'success');
      } else {
        showToast(json.error || i18n('ai_helper_admin_fetch_models_failed'), 'error');
      }
    } catch (err: any) {
      console.error('Fetch models error:', err);
      showToast(err.message || i18n('ai_helper_admin_fetch_models_failed'), 'error');
    } finally {
      setFetchingModels(null);
    }
  };

  const addEndpoint = useCallback(() => {
    setConfig(prev => {
      if (!prev) return prev;
      return { ...prev, endpoints: [...prev.endpoints, { id: `temp-${Date.now()}`, name: `${i18n('ai_helper_admin_endpoint_default_name')} ${prev.endpoints.length + 1}`, apiBaseUrl: '', models: [], enabled: true, isNew: true, newApiKey: '' }] };
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
    loadJailbreakLogs(newPage);
  };

  const copyToClipboard = async (text: string) => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        showToast(i18n('ai_helper_admin_copied_to_clipboard'), 'success');
      } else {
        window.prompt(i18n('ai_helper_admin_copy_prompt'), text);
      }
    } catch (err) {
      console.error('Copy to clipboard failed:', err);
      window.prompt(i18n('ai_helper_admin_copy_fallback'), text);
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

  const cardTitleStyle: React.CSSProperties = {
    ...TYPOGRAPHY.md,
    color: COLORS.textPrimary,
    marginTop: 0, marginBottom: SPACING.base,
    borderBottom: `1px solid ${COLORS.border}`, paddingBottom: SPACING.md,
  };

  const outerStyle: React.CSSProperties = {
    padding: embedded ? SPACING.lg : SPACING.xl,
    fontFamily: FONT_FAMILY,
    maxWidth: embedded ? 'none' : '960px',
    margin: embedded ? '0' : '40px auto',
    boxSizing: 'border-box',
  };

  if (loading) {
    return (
      <div style={outerStyle}>
        {!embedded && <h1 style={{ ...TYPOGRAPHY.xl, color: COLORS.textPrimary, letterSpacing: '-0.025em' }}>{i18n('ai_helper_config_title')}</h1>}
        <div style={{ ...dsCardStyle, marginTop: '20px', textAlign: 'center', color: COLORS.textMuted }}>
          {i18n('ai_helper_config_loading')}
        </div>
      </div>
    );
  }

  if (!config) return null;

  return (
    <div style={outerStyle}>
      <Toast messages={toasts} onDismiss={dismissToast} />

      {!embedded && (
        <div style={{ marginBottom: SPACING.xl }}>
          <h1 style={{ ...TYPOGRAPHY.xl, color: COLORS.textPrimary, marginBottom: SPACING.sm, letterSpacing: '-0.025em' }}>{i18n('ai_helper_config_title')}</h1>
          <p style={{ fontSize: '15px', color: COLORS.textMuted, margin: 0 }}>{i18n('ai_helper_admin_config_subtitle')}</p>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: SPACING.lg }}>
        <VersionBadge />

        <div style={dsCardStyle}>
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

        <div style={dsCardStyle}>
          <h2 style={cardTitleStyle}>{i18n('ai_helper_admin_general_settings')}</h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
            <div>
              <label style={{ display: 'block', marginBottom: SPACING.xs, fontWeight: 500, color: COLORS.textPrimary }}>{i18n('ai_helper_config_timeout_seconds')}</label>
              <input
                type="number"
                value={config.timeoutSeconds}
                onChange={(e) => setConfig({ ...config, timeoutSeconds: e.target.value === '' ? '' : Number(e.target.value) })}
                placeholder="30" min="1" disabled={isBusy} style={getInputStyle()}
              />
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: SPACING.xs, fontWeight: 500, color: COLORS.textPrimary }}>{i18n('ai_helper_config_rate_limit_per_minute')}</label>
              <input
                type="number"
                value={config.rateLimitPerMinute}
                onChange={(e) => setConfig({ ...config, rateLimitPerMinute: e.target.value === '' ? '' : Number(e.target.value) })}
                placeholder="5" min="1" disabled={isBusy} style={getInputStyle()}
              />
            </div>
          </div>
        </div>

        <BudgetConfigForm
          budgetConfig={config.budgetConfig}
          onChange={(updates) => setConfig({ ...config, budgetConfig: { ...config.budgetConfig, ...updates } })}
          disabled={isBusy}
        />

        <div style={dsCardStyle}>
          <h2 style={cardTitleStyle}>{i18n('ai_helper_config_advanced_section')}</h2>
          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'block', marginBottom: SPACING.xs, fontWeight: 500, color: COLORS.textPrimary }}>{i18n('ai_helper_config_system_prompt')}</label>
            <textarea
              value={config.systemPromptTemplate}
              onChange={(e) => setConfig({ ...config, systemPromptTemplate: e.target.value })}
              placeholder={i18n('ai_helper_admin_system_prompt_placeholder')}
              disabled={isBusy} rows={6}
              style={{ ...getInputStyle(), fontFamily: 'monospace', resize: 'vertical' }}
            />
          </div>
          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'block', marginBottom: SPACING.xs, fontWeight: 500, color: COLORS.textPrimary }}>{i18n('ai_helper_admin_builtin_jailbreak_rules')}</label>
            <div style={{ maxHeight: '200px', overflowY: 'auto', padding: SPACING.md, borderRadius: RADIUS.md, border: `1px solid ${COLORS.border}`, backgroundColor: COLORS.bgPage }}>
              {builtinJailbreakPatterns.length === 0 ? (
                <div style={{ color: COLORS.textMuted, fontSize: '13px' }}>{i18n('ai_helper_admin_no_builtin_rules')}</div>
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
            <label style={{ display: 'block', marginBottom: SPACING.xs, fontWeight: 500, color: COLORS.textPrimary }}>{i18n('ai_helper_admin_custom_jailbreak_rules')}</label>
            <textarea
              value={config.extraJailbreakPatternsText}
              onChange={(e) => setConfig({ ...config, extraJailbreakPatternsText: e.target.value })}
              placeholder={i18n('ai_helper_admin_jailbreak_pattern_placeholder')}
              disabled={isBusy} rows={5}
              style={{ ...getInputStyle(), fontFamily: 'monospace', resize: 'vertical' }}
            />
          </div>
        </div>

        <JailbreakLogsViewer
          logPagination={logPagination}
          loading={logsLoading}
          onChangePage={changePage}
          onCopyToClipboard={copyToClipboard}
          onAppendPattern={appendPatternToCustomRules}
        />

        <TelemetrySettings
          telemetry={telemetry}
          onToggle={async (enabled) => {
            try {
              await fetch('/ai-helper/admin/config', {
                method: 'PUT', credentials: 'include',
                headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                body: JSON.stringify({ telemetryEnabled: enabled }),
              });
              setTelemetry(prev => prev ? { ...prev, enabled } : null);
              showToast(enabled ? i18n('ai_helper_admin_telemetry_enabled') : i18n('ai_helper_admin_telemetry_disabled'), 'success');
            } catch { showToast(i18n('ai_helper_admin_telemetry_update_failed'), 'error'); }
          }}
          disabled={saving}
        />

        <FeedbackForm showToast={showToast} />
      </div>

      <div style={{ height: '60px' }} />

      <div style={{
        position: 'fixed',
        bottom: SPACING.xl,
        right: SPACING.xl,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: SPACING.md,
        zIndex: 1000,
      }}>
        <div style={{
          display: 'flex', gap: '10px', padding: '10px',
          backgroundColor: COLORS.bgCard, borderRadius: RADIUS.lg,
          boxShadow: SHADOWS.lg,
          border: `1px solid ${COLORS.border}`,
        }}>
          <button
            onClick={testConnection}
            disabled={isBusy || loading}
            style={{
              ...getButtonStyle('secondary'),
              padding: '10px 20px',
              opacity: isBusy || loading ? 0.5 : 1,
              cursor: isBusy || loading ? 'not-allowed' : 'pointer',
            }}
          >
            {testing ? i18n('ai_helper_config_testing') : i18n('ai_helper_config_test_connection')}
          </button>
          <button
            onClick={saveConfig}
            disabled={isBusy || loading}
            style={{
              ...getButtonStyle('primary'),
              padding: '10px 24px',
              opacity: isBusy || loading ? 0.5 : 1,
              cursor: isBusy || loading ? 'not-allowed' : 'pointer',
            }}
          >
            {saving ? i18n('ai_helper_config_saving') : i18n('ai_helper_config_save')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfigPanel;
