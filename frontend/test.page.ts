/**
 * AI Helper 前端测试脚本
 * 在题目详情页显示一个最小提示，验证前端集成链路
 */

import pkg from '../package.json';

/**
 * 简易页面就绪逻辑：
 * HydroOJ 默认的 NamedPage 工具位于 ui-default 主题中，
 * 但在插件的前端构建阶段不会自动提供 `vj/misc/Page` 模块。
 * 这里改用最小的 DOMContentLoaded 监听，并根据 pathname 判断是否为题目详情页。
 */
const isProblemDetailPage = () => /^\/p\/.+/.test(window.location.pathname);

const initAiHelperBanner = () => {
  if (!isProblemDetailPage()) return;

  // 创建提示元素
  const notification = document.createElement('div');
  notification.id = 'ai-helper-notification';
  notification.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    background: #f5f3ff;
    color: #5b21b6;
    padding: 15px 20px;
    border-radius: 8px;
    border: 1px solid #e0ddff;
    box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    z-index: 9999;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 14px;
    max-width: 300px;
  `;

  notification.innerHTML = `
    <div style="font-weight: bold; margin-bottom: 5px;">
      ✓ AI 助手插件已加载
    </div>
    <div style="font-size: 12px; opacity: 0.7;">
      版本: ${pkg.version}
    </div>
  `;

  // 添加到页面
  document.body.appendChild(notification);

  // 测试后端路由连接
  fetch('/ai-helper/hello')
    .then(response => response.json())
    .then(data => {
      // 更新提示显示后端连接成功
      const backendStatus = document.createElement('div');
      backendStatus.style.cssText = `
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid #e0ddff;
        font-size: 12px;
      `;
      backendStatus.textContent = '✓ 后端连接正常';
      notification.appendChild(backendStatus);
    })
    .catch(() => {
      // 显示错误信息
      const errorStatus = document.createElement('div');
      errorStatus.style.cssText = `
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid #e0ddff;
        font-size: 12px;
        color: #dc2626;
      `;
      errorStatus.textContent = '⚠ 后端连接失败';
      notification.appendChild(errorStatus);
    });

  // 5秒后淡出提示
  setTimeout(() => {
    notification.style.transition = 'opacity 0.5s';
    notification.style.opacity = '0';
    setTimeout(() => notification.remove(), 500);
  }, 2000);
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAiHelperBanner, { once: true });
} else {
  initAiHelperBanner();
}
