export const batchSummaryStyles = `
  .ai-batch-summary { color: #233247; max-width: 1120px; margin: 0 auto; width: 100%; font-family: inherit; }
  .ai-batch-summary button { font-family: inherit; gap: 6px; }
  .ai-batch-summary button:focus-visible, .ai-batch-summary textarea:focus-visible { outline: 2px solid #2563eb; outline-offset: 3px; }
  .ai-batch-summary button:disabled { opacity: .55; cursor: wait; }
  .ai-batch-summary .batch-overview { display: flex; justify-content: space-between; gap: 12px 24px; flex-wrap: wrap; padding: 4px 0 18px; }
  .ai-batch-summary .batch-generation, .ai-batch-summary .batch-publication { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; font-size: 13px; }
  .ai-batch-summary .batch-generation > :first-child { font-size: 16px; font-weight: 600; }
  .ai-batch-summary .batch-publication { color: #526174; }
  .ai-batch-summary .batch-subtle { color: #526174; }
  .ai-batch-summary .batch-failed { color: #991b1b; }
  .ai-batch-summary .batch-toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding-bottom: 18px; }
  .ai-batch-summary .batch-student-list { border-top: 1px solid #e2e8f0; }
  .ai-batch-summary .batch-student-row { border-bottom: 1px solid #e2e8f0; background: #fff; }
  .ai-batch-summary .batch-student-toggle { display: flex; align-items: center; width: 100%; border: 0; background: transparent; text-align: left; gap: 12px; padding: 16px 10px; color: inherit; cursor: pointer; }
  .ai-batch-summary .batch-student-toggle:hover, .ai-batch-summary .batch-student-row[data-expanded="true"] > button { background: #f6f8fb; }
  .ai-batch-summary .batch-student-toggle > .ai-icon { color: #526174; }
  .ai-batch-summary .batch-student-identity { min-width: 0; flex: 1; font-size: 14px; }
  .ai-batch-summary .batch-student-identity strong { overflow-wrap: anywhere; }
  .ai-batch-summary .batch-student-preview { display: block; margin-top: 5px; font-size: 13px; color: #526174; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .ai-batch-summary .batch-status { border-radius: 4px; padding: 3px 7px; font-size: 12px; white-space: nowrap; color: #526174; background: #f1f5f9; }
  .ai-batch-summary .batch-status[data-status="draft"] { color: #87530e; background: #fff8e8; }
  .ai-batch-summary .batch-status[data-status="published"] { color: #176645; background: #edf8f2; }
  .ai-batch-summary .batch-status[data-status="failed"] { color: #991b1b; background: #fef2f2; }
  .ai-batch-summary .batch-student-body { padding: 20px 36px 24px; }
  .ai-batch-summary .summary-actions { display: flex; justify-content: flex-end; gap: 8px; padding-top: 16px; margin-top: 16px; border-top: 1px solid #e2e8f0; }
  @media (max-width: 600px) {
    .ai-batch-summary .batch-student-body { padding: 16px 8px; }
    .ai-batch-summary .batch-toolbar > div:empty { display: none; }
    .ai-batch-summary .batch-toolbar button { font-size: 13px; padding: 7px 10px; }
  }
`;
