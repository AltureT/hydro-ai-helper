import React from 'react';

interface ThinkingBlockProps {
  isStreaming: boolean;
  variant: 'embedded' | 'floating';
}

export const ThinkingBlock: React.FC<ThinkingBlockProps> = ({ isStreaming, variant }) => {
  const isEmbedded = variant === 'embedded';
  const textColor = isEmbedded ? '#6b7280' : '#15803d';

  if (!isStreaming) return null;

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      padding: '6px 0',
      fontSize: '12px',
      color: textColor,
    }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
        <circle cx="12" cy="12" r="10" stroke={textColor} strokeWidth="2" strokeDasharray="31.4" strokeDashoffset="10" style={{ animation: 'spin 1s linear infinite' }} />
      </svg>
      <span>思考中...</span>
    </div>
  );
};
