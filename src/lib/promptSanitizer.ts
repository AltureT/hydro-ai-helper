/**
 * Prompt 输入消毒函数
 * 防止 prompt injection：转义边界标记、XML 标签、角色标签、代码围栏
 */

// eslint-disable-next-line no-misleading-character-class
const ZERO_WIDTH_CHARS = /[\u200B\u200C\u200D\u200E\u200F\uFEFF\u2060\u2061\u2062\u2063\u2064\u180E]/g;

const SAFETY_TAGS = ['student_input', 'student_code', 'conversation_history', 'judge_info', 'clarify_anchor'];
const SAFETY_TAG_PATTERN = new RegExp(`<\\/?(${SAFETY_TAGS.join('|')})\\s*>`, 'gi');

const BOUNDARY_KEYWORDS = [
  '学生原文开始', '学生原文结束',
  '历史开始', '历史结束',
  '评测信息开始', '评测信息结束',
];
const BOUNDARY_MARKER_PATTERN = new RegExp(`---\\s*(${BOUNDARY_KEYWORDS.join('|')})\\s*---`, 'g');

const ROLE_NAMES = ['AI导师', '系统', 'system', 'assistant', 'user'];
const ROLE_TAG_PATTERN = new RegExp(`\\[(${ROLE_NAMES.join('|')})\\]`, 'gi');

const TRIPLE_BACKTICK = /`{3,}/g;

/**
 * 对用户文本做最小化转义，防止 prompt injection 逃逸
 */
export function sanitizeForPrompt(text: string): string {
  if (!text) return text;

  let result = text;

  result = result.replace(ZERO_WIDTH_CHARS, '');

  result = result.replace(SAFETY_TAG_PATTERN, (match) =>
    match.replace(/</g, '\uFF1C').replace(/>/g, '\uFF1E')
  );

  result = result.replace(BOUNDARY_MARKER_PATTERN, (match) =>
    match.replace(/---/g, '\uFF0D\uFF0D\uFF0D')
  );

  result = result.replace(ROLE_TAG_PATTERN, (match) =>
    match.replace(/\[/g, '\uFF3B').replace(/\]/g, '\uFF3D')
  );

  result = result.replace(TRIPLE_BACKTICK, (match) =>
    match.split('').map((c, i) => (i > 0 && i % 2 === 0) ? '\u2006' + c : c).join('')
  );

  return result;
}

/* ---- Cyrillic / Greek homoglyph → Latin mapping ---- */

const HOMOGLYPH_MAP: Record<string, string> = {
  // Cyrillic uppercase
  '\u0410': 'A', '\u0412': 'B', '\u0421': 'C', '\u0415': 'E',
  '\u041D': 'H', '\u0406': 'I', '\u0408': 'J', '\u041A': 'K',
  '\u041C': 'M', '\u041E': 'O', '\u0420': 'P', '\u0405': 'S',
  '\u0422': 'T', '\u0423': 'Y', '\u0425': 'X',
  // Cyrillic lowercase
  '\u0430': 'a', '\u0441': 'c', '\u0435': 'e', '\u0456': 'i',
  '\u0458': 'j', '\u043E': 'o', '\u0440': 'p', '\u0455': 's',
  '\u0443': 'y', '\u0445': 'x',
  // Greek uppercase
  '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u0397': 'H',
  '\u0399': 'I', '\u039A': 'K', '\u039C': 'M', '\u039D': 'N',
  '\u039F': 'O', '\u03A1': 'P', '\u03A4': 'T', '\u03A7': 'X',
  '\u0396': 'Z',
  // Greek lowercase
  '\u03BF': 'o',
};

const HOMOGLYPH_REGEX = new RegExp(`[${Object.keys(HOMOGLYPH_MAP).join('')}]`, 'g');

/**
 * jailbreak 检测前的文本预处理：NFKC 归一化 + 同形字映射 + 零宽剥离
 */
export function normalizeUnicode(text: string): string {
  if (!text) return text;

  let result = text.normalize('NFKC');
  result = result.replace(HOMOGLYPH_REGEX, (char) => HOMOGLYPH_MAP[char] || char);
  result = result.replace(ZERO_WIDTH_CHARS, '');

  return result;
}
