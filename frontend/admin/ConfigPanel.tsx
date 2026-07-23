import React, { useState, useEffect, useCallback } from 'react';
import { i18n } from '../utils/i18n';
import { VersionBadge } from './VersionBadge';
import { EndpointManager } from './EndpointManager';
import { ScenarioModelSelector } from './ScenarioModelSelector';
import { TestdataBenchmarkPanel } from './TestdataBenchmarkPanel';
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
  AIScenarioKey, SelectedModel, ScenarioModelsState,
} from './configTypes';

const EMPTY_SCENARIO_MODELS: ScenarioModelsState = {
  studentChat: [], learningSummary: [], teachingAnalysis: [], testdataGeneration: [],
};
const BENCHMARK_GUIDE_STORAGE_KEY = 'ai-helper:testdata-benchmark-guide:v2';

function parseScenarioModels(raw?: Partial<Record<AIScenarioKey, SelectedModel[]>>): ScenarioModelsState {
  return {
    studentChat: raw?.studentChat || [],
    learningSummary: raw?.learningSummary || [],
    teachingAnalysis: raw?.teachingAnalysis || [],
    testdataGeneration: raw?.testdataGeneration || [],
  };
}

function toConfigState(raw: APIConfigResponse['config']): ConfigState {
  if (!raw) {
    return {
      endpoints: [], selectedModels: [],
      scenarioModels: { ...EMPTY_SCENARIO_MODELS },
      apiBaseUrl: '', modelName: '',
      rateLimitPerMinute: 5, timeoutSeconds: 30,
      systemPromptTemplate: '', extraJailbreakPatternsText: '',
      apiKeyMasked: '', hasApiKey: false,
      budgetConfig: {
        dailyTokenLimitPerUser: '', dailyTokenLimitPerDomain: '',
        monthlyTokenLimitPerDomain: '', softLimitPercent: 80,
      },
    };
  }
  return {
    endpoints: (raw.endpoints || []).map((endpoint) => ({ ...endpoint, newApiKey: '' })),
    selectedModels: raw.selectedModels || [],
    scenarioModels: parseScenarioModels(raw.scenarioModels),
    apiBaseUrl: raw.apiBaseUrl || '',
    modelName: raw.modelName || '',
    rateLimitPerMinute: raw.rateLimitPerMinute ?? 5,
    timeoutSeconds: raw.timeoutSeconds ?? 30,
    systemPromptTemplate: raw.systemPromptTemplate || '',
    extraJailbreakPatternsText: raw.extraJailbreakPatternsText || '',
    apiKeyMasked: raw.apiKeyMasked || '',
    hasApiKey: Boolean(raw.hasApiKey),
    budgetConfig: {
      dailyTokenLimitPerUser: raw.budgetConfig?.dailyTokenLimitPerUser || '',
      dailyTokenLimitPerDomain: raw.budgetConfig?.dailyTokenLimitPerDomain || '',
      monthlyTokenLimitPerDomain: raw.budgetConfig?.monthlyTokenLimitPerDomain || '',
      softLimitPercent: raw.budgetConfig?.softLimitPercent ?? 80,
    },
  };
}

function configSignature(config: ConfigState, legacyNewApiKey: string): string {
  return JSON.stringify({ config, legacyNewApiKey });
}

interface ConfigPanelProps {
  embedded?: boolean;
}

export const ConfigPanel: React.FC<ConfigPanelProps> = ({ embedded = false }) => {
  const [config, setConfig] = useState<ConfigState | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [fetchingModels, setFetchingModels] = useState<string | null>(null);
  const [savedConfigSignature, setSavedConfigSignature] = useState('');
  const [showBenchmarkGuide, setShowBenchmarkGuide] = useState(false);

  const [newApiKey, setNewApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [builtinJailbreakPatterns, setBuiltinJailbreakPatterns] = useState<string[]>([]);
  const [logPagination, setLogPagination] = useState<JailbreakLogPagination>({
    logs: [], total: 0, page: 1, totalPages: 0,
  });

  const { toasts, showToast, dismissToast } = useToast();

  const [logsLoading, setLogsLoading] = useState(false);
  const [telemetry, setTelemetry] = useState<TelemetryStatus | null>(null);

  useEffect(() => {
    loadConfig();
    loadJailbreakLogs(1);
    try {
      setShowBenchmarkGuide(localStorage.getItem(BENCHMARK_GUIDE_STORAGE_KEY) !== 'dismissed');
    } catch { setShowBenchmarkGuide(true); }
  }, []);

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

      const nextConfig = toConfigState(json.config);
      setConfig(nextConfig);
      setSavedConfigSignature(configSignature(nextConfig, ''));
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
        body.scenarioModels = config.scenarioModels;
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
        const nextConfig = toConfigState(json.config);
        setConfig(nextConfig);
        setSavedConfigSignature(configSignature(nextConfig, ''));
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
      const dropEndpoint = (models: typeof prev.selectedModels) =>
        ep?.id ? models.filter(sm => sm.endpointId !== ep.id) : models;
      return {
        ...prev,
        endpoints: prev.endpoints.filter((_, i) => i !== index),
        selectedModels: dropEndpoint(prev.selectedModels),
        scenarioModels: {
          studentChat: dropEndpoint(prev.scenarioModels.studentChat),
          learningSummary: dropEndpoint(prev.scenarioModels.learningSummary),
          teachingAnalysis: dropEndpoint(prev.scenarioModels.teachingAnalysis),
          testdataGeneration: dropEndpoint(prev.scenarioModels.testdataGeneration),
        },
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

  const updateScenarioModels = useCallback((scenario: AIScenarioKey, chain: SelectedModel[]) => {
    setConfig(prev => {
      if (!prev) return prev;
      return { ...prev, scenarioModels: { ...prev.scenarioModels, [scenario]: chain } };
    });
  }, []);

  const changePage = (newPage: number) => {
    if (newPage < 1 || newPage > logPagination.totalPages) return;
    loadJailbreakLogs(newPage);
  };

  const reviewJailbreakLog = async (
    id: string,
    reviewStatus: 'confirmed' | 'false_positive'
  ) => {
    try {
      const res = await fetch(`/ai-helper/admin/jailbreak-logs/${encodeURIComponent(id)}/review`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ reviewStatus }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || i18n('ai_helper_admin_jailbreak_review_failed'));
      }
      showToast(i18n('ai_helper_admin_jailbreak_review_success'), 'success');
      await loadJailbreakLogs(logPagination.page);
    } catch (err: any) {
      console.error('Review jailbreak log error:', err);
      showToast(err.message || i18n('ai_helper_admin_jailbreak_review_failed'), 'error');
    }
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

  const dismissBenchmarkGuide = () => {
    setShowBenchmarkGuide(false);
    try { localStorage.setItem(BENCHMARK_GUIDE_STORAGE_KEY, 'dismissed'); } catch { /* best effort */ }
  };

  const scrollToBenchmark = () => {
    document.getElementById('testdata-benchmark-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const scrollToModelSettings = () => {
    const target = config?.endpoints.length
      ? 'testdata-scenario-models-section'
      : 'api-endpoint-config-section';
    document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

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

  const configuredGenerationChain = config.scenarioModels.testdataGeneration.length > 0
    ? config.scenarioModels.testdataGeneration
    : config.selectedModels;
  const modelChainLabels = configuredGenerationChain.map(selected => selected.modelName);
  if (modelChainLabels.length === 0 && config.modelName) modelChainLabels.push(config.modelName);
  const usesGlobalModelChain = config.endpoints.length > 0
    && config.scenarioModels.testdataGeneration.length === 0;
  const hasUnsavedChanges = savedConfigSignature !== ''
    && configSignature(config, newApiKey) !== savedConfigSignature;

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

        {showBenchmarkGuide && (
          <div style={{
            ...dsCardStyle,
            borderColor: COLORS.infoBorder,
            background: `linear-gradient(135deg, ${COLORS.infoBg}, ${COLORS.bgCard})`,
          }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: SPACING.base }}>
              <span style={{
                display: 'inline-flex', padding: `3px ${SPACING.sm}`,
                borderRadius: RADIUS.full, background: COLORS.primary,
                color: '#fff', fontSize: '11px', fontWeight: 700, lineHeight: 1.4,
              }}>NEW</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h2 style={{ ...TYPOGRAPHY.md, color: COLORS.textPrimary, margin: `0 0 ${SPACING.xs}` }}>
                  {i18n('ai_helper_testdata_benchmark_onboarding_title')}
                </h2>
                <p style={{ ...TYPOGRAPHY.sm, color: COLORS.textSecondary, margin: 0 }}>
                  {i18n('ai_helper_testdata_benchmark_onboarding_desc')}
                </p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: SPACING.sm, marginTop: SPACING.md }}>
                  <button type="button" style={getButtonStyle('primary')} onClick={scrollToBenchmark}>
                    {i18n('ai_helper_testdata_benchmark_onboarding_action')}
                  </button>
                  <button type="button" style={getButtonStyle('ghost')} onClick={dismissBenchmarkGuide}>
                    {i18n('ai_helper_testdata_benchmark_onboarding_dismiss')}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        <div id="api-endpoint-config-section" style={dsCardStyle}>
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
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            flexWrap: 'wrap', gap: SPACING.md, marginTop: SPACING.lg,
            paddingTop: SPACING.base, borderTop: `1px solid ${COLORS.border}`,
          }}>
            <span style={{ ...TYPOGRAPHY.xs, color: COLORS.textMuted }}>
              {i18n('ai_helper_config_test_connection_hint')}
            </span>
            <button
              onClick={testConnection}
              disabled={isBusy || loading}
              style={{
                ...getButtonStyle('secondary'),
                opacity: isBusy || loading ? 0.5 : 1,
                cursor: isBusy || loading ? 'not-allowed' : 'pointer',
              }}
            >
              {testing ? i18n('ai_helper_config_testing') : i18n('ai_helper_config_test_connection')}
            </button>
          </div>
        </div>

        {config.endpoints.length > 0 && (
          <div id="testdata-scenario-models-section" style={dsCardStyle}>
            <ScenarioModelSelector
              endpoints={config.endpoints}
              globalModels={config.selectedModels}
              scenarioModels={config.scenarioModels}
              onChange={updateScenarioModels}
              disabled={isBusy}
            />
          </div>
        )}

        <div id="testdata-benchmark-section" style={{ ...dsCardStyle, scrollMarginTop: SPACING.lg }}>
          <TestdataBenchmarkPanel
            disabled={isBusy}
            saving={saving}
            modelChainLabels={modelChainLabels}
            usesGlobalModelChain={usesGlobalModelChain}
            hasUnsavedChanges={hasUnsavedChanges}
            onOpenModelSettings={scrollToModelSettings}
            onSaveConfig={saveConfig}
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
              <p style={{ fontSize: '12px', color: COLORS.textMuted, margin: `${SPACING.xs} 0 0` }}>
                {i18n('ai_helper_config_timeout_hint')}
              </p>
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: SPACING.xs, fontWeight: 500, color: COLORS.textPrimary }}>{i18n('ai_helper_config_rate_limit_per_minute')}</label>
              <input
                type="number"
                value={config.rateLimitPerMinute}
                onChange={(e) => setConfig({ ...config, rateLimitPerMinute: e.target.value === '' ? '' : Number(e.target.value) })}
                placeholder="5" min="0" disabled={isBusy} style={getInputStyle()}
              />
              <p style={{ fontSize: '12px', color: COLORS.textMuted, margin: `${SPACING.xs} 0 0` }}>
                {i18n('ai_helper_config_rate_limit_hint')}
              </p>
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
          onReview={reviewJailbreakLog}
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
        zIndex: 1000,
      }}>
        <div style={{
          display: 'flex', padding: '10px',
          backgroundColor: COLORS.bgCard, borderRadius: RADIUS.lg,
          boxShadow: SHADOWS.lg,
          border: `1px solid ${COLORS.border}`,
        }}>
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
