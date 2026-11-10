/**
 * 负责老师视图挂载入口
 * 路由: /ai-helper/class 和 /d/:domainId/ai-helper/class
 */

import React from 'react';
import { renderComponent } from './utils/renderHelper';
import ClassTeacherPage from './teacher/ClassTeacherPage';
import { ErrorBoundary } from './components/ErrorBoundary';

const isClassTeacherPage = () => {
  const pathname = window.location.pathname;
  return pathname === '/ai-helper/class' || /^\/d\/[^/]+\/ai-helper\/class$/.test(pathname);
};

const renderClassTeacherPage = () => {
  if (!isClassTeacherPage()) return;
  const container = document.getElementById('ai-helper-class-teacher-root');
  if (!container) return;
  renderComponent(<ErrorBoundary><ClassTeacherPage /></ErrorBoundary>, container);
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', renderClassTeacherPage, { once: true });
} else {
  renderClassTeacherPage();
}
