/**
 * AI 配置页面骨架
 * 管理员配置 AI 学习助手相关参数（开发中）
 */

import React from 'react';

/**
 * ConfigPanel 组件
 */
export const ConfigPanel: React.FC = () => {
  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif' }}>
      <h1>AI 学习助手配置</h1>

      <div style={{
        marginTop: '40px',
        padding: '40px',
        backgroundColor: '#f9fafb',
        borderRadius: '12px',
        textAlign: 'center',
        color: '#6b7280'
      }}>
        <p style={{ fontSize: '18px', marginBottom: '10px' }}>
          AI 学习助手配置页面（开发中）
        </p>
        <p style={{ fontSize: '14px', color: '#9ca3af' }}>
          此页面将提供 AI 服务配置功能（API 设置、频率限制等）
        </p>
      </div>
    </div>
  );
};

export default ConfigPanel;
