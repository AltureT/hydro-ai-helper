import { Icon, IconName } from './Icon';
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
import { COLORS, FONT_FAMILY, RADIUS, SPACING, getTabStyle } from '../utils/styles';
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

  const tabs: { id: TabType; label: string; icon: IconName }[] = [
    { id: 'conversations', icon: 'message', label: i18n('ai_helper_dashboard_tab_conversations') },
    { id: 'analytics', icon: 'chart', label: i18n('ai_helper_dashboard_tab_analytics') },
    { id: 'teaching_review', icon: 'document', label: i18n('ai_helper_dashboard_tab_teaching_review') || '教学总结回顾' },
    { id: 'cost', icon: 'wallet', label: i18n('ai_helper_dashboard_tab_cost') },
    { id: 'safety', icon: 'shield', label: i18n('ai_helper_dashboard_tab_safety') },
    { id: 'config', icon: 'settings', label: i18n('ai_helper_dashboard_tab_config') },
  ];

  return (
    <div className="ai-helper-dashboard" style={{
      padding: 'clamp(12px, 3vw, 28px)',
      fontFamily: FONT_FAMILY,
      backgroundColor: COLORS.bgPage,
      minHeight: '100vh',
    }}>
      <style>{`
        .ai-helper-dashboard button:focus-visible { outline: 2px solid #2563eb !important; outline-offset: -3px; }
        .ai-helper-dashboard [role="tab"] { display: inline-flex; align-items: center; gap: 7px; }
        @media (max-width: 600px) { .ai-helper-dashboard [role="tab"] .ai-icon { display: none; } }
      `}</style>
      <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
        {/* Dashboard Header */}
        <div style={{
          marginBottom: SPACING.lg,
          padding: '4px 0 0',
        }}>
          <h1 style={{ margin: 0, fontSize: '22px', fontWeight: 650, color: COLORS.textPrimary }}>
            {i18n('ai_helper')}
          </h1>
          <p style={{ margin: '8px 0 0', color: COLORS.textSecondary, fontSize: '14px' }}>
            {i18n('ai_helper_dashboard_subtitle')}
          </p>
        </div>

        {/* Tab Navigation Bar */}
        <div role="tablist" style={{
          marginBottom: SPACING.lg,
          display: 'flex',
          gap: SPACING.sm,
          borderBottom: `2px solid ${COLORS.border}`,
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
                  ...getTabStyle(isActive),
                  color: isActive ? COLORS.primary : COLORS.textSecondary,
                  borderBottom: isActive ? `2px solid ${COLORS.primary}` : '2px solid transparent',

                  flexShrink: 0,
                }}
              >
                <Icon name={tab.icon} /> {tab.label}
              </button>
            );
          })}
        </div>

        {/* Tab Content Container */}
        <div style={{
          backgroundColor: COLORS.bgCard,
          borderRadius: RADIUS.lg,
          border: `1px solid ${COLORS.border}`,
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
