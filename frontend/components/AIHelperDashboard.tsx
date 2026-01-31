/**
 * AI 助手统一入口 Tab 容器组件
 * 整合对话记录、使用统计、配置三个子功能
 */

import React, { useState, useEffect } from 'react';
import { AnalyticsPage } from '../teacher/AnalyticsPage';
import { ConversationList } from '../teacher/ConversationList';
import { ConfigPanel } from '../admin/ConfigPanel';

type TabType = 'conversations' | 'analytics' | 'config';

export const AIHelperDashboard: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabType>('conversations');

  useEffect(() => {
    const handlePopState = () => {
      const params = new URLSearchParams(window.location.search);
      const tab = params.get('tab') as TabType;
      if (tab === 'analytics' || tab === 'config' || tab === 'conversations') {
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
    { id: 'config', label: 'AI 配置' },
  ];

  return (
    <div style={{
      padding: '32px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      backgroundColor: '#f8fafc',
      minHeight: '100vh',
    }}>
      <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
        {/* Dashboard Header */}
        <div style={{
          marginBottom: '24px',
          padding: '24px 32px',
          background: '#ffffff',
          borderRadius: '12px',
          border: '1px solid #e5e7eb',
          boxShadow: '0 1px 3px rgba(0, 0, 0, 0.1)',
        }}>
          <h1 style={{ margin: 0, fontSize: '24px', fontWeight: 700, color: '#1f2937' }}>
            AI 助手
          </h1>
          <p style={{ margin: '8px 0 0', color: '#6b7280', fontSize: '14px' }}>
            管理 AI 助手对话、查看统计数据及系统配置
          </p>
        </div>

        {/* Tab Navigation Bar */}
        <div style={{
          marginBottom: '24px',
          display: 'flex',
          gap: '8px',
          borderBottom: '1px solid #e5e7eb',
        }}>
          {tabs.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => handleTabChange(tab.id)}
                style={{
                  padding: '12px 24px',
                  fontSize: '15px',
                  fontWeight: isActive ? 600 : 500,
                  color: isActive ? '#4f46e5' : '#6b7280',
                  backgroundColor: isActive ? '#ffffff' : 'transparent',
                  border: '1px solid',
                  borderColor: isActive ? '#e5e7eb' : 'transparent',
                  borderBottomColor: isActive ? '#ffffff' : 'transparent',
                  borderRadius: '8px 8px 0 0',
                  marginBottom: '-1px',
                  cursor: 'pointer',
                  transition: 'all 0.2s',
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
          backgroundColor: '#ffffff',
          borderRadius: '12px',
          border: '1px solid #e5e7eb',
          boxShadow: '0 1px 3px rgba(0, 0, 0, 0.1)',
          overflow: 'hidden',
        }}>
          {activeTab === 'conversations' && <ConversationList embedded />}
          {activeTab === 'analytics' && <AnalyticsPage embedded />}
          {activeTab === 'config' && <ConfigPanel embedded />}
        </div>
      </div>
    </div>
  );
};

export default AIHelperDashboard;
