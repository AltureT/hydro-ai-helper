/**
 * 安全治理 → AI 抽查（设计稿“AI 抽查”，US7）
 *
 * 自动处罚与熔断状态、上次运行、本月成本；抽查设置；立即抽查 / 抽查指定学生；运行记录；最近发现（可直接复核）。
 * 仅系统管理员可用（接口返回 403 时显示说明）。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { i18n } from '../utils/i18n';
import { COLORS, RADIUS, SPACING, cardStyle, getAlertStyle, getButtonStyle, getInputStyle } from '../utils/styles';
import { ApiError, errorMessage, getJson, postJson } from './userManagementApi';
import { Modal, labelStyle, mutedTextStyle } from './userManagementUi';
import { domainApiUrl } from './userManagementLogic';
import {
  MAX_REVIEW_NAMES,
  REVIEW_API,
  findingActionKey,
  formatPercent,
  formatTokens,
  formatUSD,
  markFindingReviewed,
  parseNameList,
  parseSettingsForm,
  runStatusKey,
  runTone,
  sameSettings,
  settingsToForm,
  type ReviewFindingView,
  type ReviewRunView,
  type ReviewSettingsForm,
  type ReviewStatusResponse,
  type RunTone,
} from './reviewLogic';

type ShowToast = (message: string, type?: 'success' | 'error' | 'warning' | 'info') => void;

const TONES: Record<RunTone | 'warn', { background: string; color: string; border: string }> = {
  ok: { background: '#ecfdf5', color: '#065f46', border: '#a7f3d0' },
  error: { background: '#fef2f2', color: '#991b1b', border: '#fecaca' },
  muted: { background: '#f8fafc', color: '#475569', border: '#e2e8f0' },
  info: { background: '#eff6ff', color: '#1d4ed8', border: '#bfdbfe' },
  warn: { background: '#fffbeb', color: '#92400e', border: '#fde68a' },
};

const Badge: React.FC<{ tone: RunTone | 'warn'; children: React.ReactNode }> = ({ tone, children }) => (
  <span style={{
    display: 'inline-block', padding: '1px 8px', borderRadius: '9999px', fontSize: '12px', whiteSpace: 'nowrap',
    background: TONES[tone].background, color: TONES[tone].color, border: `1px solid ${TONES[tone].border}`,
  }}>
    {children}
  </span>
);

function shortTime(iso?: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 安全治理页没有统一的禁用按钮样式：在这里显式变淡 */
function buttonStyle(variant: Parameters<typeof getButtonStyle>[0], disabled = false): React.CSSProperties {
  return { ...getButtonStyle(variant), ...(disabled ? { opacity: 0.55, cursor: 'not-allowed' } : {}) };
}

const statStyle: React.CSSProperties = { ...cardStyle, padding: SPACING.lg, display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 };
const bigNumberStyle: React.CSSProperties = { fontSize: '26px', fontWeight: 800, color: COLORS.textPrimary, lineHeight: 1.2 };

const ManualRunModal: React.FC<{ onClose: () => void; onStarted: (message: string) => void }> = ({ onClose, onStarted }) => {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const names = parseNameList(text);
  const tooMany = names.length > MAX_REVIEW_NAMES;

  const submit = async () => {
    if (!names.length || tooMany) return;
    setSaving(true);
    setError(null);
    try {
      await postJson(REVIEW_API.run, { unames: names }, i18n('ai_helper_review_run_failed'));
      onStarted(i18n('ai_helper_review_run_started_users', names.length));
    } catch (err) {
      setError(errorMessage(err, i18n('ai_helper_review_run_failed')));
      setSaving(false);
    }
  };

  return (
    <Modal
      title={i18n('ai_helper_review_manual_title')}
      onClose={onClose}
      footer={(
        <>
          <button type="button" style={getButtonStyle('ghost')} onClick={onClose}>{i18n('ai_helper_um_cancel')}</button>
          <button type="button" style={buttonStyle('primary', saving || !names.length || tooMany)} disabled={saving || !names.length || tooMany} onClick={submit}>
            {saving ? i18n('ai_helper_review_running_now') : i18n('ai_helper_review_manual_submit', names.length)}
          </button>
        </>
      )}
    >
      <div style={{ display: 'grid', gap: SPACING.sm }}>
        <label htmlFor="ai-review-manual-names" style={labelStyle}>{i18n('ai_helper_review_manual_label')}</label>
        <textarea
          id="ai-review-manual-names"
          rows={5}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={i18n('ai_helper_review_manual_placeholder')}
          style={{ ...getInputStyle(), boxSizing: 'border-box', resize: 'vertical', borderColor: tooMany ? COLORS.error : COLORS.border }}
        />
        <div style={{ ...mutedTextStyle, color: tooMany ? COLORS.errorText : COLORS.textMuted }}>
          {tooMany ? i18n('ai_helper_review_manual_too_many', MAX_REVIEW_NAMES) : i18n('ai_helper_review_manual_hint')}
        </div>
        {error && <div style={getAlertStyle('error')}>{error}</div>}
      </div>
    </Modal>
  );
};

const FindingCard: React.FC<{
  finding: ReviewFindingView;
  onReviewed: (finding: ReviewFindingView, status: 'confirmed' | 'false_positive') => Promise<void>;
}> = ({ finding, onReviewed }) => {
  const [busy, setBusy] = useState(false);
  const pending = finding.reviewStatus === 'pending';
  const first = finding.evidence[0];
  const quote = first
    ? (first.verified
      ? i18n('ai_helper_review_finding_quote_student', first.ref, first.snippet)
      : i18n('ai_helper_review_finding_quote_model', first.snippet))
    : null;
  const where = [finding.domainName, finding.problemTitle || finding.problemId].filter(Boolean).join(' · ');
  const review = async (status: 'confirmed' | 'false_positive') => {
    setBusy(true);
    try {
      await onReviewed(finding, status);
    } finally {
      setBusy(false);
    }
  };
  return (
    <article style={{ ...cardStyle, padding: `${SPACING.base} ${SPACING.lg}`, display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' }}>
        <span style={{ fontWeight: 700, color: COLORS.textPrimary }}>{finding.uname || (finding.userId !== undefined ? `uid ${finding.userId}` : '—')}</span>
        {where && <span style={{ ...mutedTextStyle, fontSize: '13px' }}>{where}</span>}
        {finding.category && <Badge tone="info">{i18n(`ai_helper_admin_jailbreak_category_${finding.category}`)}</Badge>}
        {finding.confidence && <Badge tone="muted">{i18n(`ai_helper_review_confidence_${finding.confidence}`)}</Badge>}
        <Badge tone={finding.evidenceVerified ? 'ok' : 'error'}>
          {i18n(finding.evidenceVerified ? 'ai_helper_review_evidence_verified' : 'ai_helper_review_evidence_unverified')}
        </Badge>
        <Badge tone={finding.autoPenalized && finding.reviewStatus !== 'false_positive' ? 'warn' : 'muted'}>{i18n(findingActionKey(finding))}</Badge>
        {!pending && (
          <Badge tone={finding.reviewStatus === 'false_positive' ? 'error' : 'ok'}>
            {i18n(`ai_helper_admin_jailbreak_review_${finding.reviewStatus}`)}
          </Badge>
        )}
        {finding.studentAppealedAt && <Badge tone="warn">{i18n('ai_helper_review_finding_appealed')}</Badge>}
      </div>
      {quote && (
        <p style={{
          margin: 0, padding: '10px 12px', borderRadius: RADIUS.md, background: COLORS.bgPage, fontSize: '14px', lineHeight: 1.6,
          color: COLORS.textPrimary, borderLeft: `3px solid ${first?.verified ? COLORS.border : COLORS.error}`, wordBreak: 'break-word',
        }}>
          {quote}
        </p>
      )}
      {finding.reason && <div style={{ fontSize: '14px', color: COLORS.textSecondary }}>{finding.reason}</div>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: SPACING.sm, alignItems: 'center' }}>
        <span style={{ ...mutedTextStyle, marginRight: 'auto' }}>{shortTime(finding.createdAt)}</span>
        {finding.domainId && finding.conversationId && (
          <a
            href={`/d/${encodeURIComponent(finding.domainId)}/ai-helper/conversations/${encodeURIComponent(finding.conversationId)}`}
            target="_blank"
            rel="noreferrer"
            style={{ ...getButtonStyle('ghost'), textDecoration: 'none' }}
          >
            {i18n('ai_helper_review_view_conversation')}
          </a>
        )}
        {pending && finding.domainId && (
          <>
            <button type="button" style={buttonStyle('secondary', busy)} disabled={busy} onClick={() => review('confirmed')}>
              {i18n('ai_helper_review_confirm')}
            </button>
            <button type="button" style={buttonStyle('secondary', busy)} disabled={busy} onClick={() => review('false_positive')}>
              {i18n('ai_helper_review_false_positive')}
            </button>
          </>
        )}
      </div>
    </article>
  );
};

function triggerText(run: ReviewRunView): string {
  if (run.trigger === 'schedule') return i18n('ai_helper_review_trigger_schedule');
  const who = run.scopeLabel || i18n('ai_helper_review_trigger_all');
  return i18n('ai_helper_review_trigger_manual', who);
}

export const ReviewPanel: React.FC<{ showToast: ShowToast }> = ({ showToast }) => {
  const [data, setData] = useState<ReviewStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [form, setForm] = useState<ReviewSettingsForm | null>(null);
  const [autoPenalty, setAutoPenalty] = useState(true);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await getJson<ReviewStatusResponse>(REVIEW_API.status, i18n('ai_helper_review_load_failed'));
      setData(res);
      setLoadError(null);
      return res;
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setForbidden(true);
      else if (!silent) setLoadError(errorMessage(err, i18n('ai_helper_review_load_failed')));
      return null;
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // 有批次在运行时每 5 秒刷新一次
  useEffect(() => {
    if (pollRef.current) clearTimeout(pollRef.current);
    if (data?.runs.some((run) => run.status === 'running')) {
      pollRef.current = setTimeout(() => { load(true); }, 5000);
    }
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, [data, load]);

  // 首次加载与保存后同步表单
  const savedConfig = data?.config;
  const savedAutoPenalty = data?.state.autoPenaltyEnabled;
  useEffect(() => {
    if (savedConfig) setForm(settingsToForm(savedConfig));
  }, [savedConfig]);
  useEffect(() => {
    if (savedAutoPenalty !== undefined) setAutoPenalty(savedAutoPenalty);
  }, [savedAutoPenalty]);

  const parsed = useMemo(() => (form ? parseSettingsForm(form) : null), [form]);
  const settingsDirty = !!(parsed && savedConfig && !sameSettings(parsed.patch, savedConfig));
  const autoPenaltyDirty = savedAutoPenalty !== undefined && autoPenalty !== savedAutoPenalty;
  const invalid = new Set(parsed?.errors || []);

  if (forbidden) {
    return <div style={{ ...cardStyle, ...mutedTextStyle }}>{i18n('ai_helper_review_forbidden')}</div>;
  }

  const save = async () => {
    if (!parsed || parsed.errors.length) return;
    setSaving(true);
    try {
      if (settingsDirty) {
        const res = await fetch('/ai-helper/admin/config', {
          method: 'PUT',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify({ aiReviewConfig: parsed.patch }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error || i18n('ai_helper_review_save_failed'));
      }
      if (autoPenaltyDirty) {
        await postJson(REVIEW_API.autoPenalty, { enabled: autoPenalty }, i18n('ai_helper_review_auto_penalty_failed'));
      }
      showToast(i18n('ai_helper_review_saved'), 'success');
      await load(true);
    } catch (err) {
      showToast(errorMessage(err, i18n('ai_helper_review_save_failed')), 'error');
    } finally {
      setSaving(false);
    }
  };

  const resume = async () => {
    try {
      await postJson(REVIEW_API.autoPenalty, { enabled: true }, i18n('ai_helper_review_auto_penalty_failed'));
      showToast(i18n('ai_helper_review_resumed'), 'success');
      await load(true);
    } catch (err) {
      showToast(errorMessage(err, i18n('ai_helper_review_auto_penalty_failed')), 'error');
    }
  };

  const runNow = async () => {
    setStarting(true);
    try {
      await postJson(REVIEW_API.run, {}, i18n('ai_helper_review_run_failed'));
      showToast(i18n('ai_helper_review_run_started'), 'success');
      await load(true);
    } catch (err) {
      showToast(errorMessage(err, i18n('ai_helper_review_run_failed')), 'error');
    } finally {
      setStarting(false);
    }
  };

  const reviewFinding = async (finding: ReviewFindingView, status: 'confirmed' | 'false_positive') => {
    if (!finding.domainId) return;
    try {
      await postJson(
        domainApiUrl(finding.domainId, `/ai-helper/admin/jailbreak-logs/${encodeURIComponent(finding.id)}/review`),
        { reviewStatus: status },
        i18n('ai_helper_admin_jailbreak_review_failed'),
      );
      setData((prev) => (prev ? { ...prev, findings: markFindingReviewed(prev.findings, finding.id, status) } : prev));
      showToast(i18n(status === 'false_positive' ? 'ai_helper_review_marked_false_positive' : 'ai_helper_review_marked_confirmed'), 'success');
      await load(true);
    } catch (err) {
      showToast(errorMessage(err, i18n('ai_helper_admin_jailbreak_review_failed')), 'error');
    }
  };

  if (!data) {
    return (
      <div style={cardStyle}>
        {loadError ? (
          <div style={{ ...getAlertStyle('error'), display: 'flex', gap: SPACING.sm, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ flex: 1 }}>{loadError}</span>
            <button type="button" style={getButtonStyle('secondary')} onClick={() => load()}>{i18n('ai_helper_um_retry')}</button>
          </div>
        ) : (
          <span style={mutedTextStyle}>{loading ? i18n('ai_helper_um_loading') : ''}</span>
        )}
      </div>
    );
  }

  const { state, breaker, runs, findings, monthCost } = data;
  const lastRun = runs[0];
  const anyRunning = runs.some((run) => run.status === 'running');

  let penaltyBadge: React.ReactNode;
  let penaltyHelp: string;
  if (state.autoPenaltyEnabled) {
    penaltyBadge = <Badge tone="ok">{i18n('ai_helper_review_auto_enabled')}</Badge>;
    penaltyHelp = i18n('ai_helper_review_breaker_help', breaker.sample, breaker.falsePositives, formatPercent(breaker.threshold), breaker.minSample);
    if (state.resumedAt) penaltyHelp += i18n('ai_helper_review_breaker_resumed', shortTime(state.resumedAt), state.resumedByName || '');
  } else if (state.trippedAt) {
    penaltyBadge = <Badge tone="error">{i18n('ai_helper_review_auto_tripped')}</Badge>;
    penaltyHelp = i18n(
      'ai_helper_review_breaker_tripped',
      shortTime(state.trippedAt),
      state.trippedStats ? formatPercent(state.trippedStats.rate) : '',
      state.trippedStats?.sample ?? 0,
    );
  } else {
    penaltyBadge = <Badge tone="muted">{i18n('ai_helper_review_auto_disabled')}</Badge>;
    penaltyHelp = i18n('ai_helper_review_breaker_disabled', shortTime(state.disabledAt), state.disabledByName || '');
  }

  const runHelp = lastRun
    ? i18n(
      'ai_helper_review_last_run_help',
      lastRun.candidateCount ?? '—',
      lastRun.flaggedCount,
      lastRun.penalizedCount,
      lastRun.failedCount,
    )
    : i18n('ai_helper_review_never_run');
  const nextText = data.nextRunAt
    ? i18n('ai_helper_review_next_run', shortTime(data.nextRunAt))
    : i18n('ai_helper_review_schedule_off');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SPACING.base }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: SPACING.base }}>
        <section style={statStyle} aria-label={i18n('ai_helper_review_auto_penalty')}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={labelStyle}>{i18n('ai_helper_review_auto_penalty')}</span>
            {penaltyBadge}
          </div>
          <div style={bigNumberStyle}>{formatPercent(breaker.rate)}</div>
          <div style={mutedTextStyle}>{penaltyHelp}</div>
          {!state.autoPenaltyEnabled && (
            <div>
              <button type="button" style={getButtonStyle('secondary')} onClick={resume}>{i18n('ai_helper_review_resume')}</button>
            </div>
          )}
        </section>
        <section style={statStyle} aria-label={i18n('ai_helper_review_last_run')}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={labelStyle}>{i18n('ai_helper_review_last_run')}</span>
            {lastRun && <Badge tone={runTone(lastRun)}>{i18n(runStatusKey(lastRun))}</Badge>}
          </div>
          <div style={bigNumberStyle}>{lastRun ? shortTime(lastRun.startedAt) : '—'}</div>
          <div style={mutedTextStyle}>{runHelp} · {nextText}</div>
        </section>
        <section style={statStyle} aria-label={i18n('ai_helper_review_month_cost')}>
          <span style={labelStyle}>{i18n('ai_helper_review_month_cost')}</span>
          <div style={bigNumberStyle}>{formatUSD(monthCost.totalCost)}</div>
          <div style={mutedTextStyle}>{i18n('ai_helper_review_month_cost_help', formatTokens(monthCost.totalTokens))}</div>
        </section>
      </div>

      {form && (
        <section style={{ ...cardStyle, padding: SPACING.lg, display: 'flex', flexDirection: 'column', gap: SPACING.base }} aria-labelledby="ai-review-settings-title">
          <div style={{ display: 'flex', alignItems: 'center', gap: SPACING.base, flexWrap: 'wrap' }}>
            <h3 id="ai-review-settings-title" style={{ margin: 0, fontSize: '16px', fontWeight: 650, color: COLORS.textPrimary }}>
              {i18n('ai_helper_review_settings_title')}
            </h3>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '14px', color: COLORS.textPrimary }}>
              <input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />
              {i18n('ai_helper_review_enable_daily')}
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '14px', color: COLORS.textPrimary }}>
              <input type="checkbox" checked={autoPenalty} onChange={(event) => setAutoPenalty(event.target.checked)} />
              {i18n('ai_helper_review_enable_auto_penalty')}
            </label>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: SPACING.base }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label htmlFor="ai-review-run-at" style={labelStyle}>{i18n('ai_helper_review_run_at')}</label>
              <input
                id="ai-review-run-at"
                type="time"
                value={form.runAt}
                onChange={(event) => setForm({ ...form, runAt: event.target.value })}
                aria-invalid={invalid.has('runAt')}
                style={{ ...getInputStyle(), boxSizing: 'border-box', borderColor: invalid.has('runAt') ? COLORS.error : COLORS.border }}
              />
              <span style={mutedTextStyle}>{i18n('ai_helper_review_run_at_hint', data.timezone)}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label htmlFor="ai-review-sample" style={labelStyle}>{i18n('ai_helper_review_sample_rate')}</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <input
                  id="ai-review-sample"
                  inputMode="decimal"
                  value={form.samplePercent}
                  onChange={(event) => setForm({ ...form, samplePercent: event.target.value })}
                  aria-invalid={invalid.has('samplePercent')}
                  style={{ ...getInputStyle(), width: '96px', borderColor: invalid.has('samplePercent') ? COLORS.error : COLORS.border }}
                />
                <span style={mutedTextStyle}>%</span>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label htmlFor="ai-review-max" style={labelStyle}>{i18n('ai_helper_review_max_conversations')}</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <input
                  id="ai-review-max"
                  inputMode="numeric"
                  value={form.maxConversations}
                  onChange={(event) => setForm({ ...form, maxConversations: event.target.value })}
                  aria-invalid={invalid.has('maxConversations')}
                  style={{ ...getInputStyle(), width: '96px', borderColor: invalid.has('maxConversations') ? COLORS.error : COLORS.border }}
                />
                <span style={mutedTextStyle}>{i18n('ai_helper_review_conversations_unit')}</span>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <span style={labelStyle}>{i18n('ai_helper_review_model')}</span>
              <div style={{ ...getInputStyle(), background: COLORS.bgPage, color: COLORS.textSecondary, display: 'flex', alignItems: 'center', minHeight: '38px', boxSizing: 'border-box' }}>
                {i18n(data.modelConfigured ? 'ai_helper_review_model_configured' : 'ai_helper_review_model_global')}
              </div>
            </div>
          </div>
          {parsed && parsed.errors.length > 0 && (
            <div style={{ ...mutedTextStyle, color: COLORS.errorText }}>
              {parsed.errors.map((error) => i18n(`ai_helper_review_err_${error}`)).join('；')}
            </div>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
            <span style={{ ...labelStyle, marginRight: '4px' }}>{i18n('ai_helper_review_sources')}</span>
            {['medium', 'off_topic', 'high_usage', 'sample'].map((key) => (
              <Badge key={key} tone="muted">{i18n(`ai_helper_review_source_${key}`)}</Badge>
            ))}
            <span style={mutedTextStyle}>{i18n('ai_helper_review_anonymized')}</span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: SPACING.sm }}>
            <button
              type="button"
              style={buttonStyle('primary', saving || !parsed || parsed.errors.length > 0 || (!settingsDirty && !autoPenaltyDirty))}
              disabled={saving || !parsed || parsed.errors.length > 0 || (!settingsDirty && !autoPenaltyDirty)}
              onClick={save}
            >
              {saving ? i18n('ai_helper_um_saving') : i18n('ai_helper_review_save')}
            </button>
            <button type="button" style={buttonStyle('secondary', starting || anyRunning)} disabled={starting || anyRunning} onClick={runNow}>
              {starting ? i18n('ai_helper_review_running_now') : i18n('ai_helper_review_run_now')}
            </button>
            <button type="button" style={buttonStyle('secondary', anyRunning)} disabled={anyRunning} onClick={() => setManualOpen(true)}>
              {i18n('ai_helper_review_run_users')}
            </button>
            {anyRunning && <span style={{ ...mutedTextStyle, alignSelf: 'center' }}>{i18n('ai_helper_review_running_hint')}</span>}
          </div>
        </section>
      )}

      <section style={{ ...cardStyle, padding: 0, overflow: 'hidden' }} aria-labelledby="ai-review-runs-title">
        <div style={{ padding: `${SPACING.base} ${SPACING.lg} ${SPACING.sm}` }}>
          <h3 id="ai-review-runs-title" style={{ margin: 0, fontSize: '16px', fontWeight: 650, color: COLORS.textPrimary }}>{i18n('ai_helper_review_runs_title')}</h3>
        </div>
        {runs.length === 0 ? (
          <div style={{ ...mutedTextStyle, padding: `0 ${SPACING.lg} ${SPACING.lg}` }}>{i18n('ai_helper_review_runs_empty')}</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', minWidth: '720px' }}>
              <thead>
                <tr style={{ background: COLORS.bgPage, color: COLORS.textSecondary, textAlign: 'left' }}>
                  {['started', 'trigger', 'candidates', 'reviewed', 'flagged', 'penalized', 'failed', 'tokens', 'status'].map((key) => (
                    <th key={key} style={{ padding: '10px 12px', fontWeight: 600, whiteSpace: 'nowrap' }}>{i18n(`ai_helper_review_col_${key}`)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} style={{ borderTop: `1px solid ${COLORS.border}` }}>
                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>{shortTime(run.startedAt)}</td>
                    <td style={{ padding: '10px 12px' }}>{triggerText(run)}</td>
                    <td style={{ padding: '10px 12px' }}>{run.candidateCount ?? '—'}</td>
                    <td style={{ padding: '10px 12px' }}>{run.processedCount}</td>
                    <td style={{ padding: '10px 12px' }}>{run.flaggedCount}</td>
                    <td style={{ padding: '10px 12px' }}>{run.penalizedCount}</td>
                    <td style={{ padding: '10px 12px' }}>{run.failedCount}</td>
                    <td style={{ padding: '10px 12px', color: COLORS.textMuted }}>{formatTokens(run.tokens.total)}</td>
                    <td style={{ padding: '10px 12px' }}><Badge tone={runTone(run)}>{i18n(runStatusKey(run))}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: SPACING.md }} aria-labelledby="ai-review-findings-title">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: SPACING.sm, flexWrap: 'wrap' }}>
          <h3 id="ai-review-findings-title" style={{ margin: 0, fontSize: '16px', fontWeight: 650, color: COLORS.textPrimary }}>{i18n('ai_helper_review_findings_title')}</h3>
          <span style={mutedTextStyle}>{i18n('ai_helper_review_findings_hint')}</span>
        </div>
        {findings.length === 0
          ? <div style={{ ...cardStyle, ...mutedTextStyle }}>{i18n('ai_helper_review_findings_empty')}</div>
          : findings.map((finding) => <FindingCard key={finding.id} finding={finding} onReviewed={reviewFinding} />)}
      </section>

      {manualOpen && (
        <ManualRunModal
          onClose={() => setManualOpen(false)}
          onStarted={(message) => { setManualOpen(false); showToast(message, 'success'); load(true); }}
        />
      )}
    </div>
  );
};

export default ReviewPanel;
