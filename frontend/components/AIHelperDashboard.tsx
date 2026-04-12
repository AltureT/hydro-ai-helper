/**
 * AI 助手统一入口 Tab 容器组件
 * 整合对话记录、使用统计、配置三个子功能
 */

import React, { useState, useEffect } from 'react';
import { i18n } from '@hydrooj/ui-default';
import { AnalyticsPage } from '../teacher/AnalyticsPage';
import { ConversationList } from '../teacher/ConversationList';
import { ConfigPanel } from '../admin/ConfigPanel';
import { CostDashboard } from '../teacher/CostDashboard';
import { TeachingReviewPanel } from '../teachingSummary/TeachingReviewPanel';
import { COLORS, FONT_FAMILY, SHADOWS, RADIUS, SPACING, getTabStyle } from '../utils/styles';

type TabType = 'conversations' | 'analytics' | 'teaching_review' | 'cost' | 'config';

function getDomainId(): string {
  const domainMatch = window.location.pathname.match(/^\/d\/([^/]+)\//);
  if (domainMatch) return domainMatch[1];
  return (window as any).UiContext?.domainId || 'system';
}

export const AIHelperDashboard: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabType>('conversations');
  const domainId = getDomainId();

  useEffect(() => {
    const handlePopState = () => {
      const params = new URLSearchParams(window.location.search);
      const tab = params.get('tab') as TabType;
      if (tab === 'analytics' || tab === 'teaching_review' || tab === 'cost' || tab === 'config' || tab === 'conversations') {
        setActiveTab(tab);
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
    const url = new URL(window.location.href);
    url.searchParams.set('tab', tab);
    window.history.pushState({}, '', url.toString());
  };

  const tabs: { id: TabType; label: string }[] = [
    { id: 'conversations', label: i18n('ai_helper_dashboard_tab_conversations') },
    { id: 'analytics', label: i18n('ai_helper_dashboard_tab_analytics') },
    { id: 'teaching_review', label: i18n('ai_helper_dashboard_tab_teaching_review') || '教学总结回顾' },
    { id: 'cost', label: i18n('ai_helper_dashboard_tab_cost') },
    { id: 'config', label: i18n('ai_helper_dashboard_tab_config') },
  ];

  return (
    <div style={{
      padding: SPACING.xl,
      fontFamily: FONT_FAMILY,
      backgroundColor: COLORS.bgPage,
      minHeight: '100vh',
    }}>
      <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
        {/* Dashboard Header */}
        <div style={{
          marginBottom: SPACING.lg,
          padding: `${SPACING.lg} ${SPACING.xl}`,
          background: COLORS.bgCard,
          borderRadius: RADIUS.lg,
          border: `1px solid ${COLORS.border}`,
          boxShadow: SHADOWS.sm,
        }}>
          <h1 style={{ margin: 0, fontSize: '24px', fontWeight: 700, color: COLORS.textPrimary }}>
            {i18n('ai_helper')}
          </h1>
          <p style={{ margin: '8px 0 0', color: COLORS.textSecondary, fontSize: '14px' }}>
            {i18n('ai_helper_dashboard_subtitle')}
          </p>
        </div>

        {/* Tab Navigation Bar */}
        <div style={{
          marginBottom: SPACING.lg,
          display: 'flex',
          gap: SPACING.sm,
          borderBottom: `2px solid ${COLORS.border}`,
        }}>
          {tabs.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => handleTabChange(tab.id)}
                style={{
                  ...getTabStyle(isActive),
                  outline: 'none',
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
          borderRadius: RADIUS.lg,
          border: `1px solid ${COLORS.border}`,
          boxShadow: SHADOWS.sm,
          overflow: 'hidden',
        }}>
          {activeTab === 'conversations' && <ConversationList embedded />}
          {activeTab === 'analytics' && <AnalyticsPage embedded />}
          {activeTab === 'teaching_review' && <TeachingReviewPanel domainId={domainId} />}
          {activeTab === 'cost' && <CostDashboard embedded />}
          {activeTab === 'config' && <ConfigPanel embedded />}
        </div>
      </div>
    </div>
  );
};

export default AIHelperDashboard;
