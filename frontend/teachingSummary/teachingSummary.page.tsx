/**
 * Teaching Summary page entry point.
 * HydroOJ builder scans frontend/ root for *.page.tsx — this file
 * re-exports the self-mounting logic from the teachingSummary subdirectory.
 *
 * Registers TeachingSummaryPanel on homework/contest scoreboard pages
 * by injecting into [data-teaching-summary-root] or creating a container.
 */

import React from 'react';
import { TeachingSummaryPanel } from './TeachingSummaryPanel';
import { renderComponent } from '../utils/renderHelper';
import { ErrorBoundary } from '../components/ErrorBoundary';

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
      // Extract domainId from /d/:domainId/ path prefix if present
      const domainMatch = pathname.match(/^\/d\/([^/]+)\//);
      const domainId = domainMatch
        ? domainMatch[1]
        : ((window as any).UiContext?.domainId || 'system');
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

const CONTAINER_ID = 'ai-teaching-summary-root';

function insertContainer(): HTMLDivElement | null {
  // Support explicit mount point
  const explicit = document.querySelector('[data-teaching-summary-root]');
  if (explicit) {
    return explicit as HTMLDivElement;
  }

  // Prevent double-mount
  if (document.getElementById(CONTAINER_ID)) return null;

  const container = document.createElement('div');
  container.id = CONTAINER_ID;
  container.style.margin = '16px 0';
  container.style.padding = '0 16px';

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

function initTeachingSummaryPanel() {
  const parsed = parseScoreboardUrl();
  if (!parsed) return;

  // Only show for teachers/admins (requires PRIV_READ_RECORD_CODE)
  if (!hasTeacherPrivilege()) return;

  const container = insertContainer();
  if (!container) return;

  renderComponent(
    <ErrorBoundary>
      <TeachingSummaryPanel
        domainId={parsed.domainId}
        contestId={parsed.contestId}
      />
    </ErrorBoundary>,
    container,
  );
}

// ─── Initialization: handle both full page load and PJAX navigation ──────────

// 1. Full page load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initTeachingSummaryPanel, { once: true });
} else {
  initTeachingSummaryPanel();
}

// 2. PJAX navigation: HydroOJ triggers jQuery 'vjContentNew' on replaced fragments
if (typeof (window as any).$ === 'function') {
  (window as any).$(document).on('vjContentNew', () => {
    setTimeout(initTeachingSummaryPanel, 50);
  });
} else {
  document.addEventListener('vjContentNew', () => {
    setTimeout(initTeachingSummaryPanel, 50);
  });
}
