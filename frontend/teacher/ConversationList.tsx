/**
 * 教师端对话列表组件
 * 显示所有学生的对话记录,支持筛选和分页
 */

import React, { useState, useEffect } from 'react';
import { ExportDialog } from './ExportDialog';
import { buildApiUrl, buildPageUrl } from '../utils/domainUtils';
import { formatDateTime } from '../utils/formatDate';
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
  tags: string[];
  teacherNote?: string;
  metadata?: {
    problemTitle?: string;
    problemContent?: string;
  };
  firstMessageSummary?: string;
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
export const ConversationList: React.FC<ConversationListProps> = ({ embedded = false }) => {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
        setError(`加载失败：${response.status}`);
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
      setError('加载失败：网络错误');
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
        <h1 style={{ margin: 0, ...TYPOGRAPHY.xl, color: COLORS.textPrimary }}>对话记录</h1>
        <p style={{ margin: `${SPACING.sm} 0 0`, color: COLORS.textMuted, fontSize: '14px' }}>查看和管理学生与 AI 助手的对话记录</p>
      </div>
      )}

      <form onSubmit={handleFilterSubmit} style={{
        ...cardStyle,
        marginBottom: SPACING.lg,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: SPACING.lg }}>
          <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600, color: COLORS.textPrimary }}>筛选条件</h3>
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
              导出数据
            </button>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: SPACING.lg }}>
          <div>
            <label style={labelStyle}>开始日期</label>
            <input
              type="date"
              value={filters.startDate}
              onChange={(e) => handleFilterChange('startDate', e.target.value)}
              style={getInputStyle()}
            />
          </div>
          <div>
            <label style={labelStyle}>结束日期</label>
            <input
              type="date"
              value={filters.endDate}
              onChange={(e) => handleFilterChange('endDate', e.target.value)}
              style={getInputStyle()}
            />
          </div>
          <div>
            <label style={labelStyle}>题目 ID</label>
            <input
              type="text"
              value={filters.problemId}
              onChange={(e) => handleFilterChange('problemId', e.target.value)}
              placeholder="如: P1000"
              style={getInputStyle()}
            />
          </div>
          <div>
            <label style={labelStyle}>班级 ID</label>
            <input
              type="text"
              value={filters.classId}
              onChange={(e) => handleFilterChange('classId', e.target.value)}
              placeholder="班级 ID"
              style={getInputStyle()}
            />
          </div>
          <div>
            <label style={labelStyle}>学生 ID</label>
            <input
              type="text"
              value={filters.userId}
              onChange={(e) => handleFilterChange('userId', e.target.value)}
              placeholder="学生用户 ID"
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
          搜索
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
          正在加载对话列表...
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
              <div style={{ fontSize: '15px' }}>暂无对话记录</div>
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
                共 <strong style={{ color: COLORS.textPrimary }}>{total}</strong> 条记录，当前第 <strong style={{ color: COLORS.textPrimary }}>{page}</strong> 页
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
                      <th style={getTableHeaderStyle()}>学生</th>
                      <th style={getTableHeaderStyle()}>班级</th>
                      <th style={getTableHeaderStyle()}>题目</th>
                      <th style={{ ...getTableHeaderStyle(), minWidth: '200px' }}>问题摘要</th>
                      <th style={getTableHeaderStyle()}>开始时间</th>
                      <th style={{ ...getTableHeaderStyle(), textAlign: 'center' }}>消息数</th>
                      <th style={{ ...getTableHeaderStyle(), textAlign: 'center' }}>有效</th>
                      <th style={{ ...getTableHeaderStyle(), textAlign: 'center' }}>操作</th>
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
                              title={`查看题目 ${conv.problemId}`}
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
                          <span style={getBadgeStyle(conv.isEffective ? 'success' : 'error')}>
                            {conv.isEffective ? '有效' : '无效'}
                          </span>
                        </td>
                        <td style={{ ...getTableCellStyle(), textAlign: 'center' }}>
                          <a
                            href={buildPageUrl(`/ai-helper/conversations/${conv._id}`)}
                            style={{
                              ...linkStyle,
                              fontWeight: 500,
                              padding: `${SPACING.xs} ${SPACING.md}`,
                              borderRadius: RADIUS.sm,
                              backgroundColor: COLORS.primaryLight,
                              display: 'inline-block'
                            }}
                          >
                            查看详情
                          </a>
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
                上一页
              </button>
              <span style={getPaginationButtonStyle(true, false)}>
                第 {page} 页
              </span>
              <button
                onClick={() => setPage(p => p + 1)}
                disabled={nextDisabled}
                style={getPaginationButtonStyle(false, nextDisabled)}
              >
                下一页
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
    </div>
  );
};

export default ConversationList;
