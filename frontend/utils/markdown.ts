import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import DOMPurify from 'dompurify';

export function createMarkdownRenderer(): MarkdownIt {
  return new MarkdownIt({
    html: false,
    linkify: true,
    typographer: true,
    highlight: (str, lang) => {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
        } catch (err) {
          console.error('[AI Helper] Highlight.js error:', err);
        }
      }
      return '';
    }
  });
}

const sharedRenderer = createMarkdownRenderer();

export function renderMarkdown(content: string): string {
  return DOMPurify.sanitize(sharedRenderer.render(content));
}
