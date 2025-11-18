/**
 * AI 使用统计页面骨架
 * 显示 AI 学习助手的使用统计信息（开发中）
 */

import React from 'react';

/**
 * AnalyticsPage 组件
 */
export const AnalyticsPage: React.FC = () => {
  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif' }}>
      <h1>AI 使用统计</h1>

      <div style={{
        marginTop: '40px',
        padding: '40px',
        backgroundColor: '#f9fafb',
        borderRadius: '12px',
        textAlign: 'center',
        color: '#6b7280'
      }}>
        <p style={{ fontSize: '18px', marginBottom: '10px' }}>
          AI 使用统计页面（开发中）
        </p>
        <p style={{ fontSize: '14px', color: '#9ca3af' }}>
          此页面将提供 AI 学习助手的使用统计分析功能
        </p>
      </div>
    </div>
  );
};

export default AnalyticsPage;
