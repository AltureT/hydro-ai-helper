export const teachingReviewStyles = `
  .ai-teaching-review { padding: 24px; color: #233247; }
  .ai-teaching-review .teaching-review-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 24px; padding: 22px 8px; color: inherit; text-decoration: none; border-bottom: 1px solid #e2e8f0; }
  .ai-teaching-review .teaching-review-row:hover { background: #f6f8fb; }
  .ai-teaching-review a:focus-visible, .ai-teaching-review button:focus-visible { outline: 2px solid #2563eb; outline-offset: 3px; }
  .ai-teaching-review .review-row-content { min-width: 0; }
  .ai-teaching-review .review-row-title { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px 10px; font-size: 16px; line-height: 1.5; font-weight: 600; overflow-wrap: anywhere; }
  .ai-teaching-review .review-row-meta { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-top: 6px; color: #526174; font-size: 12px; }
  .ai-teaching-review .review-row-finding { color: #334155; font-size: 14px; line-height: 1.7; margin: 12px 0 8px; overflow-wrap: anywhere; }
  .ai-teaching-review .review-finding-label { color: #526174; font-size: 12px; margin-right: 10px; }
  .ai-teaching-review .review-row-signals { display: flex; flex-wrap: wrap; gap: 16px; font-size: 12px; color: #526174; }
  .ai-teaching-review .review-row-action { display: flex; flex-direction: column; justify-content: center; align-items: flex-end; gap: 12px; font-size: 12px; }
  .ai-teaching-review .review-open { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; color: #245cce; font-weight: 500; font-size: 13px; }
  @media (max-width: 600px) {
    .ai-teaching-review { padding: 16px; }
    .ai-teaching-review .teaching-review-row { grid-template-columns: minmax(0, 1fr); gap: 12px; padding: 18px 0; }
    .ai-teaching-review .review-row-action { flex-direction: row; justify-content: space-between; align-items: center; }
    .ai-teaching-review .review-row-title { font-size: 15px; }
  }
`;
