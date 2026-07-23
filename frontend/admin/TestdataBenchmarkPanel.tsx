import React, { useCallback, useEffect, useRef, useState } from 'react';
import { i18n } from '../utils/i18n';
import {
  COLORS, RADIUS, SPACING, TYPOGRAPHY,
  getAlertStyle, getBadgeStyle, getButtonStyle,
  modalContentStyle, modalOverlayStyle,
} from '../utils/styles';

interface BenchmarkCaseOption {
  id: string;
  titleKey: string;
  purposeKey: string;
}

const BENCHMARK_CASES: BenchmarkCaseOption[] = [
  {
    id: 'xor-subarrays-less-than-k',
    titleKey: 'ai_helper_testdata_benchmark_case_xor',
    purposeKey: 'ai_helper_testdata_benchmark_case_xor_purpose',
  },
  {
    id: 'dynamic-connectivity-offline',
    titleKey: 'ai_helper_testdata_benchmark_case_connectivity',
    purposeKey: 'ai_helper_testdata_benchmark_case_connectivity_purpose',
  },
  {
    id: 'range-flip-longest-ones',
    titleKey: 'ai_helper_testdata_benchmark_case_segment',
    purposeKey: 'ai_helper_testdata_benchmark_case_segment_purpose',
  },
];
const QUICK_CASE_ID = BENCHMARK_CASES[0].id;

function getCaseLabel(caseId?: string, fallback = ''): string {
  const option = BENCHMARK_CASES.find(item => item.id === caseId);
  return option ? i18n(option.titleKey) : fallback;
}

interface BenchmarkCaseResult {
  id: string;
  title: string;
  passed: boolean;
  durationMs: number;
  usedModel?: string;
  failureStage?: string;
  qualityGateFailures: string[];
  probes: Array<{ name: string; passed: boolean }>;
}

interface BenchmarkReport {
  schemaVersion: 1;
  runId: string;
  completedAt: string;
  pluginVersion: string;
  models: string[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    passRate: number;
    durationMs: number;
    totalTokens: number;
    failureStages: Record<string, number>;
  };
  results: BenchmarkCaseResult[];
}

interface BenchmarkPayload {
  report: BenchmarkReport;
  aggregate: unknown;
}

interface ProgressState {
  caseId?: string;
  title?: string;
  index: number;
  total: number;
  stage?: string;
  casePercent: number;
}

interface TestdataBenchmarkPanelProps {
  disabled?: boolean;
  saving?: boolean;
  modelChainLabels: string[];
  usesGlobalModelChain: boolean;
  hasUnsavedChanges: boolean;
  onOpenModelSettings: () => void;
  onSaveConfig: () => Promise<void>;
}

interface PreflightState {
  checking: boolean;
  modelConfigured?: boolean;
  sandboxAvailable?: boolean;
  error?: string;
}

async function consumeBenchmarkStream(
  response: Response,
  onEvent: (event: string, data: any) => void,
): Promise<BenchmarkPayload> {
  if (!response.body) throw new Error(i18n('ai_helper_testdata_progress_stream_missing'));
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = '';
  let dataLines: string[] = [];
  let result: BenchmarkPayload | null = null;
  let streamError = '';
  const dispatch = () => {
    if (!eventName || dataLines.length === 0) {
      eventName = '';
      dataLines = [];
      return;
    }
    try {
      const data = JSON.parse(dataLines.join('\n'));
      if (eventName === 'result') result = data as BenchmarkPayload;
      else if (eventName === 'error') streamError = String(data?.error || i18n('ai_helper_testdata_benchmark_failed'));
      else onEvent(eventName, data);
    } catch { /* ignore malformed best-effort event */ }
    eventName = '';
    dataLines = [];
  };
  const processLine = (raw: string) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line) dispatch();
    else if (line.startsWith('event:')) eventName = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      lines.forEach(processLine);
    }
    buffer += decoder.decode();
    if (buffer) processLine(buffer);
    dispatch();
  } finally {
    reader.releaseLock();
  }
  if (streamError) throw new Error(streamError);
  if (!result) throw new Error(i18n('ai_helper_testdata_benchmark_no_result'));
  return result;
}

function downloadJson(filename: string, value: unknown) {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export const TestdataBenchmarkPanel: React.FC<TestdataBenchmarkPanelProps> = ({
  disabled = false,
  saving = false,
  modelChainLabels,
  usesGlobalModelChain,
  hasUnsavedChanges,
  onOpenModelSettings,
  onSaveConfig,
}) => {
  const [selected, setSelected] = useState([QUICK_CASE_ID]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ProgressState>({ index: 0, total: 0, casePercent: 0 });
  const [caseResults, setCaseResults] = useState<Array<Pick<BenchmarkCaseResult, 'id' | 'title' | 'passed' | 'durationMs' | 'failureStage'>>>([]);
  const [payload, setPayload] = useState<BenchmarkPayload | null>(null);
  const [error, setError] = useState('');
  const [errorDetails, setErrorDetails] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [preflight, setPreflight] = useState<PreflightState>({ checking: true });
  const abortRef = useRef<AbortController | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);

  const checkReadiness = useCallback(async () => {
    setPreflight({ checking: true });
    try {
      const response = await fetch('/ai-helper/admin/testdata-benchmark', {
        method: 'GET',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      setPreflight({
        checking: false,
        modelConfigured: Boolean(data.modelConfigured),
        sandboxAvailable: Boolean(data.sandboxAvailable),
      });
    } catch (err) {
      setPreflight({
        checking: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  useEffect(() => {
    if (!hasUnsavedChanges) checkReadiness();
  }, [checkReadiness, hasUnsavedChanges]);

  useEffect(() => {
    if (confirmOpen) confirmButtonRef.current?.focus();
  }, [confirmOpen]);

  const toggleCase = (id: string) => {
    setSelected(current => current.includes(id)
      ? current.filter(item => item !== id)
      : [...current, id]);
  };

  const selectQuickMode = () => setSelected([QUICK_CASE_ID]);
  const selectFullMode = () => setSelected(BENCHMARK_CASES.map(item => item.id));
  const selectionMode = selected.length === 1 && selected[0] === QUICK_CASE_ID
    ? 'quick'
    : selected.length === BENCHMARK_CASES.length ? 'full' : 'custom';
  const canRun = !preflight.checking
    && preflight.modelConfigured === true
    && preflight.sandboxAvailable === true
    && !hasUnsavedChanges;

  const saveAndRecheck = async () => {
    await onSaveConfig();
  };

  const requestRun = () => {
    setErrorDetails('');
    if (selected.length === 0) {
      setError(i18n('ai_helper_testdata_benchmark_select_case'));
      return;
    }
    if (!canRun) {
      setError(i18n('ai_helper_testdata_benchmark_not_ready'));
      return;
    }
    setConfirmOpen(true);
  };

  const run = async () => {
    setConfirmOpen(false);
    setRunning(true);
    setError('');
    setErrorDetails('');
    setPayload(null);
    setCaseResults([]);
    setProgress({ index: 0, total: selected.length, casePercent: 0 });
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const response = await fetch('/ai-helper/admin/testdata-benchmark', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'text/event-stream, application/json',
        },
        signal: ac.signal,
        body: JSON.stringify({ confirmCost: true, caseIds: selected }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(String(data?.error || `HTTP ${response.status}`));
      }
      const contentType = response.headers.get('content-type') || '';
      const nextPayload = contentType.includes('text/event-stream')
        ? await consumeBenchmarkStream(response, (event, data) => {
          if (event === 'case_start') {
            setProgress({
              caseId: data.caseId,
              title: data.title,
              index: Number(data.index) || 1,
              total: Number(data.total) || selected.length,
              casePercent: 0,
            });
          } else if (event === 'progress') {
            setProgress(current => ({
              ...current,
              caseId: data.caseId || current.caseId,
              stage: data.stage,
              casePercent: Math.max(current.casePercent, Math.min(100, Number(data.percent) || 0)),
            }));
          } else if (event === 'case_result') {
            setCaseResults(current => [...current, data]);
          }
        })
        : await response.json() as BenchmarkPayload;
      setPayload(nextPayload);
      setProgress(current => ({ ...current, casePercent: 100 }));
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setError(i18n('ai_helper_testdata_benchmark_canceled'));
      } else {
        setError(i18n('ai_helper_testdata_benchmark_failed'));
        setErrorDetails(err instanceof Error ? err.message : String(err));
      }
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  };

  const totalProgress = progress.total > 0
    ? Math.round((((Math.max(1, progress.index) - 1) + progress.casePercent / 100) / progress.total) * 100)
    : 0;
  const assessment = payload
    ? payload.report.summary.total === 1 && payload.report.summary.passed === 1
      ? {
        variant: 'info' as const,
        labelKey: 'ai_helper_testdata_benchmark_conclusion_quick',
        key: 'ai_helper_testdata_benchmark_assessment_quick_pass',
      }
      : payload.report.summary.total < BENCHMARK_CASES.length && payload.report.summary.failed === 0
        ? {
          variant: 'info' as const,
          labelKey: 'ai_helper_testdata_benchmark_conclusion_quick',
          key: 'ai_helper_testdata_benchmark_assessment_subset_pass',
        }
        : payload.report.summary.failed === 0
          ? {
            variant: 'success' as const,
            labelKey: 'ai_helper_testdata_benchmark_conclusion_recommended',
            key: 'ai_helper_testdata_benchmark_assessment_full_pass',
          }
          : payload.report.summary.passRate >= 2 / 3
            ? {
              variant: 'warning' as const,
              labelKey: 'ai_helper_testdata_benchmark_conclusion_caution',
              key: 'ai_helper_testdata_benchmark_assessment_partial',
            }
            : {
              variant: 'error' as const,
              labelKey: 'ai_helper_testdata_benchmark_conclusion_not_recommended',
              key: 'ai_helper_testdata_benchmark_assessment_fail',
            }
    : null;
  const runLabelKey = selectionMode === 'quick'
    ? 'ai_helper_testdata_benchmark_run_quick'
    : selectionMode === 'full'
      ? 'ai_helper_testdata_benchmark_run_full'
      : 'ai_helper_testdata_benchmark_run_custom';
  const getModeCardStyle = (active: boolean): React.CSSProperties => ({
    display: 'block',
    width: '100%',
    padding: SPACING.base,
    textAlign: 'left',
    fontFamily: 'inherit',
    color: COLORS.textPrimary,
    background: active ? COLORS.primaryLight : COLORS.bgCard,
    border: `${active ? 2 : 1}px solid ${active ? COLORS.primary : COLORS.border}`,
    borderRadius: RADIUS.lg,
    cursor: running || disabled ? 'not-allowed' : 'pointer',
    opacity: running || disabled ? 0.6 : 1,
  });

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: SPACING.sm, marginBottom: SPACING.sm }}>
        <h2 style={{ margin: 0, color: COLORS.textPrimary, fontSize: '18px' }}>
          {i18n('ai_helper_testdata_benchmark_title')}
        </h2>
        <span style={getBadgeStyle('warning')}>
          {i18n('ai_helper_testdata_benchmark_fee_badge')}
        </span>
      </div>
      <p style={{ ...TYPOGRAPHY.sm, color: COLORS.textSecondary, margin: `0 0 ${SPACING.md}` }}>
        {i18n('ai_helper_testdata_benchmark_desc')}
      </p>

      <div style={{
        padding: SPACING.base,
        marginBottom: SPACING.md,
        border: `1px solid ${COLORS.border}`,
        borderRadius: RADIUS.md,
        background: COLORS.bgCard,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: SPACING.md, marginBottom: SPACING.md }}>
          <div style={{ ...TYPOGRAPHY.sm, color: COLORS.textPrimary, fontWeight: 600 }}>
            {i18n('ai_helper_testdata_benchmark_readiness_title')}
          </div>
          <button
            type="button"
            style={{ ...getButtonStyle('secondary'), padding: `5px ${SPACING.md}`, fontSize: '12px' }}
            disabled={preflight.checking || running}
            onClick={checkReadiness}
          >
            {preflight.checking
              ? i18n('ai_helper_testdata_benchmark_readiness_checking')
              : i18n('ai_helper_testdata_benchmark_readiness_recheck')}
          </button>
        </div>

        <div style={{
          padding: SPACING.md,
          marginBottom: SPACING.md,
          borderRadius: RADIUS.md,
          background: COLORS.bgPage,
        }}>
          <div style={{ ...TYPOGRAPHY.xs, color: COLORS.textMuted, marginBottom: SPACING.xs }}>
            {i18n('ai_helper_testdata_benchmark_model_chain_label')}
          </div>
          <div style={{ ...TYPOGRAPHY.sm, color: modelChainLabels.length ? COLORS.textPrimary : COLORS.errorText, fontWeight: 600 }}>
            {modelChainLabels.length > 0
              ? `${i18n('ai_helper_testdata_benchmark_readiness_primary')}: ${modelChainLabels[0]}`
              : i18n('ai_helper_testdata_benchmark_model_chain_empty')}
          </div>
          {modelChainLabels.length > 0 && (
            <div style={{ ...TYPOGRAPHY.xs, color: COLORS.textSecondary, marginTop: SPACING.xs }}>
              {i18n('ai_helper_testdata_benchmark_readiness_fallback')}:{' '}
              {modelChainLabels.length > 1
                ? modelChainLabels.slice(1).join('、')
                : i18n('ai_helper_testdata_benchmark_readiness_no_fallback')}
            </div>
          )}
          {usesGlobalModelChain && (
            <div style={{ ...TYPOGRAPHY.xs, color: COLORS.warningText, marginTop: SPACING.xs }}>
              {i18n('ai_helper_testdata_benchmark_model_chain_global')}
            </div>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: SPACING.sm }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: SPACING.md }}>
            <span style={{ ...TYPOGRAPHY.sm, color: COLORS.textSecondary }}>
              {i18n('ai_helper_testdata_benchmark_readiness_model')}
            </span>
            <span style={getBadgeStyle(preflight.checking ? 'info' : preflight.modelConfigured ? 'success' : 'error')}>
              {preflight.checking
                ? i18n('ai_helper_testdata_benchmark_readiness_checking')
                : preflight.modelConfigured
                  ? i18n('ai_helper_testdata_benchmark_readiness_ready')
                  : i18n('ai_helper_testdata_benchmark_readiness_missing')}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: SPACING.md }}>
            <span style={{ ...TYPOGRAPHY.sm, color: COLORS.textSecondary }}>
              {i18n('ai_helper_testdata_benchmark_readiness_saved')}
            </span>
            <span style={getBadgeStyle(hasUnsavedChanges ? 'warning' : 'success')}>
              {hasUnsavedChanges
                ? i18n('ai_helper_testdata_benchmark_readiness_unsaved')
                : i18n('ai_helper_testdata_benchmark_readiness_saved_status')}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: SPACING.md }}>
            <span style={{ ...TYPOGRAPHY.sm, color: COLORS.textSecondary }}>
              {i18n('ai_helper_testdata_benchmark_readiness_sandbox')}
            </span>
            <span style={getBadgeStyle(preflight.checking ? 'info' : preflight.sandboxAvailable ? 'success' : 'error')}>
              {preflight.checking
                ? i18n('ai_helper_testdata_benchmark_readiness_checking')
                : preflight.sandboxAvailable
                  ? i18n('ai_helper_testdata_benchmark_readiness_ready')
                  : i18n('ai_helper_testdata_benchmark_readiness_unavailable')}
            </span>
          </div>
        </div>

        {preflight.error && (
          <div style={{ ...getAlertStyle('error'), marginTop: SPACING.md }}>
            {i18n('ai_helper_testdata_benchmark_readiness_failed', preflight.error)}
          </div>
        )}

        {!canRun && !preflight.checking && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: SPACING.sm, marginTop: SPACING.md }}>
            <button type="button" style={getButtonStyle('secondary')} onClick={onOpenModelSettings}>
              {i18n('ai_helper_testdata_benchmark_open_settings')}
            </button>
            {hasUnsavedChanges && (
              <button type="button" style={getButtonStyle('primary')} disabled={saving} onClick={saveAndRecheck}>
                {saving
                  ? i18n('ai_helper_config_saving')
                  : i18n('ai_helper_testdata_benchmark_save_and_recheck')}
              </button>
            )}
          </div>
        )}
      </div>

      <div style={{ marginBottom: SPACING.md }}>
        <div style={{ ...TYPOGRAPHY.sm, color: COLORS.textPrimary, fontWeight: 600, marginBottom: SPACING.sm }}>
          {i18n('ai_helper_testdata_benchmark_mode_title')}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: SPACING.md }}>
          <button
            type="button"
            aria-pressed={selectionMode === 'quick'}
            style={getModeCardStyle(selectionMode === 'quick')}
            disabled={running || disabled}
            onClick={selectQuickMode}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: SPACING.sm }}>
              <strong style={{ fontSize: '15px' }}>{i18n('ai_helper_testdata_benchmark_mode_quick')}</strong>
              <span style={getBadgeStyle('info')}>{i18n('ai_helper_testdata_benchmark_mode_quick_tag')}</span>
            </div>
            <div style={{ ...TYPOGRAPHY.xs, color: COLORS.textSecondary, marginTop: SPACING.sm }}>
              {i18n('ai_helper_testdata_benchmark_mode_quick_hint')}
            </div>
          </button>
          <button
            type="button"
            aria-pressed={selectionMode === 'full'}
            style={getModeCardStyle(selectionMode === 'full')}
            disabled={running || disabled}
            onClick={selectFullMode}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: SPACING.sm }}>
              <strong style={{ fontSize: '15px' }}>{i18n('ai_helper_testdata_benchmark_mode_full')}</strong>
              <span style={getBadgeStyle('success')}>{i18n('ai_helper_testdata_benchmark_mode_full_tag')}</span>
            </div>
            <div style={{ ...TYPOGRAPHY.xs, color: COLORS.textSecondary, marginTop: SPACING.sm }}>
              {i18n('ai_helper_testdata_benchmark_mode_full_hint')}
            </div>
          </button>
        </div>
      </div>

      <div style={{ ...getAlertStyle('warning'), marginBottom: SPACING.md }}>
        {i18n('ai_helper_testdata_benchmark_cost_warning')}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: SPACING.sm, marginBottom: SPACING.md }}>
        <button
          type="button"
          style={{
            ...getButtonStyle('primary'),
            opacity: running || disabled || selected.length === 0 || !canRun ? 0.55 : 1,
            cursor: running || disabled || selected.length === 0 || !canRun ? 'not-allowed' : 'pointer',
          }}
          disabled={running || disabled || selected.length === 0 || !canRun}
          onClick={requestRun}
        >
          {running ? i18n('ai_helper_testdata_benchmark_running') : i18n(runLabelKey)}
        </button>
        {running && (
          <button type="button" style={getButtonStyle('secondary')} onClick={() => abortRef.current?.abort()}>
            {i18n('ai_helper_testdata_benchmark_cancel')}
          </button>
        )}
      </div>

      <details style={{ marginBottom: SPACING.md }}>
        <summary style={{ cursor: 'pointer', color: COLORS.textSecondary, fontSize: '13px', fontWeight: 500 }}>
          {i18n('ai_helper_testdata_benchmark_custom_title')}
        </summary>
        <div style={{ padding: `${SPACING.md} 0 0 ${SPACING.sm}` }}>
          <p style={{ ...TYPOGRAPHY.xs, color: COLORS.textMuted, margin: `0 0 ${SPACING.sm}` }}>
            {i18n('ai_helper_testdata_benchmark_custom_hint')}
          </p>
          <div style={{ display: 'grid', gap: SPACING.sm }}>
            {BENCHMARK_CASES.map(item => (
              <label key={item.id} style={{ display: 'flex', alignItems: 'center', gap: SPACING.sm, color: COLORS.textPrimary }}>
                <input
                  type="checkbox"
                  checked={selected.includes(item.id)}
                  disabled={running || disabled}
                  onChange={() => toggleCase(item.id)}
                />
                {i18n(item.titleKey)}
              </label>
            ))}
          </div>
        </div>
      </details>

      <details style={{
        marginBottom: SPACING.md,
        border: `1px solid ${COLORS.border}`,
        borderRadius: RADIUS.md,
        background: COLORS.bgPage,
      }}>
        <summary style={{
          padding: `${SPACING.md} ${SPACING.base}`,
          cursor: 'pointer',
          color: COLORS.primary,
          fontWeight: 600,
          fontSize: '14px',
        }}>
          {i18n('ai_helper_testdata_benchmark_explainer_title')}
        </summary>
        <div style={{ padding: `0 ${SPACING.base} ${SPACING.base}` }}>
          <p style={{ ...TYPOGRAPHY.sm, color: COLORS.textSecondary, margin: `0 0 ${SPACING.md}` }}>
            {i18n('ai_helper_testdata_benchmark_explainer_purpose')}
          </p>
          <div style={{ ...getAlertStyle('info'), marginBottom: SPACING.md }}>
            {i18n('ai_helper_testdata_benchmark_explainer_process')}
          </div>
          <div style={{ display: 'grid', gap: SPACING.sm }}>
            {BENCHMARK_CASES.map((item, index) => (
              <div key={`explain-${item.id}`} style={{
                padding: SPACING.md,
                border: `1px solid ${COLORS.border}`,
                borderRadius: RADIUS.md,
                background: COLORS.bgCard,
              }}>
                <div style={{ ...TYPOGRAPHY.sm, color: COLORS.textPrimary, fontWeight: 600 }}>
                  {index + 1}. {i18n(item.titleKey)}
                </div>
                <div style={{ ...TYPOGRAPHY.xs, color: COLORS.textSecondary, marginTop: SPACING.xs }}>
                  {i18n(item.purposeKey)}
                </div>
              </div>
            ))}
          </div>
          <div style={{ ...getAlertStyle('warning'), marginTop: SPACING.md }}>
            {i18n('ai_helper_testdata_benchmark_explainer_limit')}
          </div>
        </div>
      </details>
      {running && (
        <div style={{ marginBottom: SPACING.md }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: SPACING.xs, ...TYPOGRAPHY.sm }}>
            <span>
              {i18n(
                'ai_helper_testdata_benchmark_progress',
                progress.index,
                progress.total,
                getCaseLabel(progress.caseId, progress.title || ''),
              )}
            </span>
            <strong>{totalProgress}%</strong>
          </div>
          <div style={{ height: '9px', borderRadius: '999px', background: COLORS.bgHover, overflow: 'hidden' }}>
            <div style={{ width: `${totalProgress}%`, height: '100%', background: COLORS.primary, transition: 'width 400ms ease' }} />
          </div>
        </div>
      )}
      {caseResults.length > 0 && (
        <div style={{ display: 'grid', gap: SPACING.xs, marginBottom: SPACING.md }}>
          {caseResults.map(result => (
            <div key={result.id} style={{ ...TYPOGRAPHY.sm, color: result.passed ? COLORS.success : COLORS.error }}>
              {result.passed
                ? i18n('ai_helper_testdata_benchmark_result_pass')
                : i18n('ai_helper_testdata_benchmark_result_fail')}
              {' · '}{getCaseLabel(result.id, result.title)}
            </div>
          ))}
        </div>
      )}
      {error && (
        <div style={{ ...getAlertStyle('error'), marginBottom: SPACING.md }}>
          <div>{error}</div>
          {errorDetails && (
            <details style={{ marginTop: SPACING.sm }}>
              <summary style={{ cursor: 'pointer', fontSize: '12px' }}>
                {i18n('ai_helper_testdata_benchmark_error_details')}
              </summary>
              <div style={{ ...TYPOGRAPHY.xs, marginTop: SPACING.xs, overflowWrap: 'anywhere' }}>
                {errorDetails}
              </div>
            </details>
          )}
        </div>
      )}
      {payload && assessment && (
        <div style={{ ...getAlertStyle(assessment.variant), marginBottom: SPACING.md }}>
          <div style={{ fontWeight: 700, fontSize: '16px' }}>
            {i18n(assessment.labelKey)}
          </div>
          <div style={{ ...TYPOGRAPHY.sm, marginTop: SPACING.xs }}>
            {i18n(
              'ai_helper_testdata_benchmark_summary_simple',
              payload.report.summary.total,
              payload.report.summary.passed,
            )}
          </div>
          <div style={{ marginTop: SPACING.sm, paddingTop: SPACING.sm, borderTop: '1px solid currentColor', ...TYPOGRAPHY.sm }}>
            {i18n(assessment.key)}
          </div>
          {payload.report.summary.total < BENCHMARK_CASES.length && payload.report.summary.failed === 0 && (
            <button
              type="button"
              style={{ ...getButtonStyle('secondary'), marginTop: SPACING.md }}
              onClick={selectFullMode}
            >
              {i18n('ai_helper_testdata_benchmark_run_full_next')}
            </button>
          )}
        </div>
      )}
      {payload && !running && (
        <details style={{ marginTop: SPACING.md }}>
          <summary style={{ cursor: 'pointer', color: COLORS.textSecondary, fontSize: '13px', fontWeight: 500 }}>
            {i18n('ai_helper_testdata_benchmark_details_title')}
          </summary>
          <div style={{ paddingTop: SPACING.md }}>
            <p style={{ ...TYPOGRAPHY.xs, color: COLORS.textMuted, margin: `0 0 ${SPACING.md}` }}>
              {i18n(
                'ai_helper_testdata_benchmark_usage_simple',
                (payload.report.summary.durationMs / 1000).toFixed(1),
                payload.report.models.join(' → '),
              )}
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: SPACING.sm }}>
              <button
                type="button"
                style={getButtonStyle('secondary')}
                onClick={() => downloadJson(`testdata-benchmark-${payload.report.runId}.json`, payload.report)}
              >
                {i18n('ai_helper_testdata_benchmark_download_full')}
              </button>
              <button
                type="button"
                style={getButtonStyle('secondary')}
                onClick={() => downloadJson(`testdata-benchmark-aggregate-${payload.report.runId}.json`, payload.aggregate)}
              >
                {i18n('ai_helper_testdata_benchmark_download_aggregate')}
              </button>
            </div>
            <p style={{ ...TYPOGRAPHY.xs, color: COLORS.textMuted, margin: `${SPACING.sm} 0 0` }}>
              {i18n('ai_helper_testdata_benchmark_privacy')}
            </p>
          </div>
        </details>
      )}
      {confirmOpen && (
        <div
          style={{ ...modalOverlayStyle, padding: SPACING.base, boxSizing: 'border-box' }}
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) setConfirmOpen(false);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setConfirmOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="testdata-benchmark-confirm-title"
            aria-describedby="testdata-benchmark-confirm-description"
            style={{
              ...modalContentStyle,
              maxWidth: '520px',
              border: `1px solid ${COLORS.border}`,
              padding: SPACING.xl,
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: SPACING.base }}>
              <div
                aria-hidden="true"
                style={{
                  width: '40px',
                  height: '40px',
                  flex: '0 0 40px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: RADIUS.full,
                  color: COLORS.warningText,
                  background: COLORS.warningBg,
                  border: `1px solid ${COLORS.warningBorder}`,
                  fontSize: '21px',
                  fontWeight: 700,
                }}
              >
                !
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <h3
                  id="testdata-benchmark-confirm-title"
                  style={{ ...TYPOGRAPHY.lg, color: COLORS.textPrimary, margin: `0 0 ${SPACING.sm}` }}
                >
                  {i18n('ai_helper_testdata_benchmark_confirm_title')}
                </h3>
                <p
                  id="testdata-benchmark-confirm-description"
                  style={{ ...TYPOGRAPHY.sm, color: COLORS.textSecondary, margin: 0 }}
                >
                  {i18n('ai_helper_testdata_benchmark_confirm', selected.length)}
                </p>
              </div>
            </div>

            <div style={{ ...getAlertStyle('warning'), margin: `${SPACING.lg} 0` }}>
              {i18n('ai_helper_testdata_benchmark_cost_warning')}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: SPACING.md }}>
              <button
                type="button"
                style={getButtonStyle('secondary')}
                onClick={() => setConfirmOpen(false)}
              >
                {i18n('ai_helper_testdata_benchmark_confirm_cancel')}
              </button>
              <button
                ref={confirmButtonRef}
                type="button"
                style={getButtonStyle('primary')}
                onClick={run}
              >
                {i18n('ai_helper_testdata_benchmark_confirm_accept')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
