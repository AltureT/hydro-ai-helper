/**
 * AI 助手统一入口 Tab 容器组件
 * 整合对话记录、使用统计、配置三个子功能
 */

import React, { useState, useEffect } from 'react';
import { AnalyticsPage } from '../teacher/AnalyticsPage';
import { ConversationList } from '../teacher/ConversationList';
import { ConfigPanel } from '../admin/ConfigPanel';
import { CostDashboard } from '../teacher/CostDashboard';
import { COLORS, FONT_FAMILY, SHADOWS, RADIUS, SPACING, getTabStyle } from '../utils/styles';

type TabType = 'conversations' | 'analytics' | 'cost' | 'config';

export const AIHelperDashboard: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabType>('conversations');

  useEffect(() => {
    const handlePopState = () => {
      const params = new URLSearchParams(window.location.search);
      const tab = params.get('tab') as TabType;
      if (tab === 'analytics' || tab === 'cost' || tab === 'config' || tab === 'conversations') {
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
    { id: 'conversations', label: '对话记录' },
    { id: 'analytics', label: '使用统计' },
    { id: 'cost', label: '成本分析' },
    { id: 'config', label: 'AI 配置' },
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
            AI 助手
          </h1>
          <p style={{ margin: '8px 0 0', color: COLORS.textSecondary, fontSize: '14px' }}>
            管理 AI 助手对话、查看统计数据及系统配置
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
          {activeTab === 'cost' && <CostDashboard embedded />}
          {activeTab === 'config' && <ConfigPanel embedded />}
        </div>
      </div>
    </div>
  );
};

export default AIHelperDashboard;
