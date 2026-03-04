import { useState, useEffect, useRef, useCallback } from 'react';
import React from 'react';

interface UseFloatingPanelOptions {
  defaultExpanded?: boolean;
  onCollapse?: () => void;
}

export function useFloatingPanel({ defaultExpanded, onCollapse }: UseFloatingPanelOptions) {
  const [isCollapsed, setIsCollapsed] = useState<boolean>(() => {
    if (defaultExpanded !== undefined) return !defaultExpanded;
    if (typeof window === 'undefined') return true;
    const saved = window.localStorage.getItem('ai_assistant_collapsed');
    if (saved === 'true') return true;
    if (saved === 'false') return false;
    return true;
  });
  const [position, setPosition] = useState({ bottom: 20, right: 20 });
  const [size, setSize] = useState({ width: 400, height: 500 });
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [resizeDirection, setResizeDirection] = useState<'width' | 'height' | null>(null);
  const [isMobile, setIsMobile] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);
  const dragStartPos = useRef({ x: 0, y: 0 });
  const resizeStartSize = useRef({ width: 0, height: 0 });
  const resizeStartMouse = useRef({ x: 0, y: 0 });

  const toggleCollapse = useCallback(() => {
    setIsCollapsed((prev) => {
      const next = !prev;
      try {
        if (!onCollapse) {
          window.localStorage.setItem('ai_assistant_collapsed', next ? 'true' : 'false');
        }
      } catch (e) {}
      if (next && onCollapse) onCollapse();
      return next;
    });
  }, [onCollapse]);

  // Mobile detection
  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // Drag handling
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    if (isMobile) return;
    setIsDragging(true);
    dragStartPos.current = {
      x: e.clientX - (window.innerWidth - position.right - size.width),
      y: e.clientY - (window.innerHeight - position.bottom - size.height)
    };
  }, [isMobile, position, size]);

  useEffect(() => {
    if (!isDragging) return;
    const handleDragMove = (e: MouseEvent) => {
      const newX = e.clientX - dragStartPos.current.x;
      const newY = e.clientY - dragStartPos.current.y;
      const newBottom = window.innerHeight - newY - size.height;
      const newRight = window.innerWidth - newX - size.width;
      setPosition({
        bottom: Math.max(0, Math.min(window.innerHeight - 100, newBottom)),
        right: Math.max(0, Math.min(window.innerWidth - 100, newRight))
      });
    };
    const handleDragEnd = () => setIsDragging(false);
    document.addEventListener('mousemove', handleDragMove);
    document.addEventListener('mouseup', handleDragEnd);
    return () => {
      document.removeEventListener('mousemove', handleDragMove);
      document.removeEventListener('mouseup', handleDragEnd);
    };
  }, [isDragging, size.width, size.height]);

  // Resize handling
  const handleResizeStart = useCallback((e: React.MouseEvent, direction: 'width' | 'height') => {
    if (isMobile) return;
    e.stopPropagation();
    setIsResizing(true);
    setResizeDirection(direction);
    resizeStartSize.current = { width: size.width, height: size.height };
    resizeStartMouse.current = { x: e.clientX, y: e.clientY };
  }, [isMobile, size]);

  useEffect(() => {
    if (!isResizing) return;
    const handleResizeMove = (e: MouseEvent) => {
      const deltaX = e.clientX - resizeStartMouse.current.x;
      const deltaY = e.clientY - resizeStartMouse.current.y;
      const maxHeight = Math.min(800, window.innerHeight * 0.8);
      const maxWidth = Math.min(900, window.innerWidth * 0.8);
      if (resizeDirection === 'width') {
        const newWidth = resizeStartSize.current.width - deltaX;
        setSize(prev => ({ ...prev, width: Math.max(300, Math.min(maxWidth, newWidth)) }));
      } else if (resizeDirection === 'height') {
        const newHeight = resizeStartSize.current.height + deltaY;
        setSize(prev => ({ ...prev, height: Math.max(360, Math.min(maxHeight, newHeight)) }));
      }
    };
    const handleResizeEnd = () => {
      setIsResizing(false);
      setResizeDirection(null);
      document.body.style.userSelect = '';
    };
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', handleResizeMove);
    document.addEventListener('mouseup', handleResizeEnd);
    return () => {
      document.removeEventListener('mousemove', handleResizeMove);
      document.removeEventListener('mouseup', handleResizeEnd);
      document.body.style.userSelect = '';
    };
  }, [isResizing, resizeDirection]);

  // Compute panel style
  const panelStyle: React.CSSProperties = isMobile ? {
    position: 'fixed', top: 0, left: 0, width: '100vw',
    height: isCollapsed ? '56px' : '100vh', background: '#f9fafb', zIndex: 1000,
    display: 'flex', flexDirection: 'column',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    transition: 'height 0.3s ease'
  } : {
    position: 'fixed', bottom: `${position.bottom}px`, right: `${position.right}px`,
    width: isCollapsed ? '64px' : `${size.width}px`,
    height: isCollapsed ? '64px' : `${size.height}px`,
    background: isCollapsed ? '#6366f1' : '#f9fafb',
    borderRadius: isCollapsed ? '50%' : '12px',
    boxShadow: isCollapsed
      ? '0 8px 16px rgba(99, 102, 241, 0.4), 0 2px 8px rgba(99, 102, 241, 0.3)'
      : '0 10px 25px rgba(0, 0, 0, 0.15), 0 4px 10px rgba(0, 0, 0, 0.1)',
    zIndex: 1000, display: 'flex', flexDirection: 'column',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    overflow: 'hidden', transition: 'all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)',
    cursor: isCollapsed ? 'pointer' : 'default'
  };

  return {
    isCollapsed, toggleCollapse, position, size, isDragging, isResizing,
    resizeDirection, isMobile, panelRef, panelStyle,
    handleDragStart, handleResizeStart,
  };
}
