import React from 'react';
import { i18n } from '@hydrooj/ui-default';
import { COLORS, ANIMATIONS } from '../utils/styles';

interface ThinkingBlockProps {
  isStreaming: boolean;
}

export const ThinkingBlock: React.FC<ThinkingBlockProps> = ({ isStreaming }) => {
  if (!isStreaming) return null;

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      padding: '6px 0',
      fontSize: '12px',
      color: COLORS.primary,
    }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
        <circle cx="12" cy="12" r="10" stroke={COLORS.primary} strokeWidth="2" strokeDasharray="31.4" strokeDashoffset="10" style={{ animation: ANIMATIONS.spin }} />
      </svg>
      <span>{i18n('ai_helper_student_thinking')}</span>
    </div>
  );
};
