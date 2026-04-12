import React from 'react';

// ─── Design Tokens ───────────────────────────────────────────────────────────

export const COLORS = {
  primary: '#2563eb',
  primaryHover: '#1d4ed8',
  primaryLight: '#dbeafe',
  secondary: '#64748b',
  accent: '#f59e0b',
  textPrimary: '#1e293b',
  textSecondary: '#475569',
  textMuted: '#94a3b8',
  textDisabled: '#cbd5e1',
  bgPage: '#f8fafc',
  bgCard: '#ffffff',
  bgHover: '#f1f5f9',
  bgDisabled: '#f1f5f9',
  overlay: 'rgba(0, 0, 0, 0.5)',
  border: '#e2e8f0',
  borderFocus: '#2563eb',
  shadowFocus: 'rgba(37, 99, 235, 0.25)',
  success: '#10b981',
  successBg: '#ecfdf5',
  successBorder: '#a7f3d0',
  successText: '#065f46',
  warning: '#f59e0b',
  warningBg: '#fffbeb',
  warningBorder: '#fde68a',
  warningText: '#92400e',
  error: '#ef4444',
  errorBg: '#fef2f2',
  errorBorder: '#fecaca',
  errorText: '#991b1b',
  info: '#0ea5e9',
  infoBg: '#f0f9ff',
  infoBorder: '#bae6fd',
  infoText: '#0c4a6e',
  codeBg: '#f6f8fa',
  codeBorder: '#e2e8f0',
  // HydroOJ native integration colors
  hydroGreen: '#21ba45',
  hydroGreenLight: '#f0fdf4',
  hydroGreenDark: '#1a9c39',
  nativeText: '#333333',
  nativeBorder: '#dddddd',
  nativeHeaderBg: '#f9fafb',
  blockquoteBorder: '#2563eb',
  blockquoteBg: '#f0f9ff',
  gradient: 'linear-gradient(135deg, #2563eb, #3b82f6)',
  chartScale: ['#2563eb', '#3b82f6', '#60a5fa', '#93c5fd'],
};

export const FONT_FAMILY = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

export const TYPOGRAPHY: Record<string, React.CSSProperties> = {
  xs:    { fontSize: '12px', fontWeight: 400, lineHeight: 1.25 },
  sm:    { fontSize: '14px', fontWeight: 400, lineHeight: 1.5 },
  base:  { fontSize: '16px', fontWeight: 400, lineHeight: 1.5 },
  md:    { fontSize: '18px', fontWeight: 500, lineHeight: 1.5 },
  lg:    { fontSize: '20px', fontWeight: 600, lineHeight: 1.4 },
  xl:    { fontSize: '24px', fontWeight: 700, lineHeight: 1.3 },
  '3xl': { fontSize: '32px', fontWeight: 800, lineHeight: 1.2 },
};

export const SPACING = { xs: '4px', sm: '8px', md: '12px', base: '16px', lg: '24px', xl: '32px', xxl: '48px', huge: '64px' };
export const RADIUS = { sm: '4px', md: '8px', lg: '12px', xl: '16px', full: '9999px' };
export const SHADOWS = {
  sm: '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
  md: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
  lg: '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
  focus: '0 0 0 3px rgba(37, 99, 235, 0.25)',
};
export const ZINDEX = { dropdown: 10000, sticky: 10100, drawer: 10200, modal: 10300, toast: 10400, tooltip: 10500 };
export const TRANSITIONS = {
  fast: '150ms cubic-bezier(0.4, 0, 0.2, 1)',
  normal: '250ms cubic-bezier(0.4, 0, 0.2, 1)',
  slow: '400ms cubic-bezier(0.4, 0, 0.2, 1)',
};
export const ANIMATIONS = {
  blink: 'blink 1.4s infinite both',
  pulse: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
  fadeIn: 'fadeIn 200ms ease-out',
  slideInRight: 'slideInRight 300ms ease-out',
  spin: 'spin 1s linear infinite',
};

// ─── Component Style Factories ───────────────────────────────────────────────

export const getButtonStyle = (variant: 'primary' | 'secondary' | 'danger' | 'ghost'): React.CSSProperties => {
  const base: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: `${SPACING.sm} ${SPACING.base}`,
    fontSize: '14px',
    fontWeight: 500,
    fontFamily: FONT_FAMILY,
    borderRadius: RADIUS.md,
    border: 'none',
    cursor: 'pointer',
    transition: `all ${TRANSITIONS.fast}`,
    lineHeight: 1.5,
  };
  switch (variant) {
    case 'primary':
      return { ...base, backgroundColor: COLORS.primary, color: '#ffffff', boxShadow: SHADOWS.sm };
    case 'secondary':
      return { ...base, backgroundColor: COLORS.bgHover, color: COLORS.textPrimary, border: `1px solid ${COLORS.border}` };
    case 'danger':
      return { ...base, backgroundColor: COLORS.error, color: '#ffffff', boxShadow: SHADOWS.sm };
    case 'ghost':
      return { ...base, backgroundColor: 'transparent', color: COLORS.textSecondary };
    default:
      return base;
  }
};

export const getInputStyle = (focused?: boolean): React.CSSProperties => ({
  width: '100%',
  padding: `${SPACING.sm} ${SPACING.md}`,
  fontSize: '14px',
  fontFamily: FONT_FAMILY,
  color: COLORS.textPrimary,
  backgroundColor: COLORS.bgCard,
  border: `1px solid ${focused ? COLORS.borderFocus : COLORS.border}`,
  borderRadius: RADIUS.md,
  outline: 'none',
  boxShadow: focused ? SHADOWS.focus : 'none',
  transition: `all ${TRANSITIONS.fast}`,
  lineHeight: 1.5,
});

export const cardStyle: React.CSSProperties = {
  backgroundColor: COLORS.bgCard,
  border: `1px solid ${COLORS.border}`,
  borderRadius: RADIUS.lg,
  boxShadow: SHADOWS.sm,
  padding: SPACING.lg,
};

export const tableRootStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: '14px',
};

export const getTableHeaderStyle = (): React.CSSProperties => ({
  padding: `${SPACING.sm} ${SPACING.md}`,
  fontWeight: 600,
  color: COLORS.textSecondary,
  backgroundColor: COLORS.bgHover,
  borderBottom: `2px solid ${COLORS.border}`,
  textAlign: 'left',
  fontSize: '13px',
});

export const getTableCellStyle = (): React.CSSProperties => ({
  padding: `${SPACING.sm} ${SPACING.md}`,
  borderBottom: `1px solid ${COLORS.border}`,
  color: COLORS.textPrimary,
  fontSize: '14px',
});

export const getTableRowStyle = (isHover?: boolean, isAlt?: boolean): React.CSSProperties => ({
  backgroundColor: isHover ? COLORS.bgHover : isAlt ? COLORS.bgPage : 'transparent',
  transition: `background-color ${TRANSITIONS.fast}`,
});

export const getTabStyle = (isActive: boolean): React.CSSProperties => ({
  padding: `${SPACING.sm} ${SPACING.base}`,
  fontSize: '14px',
  fontWeight: isActive ? 600 : 400,
  color: isActive ? COLORS.primary : COLORS.textSecondary,
  backgroundColor: 'transparent',
  border: 'none',
  borderBottom: isActive ? `2px solid ${COLORS.primary}` : '2px solid transparent',
  cursor: 'pointer',
  transition: `all ${TRANSITIONS.fast}`,
});

export const getBadgeStyle = (variant: 'success' | 'warning' | 'error' | 'info'): React.CSSProperties => {
  const map = {
    success: { bg: COLORS.successBg, color: COLORS.successText, border: COLORS.successBorder },
    warning: { bg: COLORS.warningBg, color: COLORS.warningText, border: COLORS.warningBorder },
    error:   { bg: COLORS.errorBg, color: COLORS.errorText, border: COLORS.errorBorder },
    info:    { bg: COLORS.infoBg, color: COLORS.infoText, border: COLORS.infoBorder },
  };
  const t = map[variant];
  return {
    display: 'inline-flex',
    alignItems: 'center',
    padding: `2px ${SPACING.sm}`,
    fontSize: '12px',
    fontWeight: 500,
    lineHeight: 1.25,
    color: t.color,
    backgroundColor: t.bg,
    border: `1px solid ${t.border}`,
    borderRadius: RADIUS.full,
  };
};

export const getPillStyle = (isActive: boolean): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  padding: `6px ${SPACING.base}`,
  fontSize: '13px',
  fontWeight: isActive ? 600 : 500,
  color: isActive ? '#ffffff' : COLORS.textSecondary,
  background: isActive ? COLORS.gradient : COLORS.bgPage,
  border: isActive ? 'none' : `1px solid ${COLORS.border}`,
  borderRadius: RADIUS.full,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  boxShadow: isActive ? '0 2px 8px rgba(37, 99, 235, 0.25)' : 'none',
  transform: isActive ? 'scale(1.02)' : 'scale(1)',
  transition: 'all 200ms cubic-bezier(0.4, 0, 0.2, 1)',
});

export const modalOverlayStyle: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: COLORS.overlay,
  zIndex: ZINDEX.modal,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

export const modalContentStyle: React.CSSProperties = {
  backgroundColor: COLORS.bgCard,
  borderRadius: RADIUS.lg,
  boxShadow: SHADOWS.lg,
  maxWidth: '480px',
  width: '90vw',
  padding: SPACING.lg,
};

export const getAlertStyle = (variant: 'success' | 'warning' | 'error' | 'info'): React.CSSProperties => {
  const map = {
    success: { bg: COLORS.successBg, color: COLORS.successText, border: COLORS.successBorder },
    warning: { bg: COLORS.warningBg, color: COLORS.warningText, border: COLORS.warningBorder },
    error:   { bg: COLORS.errorBg, color: COLORS.errorText, border: COLORS.errorBorder },
    info:    { bg: COLORS.infoBg, color: COLORS.infoText, border: COLORS.infoBorder },
  };
  const t = map[variant];
  return {
    padding: `${SPACING.md} ${SPACING.base}`,
    backgroundColor: t.bg,
    color: t.color,
    borderLeft: `4px solid ${t.border}`,
    borderRadius: RADIUS.md,
    fontSize: '14px',
    lineHeight: 1.5,
  };
};

export const emptyStateStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: SPACING.xxl,
  color: COLORS.textMuted,
  fontSize: '14px',
  textAlign: 'center',
  border: `2px dashed ${COLORS.border}`,
  borderRadius: RADIUS.lg,
};

export const getPaginationButtonStyle = (isActive: boolean, isDisabled?: boolean): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: '32px',
  height: '32px',
  padding: `0 ${SPACING.sm}`,
  fontSize: '13px',
  fontWeight: isActive ? 600 : 400,
  color: isDisabled ? COLORS.textDisabled : isActive ? '#ffffff' : COLORS.textSecondary,
  backgroundColor: isDisabled ? COLORS.bgDisabled : isActive ? COLORS.primary : COLORS.bgCard,
  border: `1px solid ${isActive ? COLORS.primary : COLORS.border}`,
  borderRadius: RADIUS.md,
  cursor: isDisabled ? 'not-allowed' : 'pointer',
  transition: `all ${TRANSITIONS.fast}`,
});

export const progressBarTrackStyle: React.CSSProperties = {
  width: '100%',
  height: '8px',
  backgroundColor: COLORS.bgHover,
  borderRadius: RADIUS.full,
  overflow: 'hidden',
};

export const getProgressBarFillStyle = (percent: number): React.CSSProperties => ({
  width: `${Math.min(100, Math.max(0, percent))}%`,
  height: '100%',
  backgroundColor: COLORS.primary,
  borderRadius: RADIUS.full,
  transition: `width ${TRANSITIONS.normal}`,
});

export const statCard = {
  container: { backgroundColor: COLORS.bgCard, border: `1px solid ${COLORS.border}`, borderRadius: RADIUS.lg, padding: SPACING.lg } as React.CSSProperties,
  label: { ...TYPOGRAPHY.xs, color: COLORS.textMuted } as React.CSSProperties,
  value: { ...TYPOGRAPHY.lg, color: COLORS.primary } as React.CSSProperties,
  change: (positive: boolean) => ({ ...TYPOGRAPHY.xs, color: positive ? COLORS.success : COLORS.error }) as React.CSSProperties,
};

export const linkStyle: React.CSSProperties = {
  color: COLORS.primary,
  textDecoration: 'none',
  cursor: 'pointer',
};

// ─── Shared Markdown Theme ───────────────────────────────────────────────────

export const markdownTheme = `
  .markdown-body { font-family: ${FONT_FAMILY}; color: ${COLORS.textPrimary}; line-height: 1.7; word-wrap: break-word; font-size: 14px; }
  .markdown-body h1 { font-size: 1.4em; font-weight: 700; margin: 1em 0 0.5em; padding-bottom: 0.3em; border-bottom: 1px solid ${COLORS.border}; }
  .markdown-body h2 { font-size: 1.25em; font-weight: 600; margin: 1em 0 0.5em; padding-bottom: 0.3em; border-bottom: 1px solid ${COLORS.border}; }
  .markdown-body h3 { font-size: 1.1em; font-weight: 600; margin: 0.8em 0 0.4em; color: ${COLORS.textPrimary}; }
  .markdown-body h4, .markdown-body h5, .markdown-body h6 { font-size: 1em; font-weight: 600; margin: 0.8em 0 0.4em; }
  .markdown-body p { margin: 0.5em 0; line-height: 1.7; }
  .markdown-body a { color: ${COLORS.primary}; text-decoration: none; }
  .markdown-body a:hover { text-decoration: underline; }
  .markdown-body pre { background: #1e293b; border: none; border-radius: ${RADIUS.md}; padding: ${SPACING.base}; overflow-x: auto; margin: 0.75em 0; }
  .markdown-body code { font-family: 'SFMono-Regular', 'Menlo', 'Consolas', 'Liberation Mono', monospace; font-size: 13px; }
  .markdown-body :not(pre) > code { background: ${COLORS.codeBg}; border: 1px solid ${COLORS.codeBorder}; border-radius: ${RADIUS.sm}; padding: 2px 6px; color: #c7254e; }
  .markdown-body pre code { background: none; padding: 0; border: none; border-radius: 0; color: #e2e8f0; font-size: 13px; line-height: 1.6; }
  .markdown-body blockquote { border-left: 4px solid ${COLORS.blockquoteBorder}; background: ${COLORS.blockquoteBg}; margin: 0.5em 0; padding: ${SPACING.sm} ${SPACING.base}; color: ${COLORS.textSecondary}; }
  .markdown-body ul, .markdown-body ol { padding-left: 2em; margin: 0.5em 0; }
  .markdown-body li { margin: 0.3em 0; line-height: 1.7; }
  .markdown-body li > strong:first-child { color: ${COLORS.textPrimary}; }
  .markdown-body table { border-collapse: collapse; width: 100%; margin: 0.75em 0; font-size: 13px; }
  .markdown-body th, .markdown-body td { border: 1px solid ${COLORS.border}; padding: 10px 14px; text-align: left; }
  .markdown-body th { background: #f8fafc; font-weight: 600; color: ${COLORS.textSecondary}; text-transform: none; font-size: 12px; letter-spacing: 0.02em; }
  .markdown-body td { color: ${COLORS.textPrimary}; }
  .markdown-body tr:hover td { background: #fafbfc; }
  .markdown-body hr { border: none; border-top: 1px solid ${COLORS.border}; margin: 1.2em 0; }
  .markdown-body img { max-width: 100%; }
  /* highlight.js dark theme (GitHub Dark) */
  .markdown-body .hljs-keyword, .markdown-body .hljs-selector-tag { color: #ff7b72; }
  .markdown-body .hljs-string, .markdown-body .hljs-attr { color: #a5d6ff; }
  .markdown-body .hljs-number, .markdown-body .hljs-literal { color: #79c0ff; }
  .markdown-body .hljs-built_in { color: #ffa657; }
  .markdown-body .hljs-comment { color: #8b949e; font-style: italic; }
  .markdown-body .hljs-function .hljs-title, .markdown-body .hljs-title.function_ { color: #d2a8ff; }
  .markdown-body .hljs-type, .markdown-body .hljs-title.class_ { color: #ffa657; }
  .markdown-body .hljs-variable, .markdown-body .hljs-template-variable { color: #ffa657; }
  .markdown-body .hljs-operator { color: #ff7b72; }
  .markdown-body .hljs-punctuation { color: #c9d1d9; }
  .markdown-body .hljs-meta { color: #79c0ff; }
  .markdown-body .hljs-params { color: #c9d1d9; }
`;

// ─── Shared Keyframe CSS ─────────────────────────────────────────────────────

export const keyframeStyles = `
  @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }
  @keyframes fadeIn { from{opacity:0} to{opacity:1} }
  @keyframes slideInRight { from{transform:translateX(100%)} to{transform:translateX(0)} }
  @keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
  @keyframes float { 0%{transform:translateY(0)} 50%{transform:translateY(-8px)} 100%{transform:translateY(0)} }
  .chat-input-card:focus-within {
    border-color: ${COLORS.borderFocus} !important;
    box-shadow: 0 0 0 3px ${COLORS.shadowFocus} !important;
  }
  .hide-scrollbar::-webkit-scrollbar { display: none; }
  .hide-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
`;
