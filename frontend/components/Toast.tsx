import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  COLORS, SPACING, RADIUS, SHADOWS, ZINDEX, TRANSITIONS, ANIMATIONS, keyframeStyles, FONT_FAMILY,
} from '../utils/styles';

export interface ToastMessage {
  id: number;
  text: string;
  type: 'success' | 'warning' | 'error' | 'info';
}

export interface ToastProps {
  messages: ToastMessage[];
  onDismiss: (id: number) => void;
}

const typeColorMap = {
  success: { bar: COLORS.success, bg: COLORS.successBg, text: COLORS.successText },
  warning: { bar: COLORS.warning, bg: COLORS.warningBg, text: COLORS.warningText },
  error: { bar: COLORS.error, bg: COLORS.errorBg, text: COLORS.errorText },
  info: { bar: COLORS.info, bg: COLORS.infoBg, text: COLORS.infoText },
};

const containerStyle: React.CSSProperties = {
  position: 'fixed',
  top: '60px',
  right: SPACING.lg,
  zIndex: ZINDEX.toast,
  display: 'flex',
  flexDirection: 'column',
  gap: SPACING.sm,
  pointerEvents: 'none',
};

const getItemStyle = (type: ToastMessage['type']): React.CSSProperties => {
  const c = typeColorMap[type];
  return {
    display: 'flex',
    alignItems: 'stretch',
    minWidth: '280px',
    maxWidth: '420px',
    backgroundColor: c.bg,
    borderRadius: RADIUS.md,
    boxShadow: SHADOWS.lg,
    overflow: 'hidden',
    animation: `${ANIMATIONS.fadeIn}, ${ANIMATIONS.slideInRight}`,
    pointerEvents: 'auto',
    fontFamily: FONT_FAMILY,
  };
};

const getBarStyle = (type: ToastMessage['type']): React.CSSProperties => ({
  width: '4px',
  flexShrink: 0,
  backgroundColor: typeColorMap[type].bar,
});

const getBodyStyle = (type: ToastMessage['type']): React.CSSProperties => ({
  flex: 1,
  padding: `${SPACING.md} ${SPACING.base}`,
  fontSize: '14px',
  lineHeight: 1.5,
  color: typeColorMap[type].text,
});

const dismissBtnStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '32px',
  flexShrink: 0,
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  fontSize: '16px',
  color: COLORS.textMuted,
  transition: `color ${TRANSITIONS.fast}`,
  padding: 0,
};

export const Toast: React.FC<ToastProps> = ({ messages, onDismiss }) => {
  if (messages.length === 0) return null;

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: keyframeStyles }} />
      <div style={containerStyle}>
        {messages.map((msg) => (
          <div key={msg.id} style={getItemStyle(msg.type)}>
            <div style={getBarStyle(msg.type)} />
            <div style={getBodyStyle(msg.type)}>{msg.text}</div>
            <button
              type="button"
              style={dismissBtnStyle}
              onClick={() => onDismiss(msg.id)}
              aria-label="Dismiss"
            >
              &times;
            </button>
          </div>
        ))}
      </div>
    </>
  );
};

let nextId = 1;

export const useToast = (autoDismissMs = 3000) => {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismissToast = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback((text: string, type: ToastMessage['type'] = 'info') => {
    const id = nextId++;
    setToasts((prev) => [...prev, { id, text, type }]);
    if (autoDismissMs > 0) {
      const timer = setTimeout(() => {
        timersRef.current.delete(id);
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, autoDismissMs);
      timersRef.current.set(id, timer);
    }
    return id;
  }, [autoDismissMs]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  return { toasts, showToast, dismissToast };
};
