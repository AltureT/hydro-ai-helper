import React from 'react';
import { i18n } from '../utils/i18n';
import {
  COLORS, SPACING, RADIUS, TYPOGRAPHY,
  cardStyle, getButtonStyle, getInputStyle,
} from '../utils/styles';
import type {
  JailbreakCategory,
  JailbreakLogFilterOption,
  JailbreakLogEntry,
  JailbreakLogFilters,
  JailbreakLogPagination,
  JailbreakReviewStatus,
} from './configTypes';

interface JailbreakLogsViewerProps {
  logPagination: JailbreakLogPagination;
  loading: boolean;
  appendPatternDisabled?: boolean;
  onChangePage: (page: number) => void;
  onCopyToClipboard: (text: string) => void;
  onAppendPattern: (pattern: string) => void;
  onReview: (id: string, reviewStatus: 'confirmed' | 'false_positive') => Promise<void>;
  onBulkReview: (ids: string[], reviewStatus: 'confirmed' | 'false_positive') => Promise<boolean>;
  onExport: (filters: JailbreakLogFilters) => Promise<void>;
  filters: JailbreakLogFilters;
  onChangeFilters: (filters: JailbreakLogFilters) => void;
  onLoadFilterOptions: (
    kind: 'user' | 'problem',
    query: string
  ) => Promise<JailbreakLogFilterOption[]>;
}

const DETECTION_SOURCE_OPTIONS: Array<{
  value: NonNullable<JailbreakLogFilters['detectionSource']>;
  labelKey: string;
}> = [
  { value: 'plain', labelKey: 'ai_helper_admin_jailbreak_source_plain' },
  { value: 'compacted', labelKey: 'ai_helper_admin_jailbreak_source_compacted' },
  { value: 'base64', labelKey: 'ai_helper_admin_jailbreak_source_base64' },
  { value: 'hex', labelKey: 'ai_helper_admin_jailbreak_source_hex' },
  { value: 'conversation', labelKey: 'ai_helper_admin_jailbreak_source_conversation' },
  { value: 'custom', labelKey: 'ai_helper_admin_jailbreak_source_custom' },
];

function getDetectionSourceLabel(source: JailbreakLogFilters['detectionSource']): string {
  const option = DETECTION_SOURCE_OPTIONS.find((item) => item.value === source);
  return option ? i18n(option.labelKey) : String(source || '');
}

export const JailbreakLogsViewer: React.FC<JailbreakLogsViewerProps> = ({
  logPagination, loading, onChangePage, onCopyToClipboard, onAppendPattern, onReview, onBulkReview, onExport,
  filters, onChangeFilters, onLoadFilterOptions, appendPatternDisabled = false,
}) => {
  const [reviewingId, setReviewingId] = React.useState<string | null>(null);
  const [selectedIds, setSelectedIds] = React.useState<string[]>([]);
  const [bulkReviewing, setBulkReviewing] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const [userIdDraft, setUserIdDraft] = React.useState(filters.userId || '');
  const [problemIdDraft, setProblemIdDraft] = React.useState(filters.problemId || '');
  const [userOptions, setUserOptions] = React.useState<JailbreakLogFilterOption[]>([]);
  const [problemOptions, setProblemOptions] = React.useState<JailbreakLogFilterOption[]>([]);
  const [userOptionsError, setUserOptionsError] = React.useState<string | null>(null);
  const [problemOptionsError, setProblemOptionsError] = React.useState<string | null>(null);
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = React.useState(false);
  const userOptionRequestId = React.useRef(0);
  const problemOptionRequestId = React.useRef(0);

  React.useEffect(() => {
    const visibleIds = new Set(logPagination.logs.map((log) => log.id));
    setSelectedIds((current) => current.filter((id) => visibleIds.has(id)));
  }, [logPagination.logs]);

  React.useEffect(() => {
    setUserIdDraft(filters.userId || '');
    setProblemIdDraft(filters.problemId || '');
  }, [filters.userId, filters.problemId]);

  React.useEffect(() => {
    const query = userIdDraft.trim();
    const requestId = ++userOptionRequestId.current;
    if (!query) {
      setUserOptions([]);
      setUserOptionsError(null);
      return undefined;
    }
    setUserOptionsError(null);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void onLoadFilterOptions('user', query).then((options) => {
        if (!cancelled && requestId === userOptionRequestId.current) {
          setUserOptions(options);
          setUserOptionsError(null);
        }
      }).catch((error: unknown) => {
        if (!cancelled && requestId === userOptionRequestId.current) {
          setUserOptions([]);
          setUserOptionsError(
            error instanceof Error && error.message
              ? error.message
              : i18n('ai_helper_admin_jailbreak_filter_suggestions_failed')
          );
        }
      });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [userIdDraft, onLoadFilterOptions]);

  React.useEffect(() => {
    const query = problemIdDraft.trim();
    const requestId = ++problemOptionRequestId.current;
    if (!query) {
      setProblemOptions([]);
      setProblemOptionsError(null);
      return undefined;
    }
    setProblemOptionsError(null);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void onLoadFilterOptions('problem', query).then((options) => {
        if (!cancelled && requestId === problemOptionRequestId.current) {
          setProblemOptions(options);
          setProblemOptionsError(null);
        }
      }).catch((error: unknown) => {
        if (!cancelled && requestId === problemOptionRequestId.current) {
          setProblemOptions([]);
          setProblemOptionsError(
            error instanceof Error && error.message
              ? error.message
              : i18n('ai_helper_admin_jailbreak_filter_suggestions_failed')
          );
        }
      });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [problemIdDraft, onLoadFilterOptions]);

  const submitReview = async (
    log: JailbreakLogEntry,
    reviewStatus: 'confirmed' | 'false_positive'
  ) => {
    setReviewingId(log.id);
    try {
      await onReview(log.id, reviewStatus);
    } finally {
      setReviewingId(null);
    }
  };

  const summary = logPagination.summary || {
    total: 0, pending: 0, confirmed: 0, falsePositive: 0, reviewed: 0,
    falsePositiveRate: 0, appealedPending: 0,
  };
  const summaryItems = [
    { label: i18n('ai_helper_admin_jailbreak_summary_total'), value: summary.total },
    { label: i18n('ai_helper_admin_jailbreak_summary_pending'), value: summary.pending },
    { label: i18n('ai_helper_admin_jailbreak_summary_appealed'), value: summary.appealedPending },
    { label: i18n('ai_helper_admin_jailbreak_summary_reviewed'), value: summary.reviewed },
    { label: i18n('ai_helper_admin_jailbreak_summary_confirmed'), value: summary.confirmed },
    { label: i18n('ai_helper_admin_jailbreak_summary_false_positive'), value: summary.falsePositive },
    { label: i18n('ai_helper_admin_jailbreak_summary_false_positive_rate'), value: `${summary.falsePositiveRate}%` },
  ];
  const operationalMetrics = logPagination.operationalMetrics;

  const withDraftIdentity = (base: JailbreakLogFilters = filters): JailbreakLogFilters => ({
    ...base,
    userId: userIdDraft.trim() || undefined,
    problemId: problemIdDraft.trim() || undefined,
  });

  const updateReviewStatusFilter = (value: string) => {
    onChangeFilters({
      ...withDraftIdentity(),
      reviewStatus: value ? value as JailbreakReviewStatus : undefined,
    });
  };

  const updateCategoryFilter = (value: string) => {
    onChangeFilters({
      ...withDraftIdentity(),
      category: value ? value as JailbreakCategory : undefined,
    });
  };

  const applyIdentityFilters = () => {
    onChangeFilters(withDraftIdentity());
  };

  const resetFilters = () => {
    setUserIdDraft('');
    setProblemIdDraft('');
    setAdvancedFiltersOpen(false);
    onChangeFilters({});
  };

  const advancedFilterCount = [
    filters.appealedOnly,
    filters.actionTaken,
    filters.detectionSource,
    filters.dateFrom,
    filters.dateTo,
  ].filter(Boolean).length;

  const submitExport = async () => {
    setExporting(true);
    try {
      await onExport(withDraftIdentity());
    } finally {
      setExporting(false);
    }
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((current) => current.includes(id)
      ? current.filter((item) => item !== id)
      : [...current, id]);
  };

  const toggleCurrentPage = () => {
    const pageIds = logPagination.logs
      .filter((log) => (log.reviewStatus || 'pending') === 'pending')
      .map((log) => log.id);
    const allSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.includes(id));
    setSelectedIds(allSelected ? [] : pageIds);
  };

  const submitBulkReview = async (reviewStatus: 'confirmed' | 'false_positive') => {
    if (selectedIds.length === 0) return;
    setBulkReviewing(true);
    try {
      const succeeded = await onBulkReview(selectedIds, reviewStatus);
      if (succeeded) setSelectedIds([]);
    } finally {
      setBulkReviewing(false);
    }
  };

  return (
  <div style={{
    ...cardStyle,
    marginTop: '20px',
  }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <h2 style={{ margin: 0, ...TYPOGRAPHY.md, color: COLORS.textPrimary }}>
        {i18n('ai_helper_admin_jailbreak_title')}
      </h2>
      {logPagination.total > 0 && (
        <span style={{ fontSize: '13px', color: COLORS.textMuted }}>
          {i18n('ai_helper_admin_jailbreak_total', logPagination.total)}
        </span>
      )}
    </div>

    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
      gap: SPACING.sm, marginTop: SPACING.base,
    }}>
      {summaryItems.map((item) => (
        <div key={item.label} style={{
          padding: SPACING.md, borderRadius: RADIUS.md, backgroundColor: COLORS.bgPage,
          border: `1px solid ${COLORS.border}`,
        }}>
          <div style={{ fontSize: '12px', color: COLORS.textMuted }}>{item.label}</div>
          <div style={{ marginTop: '4px', fontSize: '20px', fontWeight: 600, color: COLORS.textPrimary }}>
            {item.value}
          </div>
        </div>
      ))}
    </div>

    <div style={{ margin: `${SPACING.base} 0` }}>
      <div style={{ fontWeight: 600, color: COLORS.textPrimary, marginBottom: SPACING.sm }}>
        {i18n('ai_helper_admin_jailbreak_filter_title')}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: SPACING.md }}>
        <label style={{ minWidth: '180px', flex: '1 1 180px', fontSize: '13px', color: COLORS.textSecondary }}>
          {i18n('ai_helper_admin_jailbreak_filter_review_status')}
          <select
            value={filters.reviewStatus || ''}
            disabled={loading}
            onChange={(event) => updateReviewStatusFilter(event.target.value)}
            style={{ ...getInputStyle(), marginTop: '6px' }}
          >
            <option value="">{i18n('ai_helper_admin_jailbreak_filter_all')}</option>
            <option value="pending">{i18n('ai_helper_admin_jailbreak_review_pending')}</option>
            <option value="confirmed">{i18n('ai_helper_admin_jailbreak_review_confirmed')}</option>
            <option value="false_positive">{i18n('ai_helper_admin_jailbreak_review_false_positive')}</option>
          </select>
        </label>
        <label style={{ minWidth: '210px', flex: '1 1 210px', fontSize: '13px', color: COLORS.textSecondary }}>
          {i18n('ai_helper_admin_jailbreak_filter_category')}
          <select
            value={filters.category || ''}
            disabled={loading}
            onChange={(event) => updateCategoryFilter(event.target.value)}
            style={{ ...getInputStyle(), marginTop: '6px' }}
          >
            <option value="">{i18n('ai_helper_admin_jailbreak_filter_all')}</option>
            <option value="answer_seeking">{i18n('ai_helper_admin_jailbreak_category_answer_seeking')}</option>
            <option value="prompt_injection">{i18n('ai_helper_admin_jailbreak_category_prompt_injection')}</option>
            <option value="prompt_exfiltration">{i18n('ai_helper_admin_jailbreak_category_prompt_exfiltration')}</option>
            <option value="obfuscated_injection">{i18n('ai_helper_admin_jailbreak_category_obfuscated_injection')}</option>
          </select>
        </label>
        <label style={{ minWidth: '170px', flex: '1 1 170px', fontSize: '13px', color: COLORS.textSecondary }}>
          {i18n('ai_helper_admin_jailbreak_filter_user')}
          <input
            type="text"
            inputMode="numeric"
            maxLength={32}
            list="ai-safety-user-options"
            value={userIdDraft}
            disabled={loading}
            aria-invalid={Boolean(userOptionsError)}
            aria-describedby={userOptionsError ? 'ai-safety-user-options-error' : undefined}
            placeholder={i18n('ai_helper_admin_jailbreak_filter_user_placeholder')}
            onChange={(event) => setUserIdDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') applyIdentityFilters(); }}
            style={{ ...getInputStyle(), marginTop: '6px' }}
          />
          <datalist id="ai-safety-user-options">
            {userOptions.map((option) => (
              <option
                key={option.value}
                value={option.value}
                label={option.label === option.value
                  ? option.value
                  : `${option.label} (${option.value})`}
              />
            ))}
          </datalist>
          {userOptionsError && (
            <span
              id="ai-safety-user-options-error"
              role="status"
              aria-live="polite"
              style={{ display: 'block', marginTop: '4px', fontSize: '12px', color: COLORS.errorText }}
            >
              {userOptionsError}
            </span>
          )}
        </label>
        <label style={{ minWidth: '190px', flex: '1 1 190px', fontSize: '13px', color: COLORS.textSecondary }}>
          {i18n('ai_helper_admin_jailbreak_filter_problem')}
          <input
            type="text"
            maxLength={64}
            list="ai-safety-problem-options"
            value={problemIdDraft}
            disabled={loading}
            aria-invalid={Boolean(problemOptionsError)}
            aria-describedby={problemOptionsError ? 'ai-safety-problem-options-error' : undefined}
            placeholder={i18n('ai_helper_admin_jailbreak_filter_problem_placeholder')}
            onChange={(event) => setProblemIdDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') applyIdentityFilters(); }}
            style={{ ...getInputStyle(), marginTop: '6px' }}
          />
          <datalist id="ai-safety-problem-options">
            {problemOptions.map((option) => (
              <option key={option.value} value={option.value} label={option.label} />
            ))}
          </datalist>
          {problemOptionsError && (
            <span
              id="ai-safety-problem-options-error"
              role="status"
              aria-live="polite"
              style={{ display: 'block', marginTop: '4px', fontSize: '12px', color: COLORS.errorText }}
            >
              {problemOptionsError}
            </span>
          )}
        </label>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: SPACING.sm, marginTop: SPACING.md }}>
        <button
          type="button"
          disabled={loading}
          onClick={applyIdentityFilters}
          style={getButtonStyle('secondary')}
        >
          {i18n('ai_helper_admin_jailbreak_filter_apply')}
        </button>
        <button
          type="button"
          disabled={loading}
          onClick={resetFilters}
          style={getButtonStyle('secondary')}
        >
          {i18n('ai_helper_admin_jailbreak_filter_reset')}
        </button>
        <button
          type="button"
          aria-expanded={advancedFiltersOpen}
          aria-controls="ai-safety-advanced-filters"
          onClick={() => setAdvancedFiltersOpen((open) => !open)}
          style={getButtonStyle('secondary')}
        >
          {advancedFiltersOpen
            ? i18n('ai_helper_admin_jailbreak_filter_less')
            : i18n('ai_helper_admin_jailbreak_filter_more', advancedFilterCount)}
        </button>
        <button
          type="button"
          disabled={loading || exporting}
          onClick={submitExport}
          style={getButtonStyle('secondary')}
        >
          {exporting
            ? i18n('ai_helper_admin_jailbreak_exporting')
            : i18n('ai_helper_admin_jailbreak_export_csv')}
        </button>
      </div>

      {advancedFiltersOpen && (
        <div
          id="ai-safety-advanced-filters"
          role="region"
          aria-label={i18n('ai_helper_admin_jailbreak_filter_more_region')}
          style={{
            display: 'flex', flexWrap: 'wrap', gap: SPACING.md,
            marginTop: SPACING.md, padding: SPACING.md,
            border: `1px solid ${COLORS.border}`, borderRadius: RADIUS.md,
            backgroundColor: COLORS.bgPage,
          }}
        >
          <label style={{
            display: 'flex', alignItems: 'center', gap: SPACING.sm,
            minWidth: '230px', fontSize: '13px', color: COLORS.textSecondary,
          }}>
            <input
              type="checkbox"
              checked={Boolean(filters.appealedOnly)}
              disabled={loading}
              onChange={(event) => onChangeFilters({
                ...withDraftIdentity(),
                appealedOnly: event.target.checked || undefined,
              })}
            />
            {i18n('ai_helper_admin_jailbreak_filter_appealed')}
          </label>
          <label style={{ minWidth: '160px', flex: '1 1 160px', fontSize: '13px', color: COLORS.textSecondary }}>
            {i18n('ai_helper_admin_jailbreak_filter_action')}
            <select
              value={filters.actionTaken || ''}
              disabled={loading}
              onChange={(event) => onChangeFilters({
                ...withDraftIdentity(),
                actionTaken: event.target.value
                  ? event.target.value as JailbreakLogFilters['actionTaken']
                  : undefined,
              })}
              style={{ ...getInputStyle(), marginTop: '6px' }}
            >
              <option value="">{i18n('ai_helper_admin_jailbreak_filter_all')}</option>
              <option value="blocked">{i18n('ai_helper_admin_jailbreak_action_blocked')}</option>
              <option value="cooldown_60s">{i18n('ai_helper_admin_jailbreak_action_cooldown_60s')}</option>
              <option value="cooldown_5m">{i18n('ai_helper_admin_jailbreak_action_cooldown_5m')}</option>
            </select>
          </label>
          <label style={{ minWidth: '220px', flex: '1 1 220px', fontSize: '13px', color: COLORS.textSecondary }}>
            {i18n('ai_helper_admin_jailbreak_filter_source')}
            <select
              value={filters.detectionSource || ''}
              disabled={loading}
              onChange={(event) => onChangeFilters({
                ...withDraftIdentity(),
                detectionSource: event.target.value
                  ? event.target.value as JailbreakLogFilters['detectionSource']
                  : undefined,
              })}
              style={{ ...getInputStyle(), marginTop: '6px' }}
            >
              <option value="">{i18n('ai_helper_admin_jailbreak_filter_all')}</option>
              {DETECTION_SOURCE_OPTIONS.map((source) => (
                <option key={source.value} value={source.value}>{i18n(source.labelKey)}</option>
              ))}
            </select>
            <span style={{ display: 'block', marginTop: '4px', fontSize: '12px', color: COLORS.textMuted }}>
              {i18n('ai_helper_admin_jailbreak_filter_source_help')}
            </span>
          </label>
          <label style={{ minWidth: '160px', flex: '1 1 160px', fontSize: '13px', color: COLORS.textSecondary }}>
            {i18n('ai_helper_admin_jailbreak_filter_date_from')}
            <input
              type="date"
              value={filters.dateFrom || ''}
              disabled={loading}
              onChange={(event) => onChangeFilters({
                ...withDraftIdentity(),
                dateFrom: event.target.value || undefined,
              })}
              style={{ ...getInputStyle(), marginTop: '6px' }}
            />
          </label>
          <label style={{ minWidth: '160px', flex: '1 1 160px', fontSize: '13px', color: COLORS.textSecondary }}>
            {i18n('ai_helper_admin_jailbreak_filter_date_to')}
            <input
              type="date"
              value={filters.dateTo || ''}
              disabled={loading}
              onChange={(event) => onChangeFilters({
                ...withDraftIdentity(),
                dateTo: event.target.value || undefined,
              })}
              style={{ ...getInputStyle(), marginTop: '6px' }}
            />
          </label>
        </div>
      )}
    </div>
        {operationalMetrics && (
          <div style={{ marginBottom: SPACING.base }}>
            <div style={{ marginBottom: SPACING.sm, fontWeight: 600, color: COLORS.textPrimary }}>
              {i18n('ai_helper_admin_jailbreak_operations_title', operationalMetrics.windowDays)}
            </div>
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
              gap: SPACING.sm, marginBottom: SPACING.sm,
            }}>
              {[
                [i18n('ai_helper_admin_jailbreak_operations_total'), operationalMetrics.total],
                [i18n('ai_helper_admin_jailbreak_operations_cooldown'), operationalMetrics.cooldown],
                [i18n('ai_helper_admin_jailbreak_operations_pending_appeals'), operationalMetrics.pendingAppeals],
                [i18n('ai_helper_admin_jailbreak_operations_review_time'), operationalMetrics.averageReviewMinutes ?? '-'],
                [i18n('ai_helper_admin_jailbreak_operations_appeal_time'), operationalMetrics.averageAppealReviewMinutes ?? '-'],
              ].map(([label, value]) => (
                <div key={String(label)} style={{
                  padding: SPACING.sm, borderRadius: RADIUS.md,
                  backgroundColor: COLORS.bgPage, border: `1px solid ${COLORS.border}`,
                }}>
                  <div style={{ fontSize: '12px', color: COLORS.textMuted }}>{label}</div>
                  <div style={{ marginTop: '3px', fontWeight: 600, color: COLORS.textPrimary }}>{value}</div>
                </div>
              ))}
            </div>
            {operationalMetrics.dailyTrend.length > 0 && (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                  <thead>
                    <tr style={{ color: COLORS.textSecondary, textAlign: 'left' }}>
                      <th style={{ padding: SPACING.sm }}>{i18n('ai_helper_admin_jailbreak_trend_date')}</th>
                      <th style={{ padding: SPACING.sm }}>{i18n('ai_helper_admin_jailbreak_summary_total')}</th>
                      <th style={{ padding: SPACING.sm }}>{i18n('ai_helper_admin_jailbreak_operations_cooldown')}</th>
                      <th style={{ padding: SPACING.sm }}>{i18n('ai_helper_admin_jailbreak_summary_appealed')}</th>
                      <th style={{ padding: SPACING.sm }}>{i18n('ai_helper_admin_jailbreak_summary_false_positive')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {operationalMetrics.dailyTrend.map((row) => (
                      <tr key={row.date} style={{ borderTop: `1px solid ${COLORS.border}` }}>
                        <td style={{ padding: SPACING.sm }}>{row.date}</td>
                        <td style={{ padding: SPACING.sm }}>{row.total}</td>
                        <td style={{ padding: SPACING.sm }}>{row.cooldown}</td>
                        <td style={{ padding: SPACING.sm }}>{row.appealed}</td>
                        <td style={{ padding: SPACING.sm }}>{row.falsePositive}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
        {logPagination.ruleMetrics?.length > 0 && (
          <div style={{ marginBottom: SPACING.base, overflowX: 'auto' }}>
            <div style={{ marginBottom: SPACING.sm, fontWeight: 600, color: COLORS.textPrimary }}>
              {i18n('ai_helper_admin_jailbreak_rule_quality_title')}
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead>
                <tr style={{ color: COLORS.textSecondary, textAlign: 'left' }}>
                  <th style={{ padding: SPACING.sm }}>{i18n('ai_helper_admin_jailbreak_rule')}</th>
                  <th style={{ padding: SPACING.sm }}>{i18n('ai_helper_admin_jailbreak_filter_category')}</th>
                  <th style={{ padding: SPACING.sm }}>{i18n('ai_helper_admin_jailbreak_summary_total')}</th>
                  <th style={{ padding: SPACING.sm }}>{i18n('ai_helper_admin_jailbreak_summary_pending')}</th>
                  <th style={{ padding: SPACING.sm }}>{i18n('ai_helper_admin_jailbreak_summary_confirmed')}</th>
                  <th style={{ padding: SPACING.sm }}>{i18n('ai_helper_admin_jailbreak_summary_false_positive')}</th>
                  <th style={{ padding: SPACING.sm }}>{i18n('ai_helper_admin_jailbreak_summary_false_positive_rate')}</th>
                </tr>
              </thead>
              <tbody>
                {logPagination.ruleMetrics.map((metric) => (
                  <tr key={`${metric.category || ''}:${metric.matchedPattern}`} style={{ borderTop: `1px solid ${COLORS.border}` }}>
                    <td style={{ padding: SPACING.sm, maxWidth: '280px', wordBreak: 'break-all' }}>
                      <code>{metric.matchedPattern}</code>
                    </td>
                    <td style={{ padding: SPACING.sm }}>{metric.category || '-'}</td>
                    <td style={{ padding: SPACING.sm }}>{metric.total}</td>
                    <td style={{ padding: SPACING.sm }}>{metric.pending}</td>
                    <td style={{ padding: SPACING.sm }}>{metric.confirmed}</td>
                    <td style={{ padding: SPACING.sm }}>{metric.falsePositive}</td>
                    <td style={{ padding: SPACING.sm }}>{metric.falsePositiveRate}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {logPagination.logs.length > 0 && (
          <div style={{
            display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: SPACING.sm,
            marginBottom: SPACING.base, padding: SPACING.md,
            border: `1px solid ${COLORS.border}`, borderRadius: RADIUS.md,
            backgroundColor: COLORS.bgPage,
          }}>
            <button type="button" onClick={toggleCurrentPage} disabled={loading || bulkReviewing} style={getButtonStyle('secondary')}>
              {i18n('ai_helper_admin_jailbreak_select_page')}
            </button>
            <span style={{ color: COLORS.textSecondary, fontSize: '13px' }}>
              {i18n('ai_helper_admin_jailbreak_selected_count', selectedIds.length)}
            </span>
            <button
              type="button"
              onClick={() => submitBulkReview('confirmed')}
              disabled={selectedIds.length === 0 || bulkReviewing}
              style={{ ...getButtonStyle('secondary'), opacity: selectedIds.length === 0 ? 0.5 : 1 }}
            >
              {i18n('ai_helper_admin_jailbreak_bulk_confirm')}
            </button>
            <button
              type="button"
              onClick={() => submitBulkReview('false_positive')}
              disabled={selectedIds.length === 0 || bulkReviewing}
              style={{ ...getButtonStyle('secondary'), opacity: selectedIds.length === 0 ? 0.5 : 1 }}
            >
              {i18n('ai_helper_admin_jailbreak_bulk_false_positive')}
            </button>
            {selectedIds.length > 0 && (
              <button type="button" onClick={() => setSelectedIds([])} disabled={bulkReviewing} style={getButtonStyle('ghost')}>
                {i18n('ai_helper_admin_jailbreak_clear_selection')}
              </button>
            )}
          </div>
        )}
    {loading && logPagination.logs.length === 0 ? (
      <div style={{
        padding: SPACING.base, backgroundColor: COLORS.bgPage, borderRadius: RADIUS.md,
        border: `1px dashed ${COLORS.border}`, color: COLORS.textMuted, fontSize: '14px',
      }}>
        {i18n('ai_helper_safety_events_loading')}
      </div>
    ) : logPagination.logs.length === 0 ? (
      <div style={{
        padding: SPACING.base, backgroundColor: COLORS.bgPage, borderRadius: RADIUS.md,
        border: `1px dashed ${COLORS.border}`, color: COLORS.textMuted, fontSize: '14px',
      }}>
        {i18n('ai_helper_admin_jailbreak_empty')}
      </div>
    ) : (
      <>
        <div style={{ display: 'flex', flexDirection: 'column', gap: SPACING.base }}>
          {logPagination.logs.map((log) => {
            const contextPieces: string[] = [];
            if (log.userId !== undefined) contextPieces.push(`${i18n('ai_helper_admin_jailbreak_user_id')}${log.userId}`);
            if (log.problemId) contextPieces.push(`${i18n('ai_helper_admin_jailbreak_problem_id')}${log.problemId}`);
            if (log.conversationId) contextPieces.push(`${i18n('ai_helper_admin_jailbreak_conversation_id')}${log.conversationId}`);
            if (log.questionType) contextPieces.push(`${i18n('ai_helper_admin_jailbreak_question_type')}${log.questionType}`);
            if (log.category) contextPieces.push(`${i18n('ai_helper_admin_jailbreak_category')}${log.category}`);
            if (log.riskScore !== undefined) contextPieces.push(`${i18n('ai_helper_admin_jailbreak_risk_score')}${log.riskScore}`);
            if (log.actionTaken) contextPieces.push(`${i18n('ai_helper_admin_jailbreak_action')}${log.actionTaken}`);
            if (log.detectionSource) {
              contextPieces.push(
                `${i18n('ai_helper_admin_jailbreak_detection_source')}${getDetectionSourceLabel(log.detectionSource)}`
              );
            }
            if (log.expiresAt) contextPieces.push(
              `${i18n('ai_helper_admin_jailbreak_expires_at')}${new Date(log.expiresAt).toLocaleDateString()}`
            );
            const reviewStatus = log.reviewStatus || 'pending';
            const isPendingReview = reviewStatus === 'pending';
            contextPieces.push(
              `${i18n('ai_helper_admin_jailbreak_review_status')}${i18n(`ai_helper_admin_jailbreak_review_${reviewStatus}`)}`
            );
            const contextText = contextPieces.join(' \u00b7 ');
            const isReviewing = reviewingId === log.id;

            return (
              <div key={log.id} style={{
                ...cardStyle,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: SPACING.sm }}>
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(log.id)}
                    disabled={!isPendingReview}
                    onChange={() => toggleSelected(log.id)}
                    aria-label={i18n('ai_helper_admin_jailbreak_select_record')}
                  />
                  <div style={{ fontSize: '14px', color: COLORS.textPrimary, fontWeight: 500 }}>
                    {i18n('ai_helper_admin_jailbreak_time')}{new Date(log.createdAt).toLocaleString()}
                  </div>
                </div>
                <div style={{ marginTop: '6px', fontSize: '13px', color: COLORS.textSecondary }}>
                  {i18n('ai_helper_admin_jailbreak_matched_rule')}<code style={{ fontFamily: 'monospace' }}>{log.matchedPattern}</code>
                </div>
                <pre style={{
                  marginTop: '10px', padding: SPACING.md, backgroundColor: '#1f2937', color: '#f9fafb',
                  borderRadius: RADIUS.md, fontSize: '13px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}>
                  {log.matchedText}
                </pre>
                {contextText && (
                  <div style={{ marginTop: '6px', fontSize: '12px', color: COLORS.textMuted }}>
                    {contextText}
                  </div>
                )}
                {log.studentAppealedAt && (
                  <div style={{
                    marginTop: '8px', padding: '8px 10px', borderRadius: RADIUS.sm,
                    backgroundColor: '#fff7ed', color: '#9a3412', fontSize: '12px',
                  }}>
                    {i18n('ai_helper_admin_jailbreak_student_appealed')}
                    {new Date(log.studentAppealedAt).toLocaleString()}
                    {log.studentAppealReason ? ` · ${log.studentAppealReason}` : ''}
                  </div>
                )}
                <div style={{ marginTop: '10px', display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
                  <button type="button" onClick={() => onCopyToClipboard(log.matchedText)} style={getButtonStyle('secondary')}>
                    {i18n('ai_helper_admin_jailbreak_copy_text')}
                  </button>
                  <button type="button" onClick={() => onCopyToClipboard(log.matchedPattern)} style={getButtonStyle('secondary')}>
                    {i18n('ai_helper_admin_jailbreak_copy_regex')}
                  </button>
                  <button
                    type="button"
                    onClick={() => onAppendPattern(log.matchedPattern)}
                    disabled={appendPatternDisabled}
                    style={getButtonStyle('ghost')}
                  >
                    {i18n('ai_helper_admin_jailbreak_append_rule')}
                  </button>
                  <button
                    type="button"
                    disabled={isReviewing || !isPendingReview}
                    onClick={() => submitReview(log, 'confirmed')}
                    style={{
                      ...getButtonStyle('secondary'),
                      opacity: isReviewing || !isPendingReview ? 0.5 : 1,
                    }}
                  >
                    {i18n('ai_helper_admin_jailbreak_confirm_violation')}
                  </button>
                  <button
                    type="button"
                    disabled={isReviewing || !isPendingReview}
                    onClick={() => submitReview(log, 'false_positive')}
                    style={{
                      ...getButtonStyle('secondary'),
                      opacity: isReviewing || !isPendingReview ? 0.5 : 1,
                    }}
                  >
                    {i18n('ai_helper_admin_jailbreak_mark_false_positive')}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {logPagination.totalPages > 1 && (
          <div style={{
            marginTop: '20px', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '10px',
          }}>
            <button
              onClick={() => onChangePage(logPagination.page - 1)}
              disabled={logPagination.page <= 1 || loading}
              style={{
                ...getButtonStyle('secondary'),
                opacity: logPagination.page <= 1 ? 0.5 : 1,
                cursor: logPagination.page <= 1 ? 'not-allowed' : 'pointer',
              }}
            >
              {i18n('ai_helper_admin_jailbreak_prev_page')}
            </button>
            <span style={{ fontSize: '14px', color: COLORS.textSecondary }}>
              {i18n('ai_helper_admin_jailbreak_page_info', logPagination.page, logPagination.totalPages)}
            </span>
            <button
              onClick={() => onChangePage(logPagination.page + 1)}
              disabled={logPagination.page >= logPagination.totalPages || loading}
              style={{
                ...getButtonStyle('secondary'),
                opacity: logPagination.page >= logPagination.totalPages ? 0.5 : 1,
                cursor: logPagination.page >= logPagination.totalPages ? 'not-allowed' : 'pointer',
              }}
            >
              {i18n('ai_helper_admin_jailbreak_next_page')}
            </button>
          </div>
        )}
      </>
    )}
  </div>
  );
};
