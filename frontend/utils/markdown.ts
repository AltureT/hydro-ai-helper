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

export function renderStreamingMarkdown(content: string): string {
  let patched = content;
  // Auto-close unclosed fenced code blocks (odd number of ```)
  const fenceCount = (patched.match(/^```/gm) || []).length;
  if (fenceCount % 2 !== 0) {
    patched += '\n```';
  }
  // Auto-close unclosed inline code
  const backtickCount = (patched.match(/`/g) || []).length;
  if (backtickCount % 2 !== 0) {
    patched += '`';
  }
  return DOMPurify.sanitize(sharedRenderer.render(patched));
}
