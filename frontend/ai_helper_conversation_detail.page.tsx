/**
 * 教师端对话详情页面
 * 挂载点: 通过 URL 直接访问 (后续可添加到后台导航)
 *
 * 说明:
 * - HydroOJ 默认的 NamedPage 工具位于 ui-default 主题，但在插件前端构建阶段不会自动提供 `vj/misc/Page`
 * - 挂载点 ID 需要与模板 templates/ai-helper/teacher_conversation_detail.html 中定义的一致
 */

import React from 'react';
import * as ReactDOM from 'react-dom';
import ConversationDetail from './teacher/ConversationDetail';

/**
 * 从 URL 中提取 conversationId
 */
const getConversationIdFromUrl = (): string | null => {
  const match = window.location.pathname.match(/\/ai-helper\/conversations\/([a-f0-9]{24})/i);
  return match ? match[1] : null;
};

/**
 * 挂载对话详情组件
 */
const renderTeacherConversationDetailPage = () => {
  const conversationId = getConversationIdFromUrl();
  if (!conversationId) {
    return;
  }

  const container = document.getElementById('ai-helper-conversation-detail-root');
  if (!container) {
    console.debug('[AI Helper] conversation detail root not found, skip render');
    return;
  }

  const reactDom = ReactDOM as unknown as {
    createRoot?: (el: Element | DocumentFragment) => { render: (node: React.ReactNode) => void };
    render?: (node: React.ReactNode, el: Element | DocumentFragment | null) => void;
  };

  if (typeof reactDom.createRoot === 'function') {
    const root = reactDom.createRoot(container);
    root.render(<ConversationDetail conversationId={conversationId} />);
  } else if (typeof reactDom.render === 'function') {
    reactDom.render(<ConversationDetail conversationId={conversationId} />, container);
  }
};

// 等待 DOM 加载完成后自动执行
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', renderTeacherConversationDetailPage, { once: true });
} else {
  renderTeacherConversationDetailPage();
}
