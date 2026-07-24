import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { i18n } from '../utils/i18n';
import { buildApiUrl } from '../utils/domainUtils';
import { Toast, useToast } from '../components/Toast';
import { JailbreakAnalyticsPanel } from './JailbreakAnalyticsPanel';
import { JailbreakLogsViewer } from './JailbreakLogsViewer';
import {
  COLORS,
  FONT_FAMILY,
  RADIUS,
  SPACING,
  TYPOGRAPHY,
  cardStyle,
  getButtonStyle,
  getInputStyle,
  getPillStyle,
} from '../utils/styles';
import type {
  APIConfigResponse,
  JailbreakLogFilterOption,
  JailbreakLogFilters,
  JailbreakLogPagination,
} from './configTypes';

type SafetySection = 'records' | 'analytics' | 'rules';

const EMPTY_LOG_PAGINATION: JailbreakLogPagination = {
  logs: [],
  total: 0,
  page: 1,
  totalPages: 0,
  summary: {
    total: 0,
    pending: 0,
    confirmed: 0,
    falsePositive: 0,
    reviewed: 0,
    falsePositiveRate: 0,
    appealedPending: 0,
  },
  ruleMetrics: [],
};

function appendLogFilters(params: URLSearchParams, filters: JailbreakLogFilters) {
  if (filters.reviewStatus) params.set('reviewStatus', filters.reviewStatus);
  if (filters.category) params.set('category', filters.category);
  if (filters.appealedOnly) params.set('appealed', '1');
  if (filters.userId) params.set('userId', filters.userId);
  if (filters.problemId) params.set('problemId', filters.problemId);
  if (filters.actionTaken) params.set('actionTaken', filters.actionTaken);
  if (filters.detectionSource) params.set('detectionSource', filters.detectionSource);
  if (filters.dateFrom) params.set('dateFrom', filters.dateFrom);
  if (filters.dateTo) params.set('dateTo', filters.dateTo);
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

interface SafetyGovernancePanelProps {
  embedded?: boolean;
}

export const SafetyGovernancePanel: React.FC<SafetyGovernancePanelProps> = ({ embedded = false }) => {
  const [activeSection, setActiveSection] = useState<SafetySection>('records');
  const [builtinPatterns, setBuiltinPatterns] = useState<string[]>([]);
  const [customPatternsText, setCustomPatternsText] = useState('');
  const [savedCustomPatternsText, setSavedCustomPatternsText] = useState('');
  const [ruleSearch, setRuleSearch] = useState('');
  const [rulesLoading, setRulesLoading] = useState(false);
  const [rulesReady, setRulesReady] = useState(false);
  const [rulesSaving, setRulesSaving] = useState(false);
  const [logPagination, setLogPagination] = useState<JailbreakLogPagination>(EMPTY_LOG_PAGINATION);
  const [logFilters, setLogFilters] = useState<JailbreakLogFilters>({});
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [analyticsPagination, setAnalyticsPagination] = useState<JailbreakLogPagination>(EMPTY_LOG_PAGINATION);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const logsRequestId = useRef(0);
  const analyticsRequestId = useRef(0);
  const latestLogPage = useRef(1);
  const latestLogFilters = useRef<JailbreakLogFilters>({});
  const { toasts, showToast, dismissToast } = useToast();

  const loadRules = useCallback(async () => {
    setRulesLoading(true);
    try {
      const res = await fetch('/ai-helper/admin/config', {
        method: 'GET',
        credentials: 'include',
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || i18n('ai_helper_safety_rules_load_failed'));
      }
      const json: APIConfigResponse = await res.json();
      const nextCustomPatterns = json.config?.extraJailbreakPatternsText || '';
      setBuiltinPatterns(json.builtinJailbreakPatterns || []);
      setCustomPatternsText(nextCustomPatterns);
      setSavedCustomPatternsText(nextCustomPatterns);
      setRulesReady(true);
    } catch (err: unknown) {
      console.error('Load safety rules error:', err);
      showToast(getErrorMessage(err, i18n('ai_helper_safety_rules_load_failed')), 'error');
    } finally {
      setRulesLoading(false);
    }
  }, []);

  const loadJailbreakLogs = useCallback(async (
    page: number = 1,
    filters: JailbreakLogFilters = {}
  ) => {
    const requestId = ++logsRequestId.current;
    setLogsLoading(true);
    setLogsError(null);
    try {
      const params = new URLSearchParams({ page: String(page), limit: '20' });
      appendLogFilters(params, filters);
      const res = await fetch(`${buildApiUrl('/ai-helper/admin/jailbreak-logs')}?${params.toString()}`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`${i18n('ai_helper_admin_jailbreak_load_failed')}: ${res.status}`);
      const json: JailbreakLogPagination = await res.json();
      if (requestId === logsRequestId.current) setLogPagination(json);
    } catch (err: unknown) {
      if (requestId !== logsRequestId.current) return;
      console.error('Load jailbreak logs error:', err);
      const message = getErrorMessage(err, i18n('ai_helper_admin_jailbreak_load_failed'));
      setLogsError(message);
      showToast(message, 'error');
    } finally {
      if (requestId === logsRequestId.current) setLogsLoading(false);
    }
  }, []);

  const loadLogFilterOptions = useCallback(async (
    kind: 'user' | 'problem',
    query: string
  ): Promise<JailbreakLogFilterOption[]> => {
    const params = new URLSearchParams({ kind, q: query, limit: '10' });
    try {
      const res = await fetch(
        `${buildApiUrl('/ai-helper/admin/jailbreak-logs/filter-options')}?${params.toString()}`,
        { method: 'GET', credentials: 'include' }
      );
      if (!res.ok) {
        let message = i18n('ai_helper_admin_jailbreak_filter_suggestions_failed');
        try {
          const errorBody = await res.json();
          if (typeof errorBody?.error === 'string') message = errorBody.error;
        } catch { /* keep the localized fallback */ }
        throw new Error(message);
      }
      const json = await res.json();
      return Array.isArray(json.options) ? json.options : [];
    } catch (err) {
      console.error('Load safety filter options error:', err);
      throw err;
    }
  }, []);

  const loadJailbreakAnalytics = useCallback(async () => {
    const requestId = ++analyticsRequestId.current;
    setAnalyticsLoading(true);
    setAnalyticsError(null);
    try {
      const params = new URLSearchParams({ page: '1', limit: '1' });
      const res = await fetch(
        `${buildApiUrl('/ai-helper/admin/jailbreak-logs')}?${params.toString()}`,
        { method: 'GET', credentials: 'include' }
      );
      if (!res.ok) throw new Error(`${i18n('ai_helper_admin_jailbreak_load_failed')}: ${res.status}`);
      const json: JailbreakLogPagination = await res.json();
      if (requestId === analyticsRequestId.current) setAnalyticsPagination(json);
    } catch (err: unknown) {
      if (requestId !== analyticsRequestId.current) return;
      console.error('Load jailbreak analytics error:', err);
      const message = getErrorMessage(err, i18n('ai_helper_admin_jailbreak_load_failed'));
      setAnalyticsError(message);
      showToast(message, 'error');
    } finally {
      if (requestId === analyticsRequestId.current) setAnalyticsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRules();
    loadJailbreakLogs(1);
  }, []);

  const hasUnsavedRules = customPatternsText !== savedCustomPatternsText;

  useEffect(() => {
    if (!hasUnsavedRules) return undefined;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasUnsavedRules]);

  const saveRules = async () => {
    const submittedText = customPatternsText;
    setRulesSaving(true);
    try {
      const res = await fetch('/ai-helper/admin/config', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ extraJailbreakPatternsText: submittedText }),
      });
      const json: APIConfigResponse & { error?: string } = await res.json();
      if (!res.ok) throw new Error(json.error || i18n('ai_helper_safety_rules_save_failed'));
      const savedText = json.config?.extraJailbreakPatternsText ?? submittedText;
      setCustomPatternsText((currentText) => currentText === submittedText ? savedText : currentText);
      setSavedCustomPatternsText(savedText);
      showToast(i18n('ai_helper_safety_rules_save_success'), 'success');
    } catch (err: unknown) {
      console.error('Save safety rules error:', err);
      showToast(getErrorMessage(err, i18n('ai_helper_safety_rules_save_failed')), 'error');
    } finally {
      setRulesSaving(false);
    }
  };

  const changePage = (newPage: number) => {
    if (newPage < 1 || newPage > logPagination.totalPages) return;
    latestLogPage.current = newPage;
    loadJailbreakLogs(newPage, latestLogFilters.current);
  };

  const changeLogFilters = (filters: JailbreakLogFilters) => {
    setLogFilters(filters);
    latestLogFilters.current = filters;
    latestLogPage.current = 1;
    loadJailbreakLogs(1, filters);
  };

  const reviewJailbreakLog = async (
    id: string,
    reviewStatus: 'confirmed' | 'false_positive'
  ) => {
    try {
      const res = await fetch(buildApiUrl(`/ai-helper/admin/jailbreak-logs/${encodeURIComponent(id)}/review`), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ reviewStatus }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || i18n('ai_helper_admin_jailbreak_review_failed'));
      showToast(i18n('ai_helper_admin_jailbreak_review_success'), 'success');
      await loadJailbreakLogs(latestLogPage.current, latestLogFilters.current);
    } catch (err: unknown) {
      console.error('Review jailbreak log error:', err);
      showToast(getErrorMessage(err, i18n('ai_helper_admin_jailbreak_review_failed')), 'error');
    }
  };

  const bulkReviewJailbreakLogs = async (
    ids: string[],
    reviewStatus: 'confirmed' | 'false_positive'
  ): Promise<boolean> => {
    try {
      const res = await fetch(buildApiUrl('/ai-helper/admin/jailbreak-logs/bulk-review'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ ids, reviewStatus }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || i18n('ai_helper_admin_jailbreak_bulk_failed'));
      showToast(i18n('ai_helper_admin_jailbreak_bulk_success', json.modifiedCount || 0), 'success');
      await loadJailbreakLogs(latestLogPage.current, latestLogFilters.current);
      return true;
    } catch (err: unknown) {
      console.error('Bulk review jailbreak logs error:', err);
      showToast(getErrorMessage(err, i18n('ai_helper_admin_jailbreak_bulk_failed')), 'error');
      return false;
    }
  };

  const exportJailbreakLogs = async (filters: JailbreakLogFilters): Promise<void> => {
    try {
      const params = new URLSearchParams();
      appendLogFilters(params, filters);
      const url = `${buildApiUrl('/ai-helper/admin/jailbreak-logs/export')}?${params.toString()}`;
      const res = await fetch(url, { method: 'GET', credentials: 'include' });
      if (!res.ok) throw new Error(`${i18n('ai_helper_admin_jailbreak_export_failed')}: ${res.status}`);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = `ai-safety-events-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (err: unknown) {
      console.error('Export jailbreak logs error:', err);
      showToast(getErrorMessage(err, i18n('ai_helper_admin_jailbreak_export_failed')), 'error');
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
    const nextPattern = pattern.trim();
    if (!nextPattern) return;
    if (rulesSaving) {
      showToast(i18n('ai_helper_safety_rules_save_in_progress'), 'warning');
      return;
    }
    if (!rulesReady) {
      showToast(i18n('ai_helper_safety_rules_not_ready'), 'warning');
      setActiveSection('rules');
      return;
    }
    const existingPatterns = customPatternsText.split('\n').map((item) => item.trim()).filter(Boolean);
    if (existingPatterns.includes(nextPattern)) {
      showToast(i18n('ai_helper_safety_rule_already_exists'), 'info');
    } else {
      const prefix = customPatternsText && !customPatternsText.endsWith('\n') ? '\n' : '';
      setCustomPatternsText(`${customPatternsText}${prefix}${nextPattern}`);
      showToast(i18n('ai_helper_safety_rule_added_unsaved'), 'success');
    }
    setActiveSection('rules');
  };

  const filteredBuiltinPatterns = useMemo(() => {
    const keyword = ruleSearch.trim().toLocaleLowerCase();
    if (!keyword) return builtinPatterns;
    return builtinPatterns.filter((pattern) => pattern.toLocaleLowerCase().includes(keyword));
  }, [builtinPatterns, ruleSearch]);

  const customRuleCount = useMemo(() => (
    customPatternsText.split('\n').filter((pattern) => pattern.trim().length > 0).length
  ), [customPatternsText]);
  const outerStyle: React.CSSProperties = {
    padding: embedded ? SPACING.lg : SPACING.xl,
    fontFamily: FONT_FAMILY,
    maxWidth: embedded ? 'none' : '1100px',
    margin: embedded ? '0' : '40px auto',
    boxSizing: 'border-box',
  };

  return (
    <div style={outerStyle}>
      <Toast messages={toasts} onDismiss={dismissToast} />

      <div style={{ marginBottom: SPACING.lg }}>
        <h1 style={{ ...TYPOGRAPHY.xl, color: COLORS.textPrimary, margin: 0 }}>
          {i18n('ai_helper_safety_governance_title')}
        </h1>
        <p style={{ ...TYPOGRAPHY.sm, color: COLORS.textMuted, margin: `${SPACING.sm} 0 0` }}>
          {i18n('ai_helper_safety_governance_desc')}
        </p>
      </div>

      <div
        role="tablist"
        aria-label={i18n('ai_helper_safety_governance_title')}
        style={{
        display: 'flex', flexWrap: 'wrap', gap: SPACING.sm,
        marginBottom: SPACING.base,
      }}>
        <button
          id="ai-safety-tab-records"
          type="button"
          role="tab"
          aria-selected={activeSection === 'records'}
          aria-controls="ai-safety-panel-records"
          onClick={() => setActiveSection('records')}
          style={getPillStyle(activeSection === 'records')}
        >
          {i18n('ai_helper_safety_section_records')}
        </button>
        <button
          id="ai-safety-tab-analytics"
          type="button"
          role="tab"
          aria-selected={activeSection === 'analytics'}
          aria-controls="ai-safety-panel-analytics"
          onClick={() => {
            setActiveSection('analytics');
            loadJailbreakAnalytics();
          }}
          style={getPillStyle(activeSection === 'analytics')}
        >
          {i18n('ai_helper_safety_section_analytics')}
        </button>
        <button
          id="ai-safety-tab-rules"
          type="button"
          role="tab"
          aria-selected={activeSection === 'rules'}
          aria-controls="ai-safety-panel-rules"
          onClick={() => setActiveSection('rules')}
          style={getPillStyle(activeSection === 'rules')}
        >
          {i18n('ai_helper_safety_section_rules')}
          {hasUnsavedRules ? ' *' : ''}
        </button>
      </div>

      {activeSection === 'records' && (
        <>
          {logsError && (
            <div style={{
              ...cardStyle,
              marginTop: SPACING.base,
              borderColor: COLORS.errorBorder,
              backgroundColor: COLORS.errorBg,
              color: COLORS.errorText,
            }}>
              <div style={{ marginBottom: SPACING.sm }}>
                {i18n('ai_helper_safety_events_load_error', logsError)}
              </div>
              <button
                type="button"
                disabled={logsLoading}
                onClick={() => loadJailbreakLogs(latestLogPage.current, latestLogFilters.current)}
                style={getButtonStyle('secondary')}
              >
                {i18n('ai_helper_safety_events_retry')}
              </button>
            </div>
          )}
          {(!logsError || logPagination.logs.length > 0) && (
            <JailbreakLogsViewer
              logPagination={logPagination}
              loading={logsLoading}
              appendPatternDisabled={rulesSaving || !rulesReady}
              onChangePage={changePage}
              onCopyToClipboard={copyToClipboard}
              onAppendPattern={appendPatternToCustomRules}
              onReview={reviewJailbreakLog}
              onBulkReview={bulkReviewJailbreakLogs}
              onExport={exportJailbreakLogs}
              filters={logFilters}
              onChangeFilters={changeLogFilters}
              onLoadFilterOptions={loadLogFilterOptions}
            />
          )}
        </>
      )}

      {activeSection === 'analytics' && (
        <>
          {analyticsError && (
            <div style={{
              ...cardStyle,
              marginTop: SPACING.base,
              borderColor: COLORS.errorBorder,
              backgroundColor: COLORS.errorBg,
              color: COLORS.errorText,
            }}>
              <div style={{ marginBottom: SPACING.sm }}>
                {i18n('ai_helper_safety_analytics_load_error', analyticsError)}
              </div>
              <button
                type="button"
                disabled={analyticsLoading}
                onClick={loadJailbreakAnalytics}
                style={getButtonStyle('secondary')}
              >
                {i18n('ai_helper_safety_analytics_retry')}
              </button>
            </div>
          )}
          {(!analyticsError || analyticsPagination.summary.total > 0) && (
            <JailbreakAnalyticsPanel
              logPagination={analyticsPagination}
              loading={analyticsLoading}
            />
          )}
        </>
      )}

      {activeSection === 'rules' && (
        <div
          id="ai-safety-panel-rules"
          role="tabpanel"
          aria-labelledby="ai-safety-tab-rules"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: SPACING.lg,
            marginTop: SPACING.base,
          }}
        >
          <div style={cardStyle}>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
              gap: SPACING.base, flexWrap: 'wrap', marginBottom: SPACING.base,
            }}>
              <div>
                <h2 style={{ ...TYPOGRAPHY.md, color: COLORS.textPrimary, margin: 0 }}>
                  {i18n('ai_helper_admin_builtin_jailbreak_rules')}
                </h2>
                <p style={{ ...TYPOGRAPHY.xs, color: COLORS.textMuted, margin: `${SPACING.xs} 0 0` }}>
                  {i18n('ai_helper_safety_builtin_rules_desc', builtinPatterns.length)}
                </p>
              </div>
              <input
                type="search"
                value={ruleSearch}
                onChange={(event) => setRuleSearch(event.target.value)}
                placeholder={i18n('ai_helper_safety_rule_search_placeholder')}
                disabled={rulesLoading}
                style={{ ...getInputStyle(), width: 'min(100%, 320px)' }}
              />
            </div>
            <div style={{
              maxHeight: '420px', overflowY: 'auto', padding: SPACING.md,
              borderRadius: RADIUS.md, border: `1px solid ${COLORS.border}`,
              backgroundColor: COLORS.bgPage,
            }}>
              {rulesLoading ? (
                <div style={{ color: COLORS.textMuted }}>{i18n('ai_helper_safety_rules_loading')}</div>
              ) : !rulesReady ? (
                <button type="button" onClick={loadRules} style={getButtonStyle('secondary')}>
                  {i18n('ai_helper_safety_rules_retry')}
                </button>
              ) : filteredBuiltinPatterns.length === 0 ? (
                <div style={{ color: COLORS.textMuted }}>{i18n('ai_helper_admin_no_builtin_rules')}</div>
              ) : (
                <ol style={{ margin: 0, paddingLeft: '24px' }}>
                  {filteredBuiltinPatterns.map((pattern, index) => (
                    <li key={`${pattern}-${index}`} style={{ marginBottom: SPACING.sm, wordBreak: 'break-all' }}>
                      <code style={{ fontSize: '13px' }}>{pattern}</code>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>

          <div style={cardStyle}>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
              gap: SPACING.base, flexWrap: 'wrap', marginBottom: SPACING.base,
            }}>
              <div>
                <h2 style={{ ...TYPOGRAPHY.md, color: COLORS.textPrimary, margin: 0 }}>
                  {i18n('ai_helper_admin_custom_jailbreak_rules')}
                </h2>
                <p style={{ ...TYPOGRAPHY.xs, color: COLORS.textMuted, margin: `${SPACING.xs} 0 0` }}>
                  {i18n('ai_helper_safety_custom_rules_desc', customRuleCount)}
                </p>
              </div>
              {hasUnsavedRules && (
                <span style={{
                  padding: `3px ${SPACING.sm}`, borderRadius: RADIUS.full,
                  backgroundColor: COLORS.warningBg, color: COLORS.warningText,
                  border: `1px solid ${COLORS.warningBorder}`, fontSize: '12px',
                }}>
                  {i18n('ai_helper_safety_rules_unsaved')}
                </span>
              )}
            </div>
            <textarea
              value={customPatternsText}
              onChange={(event) => setCustomPatternsText(event.target.value)}
              placeholder={i18n('ai_helper_admin_jailbreak_pattern_placeholder')}
              disabled={!rulesReady || rulesLoading || rulesSaving}
              rows={12}
              style={{ ...getInputStyle(), fontFamily: 'monospace', resize: 'vertical' }}
            />
            <div style={{
              display: 'flex', justifyContent: 'flex-end', gap: SPACING.sm,
              flexWrap: 'wrap', marginTop: SPACING.base,
            }}>
              <button
                type="button"
                onClick={() => setCustomPatternsText(savedCustomPatternsText)}
                disabled={!rulesReady || !hasUnsavedRules || rulesSaving}
                style={{
                  ...getButtonStyle('secondary'),
                  opacity: !rulesReady || !hasUnsavedRules || rulesSaving ? 0.5 : 1,
                }}
              >
                {i18n('ai_helper_safety_rules_discard')}
              </button>
              <button
                type="button"
                onClick={saveRules}
                disabled={!rulesReady || !hasUnsavedRules || rulesLoading || rulesSaving}
                style={{
                  ...getButtonStyle('primary'),
                  opacity: !rulesReady || !hasUnsavedRules || rulesLoading || rulesSaving ? 0.5 : 1,
                }}
              >
                {rulesSaving
                  ? i18n('ai_helper_safety_rules_saving')
                  : i18n('ai_helper_safety_rules_save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SafetyGovernancePanel;
