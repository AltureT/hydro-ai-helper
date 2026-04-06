/**
 * 教师端对话列表组件
 * 显示所有学生的对话记录,支持筛选和分页
 */

import React, { useState, useEffect } from 'react';
import { i18n } from '@hydrooj/ui-default';
import { ExportDialog } from './ExportDialog';
import { ConversationDetailModal } from './ConversationDetailModal';
import { buildApiUrl } from '../utils/domainUtils';
import { formatDateTime } from '../utils/formatDate';
import type { ConversationMetricsDTO, MetricsStatus } from './analyticsTypes';
import {
  COLORS,
  SPACING,
  RADIUS,
  SHADOWS,
  TRANSITIONS,
  FONT_FAMILY,
  TYPOGRAPHY,
  getInputStyle,
  getButtonStyle,
  getTableHeaderStyle,
  getTableCellStyle,
  getTableRowStyle,
  tableRootStyle,
  getPaginationButtonStyle,
  cardStyle,
  getBadgeStyle,
  linkStyle,
  emptyStateStyle,
  getAlertStyle,
} from '../utils/styles';

/**
 * 对话摘要接口
 */
interface ConversationSummary {
  _id: string;
  userId: number;
  userName?: string;
  classId?: string;
  problemId: string;
  problemUrl?: string;
  startTime: string;
  endTime: string;
  messageCount: number;
  isEffective: boolean;
  metrics?: ConversationMetricsDTO;
  metricsStatus?: MetricsStatus;
  tags: string[];
  teacherNote?: string;
  metadata?: {
    problemTitle?: string;
    problemContent?: string;
  };
  firstMessageSummary?: string;
  questionType?: string;
}

const signalPillStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: SPACING.xs,
  padding: `2px ${SPACING.sm}`,
  borderRadius: RADIUS.sm,
  fontSize: '12px',
  fontWeight: 500,
  lineHeight: '18px',
  whiteSpace: 'nowrap',
};

const MSG_ENGAGEMENT_HIGH = 6;
const MSG_ENGAGEMENT_MEDIUM = 3;

function SignalPillGroup({ conv }: { conv: ConversationSummary }) {
  const status = conv.metricsStatus || 'legacy';
  const m = conv.metrics;

  if (status === 'legacy' || !m) {
    return (
      <span style={getBadgeStyle(conv.isEffective ? 'success' : 'error')}>
        {conv.isEffective ? i18n('ai_helper_teacher_effective') : i18n('ai_helper_teacher_ineffective')}
      </span>
    );
  }

  const msgColor = m.studentMessageCount >= MSG_ENGAGEMENT_HIGH ? COLORS.primary
    : m.studentMessageCount >= MSG_ENGAGEMENT_MEDIUM ? COLORS.info
    : COLORS.textMuted;

  return (
    <span style={{ display: 'inline-flex', gap: SPACING.xs, flexWrap: 'wrap', justifyContent: 'center' }}>
      <span style={{ ...signalPillStyle, backgroundColor: `${msgColor}14`, color: msgColor }}>
        {'\u{1F4AC}'} {m.studentMessageCount}
      </span>
      {status === 'pending' ? (
        <span style={{ ...signalPillStyle, backgroundColor: COLORS.bgHover, color: COLORS.textMuted }}
          title={i18n('ai_helper_teacher_signal_pending')}>
          {'\u23F3'}
        </span>
      ) : m.submissionsAfter === null ? (
        <span style={{ ...signalPillStyle, backgroundColor: COLORS.bgHover, color: COLORS.textMuted }}
          title={i18n('ai_helper_teacher_signal_no_problem')}>
          —
        </span>
      ) : (
        <>
          <span style={{ ...signalPillStyle, backgroundColor: m.submissionsAfter > 0 ? `${COLORS.info}14` : COLORS.bgHover, color: m.submissionsAfter > 0 ? COLORS.info : COLORS.textMuted }}>
            {'\u{1F4DD}'} {m.submissionsAfter}
          </span>
          {m.firstAcceptedIndex !== null ? (
            <span style={{ ...signalPillStyle, backgroundColor: `${COLORS.success}14`, color: COLORS.success }}>
              {'\u2705'} AC(#{m.firstAcceptedIndex + 1})
            </span>
          ) : m.submissionsAfter > 0 ? (
            <span style={{ ...signalPillStyle, backgroundColor: `${COLORS.error}14`, color: COLORS.error }}>
              {'\u274C'}
            </span>
          ) : null}
        </>
      )}
    </span>
  );
}

/**
 * 对话列表响应接口
 */
interface ConversationListResponse {
  conversations: ConversationSummary[];
  total: number;
  page: number;
  limit: number;
}

/**
 * 从 URL query 中解析初始筛选条件
 */
function getInitialFiltersFromUrl(): { userId: string; classId: string; problemId: string } {
  if (typeof window === 'undefined') {
    return { userId: '', classId: '', problemId: '' };
  }
  const params = new URLSearchParams(window.location.search);
  return {
    userId: params.get('userId') || '',
    classId: params.get('classId') || '',
    problemId: params.get('problemId') || '',
  };
}

/**
 * ConversationList 组件 Props
 */
interface ConversationListProps {
  embedded?: boolean;
}

/**
 * ConversationList 组件
 */
const questionTypeBadgeMap: Record<string, { bg: string; color: string; labelKey: string }> = {
  understand: { bg: '#dbeafe', color: '#1e40af', labelKey: 'ai_helper_teacher_qtype_understand' },
  think: { bg: '#f3e8ff', color: '#6b21a8', labelKey: 'ai_helper_teacher_qtype_think' },
  debug: { bg: '#fee2e2', color: '#991b1b', labelKey: 'ai_helper_teacher_qtype_debug' },
};

export const ConversationList: React.FC<ConversationListProps> = ({ embedded = false }) => {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detailModalOpen, setDetailModalOpen] = useState(false);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);

  const initialFilters = getInitialFiltersFromUrl();
  const [filters, setFilters] = useState({
    startDate: '',
    endDate: '',
    problemId: initialFilters.problemId,
    classId: initialFilters.classId,
    userId: initialFilters.userId
  });

  const [exportDialogOpen, setExportDialogOpen] = useState(false);

  const loadConversations = async (targetPage?: number) => {
    setLoading(true);
    setError(null);

    const effectivePage = targetPage ?? page;
    try {
      const params = new URLSearchParams({
        page: effectivePage.toString(),
        limit: limit.toString()
      });

      if (filters.startDate) params.append('startDate', filters.startDate);
      if (filters.endDate) params.append('endDate', filters.endDate);
      if (filters.problemId) params.append('problemId', filters.problemId);
      if (filters.classId) params.append('classId', filters.classId);
      if (filters.userId) params.append('userId', filters.userId);

      const response = await fetch(buildApiUrl(`/ai-helper/conversations?${params.toString()}`), {
        headers: {
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        const text = await response.text();
        console.error('[AI Helper] failed to load conversations', response.status, text);
        setConversations([]);
        setTotal(0);
        setError(`${i18n('ai_helper_teacher_load_failed')}${response.status}`);
        return;
      }

      const data: ConversationListResponse = await response.json();

      console.debug('[AI Helper] conversations loaded', data);
      setConversations(data.conversations || []);
      setTotal(data.total ?? 0);
    } catch (err) {
      console.error('[AI Helper] error while loading conversations', err);
      setConversations([]);
      setTotal(0);
      setError(i18n('ai_helper_teacher_load_failed_network'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadConversations();
  }, [page]);

  const handleFilterSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (page !== 1) {
      setPage(1);
    } else {
      loadConversations(1);
    }
  };

  const handleFilterChange = (field: string, value: string) => {
    setFilters(prev => ({ ...prev, [field]: value }));
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    marginBottom: SPACING.sm,
    fontWeight: 500,
    fontSize: '14px',
    color: COLORS.textSecondary
  };

  const prevDisabled = page === 1;
  const nextDisabled = page * limit >= total;

  return (
    <div style={{
      padding: embedded ? SPACING.lg : SPACING.xl,
      fontFamily: FONT_FAMILY,
      backgroundColor: embedded ? 'transparent' : COLORS.bgPage,
      minHeight: embedded ? 'auto' : '100vh'
    }}>
      {!embedded && (
      <div style={{
        ...cardStyle,
        marginBottom: SPACING.xl,
        padding: `${SPACING.lg} ${SPACING.xl}`,
      }}>
        <h1 style={{ margin: 0, ...TYPOGRAPHY.xl, color: COLORS.textPrimary }}>{i18n('ai_helper_teacher_conv_title')}</h1>
        <p style={{ margin: `${SPACING.sm} 0 0`, color: COLORS.textMuted, fontSize: '14px' }}>{i18n('ai_helper_teacher_conv_subtitle')}</p>
      </div>
      )}

      <form onSubmit={handleFilterSubmit} style={{
        ...cardStyle,
        marginBottom: SPACING.lg,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: SPACING.lg }}>
          <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600, color: COLORS.textPrimary }}>{i18n('ai_helper_teacher_filter_title')}</h3>
          <div style={{ display: 'flex', gap: SPACING.md }}>
            <button
              type="button"
              onClick={() => setExportDialogOpen(true)}
              style={{
                ...getButtonStyle('primary'),
                backgroundColor: COLORS.success,
                boxShadow: SHADOWS.sm,
              }}
            >
              {i18n('ai_helper_teacher_export_data')}
            </button>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: SPACING.lg }}>
          <div>
            <label style={labelStyle}>{i18n('ai_helper_teacher_filter_start_date')}</label>
            <input
              type="date"
              value={filters.startDate}
              onChange={(e) => handleFilterChange('startDate', e.target.value)}
              style={getInputStyle()}
            />
          </div>
          <div>
            <label style={labelStyle}>{i18n('ai_helper_teacher_filter_end_date')}</label>
            <input
              type="date"
              value={filters.endDate}
              onChange={(e) => handleFilterChange('endDate', e.target.value)}
              style={getInputStyle()}
            />
          </div>
          <div>
            <label style={labelStyle}>{i18n('ai_helper_teacher_filter_problem_id')}</label>
            <input
              type="text"
              value={filters.problemId}
              onChange={(e) => handleFilterChange('problemId', e.target.value)}
              placeholder={i18n('ai_helper_teacher_filter_problem_id_placeholder')}
              style={getInputStyle()}
            />
          </div>
          <div>
            <label style={labelStyle}>{i18n('ai_helper_teacher_filter_class_id')}</label>
            <input
              type="text"
              value={filters.classId}
              onChange={(e) => handleFilterChange('classId', e.target.value)}
              placeholder={i18n('ai_helper_teacher_filter_class_id')}
              style={getInputStyle()}
            />
          </div>
          <div>
            <label style={labelStyle}>{i18n('ai_helper_teacher_filter_student_id')}</label>
            <input
              type="text"
              value={filters.userId}
              onChange={(e) => handleFilterChange('userId', e.target.value)}
              placeholder={i18n('ai_helper_teacher_filter_student_id')}
              style={getInputStyle()}
            />
          </div>
        </div>
        <button
          type="submit"
          style={{
            ...getButtonStyle('primary'),
            marginTop: SPACING.lg,
            padding: `${SPACING.md} 28px`,
            fontSize: '15px',
            fontWeight: 600,
          }}
        >
          {i18n('ai_helper_teacher_search')}
        </button>
      </form>

      {loading && (
        <div style={{
          ...cardStyle,
          padding: '40px',
          textAlign: 'center',
          color: COLORS.textMuted,
        }}>
          <div style={{ fontSize: '24px', marginBottom: SPACING.md }}>...</div>
          {i18n('ai_helper_teacher_conv_loading')}
        </div>
      )}

      {error && (
        <div style={{
          ...getAlertStyle('error'),
          marginBottom: SPACING.lg,
        }}>
          {error}
        </div>
      )}

      {!loading && !error && (
        <>
          {conversations.length === 0 ? (
            <div style={emptyStateStyle}>
              <div style={{ fontSize: '48px', marginBottom: SPACING.base }}>--</div>
              <div style={{ fontSize: '15px' }}>{i18n('ai_helper_teacher_conv_empty')}</div>
            </div>
          ) : (
            <>
              <div style={{
                marginBottom: SPACING.base,
                padding: `${SPACING.md} ${SPACING.base}`,
                backgroundColor: COLORS.bgCard,
                borderRadius: RADIUS.md,
                border: `1px solid ${COLORS.border}`,
                fontSize: '14px',
                color: COLORS.textSecondary
              }}>
                {i18n('ai_helper_teacher_conv_total_prefix')} <strong style={{ color: COLORS.textPrimary }}>{total}</strong> {i18n('ai_helper_teacher_conv_total_records')}{i18n('ai_helper_teacher_conv_current_page_prefix')} <strong style={{ color: COLORS.textPrimary }}>{page}</strong> {i18n('ai_helper_teacher_conv_current_page_suffix')}
              </div>
              <div style={{
                backgroundColor: COLORS.bgCard,
                borderRadius: RADIUS.lg,
                boxShadow: SHADOWS.sm,
                border: `1px solid ${COLORS.border}`,
                overflow: 'hidden'
              }}>
                <div style={{ overflowX: 'auto' }}>
                <table style={tableRootStyle}>
                  <thead>
                    <tr>
                      <th style={getTableHeaderStyle()}>{i18n('ai_helper_teacher_conv_col_student')}</th>
                      <th style={getTableHeaderStyle()}>{i18n('ai_helper_teacher_conv_col_class')}</th>
                      <th style={getTableHeaderStyle()}>{i18n('ai_helper_teacher_conv_col_problem')}</th>
                      <th style={{ ...getTableHeaderStyle(), minWidth: '200px' }}>{i18n('ai_helper_teacher_conv_col_summary')}</th>
                      <th style={getTableHeaderStyle()}>{i18n('ai_helper_teacher_conv_col_start_time')}</th>
                      <th style={{ ...getTableHeaderStyle(), textAlign: 'center' }}>{i18n('ai_helper_teacher_conv_col_messages')}</th>
                      <th style={{ ...getTableHeaderStyle(), textAlign: 'center', minWidth: '140px' }} title={i18n('ai_helper_teacher_conv_col_effective_tooltip')}>{i18n('ai_helper_teacher_conv_col_effective')}</th>
                      <th style={{ ...getTableHeaderStyle(), textAlign: 'center' }}>{i18n('ai_helper_teacher_analytics_actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {conversations.map((conv, idx) => (
                      <tr key={conv._id} style={getTableRowStyle(false, idx % 2 === 1)}>
                        <td style={{ ...getTableCellStyle(), fontWeight: 500 }}>
                          {conv.userName ? `${conv.userName}` : `#${conv.userId}`}
                          {conv.userName && <span style={{ color: COLORS.textMuted, fontSize: '12px', marginLeft: SPACING.xs }}>({conv.userId})</span>}
                        </td>
                        <td style={{ ...getTableCellStyle(), color: COLORS.textSecondary }}>
                          {conv.classId || <span style={{ color: COLORS.textMuted }}>-</span>}
                        </td>
                        <td style={getTableCellStyle()}>
                          {conv.problemUrl ? (
                            <a
                              href={conv.problemUrl}
                              style={{ ...linkStyle, fontWeight: 500 }}
                              title={`${i18n('ai_helper_teacher_conv_view_problem')} ${conv.problemId}`}
                            >
                              {conv.metadata?.problemTitle || conv.problemId}
                            </a>
                          ) : (
                            <span style={{ color: COLORS.textMuted }}>
                              {conv.metadata?.problemTitle || conv.problemId || '-'}
                            </span>
                          )}
                        </td>
                        <td style={{
                          ...getTableCellStyle(),
                          fontSize: '13px',
                          color: COLORS.textSecondary,
                          maxWidth: '300px',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap'
                        }}
                          title={conv.firstMessageSummary || ''}
                        >
                          {conv.questionType && questionTypeBadgeMap[conv.questionType] && (
                            <span style={{
                              padding: '2px 8px',
                              borderRadius: '4px',
                              fontSize: '11px',
                              fontWeight: 600,
                              backgroundColor: questionTypeBadgeMap[conv.questionType].bg,
                              color: questionTypeBadgeMap[conv.questionType].color,
                              marginRight: '6px',
                            }}>
                              {i18n(questionTypeBadgeMap[conv.questionType].labelKey)}
                            </span>
                          )}
                          {conv.firstMessageSummary || <span style={{ color: COLORS.textDisabled }}>-</span>}
                        </td>
                        <td style={{ ...getTableCellStyle(), fontSize: '13px', color: COLORS.textSecondary }}>
                          {formatDateTime(conv.startTime)}
                        </td>
                        <td style={{ ...getTableCellStyle(), textAlign: 'center' }}>
                          <span style={{
                            display: 'inline-block',
                            minWidth: '28px',
                            padding: `${SPACING.xs} ${SPACING.sm}`,
                            backgroundColor: COLORS.bgHover,
                            borderRadius: RADIUS.sm,
                            fontWeight: 500
                          }}>
                            {conv.messageCount}
                          </span>
                        </td>
                        <td style={{ ...getTableCellStyle(), textAlign: 'center' }}>
                          <SignalPillGroup conv={conv} />
                        </td>
                        <td style={{ ...getTableCellStyle(), textAlign: 'center' }}>
                          <button
                            onClick={() => {
                              setSelectedConversationId(conv._id);
                              setDetailModalOpen(true);
                            }}
                            style={{
                              ...linkStyle,
                              padding: `${SPACING.xs} ${SPACING.md}`,
                              borderRadius: RADIUS.sm,
                              backgroundColor: COLORS.primaryLight,
                              border: 'none',
                              cursor: 'pointer',
                              fontWeight: 500,
                              fontSize: '13px',
                            }}
                          >
                            {i18n('ai_helper_teacher_view_detail')}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </div>
            </>
          )}

          {conversations.length > 0 && (
            <div style={{
              display: 'flex',
              gap: SPACING.md,
              alignItems: 'center',
              justifyContent: 'center',
              marginTop: SPACING.lg
            }}>
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={prevDisabled}
                style={getPaginationButtonStyle(false, prevDisabled)}
              >
                {i18n('ai_helper_teacher_prev_page')}
              </button>
              <span style={getPaginationButtonStyle(true, false)}>
                {i18n('ai_helper_teacher_page_prefix')} {page} {i18n('ai_helper_teacher_page_suffix')}
              </span>
              <button
                onClick={() => setPage(p => p + 1)}
                disabled={nextDisabled}
                style={getPaginationButtonStyle(false, nextDisabled)}
              >
                {i18n('ai_helper_teacher_next_page')}
              </button>
            </div>
          )}
        </>
      )}

      <ExportDialog
        isOpen={exportDialogOpen}
        onClose={() => setExportDialogOpen(false)}
        filters={{
          startDate: filters.startDate || undefined,
          endDate: filters.endDate || undefined,
          classId: filters.classId || undefined,
          problemId: filters.problemId || undefined,
          userId: filters.userId || undefined,
        }}
      />

      <ConversationDetailModal
        isOpen={detailModalOpen}
        onClose={() => setDetailModalOpen(false)}
        conversationId={selectedConversationId}
        conversationIds={conversations.map(c => c._id)}
        onNavigate={(id) => setSelectedConversationId(id)}
      />
    </div>
  );
};

export default ConversationList;
