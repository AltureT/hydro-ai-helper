/**
 * 用户管理页面共用的小组件：徽标、弹窗、侧栏、二级导航、表格容器、加载状态
 */

import React, { useEffect, useState } from 'react';
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

// ─── 加载状态 ─────────────────────────────────────────────────────────────────

const LOADING_CSS = `
@keyframes ai-um-spin { to { transform: rotate(360deg); } }
@keyframes ai-um-bar { 0% { transform: translateX(-100%); } 100% { transform: translateX(260%); } }
@keyframes ai-um-pulse { 0%, 100% { opacity: 0.45; } 50% { opacity: 0.9; } }
@media (prefers-reduced-motion: reduce) {
  .ai-um-anim { animation-duration: 2.4s !important; }
}
`;

/** 动画样式只注入一次；放在 head 里，弹窗和面板都能用 */
function useLoadingCss(): void {
  useEffect(() => {
    if (typeof document === 'undefined' || document.getElementById('ai-um-loading-css')) return;
    const el = document.createElement('style');
    el.id = 'ai-um-loading-css';
    el.textContent = LOADING_CSS;
    document.head.appendChild(el);
  }, []);
}

/**
 * active 持续超过 delay 毫秒才返回 true：请求很快完成时不闪一下加载提示
 */
export function useDelayedFlag(active: boolean, delay = 180): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) { setShown(false); return undefined; }
    const timer = window.setTimeout(() => setShown(true), delay);
    return () => window.clearTimeout(timer);
  }, [active, delay]);
  return shown;
}

/** 行内转圈（按钮、提示文字前） */
export const Spinner: React.FC<{ size?: number; color?: string }> = ({ size = 14, color = 'currentColor' }) => {
  useLoadingCss();
  return (
    <span
      aria-hidden="true"
      className="ai-um-anim"
      style={{
        display: 'inline-block',
        width: `${size}px`,
        height: `${size}px`,
        boxSizing: 'border-box',
        borderRadius: '50%',
        border: `2px solid ${color}`,
        borderRightColor: 'transparent',
        opacity: 0.85,
        verticalAlign: '-2px',
        flexShrink: 0,
        animation: 'ai-um-spin 0.75s linear infinite',
      }}
    />
  );
};

/** 按钮内容：忙时在文字前加转圈（按钮本身仍由调用方禁用） */
export const BusyLabel: React.FC<{ busy: boolean; children: React.ReactNode }> = ({ busy, children }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
    {busy && <Spinner size={13} />}
    {children}
  </span>
);

/** 卡片顶部的细进度条：已有数据、正在刷新时显示（父元素需 position: relative） */
export const LoadingBar: React.FC<{ active: boolean }> = ({ active }) => {
  useLoadingCss();
  if (!active) return null;
  return (
    <div aria-hidden="true" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '3px', overflow: 'hidden', zIndex: 1, pointerEvents: 'none' }}>
      <div
        className="ai-um-anim"
        style={{ width: '40%', height: '100%', borderRadius: RADIUS.full, background: COLORS.primary, animation: 'ai-um-bar 1.1s ease-in-out infinite' }}
      />
    </div>
  );
};

/** 列表上方的刷新进度条：已有数据、重新加载超过片刻才显示；不占高度 */
export const RefreshBar: React.FC<{ loading: boolean }> = ({ loading }) => {
  const shown = useDelayedFlag(loading);
  return (
    <div style={{ position: 'relative', height: 0 }}>
      <LoadingBar active={shown} />
    </div>
  );
};

/** 首次加载：转圈 + 文字，占住高度，避免内容出现时页面跳动 */
export const LoadingState: React.FC<{ label: string; minHeight?: number }> = ({ label, minHeight = 120 }) => (
  <div
    role="status"
    style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm,
      minHeight: `${minHeight}px`, color: COLORS.textMuted, fontSize: '14px',
    }}
  >
    <Spinner size={16} />
    <span>{label}</span>
  </div>
);

/** 表格首次加载的骨架行 */
export const SkeletonRows: React.FC<{ rows?: number; columns: number; label: string }> = ({ rows = 6, columns, label }) => {
  useLoadingCss();
  const widths = ['70%', '45%', '60%', '35%', '55%', '40%', '50%', '30%'];
  return (
    <>
      {Array.from({ length: rows }, (_, row) => (
        <tr key={row} aria-hidden={row > 0 ? 'true' : undefined}>
          {Array.from({ length: columns }, (__, col) => (
            <td key={col} style={{ padding: '14px 12px', borderBottom: `1px solid ${COLORS.border}` }}>
              {row === 0 && col === 0 ? <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{label}</span> : null}
              <div
                className="ai-um-anim"
                style={{
                  height: '12px',
                  width: col === 0 ? '16px' : widths[(row + col) % widths.length],
                  borderRadius: RADIUS.sm,
                  background: COLORS.bgHover,
                  animation: 'ai-um-pulse 1.4s ease-in-out infinite',
                  animationDelay: `${row * 0.08}s`,
                }}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
};
