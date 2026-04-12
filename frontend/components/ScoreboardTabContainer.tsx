/**
 * ScoreboardTabContainer — unified tab layout for the HydroOJ scoreboard page.
 *
 * Separates three concerns into tabs:
 *   1. "成绩表" — native HydroOJ scoreboard (DOM visibility toggle)
 *   2. "教学分析" — AI teaching analysis (teacher only)
 *   3. "学习总结" — AI batch summaries (teacher: all students, student: own)
 *
 * Badge data is communicated via lightweight callbacks from child components,
 * avoiding double-fetch of API data.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { i18n } from '@hydrooj/ui-default';
import { COLORS, SPACING, RADIUS, SHADOWS } from '../utils/styles';
import { TeachingSummaryPanel } from '../teachingSummary/TeachingSummaryPanel';
import { BatchSummaryPanel } from '../batchSummary/BatchSummaryPanel';
import { StudentSummaryView } from '../batchSummary/StudentSummaryView';

// ─── i18n fallbacks ──────────────────────────────────────────────────────────

const I18N_FALLBACK: Record<string, string> = {
  ai_helper_scoreboard_tab_main: '成绩表',
  ai_helper_scoreboard_tab_teaching: '教学分析',
  ai_helper_scoreboard_tab_learning: '学习总结',
};

function t(key: string): string {
  const val = i18n(key);
  return val === key ? (I18N_FALLBACK[key] || val) : val;
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface ScoreboardTabContainerProps {
  domainId: string;
  contestId: string;
  isTeacher: boolean;
}

const TABS = {
  SCOREBOARD: 'SCOREBOARD',
  TEACHING: 'TEACHING',
  LEARNING: 'LEARNING',
} as const;

type TabType = typeof TABS[keyof typeof TABS];

// ─── Native scoreboard DOM helpers ───────────────────────────────────────────

/**
 * Selectors for native HydroOJ elements that should be hidden when a non-scoreboard
 * tab is active. These include the score table, section headers, and export buttons.
 */
const NATIVE_SELECTORS = [
  '[data-fragment-id="scoreboard"]',
  '.section__header',
];

function setNativeVisibility(visible: boolean) {
  const display = visible ? '' : 'none';
  for (const selector of NATIVE_SELECTORS) {
    const els = document.querySelectorAll(selector);
    els.forEach((el) => {
      if (el instanceof HTMLElement) el.style.display = display;
    });
  }
  // Export buttons row: typically a direct sibling after .section__header
  // containing the "导出为 HTML / CSV / Ghost" buttons and user filter dropdown
  const header = document.querySelector('.section__header');
  if (header) {
    let sibling = header.nextElementSibling;
    // Walk siblings until we hit our container or the scoreboard fragment
    while (sibling && sibling.id !== 'ai-scoreboard-tab-root' && !sibling.hasAttribute('data-fragment-id')) {
      if (sibling instanceof HTMLElement) sibling.style.display = display;
      sibling = sibling.nextElementSibling;
    }
  }
}

function restoreNativeVisibility() {
  setNativeVisibility(true);
}

// ─── Tab item style ──────────────────────────────────────────────────────────

function getTabItemStyle(isActive: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: `10px ${SPACING.base}`,
    fontSize: '14px',
    fontWeight: isActive ? 600 : 400,
    color: isActive ? COLORS.primary : COLORS.textSecondary,
    backgroundColor: isActive ? COLORS.bgCard : 'transparent',
    border: 'none',
    borderBottom: isActive ? `2px solid ${COLORS.primary}` : '2px solid transparent',
    cursor: 'pointer',
    outline: 'none',
    whiteSpace: 'nowrap',
    transition: 'all 200ms ease',
    lineHeight: 1.5,
  };
}

// ─── Component ───────────────────────────────────────────────────────────────

export const ScoreboardTabContainer: React.FC<ScoreboardTabContainerProps> = ({
  domainId,
  contestId,
  isTeacher,
}) => {
  const [activeTab, setActiveTab] = useState<TabType>(TABS.SCOREBOARD);

  // Badge data from child callbacks
  const [teachingBadge, setTeachingBadge] = useState<string | undefined>(undefined);
  const [learningBadge, setLearningBadge] = useState<string | undefined>(undefined);

  // Track whether each tab has been activated at least once (lazy mount)
  const [mountedTabs, setMountedTabs] = useState<Set<TabType>>(new Set([TABS.SCOREBOARD]));

  // ── DOM visibility management ─────────────────────────────────────────────

  useEffect(() => {
    setNativeVisibility(activeTab === TABS.SCOREBOARD);
    return restoreNativeVisibility;
  }, [activeTab]);

  // PJAX support: re-apply visibility after HydroOJ fragment replacement
  useEffect(() => {
    const reapply = () => {
      setTimeout(() => setNativeVisibility(activeTab === TABS.SCOREBOARD), 60);
    };
    document.addEventListener('vjContentNew', reapply);
    if ((window as any).$) (window as any).$(document).on('vjContentNew', reapply);
    return () => {
      document.removeEventListener('vjContentNew', reapply);
      if ((window as any).$) (window as any).$(document).off('vjContentNew', reapply);
    };
  }, [activeTab]);

  // ── Tab switching ─────────────────────────────────────────────────────────

  const switchTab = useCallback((tab: TabType) => {
    setActiveTab(tab);
    setMountedTabs(prev => {
      if (prev.has(tab)) return prev;
      const next = new Set(prev);
      next.add(tab);
      return next;
    });
  }, []);

  // ── Badge callbacks (invoked by child panels) ─────────────────────────────

  const handleTeachingStats = useCallback((findingsCount: number) => {
    setTeachingBadge(findingsCount > 0 ? String(findingsCount) : undefined);
  }, []);

  const handleLearningProgress = useCallback((completed: number, total: number) => {
    if (total > 0) {
      setLearningBadge(`${completed}/${total}`);
    }
  }, []);

  // ── Tab list ──────────────────────────────────────────────────────────────

  const tabsList = useMemo(() => {
    const list: Array<{ id: TabType; label: string; badge?: string }> = [
      { id: TABS.SCOREBOARD, label: t('ai_helper_scoreboard_tab_main') },
    ];

    if (isTeacher) {
      list.push({
        id: TABS.TEACHING,
        label: t('ai_helper_scoreboard_tab_teaching'),
        badge: teachingBadge,
      });
    }

    list.push({
      id: TABS.LEARNING,
      label: t('ai_helper_scoreboard_tab_learning'),
      badge: isTeacher ? learningBadge : undefined,
    });

    return list;
  }, [isTeacher, teachingBadge, learningBadge]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={{ margin: `${SPACING.base} 0`, fontFamily: 'inherit' }}>
      {/* Tab bar */}
      <div style={{
        display: 'flex',
        alignItems: 'stretch',
        borderBottom: `1px solid ${COLORS.border}`,
        marginBottom: SPACING.base,
        backgroundColor: COLORS.bgPage,
        borderRadius: `${RADIUS.md} ${RADIUS.md} 0 0`,
        padding: `0 ${SPACING.sm}`,
        overflowX: 'auto',
      }}>
        {tabsList.map(tab => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => switchTab(tab.id)}
              style={getTabItemStyle(isActive)}
            >
              {tab.label}
              {tab.badge && (
                <span style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  backgroundColor: isActive ? COLORS.primary : COLORS.textMuted,
                  color: '#ffffff',
                  padding: '1px 7px',
                  borderRadius: RADIUS.full,
                  minWidth: '18px',
                  textAlign: 'center',
                  lineHeight: '16px',
                }}>
                  {tab.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Tab content panels — lazy-mounted, hidden via display:none to preserve state */}
      <div style={{ padding: `0 ${SPACING.base}` }}>
        {/* Teaching Analysis tab (teacher only) */}
        {isTeacher && mountedTabs.has(TABS.TEACHING) && (
          <div style={{ display: activeTab === TABS.TEACHING ? 'block' : 'none' }}>
            <TeachingSummaryPanel
              domainId={domainId}
              contestId={contestId}
              onStatsUpdate={handleTeachingStats}
            />
          </div>
        )}

        {/* Learning Summaries tab */}
        {mountedTabs.has(TABS.LEARNING) && (
          <div style={{ display: activeTab === TABS.LEARNING ? 'block' : 'none' }}>
            {isTeacher ? (
              <BatchSummaryPanel
                domainId={domainId}
                contestId={contestId}
                isTeacher={true}
                onProgressUpdate={handleLearningProgress}
              />
            ) : (
              <StudentSummaryView domainId={domainId} contestId={contestId} />
            )}
          </div>
        )}

        {/* Scoreboard tab — no React content; native DOM is toggled via visibility */}
      </div>
    </div>
  );
};

export default ScoreboardTabContainer;
