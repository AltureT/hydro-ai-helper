import React from 'react';
import { i18n } from '../utils/i18n';
import {
  COLORS, SPACING, RADIUS, TYPOGRAPHY,
  cardStyle, getButtonStyle, getInputStyle,
} from '../utils/styles';
import type {
  JailbreakCategory,
  JailbreakLogEntry,
  JailbreakLogFilters,
  JailbreakLogPagination,
  JailbreakReviewStatus,
} from './configTypes';

interface JailbreakLogsViewerProps {
  logPagination: JailbreakLogPagination;
  loading: boolean;
  onChangePage: (page: number) => void;
  onCopyToClipboard: (text: string) => void;
  onAppendPattern: (pattern: string) => void;
  onReview: (id: string, reviewStatus: 'confirmed' | 'false_positive') => Promise<void>;
  onBulkReview: (ids: string[], reviewStatus: 'confirmed' | 'false_positive') => Promise<boolean>;
  filters: JailbreakLogFilters;
  onChangeFilters: (filters: JailbreakLogFilters) => void;
}

export const JailbreakLogsViewer: React.FC<JailbreakLogsViewerProps> = ({
  logPagination, loading, onChangePage, onCopyToClipboard, onAppendPattern, onReview, onBulkReview,
  filters, onChangeFilters,
}) => {
  const [collapsed, setCollapsed] = React.useState(true);
  const [reviewingId, setReviewingId] = React.useState<string | null>(null);
  const [selectedIds, setSelectedIds] = React.useState<string[]>([]);
  const [bulkReviewing, setBulkReviewing] = React.useState(false);

  React.useEffect(() => {
    const visibleIds = new Set(logPagination.logs.map((log) => log.id));
    setSelectedIds((current) => current.filter((id) => visibleIds.has(id)));
  }, [logPagination.logs]);

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

  const updateReviewStatusFilter = (value: string) => {
    onChangeFilters({
      ...filters,
      reviewStatus: value ? value as JailbreakReviewStatus : undefined,
    });
  };

  const updateCategoryFilter = (value: string) => {
    onChangeFilters({
      ...filters,
      category: value ? value as JailbreakCategory : undefined,
    });
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
    <div
      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', userSelect: 'none' }}
      onClick={() => setCollapsed(!collapsed)}
    >
      <h2 style={{ margin: 0, ...TYPOGRAPHY.md, color: COLORS.textPrimary }}>
        <span style={{ display: 'inline-block', transition: 'transform 0.2s', transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', marginRight: '8px' }}>▼</span>
        {i18n('ai_helper_admin_jailbreak_title')}
      </h2>
      {logPagination.total > 0 && (
        <span style={{ fontSize: '13px', color: COLORS.textMuted }}>
          {i18n('ai_helper_admin_jailbreak_total', logPagination.total)}
        </span>
      )}
    </div>

    {!collapsed && (
      <>
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
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: SPACING.md, margin: `${SPACING.base} 0` }}>
          <label style={{ minWidth: '180px', fontSize: '13px', color: COLORS.textSecondary }}>
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
          <label style={{ minWidth: '210px', fontSize: '13px', color: COLORS.textSecondary }}>
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
          <label style={{
            display: 'flex', alignItems: 'center', gap: SPACING.sm,
            fontSize: '13px', color: COLORS.textSecondary, alignSelf: 'flex-end', paddingBottom: '8px',
          }}>
            <input
              type="checkbox"
              checked={Boolean(filters.appealedOnly)}
              disabled={loading}
              onChange={(event) => onChangeFilters({
                ...filters,
                appealedOnly: event.target.checked || undefined,
              })}
            />
            {i18n('ai_helper_admin_jailbreak_filter_appealed')}
          </label>
        </div>
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
      </>
    )}

    {collapsed ? null : logPagination.logs.length === 0 ? (
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
            if (log.detectionSource) contextPieces.push(`${i18n('ai_helper_admin_jailbreak_detection_source')}${log.detectionSource}`);
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
