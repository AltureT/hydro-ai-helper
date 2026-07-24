/**
 * AI 助手统一入口 Tab 容器组件
 * 整合对话记录、使用统计、配置三个子功能
 */

import React, { useState, useEffect } from 'react';
import { i18n } from '../utils/i18n';
import { AnalyticsPage } from '../teacher/AnalyticsPage';
import { ConversationList } from '../teacher/ConversationList';
import { ConfigPanel } from '../admin/ConfigPanel';
import { SafetyGovernancePanel } from '../admin/SafetyGovernancePanel';
import { CostDashboard } from '../teacher/CostDashboard';
import { TeachingReviewPanel } from '../teachingSummary/TeachingReviewPanel';
import { COLORS, FONT_FAMILY, SPACING } from '../utils/styles';
import { getDomainFromUrl } from '../utils/domainUtils';

type TabType = 'conversations' | 'analytics' | 'teaching_review' | 'cost' | 'safety' | 'config';

const isTabType = (tab: string | null): tab is TabType => (
  tab === 'conversations'
  || tab === 'analytics'
  || tab === 'teaching_review'
  || tab === 'cost'
  || tab === 'safety'
  || tab === 'config'
);

export const AIHelperDashboard: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabType>('conversations');
  const [safetyVisited, setSafetyVisited] = useState(false);
  const domainId = getDomainFromUrl() || 'system';

  useEffect(() => {
    const handlePopState = () => {
      const params = new URLSearchParams(window.location.search);
      const tab = params.get('tab');
      if (isTabType(tab)) {
        setActiveTab(tab);
        if (tab === 'safety') setSafetyVisited(true);
      } else {
        setActiveTab('conversations');
      }
    };

    // Initialize from URL
    handlePopState();

    // Listen for back/forward navigation
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const handleTabChange = (tab: TabType) => {
    setActiveTab(tab);
    if (tab === 'safety') setSafetyVisited(true);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', tab);
    window.history.pushState({}, '', url.toString());
  };

  const tabs: { id: TabType; label: string }[] = [
    { id: 'conversations', label: i18n('ai_helper_dashboard_tab_conversations') },
    { id: 'analytics', label: i18n('ai_helper_dashboard_tab_analytics') },
    { id: 'teaching_review', label: i18n('ai_helper_dashboard_tab_teaching_review') || '教学总结回顾' },
    { id: 'cost', label: i18n('ai_helper_dashboard_tab_cost') },
    { id: 'safety', label: i18n('ai_helper_dashboard_tab_safety') },
    { id: 'config', label: i18n('ai_helper_dashboard_tab_config') },
  ];

  return (
    <div style={{
      padding: `${SPACING.lg} 0`,
      fontFamily: FONT_FAMILY,
      color: COLORS.nativeText,
    }}>
      <div style={{ width: '100%' }}>
        {/* Dashboard Header */}
        <div style={{
          padding: `0 0 ${SPACING.lg}`,
        }}>
          <h1 style={{ margin: 0, fontSize: '22px', fontWeight: 600, color: COLORS.nativeText }}>
            {i18n('ai_helper')}
          </h1>
          <p style={{ margin: '6px 0 0', color: COLORS.textSecondary, fontSize: '13px' }}>
            {i18n('ai_helper_dashboard_subtitle')}
          </p>
        </div>

        {/* Tab Navigation Bar */}
        <div role="tablist" style={{
          display: 'flex',
          gap: 0,
          borderBottom: `1px solid ${COLORS.nativeBorder}`,
          overflowX: 'auto',
          whiteSpace: 'nowrap',
          WebkitOverflowScrolling: 'touch',
        }}>
          {tabs.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => handleTabChange(tab.id)}
                style={{
                  padding: `10px ${SPACING.base}`,
                  color: isActive ? COLORS.hydroGreenDark : COLORS.textSecondary,
                  backgroundColor: 'transparent',
                  border: 'none',
                  borderBottom: isActive ? `2px solid ${COLORS.hydroGreen}` : '2px solid transparent',
                  fontSize: '14px',
                  fontWeight: isActive ? 600 : 400,
                  cursor: 'pointer',
                  outline: 'none',
                  flexShrink: 0,
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Tab Content Container */}
        <div style={{
          backgroundColor: COLORS.bgCard,
          border: `1px solid ${COLORS.nativeBorder}`,
          borderTop: 'none',
          overflow: 'hidden',
        }}>
          {activeTab === 'conversations' && <ConversationList embedded />}
          {activeTab === 'analytics' && <AnalyticsPage embedded />}
          {activeTab === 'teaching_review' && <TeachingReviewPanel domainId={domainId} />}
          {activeTab === 'cost' && <CostDashboard embedded />}
          {safetyVisited && (
            <div style={{ display: activeTab === 'safety' ? 'block' : 'none' }}>
              <SafetyGovernancePanel embedded />
            </div>
          )}
          {activeTab === 'config' && <ConfigPanel embedded />}
        </div>
      </div>
    </div>
  );
};

export default AIHelperDashboard;
