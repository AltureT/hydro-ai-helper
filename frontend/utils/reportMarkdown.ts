import DOMPurify from 'dompurify';
import { createMarkdownRenderer, PURIFY_CONFIG } from './markdown';
import { iconMarkup, IconName } from '../components/iconPaths';

const reportMarkers: Record<string, IconName> = {
  '✅': 'checkCircle', '🔶': 'warning', '⬜': 'circle', '💡': 'lightbulb',
  '⚠': 'warning', '❌': 'close', '⏳': 'clock',
};

/** Restyle known report decoration without touching source, code, math, or links. */
export function createReportMarkdownRenderer() {
  const renderer = createMarkdownRenderer();
  renderer.core.ruler.after('inline', 'report_markers', state => {
    state.tokens.forEach((token, index) => {
      if (token.type !== 'inline' || !token.children?.length) return;
      const first = token.children[0];
      if (first.type !== 'text') return;
      const parent = state.tokens[index - 1]?.type;
      if (parent === 'heading_open') {
        first.content = first.content.replace(/^(?:📊|📋|👥|📝|🧠|🔍|🛠️?)\s+(?=\S)/u, '');
        return;
      }
      if (parent !== 'td_open' && parent !== 'paragraph_open') return;
      const match = first.content.match(/^(✅|🔶|⬜|💡|⚠️?|❌|⏳)\s*(?=\S)/u);
      if (!match || first.content.slice(match[0].length).trim() === '') return;
      const marker = match[1].replace(/\uFE0F/g, '');
      const icon = new state.Token('report_icon', '', 0);
      icon.content = reportMarkers[marker];
      first.content = first.content.slice(match[0].length);
      token.children.unshift(icon);
    });
  });
  renderer.renderer.rules.report_icon = (tokens, index) => `${iconMarkup(tokens[index].content as IconName)} `;
  renderer.renderer.rules.table_open = () => '<div class="report-table-scroll" tabindex="0"><table>\n';
  renderer.renderer.rules.table_close = () => '</table></div>\n';
  return renderer;
}

const reportRenderer = createReportMarkdownRenderer();

export function renderReportMarkdown(content: string): string {
  return DOMPurify.sanitize(reportRenderer.render(content), {
    ...PURIFY_CONFIG,
    ALLOWED_ATTR: [...PURIFY_CONFIG.ALLOWED_ATTR!, 'stroke-linecap', 'stroke-linejoin', 'focusable', 'tabindex'],
  });
}

export function getLearningSummaryPreview(content: string | null): string {
  if (!content) return '';
  for (const token of reportRenderer.parse(content, {})) {
    if (token.type !== 'inline') continue;
    const text = (token.children || []).map(child => {
      if (['text', 'code_inline', 'math_inline'].includes(child.type)) return child.content;
      return child.type === 'softbreak' || child.type === 'hardbreak' ? ' ' : '';
    }).join('');
    const match = text.match(/^(?:下一步|Next step)\s*[：:]\s*(.+)/i);
    if (match) return match[1];
  }
  return '';
}

export const reportMarkdownStyles = `
  .ai-report-content .ai-icon { display: inline-block; vertical-align: -0.15em; flex-shrink: 0; }
  .ai-report-content .markdown-body { overflow-wrap: anywhere; }
  .ai-report-content .markdown-body > :first-child { margin-top: 0; }
  .ai-report-content .report-table-scroll { max-width: 100%; overflow-x: auto; margin: 12px 0; }
  .ai-report-content .report-table-scroll:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
  .ai-report-content .markdown-body table { display: table; width: 100%; margin: 0; border: 0; }
  .ai-report-content .markdown-body th, .ai-report-content .markdown-body td { border: 0; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  .ai-report-content .markdown-body th { white-space: nowrap; background: #f6f8fb; letter-spacing: 0; }
  .ai-report-content .markdown-body td { min-width: 112px; line-height: 1.7; }
  .ai-report-content .markdown-body td:last-child { min-width: 220px; width: 60%; }
  .ai-report-content .markdown-body :not(pre) > code { color: #334155; }
`;
