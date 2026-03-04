import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import DOMPurify from 'dompurify';
import texmath from 'markdown-it-texmath';
import katex from 'katex';
import 'katex/dist/katex.min.css';

export const PURIFY_CONFIG: DOMPurify.Config = {
  ALLOWED_TAGS: [
    'p', 'pre', 'code', 'span', 'strong', 'em', 'ul', 'ol', 'li', 'a',
    'h1', 'h2', 'h3', 'h4', 'blockquote', 'table', 'thead', 'tbody',
    'tr', 'td', 'th', 'br', 'hr', 'del', 'img', 'div', 'sup', 'sub',
    // MathML tags for KaTeX
    'math', 'semantics', 'annotation', 'mrow', 'mi', 'mo', 'mn',
    'msup', 'msub', 'mfrac', 'munder', 'mover', 'msqrt', 'mroot',
    'mtable', 'mtr', 'mtd', 'mtext', 'mspace', 'mpadded', 'menclose',
    'mstyle', 'merror', 'mphantom',
    // SVG tags for KaTeX rendering
    'svg', 'path', 'line', 'rect', 'circle', 'g', 'use', 'defs',
  ],
  ALLOWED_ATTR: [
    'class', 'href', 'target', 'rel', 'src', 'alt', 'style',
    // MathML attributes
    'mathvariant', 'encoding', 'xmlns', 'display', 'stretchy',
    'fence', 'separator', 'lspace', 'rspace', 'accent', 'accentunder',
    'columnalign', 'rowalign', 'columnspacing', 'rowspacing',
    'linethickness', 'width', 'height', 'depth',
    // SVG attributes
    'd', 'viewBox', 'fill', 'stroke', 'stroke-width', 'transform',
    'x', 'y', 'x1', 'y1', 'x2', 'y2', 'r', 'cx', 'cy',
    'xlink:href', 'preserveAspectRatio',
  ],
  ALLOW_DATA_ATTR: false,
};

export function createMarkdownRenderer(): MarkdownIt {
  const md = new MarkdownIt({
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

  md.use(texmath, {
    engine: katex,
    delimiters: 'dollars',
  });

  return md;
}

const sharedRenderer = createMarkdownRenderer();

export function renderMarkdown(content: string): string {
  return DOMPurify.sanitize(sharedRenderer.render(content), PURIFY_CONFIG);
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
  return DOMPurify.sanitize(sharedRenderer.render(patched), PURIFY_CONFIG);
}
