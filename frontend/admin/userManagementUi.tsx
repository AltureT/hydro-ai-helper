/**
 * 用户管理页面共用的小组件：徽标、弹窗、侧栏、二级导航、表格容器
 */

import React, { useEffect } from 'react';
import { Icon } from '../components/Icon';
import {
  COLORS,
  FONT_FAMILY,
  RADIUS,
  SHADOWS,
  SPACING,
  ZINDEX,
  getSubNavStyle,
  modalOverlayStyle,
} from '../utils/styles';

export type BadgeVariant = 'info' | 'ok' | 'warn' | 'err' | 'muted';

const BADGE_COLORS: Record<BadgeVariant, { bg: string; color: string; border: string }> = {
  info: { bg: COLORS.infoBg, color: COLORS.infoText, border: COLORS.infoBorder },
  ok: { bg: COLORS.successBg, color: COLORS.successText, border: COLORS.successBorder },
  warn: { bg: COLORS.warningBg, color: COLORS.warningText, border: COLORS.warningBorder },
  err: { bg: COLORS.errorBg, color: COLORS.errorText, border: COLORS.errorBorder },
  muted: { bg: COLORS.bgHover, color: COLORS.textSecondary, border: COLORS.border },
};

export const Badge: React.FC<{ variant: BadgeVariant; children: React.ReactNode; title?: string }> = ({ variant, children, title }) => {
  const c = BADGE_COLORS[variant];
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '2px 8px',
        fontSize: '12px',
        fontWeight: 500,
        lineHeight: 1.5,
        whiteSpace: 'nowrap',
        borderRadius: RADIUS.full,
        border: `1px solid ${c.border}`,
        backgroundColor: c.bg,
        color: c.color,
      }}
    >
      {children}
    </span>
  );
};

export interface SubNavItem<T extends string> {
  id: T;
  label: string;
}

export function SubNav<T extends string>({ items, active, onChange, ariaLabel }: {
  items: Array<SubNavItem<T>>;
  active: T;
  onChange: (id: T) => void;
  ariaLabel: string;
}) {
  return (
    <div role="tablist" aria-label={ariaLabel} style={{ display: 'flex', flexWrap: 'wrap', gap: SPACING.xs, marginBottom: SPACING.base }}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={active === item.id}
          onClick={() => onChange(item.id)}
          style={getSubNavStyle(active === item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);
}

/** 弹窗内表单控件按边框盒计算宽度；禁用按钮降低不透明度 */
const dialogCss = `
  .ai-um-dialog input, .ai-um-dialog select, .ai-um-dialog textarea { box-sizing: border-box; max-width: 100%; }
  .ai-um-dialog button:disabled { opacity: 0.55; cursor: not-allowed; }
`;

export const Modal: React.FC<{
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
}> = ({ title, onClose, children, footer, width = 480 }) => {
  useEscape(onClose);
  return (
    <div style={modalOverlayStyle} onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="ai-um-dialog"
        onClick={(event) => event.stopPropagation()}
        style={{
          boxSizing: 'border-box',
          backgroundColor: COLORS.bgCard,
          borderRadius: RADIUS.lg,
          boxShadow: SHADOWS.lg,
          width: `min(${width}px, calc(100vw - 32px))`,
          maxHeight: 'calc(100vh - 48px)',
          overflowY: 'auto',
          padding: SPACING.lg,
          fontFamily: FONT_FAMILY,
        }}
      >
        <style>{dialogCss}</style>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: SPACING.base }}>
          <h3 style={{ margin: 0, fontSize: '17px', fontWeight: 650, color: COLORS.textPrimary }}>{title}</h3>
          <button type="button" aria-label="close" onClick={onClose} style={iconButtonStyle}>
            <Icon name="close" />
          </button>
        </div>
        {children}
        {footer && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: SPACING.sm, marginTop: SPACING.lg, flexWrap: 'wrap' }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};

export const Drawer: React.FC<{
  title: string;
  subtitle?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}> = ({ title, subtitle, onClose, children }) => {
  useEscape(onClose);
  return (
    <div style={{ ...modalOverlayStyle, zIndex: ZINDEX.drawer, justifyContent: 'flex-end', alignItems: 'stretch' }} onClick={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="ai-um-dialog"
        onClick={(event) => event.stopPropagation()}
        style={{
          width: 'min(440px, 100vw)',
          height: '100%',
          overflowY: 'auto',
          backgroundColor: COLORS.bgCard,
          boxShadow: SHADOWS.lg,
          padding: SPACING.lg,
          boxSizing: 'border-box',
          fontFamily: FONT_FAMILY,
        }}
      >
        <style>{dialogCss}</style>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: SPACING.sm }}>
          <div>
            <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 650, color: COLORS.textPrimary }}>{title}</h3>
            {subtitle && <div style={{ marginTop: '4px', fontSize: '13px', color: COLORS.textMuted }}>{subtitle}</div>}
          </div>
          <button type="button" aria-label="close" onClick={onClose} style={iconButtonStyle}>
            <Icon name="close" />
          </button>
        </div>
        <div style={{ marginTop: SPACING.lg }}>{children}</div>
      </aside>
    </div>
  );
};

export const iconButtonStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '32px',
  height: '32px',
  border: 'none',
  borderRadius: RADIUS.md,
  background: 'transparent',
  color: COLORS.textSecondary,
  cursor: 'pointer',
  flexShrink: 0,
};

export const linkButtonStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: COLORS.primary,
  padding: '4px 6px',
  fontSize: '14px',
  fontFamily: FONT_FAMILY,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

export const labelStyle: React.CSSProperties = {
  fontSize: '13px',
  fontWeight: 600,
  color: COLORS.textSecondary,
};

export const mutedTextStyle: React.CSSProperties = {
  fontSize: '13px',
  color: COLORS.textMuted,
  lineHeight: 1.6,
};

/** 表格横向滚动容器：单元格默认不换行（窄屏横向滚动），带 ai-um-wrap 类的单元格允许换行 */
export const TableScroll: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="ai-um-table-scroll" style={{ width: '100%', overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
    <style>{`
      .ai-um-table-scroll th, .ai-um-table-scroll td { white-space: nowrap; }
      .ai-um-table-scroll td.ai-um-wrap { white-space: normal; min-width: 180px; }
    `}</style>
    {children}
  </div>
);

/** 胶囊单选组（匹配方式 / 范围等） */
export function PillGroup<T extends string>({ options, value, onChange, disabled, ariaLabel }: {
  options: Array<{ id: T; label: string }>;
  value: T;
  onChange: (id: T) => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} style={{ display: 'inline-flex', flexWrap: 'wrap', gap: '6px' }}>
      {options.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(option.id)}
            style={{
              padding: '6px 14px',
              borderRadius: RADIUS.full,
              fontSize: '14px',
              fontFamily: FONT_FAMILY,
              border: `1px solid ${active ? COLORS.primary : COLORS.border}`,
              background: active ? COLORS.primary : COLORS.bgHover,
              color: active ? '#ffffff' : COLORS.textSecondary,
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.55 : 1,
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
