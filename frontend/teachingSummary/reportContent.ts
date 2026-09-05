import MarkdownIt from 'markdown-it';

// Parse structure without rendering HTML. Fenced code is never treated as a heading.
const parser = new MarkdownIt({ html: false });

function visibleInlineText(children: ReturnType<MarkdownIt['parse']>[number]['children']): string {
  return (children || []).map(token => {
    if (token.type === 'softbreak' || token.type === 'hardbreak') return '\n';
    return token.type === 'text' || token.type === 'code_inline' ? token.content : '';
  }).join('');
}

function isTeacherLabel(text: string): boolean {
  // Formatting and decorative prefixes do not change a heading's audience.
  const label = text.trim().replace(/^[\p{P}\p{S}\s]+/u, '');
  return /教师参考|参考答案|挖空点说明/.test(label)
    || /^(?:答案|解答|解析|answer(?:\s+key)?|solution)(?:$|[\s:：（(])/i.test(label);
}

function containsAnswerBlock(markdown: string): boolean {
  return parser.parse(markdown, {}).some(token => {
    if (token.type !== 'inline') return false;
    const text = visibleInlineText(token.children);
    return isTeacherLabel(text) || /(?:答案|解答|解析|answer|solution)\s*[:：]/i.test(text);
  });
}

export interface ReviewAction {
  priority: string;
  problem: string;
  action: string;
}

/** Convert only the known three-column review table; preserve other reports verbatim. */
export function parseReviewActions(markdown: string): ReviewAction[] | null {
  const environment: { references?: Record<string, unknown> } = {};
  const tokens = parser.parse(markdown, environment);
  // Reference definitions are document-level state and cannot be rendered per cell.
  if (Object.keys(environment.references || {}).length) return null;
  if (tokens[0]?.type !== 'table_open' || tokens[tokens.length - 1]?.type !== 'table_close'
    || tokens.filter(token => token.type === 'table_open').length !== 1) return null;
  const rows: string[][] = [];
  for (const token of tokens) {
    if (token.type === 'tr_open') rows.push([]);
    if (token.type === 'inline') rows[rows.length - 1]?.push(token.content);
  }
  const [header, ...body] = rows;
  if (header?.length !== 3 || !/优先级/.test(header[0]) || !/问题/.test(header[1])
    || !/动作/.test(header[2]) || !body.length || body.some(row => row.length !== 3)) return null;
  return body.map(([priority, problem, action]) => ({ priority, problem, action }));
}

export interface StudentHomework {
  /** Null means the stored document could not be separated reliably. */
  studentMarkdown: string | null;
  questionCount: number;
}

/**
 * Student export is an allowlist of the generator's exercise and variation sections.
 * Unknown formats remain available to the teacher, with one-click export disabled.
 * Never copy the original document as a fallback: it can contain reference answers.
 */
export function prepareStudentHomework(markdown: string): StudentHomework {
  const unavailable = { studentMarkdown: null, questionCount: 0 };
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const normalized = lines.join('\n');
  const environment: { references?: Record<string, unknown> } = {};
  const tokens = parser.parse(normalized, environment);
  if (Object.keys(environment.references || {}).length) return unavailable;
  const headings = tokens.flatMap((token, index) => (
    token.type === 'heading_open' && token.level === 0 && token.map
      ? [{ title: tokens[index + 1].content.trim(), depth: Number(token.tag.slice(1)), start: token.map[0], end: token.map[1] }]
      : []
  ));
  const questions: Array<{ title: string; depth: number; code?: string; variation?: string }> = [];
  let question: typeof questions[number] | undefined;
  let teacherDepth: number | undefined;

  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    const plainTitle = visibleInlineText(parser.parseInline(heading.title, {})[0]?.children) || heading.title;
    if (teacherDepth !== undefined) {
      if (heading.depth > teacherDepth) continue;
      teacherDepth = undefined;
    }
    if (isTeacherLabel(plainTitle)) {
      teacherDepth = heading.depth;
      continue;
    }
    // Remove blank lines only. Trimming the first fence would change Python indentation.
    const body = lines.slice(heading.end, headings[i + 1]?.start ?? lines.length).join('\n')
      .replace(/^(?:[\t ]*\n)+/, '').replace(/(?:\n[\t ]*)+$/, '');
    if (/^第\s*(?:\d+|[一二三四五六七八九十]+)\s*题\s*[:：]/.test(plainTitle)) {
      question = { title: heading.title, depth: heading.depth };
      questions.push(question);
      continue;
    }
    if (!question) {
      const title = plainTitle.trim().replace(/^[\p{P}\p{S}\s]+/u, '');
      // Only the known assignment wrapper may contain student questions.
      // An unknown parent such as "reference solution" needs teacher review.
      if (/^课后(?:巩固|强化)(?:作业|练习|训练)(?:\s*[（(].*[）)])?$/.test(title)) continue;
      return unavailable;
    }
    if (heading.depth !== question.depth + 1) return unavailable;
    if (/^练习代码(?:\s*[（(].*[）)])?$/.test(plainTitle)) {
      if (question.code) return unavailable;
      const blocks = parser.parse(body, {});
      // Keep the exercise fence exactly as written, including indentation and blanks.
      // Extra prose or answer blocks are ambiguous and need teacher review.
      if (blocks.length !== 1 || blocks[0].type !== 'fence' || !blocks[0].content.trim()) return unavailable;
      question.code = body;
    } else if (/^变式思考(?:\s*[（(].*[）)])?$/.test(plainTitle)) {
      if (question.variation || !body.trim() || containsAnswerBlock(body)) return unavailable;
      question.variation = body;
    } else if (!/^练习目的(?:\s*[（(].*[）)])?$/.test(plainTitle)) {
      // Do not silently omit an unrecognized part of a student's assignment.
      return unavailable;
    }
  }

  if (!questions.length || questions.some(item => !item.code || !item.variation)) return unavailable;
  const studentMarkdown = questions.map(item => (
    `### ${item.title}\n\n#### 练习代码\n\n${item.code}\n\n#### 变式思考（选做）\n\n${item.variation}`
  )).join('\n\n');
  return { studentMarkdown, questionCount: questions.length };
}
