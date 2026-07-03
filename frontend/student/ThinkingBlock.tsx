import React from 'react';
import { i18n } from '../utils/i18n';

interface ThinkingBlockProps {
  isStreaming: boolean;
}

/**
 * 方案 A · 克制蓝 — 深度思考指示
 * 三个蓝点的脉冲动画（需要 dotpulse keyframes，已由 ChatMessageList 注入）。
 */
export const ThinkingBlock: React.FC<ThinkingBlockProps> = ({ isStreaming }) => {
  if (!isStreaming) return null;

  const dot = (delay: string): React.CSSProperties => ({
    width: '5px', height: '5px', borderRadius: '50%', background: '#2563eb',
    animation: `dotpulse 1.2s infinite ${delay}`,
  });

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 0', fontSize: '12.5px', color: '#64748b' }}>
      <span>{i18n('ai_helper_student_thinking')}</span>
      <span style={{ display: 'inline-flex', gap: '3px' }}>
        <span style={dot('0s')} />
        <span style={dot('0.2s')} />
        <span style={dot('0.4s')} />
      </span>
    </div>
  );
};
