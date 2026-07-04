/**
 * 题目文件页面集成（/p/:pid/files）
 *
 * 在题目文件管理页注入「AI 生成测试数据」面板。
 * 权限由后端校验（题目编辑权限）；面板在无权限时自动隐藏。
 */

import React from 'react';
import { renderComponent } from './utils/renderHelper';
import { ErrorBoundary } from './components/ErrorBoundary';
import { TestdataGenPanel } from './testdataGen/TestdataGenPanel';

// 支持的题目文件页 URL 模式
const PROBLEM_FILES_PATTERNS: RegExp[] = [
  /^\/p\/([^/]+)\/files\/?$/, // 根域：/p/D3102/files
  /^\/d\/[^/]+\/p\/([^/]+)\/files\/?$/, // 域下：/d/:domain/p/:pid/files
];

function extractProblemId(): string | null {
  const pathname = window.location.pathname;
  for (const pattern of PROBLEM_FILES_PATTERNS) {
    const match = pathname.match(pattern);
    if (match && match[1]) return decodeURIComponent(match[1]);
  }
  return null;
}

const CONTAINER_ID = 'ai-testdata-gen-root';

/**
 * 将容器插入主列（测试数据/附加文件卡片所在列）的末尾；
 * 找不到预期结构时退回到 main 元素末尾。
 */
function insertContainer(): HTMLDivElement | null {
  if (document.getElementById(CONTAINER_ID)) return null;

  const container = document.createElement('div');
  container.id = CONTAINER_ID;

  const firstSection = document.querySelector('.main .section, .row .section');
  const column = firstSection?.closest('[class*="columns"]') as HTMLElement | null;
  if (column) {
    column.appendChild(container);
    return container;
  }
  const main = document.querySelector('.main') || document.body;
  main.appendChild(container);
  return container;
}

function initTestdataGen() {
  const problemId = extractProblemId();
  if (!problemId) return;

  // 便于排查"面板不出现"：F12 控制台无此日志 = 前端 bundle 未包含本插件
  // （UI 未重建或插件被回滚到旧版本）
  console.debug(`[AI-Helper] testdata-gen panel init: problemId=${problemId}`);

  const container = insertContainer();
  if (!container) return;

  renderComponent(
    <ErrorBoundary>
      <TestdataGenPanel problemId={problemId} />
    </ErrorBoundary>,
    container,
  );
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initTestdataGen, { once: true });
} else {
  initTestdataGen();
}
