import React, { useRef, useState } from 'react';
import { i18n } from '../utils/i18n';
import { COLORS, SPACING, TYPOGRAPHY, getAlertStyle, getButtonStyle } from '../utils/styles';

interface BenchmarkCaseOption {
  id: string;
  titleKey: string;
}

const BENCHMARK_CASES: BenchmarkCaseOption[] = [
  { id: 'xor-subarrays-less-than-k', titleKey: 'ai_helper_testdata_benchmark_case_xor' },
  { id: 'dynamic-connectivity-offline', titleKey: 'ai_helper_testdata_benchmark_case_connectivity' },
  { id: 'range-flip-longest-ones', titleKey: 'ai_helper_testdata_benchmark_case_segment' },
];

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

export const TestdataBenchmarkPanel: React.FC<TestdataBenchmarkPanelProps> = ({ disabled = false }) => {
  const [selected, setSelected] = useState(BENCHMARK_CASES.map(item => item.id));
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ProgressState>({ index: 0, total: 0, casePercent: 0 });
  const [caseResults, setCaseResults] = useState<Array<Pick<BenchmarkCaseResult, 'id' | 'title' | 'passed' | 'durationMs' | 'failureStage'>>>([]);
  const [payload, setPayload] = useState<BenchmarkPayload | null>(null);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const toggleCase = (id: string) => {
    setSelected(current => current.includes(id)
      ? current.filter(item => item !== id)
      : [...current, id]);
  };

  const run = async () => {
    if (selected.length === 0) {
      setError(i18n('ai_helper_testdata_benchmark_select_case'));
      return;
    }
    if (!window.confirm(i18n('ai_helper_testdata_benchmark_confirm', selected.length))) return;
    setRunning(true);
    setError('');
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
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  };

  const totalProgress = progress.total > 0
    ? Math.round((((Math.max(1, progress.index) - 1) + progress.casePercent / 100) / progress.total) * 100)
    : 0;

  return (
    <div>
      <h2 style={{ margin: `0 0 ${SPACING.sm}`, color: COLORS.textPrimary, fontSize: '18px' }}>
        {i18n('ai_helper_testdata_benchmark_title')}
      </h2>
      <p style={{ ...TYPOGRAPHY.sm, color: COLORS.textSecondary, margin: `0 0 ${SPACING.md}` }}>
        {i18n('ai_helper_testdata_benchmark_desc')}
      </p>
      <div style={{ ...getAlertStyle('warning'), marginBottom: SPACING.md }}>
        {i18n('ai_helper_testdata_benchmark_cost_warning')}
      </div>
      <div style={{ display: 'grid', gap: SPACING.sm, marginBottom: SPACING.md }}>
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
      {running && (
        <div style={{ marginBottom: SPACING.md }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: SPACING.xs, ...TYPOGRAPHY.sm }}>
            <span>
              {i18n('ai_helper_testdata_benchmark_progress', progress.index, progress.total, progress.title || progress.caseId || '')}
              {progress.stage ? ` · ${i18n(`ai_helper_testdata_progress_${progress.stage}`)}` : ''}
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
              {result.passed ? 'PASS' : 'FAIL'} · {result.title} · {(result.durationMs / 1000).toFixed(1)}s
              {result.failureStage ? ` · ${result.failureStage}` : ''}
            </div>
          ))}
        </div>
      )}
      {error && <div style={{ ...getAlertStyle('error'), marginBottom: SPACING.md }}>{error}</div>}
      {payload && (
        <div style={{ ...getAlertStyle(payload.report.summary.failed === 0 ? 'success' : 'warning'), marginBottom: SPACING.md }}>
          <div style={{ fontWeight: 700 }}>
            {i18n(
              'ai_helper_testdata_benchmark_summary',
              payload.report.summary.passed,
              payload.report.summary.total,
              (payload.report.summary.passRate * 100).toFixed(1),
            )}
          </div>
          <div style={{ ...TYPOGRAPHY.xs, marginTop: SPACING.xs }}>
            {i18n(
              'ai_helper_testdata_benchmark_usage',
              (payload.report.summary.durationMs / 1000).toFixed(1),
              payload.report.summary.totalTokens,
              payload.report.models.join(' → '),
            )}
          </div>
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: SPACING.sm }}>
        <button style={getButtonStyle('primary')} disabled={running || disabled || selected.length === 0} onClick={run}>
          {running ? i18n('ai_helper_testdata_benchmark_running') : i18n('ai_helper_testdata_benchmark_run')}
        </button>
        {running && (
          <button style={getButtonStyle('secondary')} onClick={() => abortRef.current?.abort()}>
            {i18n('ai_helper_testdata_benchmark_cancel')}
          </button>
        )}
        {payload && !running && (
          <>
            <button
              style={getButtonStyle('secondary')}
              onClick={() => downloadJson(`testdata-benchmark-${payload.report.runId}.json`, payload.report)}
            >
              {i18n('ai_helper_testdata_benchmark_download_full')}
            </button>
            <button
              style={getButtonStyle('secondary')}
              onClick={() => downloadJson(`testdata-benchmark-aggregate-${payload.report.runId}.json`, payload.aggregate)}
            >
              {i18n('ai_helper_testdata_benchmark_download_aggregate')}
            </button>
          </>
        )}
      </div>
      <p style={{ ...TYPOGRAPHY.xs, color: COLORS.textMuted, margin: `${SPACING.sm} 0 0` }}>
        {i18n('ai_helper_testdata_benchmark_privacy')}
      </p>
    </div>
  );
};
