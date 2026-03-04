import React from 'react';

export const colors = {
  primary: '#6366f1',
  primaryHover: '#4f46e5',
  primaryGradient: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
  primaryLight: '#eef2ff',
  primaryBorder: '#c7d2fe',

  text: '#1f2937',
  textSecondary: '#4b5563',
  textMuted: '#6b7280',
  textFaint: '#9ca3af',

  border: '#e5e7eb',
  borderLight: '#f3f4f6',

  bg: '#ffffff',
  bgPage: '#f8fafc',
  bgCard: '#f9fafb',
  bgHover: '#fafafa',

  success: '#10b981',
  successBg: '#dcfce7',
  successText: '#166534',

  warning: '#f59e0b',
  warningBg: '#fef9c3',
  warningText: '#854d0e',

  error: '#ef4444',
  errorBg: '#fee2e2',
  errorText: '#991b1b',
};

export const fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

export const cardStyle: React.CSSProperties = {
  padding: '20px',
  backgroundColor: colors.bg,
  borderRadius: '12px',
  boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
  border: `1px solid ${colors.border}`,
};

export const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'separate' as const,
  borderSpacing: 0,
  borderRadius: '12px',
  overflow: 'hidden',
  boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
  border: `1px solid ${colors.border}`,
};

export const cellStyle: React.CSSProperties = {
  padding: '14px 16px',
  borderBottom: `1px solid ${colors.borderLight}`,
  fontSize: '14px',
};

export const buttonPrimary: React.CSSProperties = {
  padding: '12px 28px',
  background: colors.primaryGradient,
  color: 'white',
  border: 'none',
  borderRadius: '8px',
  fontSize: '15px',
  fontWeight: 600,
  cursor: 'pointer',
  boxShadow: '0 2px 8px rgba(102, 126, 234, 0.3)',
  transition: 'all 0.2s',
};

export const modalOverlay: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: 'rgba(0, 0, 0, 0.5)',
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
  zIndex: 10001,
};

export const linkStyle: React.CSSProperties = {
  color: colors.primary,
  textDecoration: 'none',
  fontWeight: 500,
  padding: '6px 12px',
  borderRadius: '6px',
  backgroundColor: colors.primaryLight,
  transition: 'all 0.2s',
  display: 'inline-block',
};
