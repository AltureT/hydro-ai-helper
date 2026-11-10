/**
 * 负责老师视图（US8，FR-058）：只读查看自己负责小组在本域的 AI 对话与近 7 天统计。
 * 所有过滤都在服务端完成；本页面只发 GET 请求。
 */

import React, { useCallback, useEffect, useState } from 'react';
import { i18n } from '../utils/i18n';
import { buildApiUrl } from '../utils/domainUtils';
import { formatDateTime } from '../utils/formatDate';
import {
  COLORS, FONT_FAMILY, SPACING,
  cardStyle, emptyStateStyle, getAlertStyle, getBadgeStyle, getPaginationButtonStyle, getTabStyle,
  getTableCellStyle, getTableHeaderStyle, getTableRowStyle, linkStyle, tableRootStyle,
} from '../utils/styles';
import { ConversationDetailModal } from './ConversationDetailModal';
import {
  CLASS_API,
  accessErrorOf,
  pickInitialGroup,
  totalPages,
  turnsOf,
  violationBreakdown,
  type ClassAccessError,
  type ClassConversationsResponse,
  type ClassScopeResponse,
  type ClassStatsResponse,
} from './classTeacherLogic';

class RequestError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(buildApiUrl(path), { credentials: 'include', headers: { Accept: 'application/json' } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new RequestError(typeof json.error === 'string' ? json.error : i18n('ai_helper_class_err_load'), json.code);
  }
  return json as T;
}

const ACCESS_ERROR_KEYS: Record<ClassAccessError, string> = {
  disabled: 'ai_helper_class_err_disabled',
  not_teacher: 'ai_helper_class_err_not_teacher',
  group: 'ai_helper_class_err_group',
  other: 'ai_helper_class_err_load',
};

const QUESTION_TYPE_KEYS: Record<string, string> = {
  understand: 'ai_helper_teacher_qtype_understand',
  think: 'ai_helper_teacher_qtype_think',
  debug: 'ai_helper_teacher_qtype_debug',
};

const categoryLabel = (category: string) => i18n(`ai_helper_admin_jailbreak_category_${category}`);

const StatCard: React.FC<{ label: string; value: string; note?: string }> = ({ label, value, note }) => (
  <section style={{ ...cardStyle, display: 'flex', flexDirection: 'column', gap: SPACING.xs, padding: `${SPACING.base} ${SPACING.lg}` }}>
    <span style={{ fontSize: '13px', color: COLORS.textSecondary }}>{label}</span>
    <span style={{ fontSize: '26px', fontWeight: 800, color: COLORS.textPrimary, lineHeight: 1.2 }}>{value}</span>
    {note && <span style={{ fontSize: '12px', color: COLORS.textSecondary }}>{note}</span>}
  </section>
);

export const ClassTeacherPage: React.FC = () => {
  const [scope, setScope] = useState<ClassScopeResponse | null>(null);
  const [scopeError, setScopeError] = useState<{ kind: ClassAccessError; message: string } | null>(null);
  const [group, setGroup] = useState('');
  const [stats, setStats] = useState<ClassStatsResponse | null>(null);
  const [list, setList] = useState<ClassConversationsResponse | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    getJson<ClassScopeResponse>(CLASS_API.scope)
      .then((data) => {
        setScope(data);
        setGroup(pickInitialGroup(data.groups, window.location.search));
      })
      .catch((err: RequestError) => {
        const kind = accessErrorOf(err.code);
        setScopeError({ kind, message: kind === 'other' ? err.message : i18n(ACCESS_ERROR_KEYS[kind]) });
      });
  }, []);

  const load = useCallback(async (targetGroup: string, targetPage: number) => {
    if (!targetGroup) return;
    setLoading(true);
    setError(null);
    const query = `group=${encodeURIComponent(targetGroup)}`;
    try {
      const [statsData, listData] = await Promise.all([
        getJson<ClassStatsResponse>(`${CLASS_API.analytics}?${query}`),
        getJson<ClassConversationsResponse>(`${CLASS_API.conversations}?${query}&page=${targetPage}`),
      ]);
      setStats(statsData);
      setList(listData);
    } catch (err) {
      setError(err instanceof Error ? err.message : i18n('ai_helper_class_err_load'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(group, page); }, [group, page, load]);

  const selectGroup = (name: string) => {
    if (name === group) return;
    setStats(null);
    setList(null);
    setPage(1);
    setGroup(name);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('group', name);
      window.history.replaceState(null, '', url.toString());
    } catch {
      // 地址栏同步失败不影响使用
    }
  };

  const shell = (children: React.ReactNode) => (
    <div style={{ fontFamily: FONT_FAMILY, padding: `${SPACING.lg} 0 ${SPACING.xl}`, display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {children}
    </div>
  );

  if (scopeError) {
    return shell(
      <section style={cardStyle}>
        <h1 style={{ margin: 0, fontSize: '22px', fontWeight: 700, color: COLORS.textPrimary }}>{i18n('ai_helper_class_title')}</h1>
        <div style={{ ...getAlertStyle(scopeError.kind === 'other' ? 'error' : 'warning'), marginTop: SPACING.base }}>{scopeError.message}</div>
      </section>,
    );
  }
  if (!scope) {
    return shell(<div style={{ ...cardStyle, color: COLORS.textSecondary }}>{i18n('ai_helper_class_loading')}</div>);
  }

  const breakdown = stats ? violationBreakdown(stats.violations.byCategory) : [];
  const pages = list ? totalPages(list.total, list.limit) : 1;

  return shell(
    <>
      <section style={{ ...cardStyle, padding: `${SPACING.lg} 28px`, display: 'flex', flexWrap: 'wrap', gap: SPACING.md, alignItems: 'center' }}>
        <div style={{ minWidth: 0 }}>
          <h1 style={{ margin: 0, fontSize: '26px', fontWeight: 800, color: COLORS.textPrimary }}>{i18n('ai_helper_class_title')}</h1>
          <p style={{ margin: `6px 0 0`, color: COLORS.textSecondary, fontSize: '15px' }}>
            {i18n('ai_helper_class_subtitle', scope.domainName)}
          </p>
        </div>
        <span style={{ ...getBadgeStyle('info'), marginLeft: 'auto' }}>
          {scope.systemAdmin ? i18n('ai_helper_class_badge_admin') : i18n('ai_helper_class_badge_teacher')}
        </span>
      </section>

      {scope.groups.length === 0 ? (
        <div style={{ ...cardStyle, ...emptyStateStyle }}>{i18n('ai_helper_class_no_groups')}</div>
      ) : (
        <>
          <div role="tablist" aria-label={i18n('ai_helper_class_tabs_label')} style={{ display: 'flex', gap: '4px', borderBottom: `1px solid ${COLORS.border}`, overflowX: 'auto' }}>
            {scope.groups.map((item) => (
              <button
                key={item.name}
                type="button"
                role="tab"
                aria-selected={item.name === group}
                onClick={() => selectGroup(item.name)}
                style={{ ...getTabStyle(item.name === group), whiteSpace: 'nowrap', fontSize: '15px' }}
              >
                {i18n('ai_helper_class_tab', item.name, item.memberCount)}
                {item.archived && <span style={{ color: COLORS.textMuted, marginLeft: '4px', fontSize: '12px' }}>{i18n('ai_helper_um_status_archived')}</span>}
              </button>
            ))}
          </div>

          {error && <div style={getAlertStyle('error')}>{error}</div>}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: SPACING.base }}>
            <StatCard label={i18n('ai_helper_class_stat_conversations', stats?.days ?? 7)} value={stats ? String(stats.conversations) : '—'} />
            <StatCard
              label={i18n('ai_helper_class_stat_students', stats?.days ?? 7)}
              value={stats ? `${stats.activeStudents} / ${stats.memberCount}` : '—'}
            />
            <StatCard label={i18n('ai_helper_class_stat_turns')} value={stats?.avgTurns != null ? String(stats.avgTurns) : '—'} />
            <StatCard
              label={i18n('ai_helper_class_stat_violations', stats?.days ?? 7)}
              value={stats ? String(stats.violations.total) : '—'}
              note={breakdown.length ? breakdown.map((item) => `${categoryLabel(item.category)} ${item.count}`).join(' · ') : undefined}
            />
          </div>
          {stats?.truncated && <div style={getAlertStyle('warning')}>{i18n('ai_helper_class_stats_truncated')}</div>}

          <section style={{ ...cardStyle, padding: 0, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: SPACING.md, padding: '18px 22px 12px' }}>
              <h2 style={{ margin: 0, fontSize: '18px', color: COLORS.textPrimary }}>{i18n('ai_helper_class_recent')}</h2>
              <span style={{ fontSize: '13px', color: COLORS.textSecondary }}>{i18n('ai_helper_class_recent_hint')}</span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ ...tableRootStyle, minWidth: '720px' }}>
                <thead>
                  <tr>
                    <th style={{ ...getTableHeaderStyle(), whiteSpace: 'nowrap' }}>{i18n('ai_helper_class_col_time')}</th>
                    <th style={{ ...getTableHeaderStyle(), whiteSpace: 'nowrap' }}>{i18n('ai_helper_teacher_conv_col_student')}</th>
                    <th style={{ ...getTableHeaderStyle(), whiteSpace: 'nowrap' }}>{i18n('ai_helper_teacher_conv_col_problem')}</th>
                    <th style={{ ...getTableHeaderStyle(), whiteSpace: 'nowrap' }}>{i18n('ai_helper_class_col_type')}</th>
                    <th style={{ ...getTableHeaderStyle(), whiteSpace: 'nowrap' }}>{i18n('ai_helper_class_col_turns')}</th>
                    <th style={{ ...getTableHeaderStyle(), whiteSpace: 'nowrap' }}>{i18n('ai_helper_class_col_flags')}</th>
                    <th style={{ ...getTableHeaderStyle(), textAlign: 'right', whiteSpace: 'nowrap' }}>{i18n('ai_helper_teacher_analytics_actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(list?.conversations || []).map((row, index) => (
                    <tr key={row._id} style={getTableRowStyle(false, index % 2 === 1)}>
                      <td style={{ ...getTableCellStyle(), color: COLORS.textSecondary, whiteSpace: 'nowrap' }}>{formatDateTime(row.startTime)}</td>
                      <td style={{ ...getTableCellStyle(), fontWeight: 500, whiteSpace: 'nowrap' }}>{row.userName}</td>
                      <td style={getTableCellStyle()}>
                        {row.problemUrl
                          ? <a href={row.problemUrl} style={linkStyle}>{row.metadata?.problemTitle || row.problemId}</a>
                          : (row.metadata?.problemTitle || row.problemId)}
                      </td>
                      <td style={{ ...getTableCellStyle(), whiteSpace: 'nowrap' }}>
                        {row.questionType && QUESTION_TYPE_KEYS[row.questionType] ? i18n(QUESTION_TYPE_KEYS[row.questionType]) : '—'}
                      </td>
                      <td style={getTableCellStyle()}>{turnsOf(row)}</td>
                      <td style={{ ...getTableCellStyle(), whiteSpace: 'nowrap' }}>
                        {row.flags.count > 0 && (
                          <span style={getBadgeStyle('warning')} title={row.flags.categories.map(categoryLabel).join('、')}>
                            {categoryLabel(row.flags.categories[0])}
                            {row.flags.count > 1 ? ` ×${row.flags.count}` : ''}
                          </span>
                        )}
                      </td>
                      <td style={{ ...getTableCellStyle(), textAlign: 'right' }}>
                        <button
                          type="button"
                          onClick={() => setOpenId(row._id)}
                          style={{ ...linkStyle, background: 'none', border: 'none', padding: 0, font: 'inherit', fontWeight: 500 }}
                        >
                          {i18n('ai_helper_class_view')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {list && list.conversations.length === 0 && !loading && (
              <div style={{ ...emptyStateStyle, padding: SPACING.xl }}>{i18n('ai_helper_class_empty')}</div>
            )}
            {loading && !list && (
              <div style={{ padding: SPACING.lg, color: COLORS.textSecondary }}>{i18n('ai_helper_class_loading')}</div>
            )}
            {list && pages > 1 && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: SPACING.sm, padding: `${SPACING.md} 22px` }}>
                <span style={{ fontSize: '13px', color: COLORS.textSecondary }}>{i18n('ai_helper_class_page', page, pages, list.total)}</span>
                <button type="button" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)} style={getPaginationButtonStyle(false, page <= 1 || loading)}>
                  {i18n('ai_helper_class_prev')}
                </button>
                <button type="button" disabled={page >= pages || loading} onClick={() => setPage(page + 1)} style={getPaginationButtonStyle(false, page >= pages || loading)}>
                  {i18n('ai_helper_class_next')}
                </button>
              </div>
            )}
          </section>
        </>
      )}

      <p style={{ margin: 0, fontSize: '13px', color: COLORS.textSecondary }}>{i18n('ai_helper_class_footer')}</p>

      <ConversationDetailModal
        isOpen={!!openId}
        onClose={() => setOpenId(null)}
        conversationId={openId}
        conversationIds={(list?.conversations || []).map((row) => row._id)}
        onNavigate={setOpenId}
        detailUrl={(id) => buildApiUrl(CLASS_API.detail(id))}
      />
    </>,
  );
};

export default ClassTeacherPage;
