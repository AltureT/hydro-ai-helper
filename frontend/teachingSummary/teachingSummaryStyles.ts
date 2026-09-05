import { COLORS } from '../utils/styles';

// Scoped to this report; other plugin pages retain their existing Markdown theme.
export const teachingSummaryStyles = `
  .ai-teaching-summary { --report-muted: #64748b; }
  .ai-teaching-summary button { font-family: inherit; }
  .ai-teaching-summary button:focus-visible, .ai-teaching-summary summary:focus-visible {
    outline: 2px solid ${COLORS.primary}; outline-offset: 3px;
  }
  .ai-teaching-summary .report-section { margin: 28px 0; padding-top: 24px; border-top: 1px solid ${COLORS.border}; }
  .ai-teaching-summary .report-section-header { display: flex; align-items: center; justify-content: space-between;
    flex-wrap: wrap; gap: 12px; margin-bottom: 16px; }
  .ai-teaching-summary .report-section-title { font-size: 16px; font-weight: 600; margin: 0; color: ${COLORS.textPrimary}; }
  .ai-teaching-summary .report-section-body { min-width: 0; }
  .ai-teaching-summary .report-note { color: var(--report-muted); font-size: 13px; line-height: 1.6; margin: 8px 0 16px; }
  .ai-teaching-summary .report-disclosure > summary { cursor: pointer; font-size: 14px; font-weight: 600; color: ${COLORS.textSecondary}; }
  .ai-teaching-summary .report-disclosure[open] > summary { margin-bottom: 16px; }
  .ai-teaching-summary .report-reading { max-width: 76ch; }
  .ai-teaching-summary .markdown-body { min-width: 0; overflow-x: auto; }
  .ai-teaching-summary .markdown-body > :first-child { margin-top: 0; }
  .ai-teaching-summary .markdown-body > :last-child { margin-bottom: 0; }
  .ai-teaching-summary .markdown-body :not(pre) > code { color: ${COLORS.textPrimary}; padding: 1px 4px; }
  .ai-teaching-summary .markdown-body blockquote { border-left: 2px solid ${COLORS.border}; background: ${COLORS.bgPage}; }
  .ai-teaching-summary .markdown-body table { width: 100%; min-width: 520px; }
  .ai-teaching-summary .markdown-body th { white-space: nowrap; letter-spacing: 0; font-size: 13px; }
  .ai-teaching-summary .markdown-body th, .ai-teaching-summary .markdown-body td {
    border: 0; border-bottom: 1px solid ${COLORS.border}; padding: 12px; vertical-align: top;
  }
  .ai-teaching-summary .review-actions { list-style: none; padding: 0; margin: 0; }
  .ai-teaching-summary .review-action { display: grid; grid-template-columns: 28px minmax(0, 1fr);
    gap: 12px; padding: 18px 0; border-bottom: 1px solid ${COLORS.border}; }
  .ai-teaching-summary .review-action:first-child { padding-top: 0; }
  .ai-teaching-summary .review-action:last-child { border-bottom: 0; }
  .ai-teaching-summary .review-priority { font-size: 14px; font-weight: 600; color: ${COLORS.primary}; padding-top: 2px; }
  .ai-teaching-summary .review-action-text { font-size: 15px; }
  .ai-teaching-summary .review-evidence { display: flex; align-items: baseline; gap: 8px; margin-top: 8px; color: var(--report-muted); }
  .ai-teaching-summary .review-evidence .markdown-body { color: ${COLORS.textSecondary}; font-size: 13px; }
  .ai-teaching-summary .finding-row { border-bottom: 1px solid ${COLORS.border}; }
  .ai-teaching-summary .finding-toggle { display: grid; grid-template-columns: minmax(0, 1fr) auto;
    width: 100%; gap: 12px; align-items: center; padding: 16px 0; text-align: left;
    border: 0; border-radius: 0; background: transparent; color: inherit; }
  .ai-teaching-summary button.finding-toggle:hover { background: ${COLORS.bgPage}; cursor: pointer; }
  .ai-teaching-summary .finding-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 6px;
    color: var(--report-muted); font-size: 12px; }
  .ai-teaching-summary .finding-title { font-size: 14px; font-weight: 500; line-height: 1.65; overflow-wrap: anywhere; }
  .ai-teaching-summary .finding-expand { color: ${COLORS.primary}; font-size: 12px; white-space: nowrap; }
  .ai-teaching-summary .homework-toolbar { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
  .ai-teaching-summary .homework-tabs { display: flex; gap: 20px; margin-bottom: 20px; border-bottom: 1px solid ${COLORS.border}; }
  .ai-teaching-summary .homework-tabs button { padding: 10px 0; font-size: 14px; border: 0; border-bottom: 2px solid transparent;
    background: transparent; color: ${COLORS.textSecondary}; cursor: pointer; }
  .ai-teaching-summary .homework-tabs button[aria-pressed="true"] { color: ${COLORS.primary}; border-bottom-color: ${COLORS.primary}; font-weight: 600; }
  @media (max-width: 600px) {
    .ai-teaching-summary .report-section { margin: 24px 0; padding-top: 20px; }
    .ai-teaching-summary .finding-toggle { gap: 8px; }
    .ai-teaching-summary .review-action { grid-template-columns: 20px minmax(0, 1fr); gap: 8px; }
    .ai-teaching-summary .review-evidence { display: block; }
    .ai-teaching-summary .review-evidence > span { display: none; }
  }
`;
