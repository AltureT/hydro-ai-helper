import React from 'react';
import { ScoreboardTabContainer } from './components/ScoreboardTabContainer';
import { renderComponent } from './utils/renderHelper';
import { ErrorBoundary } from './components/ErrorBoundary';

// ─── URL parsing ──────────────────────────────────────────────────────────────

const SCOREBOARD_PATTERNS: RegExp[] = [
  /\/homework\/([a-f0-9]{24})\/scoreboard/,
  /\/contest\/([a-f0-9]{24})\/scoreboard/,
];

function parseScoreboardUrl(): { domainId: string; contestId: string } | null {
  const pathname = window.location.pathname;
  for (const pattern of SCOREBOARD_PATTERNS) {
    const match = pathname.match(pattern);
    if (match) {
      const domainId = (window as any).UiContext?.domainId || 'system';
      return { domainId, contestId: match[1] };
    }
  }
  return null;
}

// ─── Permission detection ─────────────────────────────────────────────────────

const PRIV_READ_RECORD_CODE = 1 << 7;

function hasTeacherPrivilege(): boolean {
  const ctx = (window as any).UserContext;
  if (!ctx || !ctx._id) return false;

  const priv = ctx.priv;
  if (typeof priv === 'number') {
    if (priv < 0) return true;
    if ((priv & PRIV_READ_RECORD_CODE) !== 0) return true;
  }

  const role = ctx.role;
  if (typeof role === 'string' && role !== 'default' && role !== 'guest' && role !== '') return true;

  return false;
}

// ─── Container insertion ──────────────────────────────────────────────────────

const CONTAINER_ID = 'ai-scoreboard-tab-root';

function insertContainer(): HTMLDivElement | null {
  if (document.getElementById(CONTAINER_ID)) return null;

  const container = document.createElement('div');
  container.id = CONTAINER_ID;

  const sectionHeader = document.querySelector('.section__header');
  if (sectionHeader && sectionHeader.parentElement) {
    sectionHeader.parentElement.insertBefore(container, sectionHeader.nextSibling);
  } else {
    const scoreboard = document.querySelector('[data-fragment-id="scoreboard"]');
    if (scoreboard && scoreboard.parentElement) {
      scoreboard.parentElement.insertBefore(container, scoreboard);
    } else {
      const section = document.querySelector('.section.visible') || document.body;
      section.appendChild(container);
    }
  }
  return container;
}

// ─── Initialization ───────────────────────────────────────────────────────────

function initScoreboardIntegration() {
  const parsed = parseScoreboardUrl();
  if (!parsed) return;

  const container = insertContainer();
  if (!container) return;

  const isTeacher = hasTeacherPrivilege();

  renderComponent(
    <ErrorBoundary>
      <ScoreboardTabContainer
        domainId={parsed.domainId}
        contestId={parsed.contestId}
        isTeacher={isTeacher}
      />
    </ErrorBoundary>,
    container,
  );
}

// ─── Initialization: handle both full page load and PJAX navigation ─────────

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initScoreboardIntegration, { once: true });
} else {
  initScoreboardIntegration();
}

if (typeof (window as any).$ === 'function') {
  (window as any).$(document).on('vjContentNew', () => {
    setTimeout(initScoreboardIntegration, 50);
  });
} else {
  document.addEventListener('vjContentNew', () => {
    setTimeout(initScoreboardIntegration, 50);
  });
}
