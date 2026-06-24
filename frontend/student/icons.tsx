import React from 'react';

/**
 * 方案 A · 克制蓝 — 统一图标集（单线、随 color 着色）
 * 用于问题类型卡片、输入框操作与发送按钮，替换原先的 emoji。
 */

type IconProps = { size?: number };

const base = (size: number): React.SVGProps<SVGSVGElement> => ({
  width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round',
});

/** 问题类型图标：understand / think / debug / optimize */
export const TypeIcon: React.FC<IconProps & { type: string }> = ({ type, size = 14 }) => {
  switch (type) {
    case 'understand':
      return (
        <svg {...base(size)} strokeWidth={2}>
          <circle cx="12" cy="12" r="9" />
          <path d="M9.6 9.3a2.4 2.4 0 0 1 4.3 1.4c0 1.6-2 1.7-2 3.1" />
          <circle cx="11.9" cy="17.2" r="0.9" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'think':
      return (
        <svg {...base(size)} strokeWidth={2}>
          <path d="M9 18h6M10 21h4" />
          <path d="M12 3a6 6 0 0 0-3.8 10.6c.6.5.9 1.1.9 2.4h5.8c0-1.3.3-1.9.9-2.4A6 6 0 0 0 12 3z" />
        </svg>
      );
    case 'debug':
      return (
        <svg {...base(size)} strokeWidth={2}>
          <polyline points="9 8 5 12 9 16" />
          <polyline points="15 8 19 12 15 16" />
        </svg>
      );
    case 'optimize':
      return (
        <svg {...base(size)} strokeWidth={1.8}>
          <path d="M12 3l1.7 6.3L20 11l-6.3 1.7L12 19l-1.7-6.3L4 11l6.3-1.7z" />
        </svg>
      );
    default:
      return null;
  }
};

export const SendIcon: React.FC<IconProps> = ({ size = 15 }) => (
  <svg {...base(size)} strokeWidth={2.2}><path d="M5 12h13M13 6l6 6-6 6" /></svg>
);

export const AttachIcon: React.FC<IconProps> = ({ size = 12 }) => (
  <svg {...base(size)} strokeWidth={2}>
    <path d="M21 15V8a2 2 0 0 0-2-2h-7l-2-2H5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h7" />
  </svg>
);

export const RefreshIcon: React.FC<IconProps> = ({ size = 12 }) => (
  <svg {...base(size)} strokeWidth={2}><path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 4v4h4" /></svg>
);

export const RemoveIcon: React.FC<IconProps> = ({ size = 11 }) => (
  <svg {...base(size)} strokeWidth={2}><path d="M6 6l12 12M18 6L6 18" /></svg>
);

/** 字母标识：替换原机器人 emoji 头像 */
export const AIMark: React.FC<{ size?: number; radius?: number; fontSize?: number }> = ({
  size = 28, radius = 8, fontSize = 11,
}) => (
  <div style={{
    width: size, height: size, borderRadius: radius,
    background: 'linear-gradient(135deg, #2563eb, #5b8def)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: "'JetBrains Mono', ui-monospace, 'SFMono-Regular', monospace",
    fontSize, fontWeight: 700, color: '#ffffff', letterSpacing: '-0.5px',
    flexShrink: 0,
  }}>AI</div>
);
