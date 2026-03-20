import React, { useState, useRef, useEffect } from 'react';
import { renderMarkdown as renderMarkdownSafe, renderStreamingMarkdown } from '../utils/markdown';

interface ThinkingBlockProps {
  content: string;
  isStreaming: boolean;
  variant: 'embedded' | 'floating';
}

export const ThinkingBlock: React.FC<ThinkingBlockProps> = ({ content, isStreaming, variant }) => {
  const [expanded, setExpanded] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState(0);

  useEffect(() => {
    if (contentRef.current) {
      setContentHeight(contentRef.current.scrollHeight);
    }
  }, [content, expanded]);

  const isEmbedded = variant === 'embedded';

  const html = isStreaming ? renderStreamingMarkdown(content) : renderMarkdownSafe(content);

  const borderColor = isEmbedded ? '#e5e7eb' : '#bbf7d0';
  const textColor = isEmbedded ? '#4b5563' : '#15803d';
  const headerBg = expanded
    ? (isEmbedded ? '#f9fafb' : '#f0fdf4')
    : 'transparent';
  const shadow = isEmbedded
    ? '0 1px 2px rgba(0,0,0,0.05)'
    : '0 1px 3px rgba(21,128,61,0.1)';

  return (
    <div style={{
      background: 'white',
      border: `1px solid ${borderColor}`,
      borderRadius: '8px',
      marginBottom: '8px',
      overflow: 'hidden',
      boxShadow: shadow,
    }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '8px 12px',
          cursor: 'pointer',
          background: headerBg,
          userSelect: 'none',
          transition: 'background 0.2s ease',
        }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          style={{
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
            flexShrink: 0,
          }}
        >
          <path d="M7 10l5 5 5-5" stroke={textColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span style={{ fontSize: '12px', color: textColor, fontWeight: 500 }}>
          {expanded ? '思考过程' : '思考过程 (点击展开)'}
        </span>
        {isStreaming && (
          <span style={{
            display: 'inline-block',
            width: '5px',
            height: '12px',
            background: textColor,
            marginLeft: '2px',
            animation: 'blink 1s step-end infinite',
            verticalAlign: 'text-bottom',
          }} />
        )}
      </div>
      <div style={{
        maxHeight: expanded ? `${Math.max(contentHeight + 24, 200)}px` : '0px',
        opacity: expanded ? 1 : 0,
        overflow: 'hidden',
        transition: 'max-height 0.4s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s ease',
      }}>
        <div
          ref={contentRef}
          style={{ padding: '0 12px 10px 12px' }}
        >
          <div
            className="markdown-body"
            dangerouslySetInnerHTML={{ __html: html }}
            style={{
              fontSize: '12px',
              lineHeight: '1.5',
              color: isEmbedded ? '#6b7280' : '#4b5563',
            }}
          />
        </div>
      </div>
    </div>
  );
};
