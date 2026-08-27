export type MutationLanguage = 'python' | 'cpp';

export const MUTATION_OPERATOR_IDS = [
  'comparison-boundary',
  'equality-negation',
  'logical-connector',
  'arithmetic-operator',
  'constant-off-by-one',
  'historical-submission',
] as const;

export type MutationOperatorId = typeof MUTATION_OPERATOR_IDS[number];
export type MutationGateMode = 'off' | 'observe' | 'enforce';

export interface MutationCandidate {
  origin: 'generated' | 'historical';
  language: MutationLanguage;
  operatorId: MutationOperatorId;
  source: string;
}

export interface HistoricalMutationCandidate {
  language: MutationLanguage;
  source: string;
  expectedStatus: 'wrong-answer' | 'runtime-error' | 'time-limit';
}

interface SourceToken {
  start: number;
  end: number;
  text: string;
  kind: 'operator' | 'integer';
}

const MAX_POSITIONS_PER_OPERATOR = 3;
export const MAX_GENERATED_MUTATION_CANDIDATES = 12;
export const MAX_HISTORICAL_MUTATION_CANDIDATES = 8;
export const MAX_TOTAL_MUTATION_CANDIDATES = 20;

const GENERATED_OPERATOR_ORDER: ReadonlyArray<Exclude<
  MutationOperatorId,
  'historical-submission'
>> = [
  'comparison-boundary',
  'equality-negation',
  'logical-connector',
  'arithmetic-operator',
  'constant-off-by-one',
];

const OPERATOR_REPLACEMENTS: Readonly<Record<string, {
  id: Exclude<MutationOperatorId, 'constant-off-by-one' | 'historical-submission'>;
  replacement: string;
}>> = {
  '<': { id: 'comparison-boundary', replacement: '<=' },
  '<=': { id: 'comparison-boundary', replacement: '<' },
  '>': { id: 'comparison-boundary', replacement: '>=' },
  '>=': { id: 'comparison-boundary', replacement: '>' },
  '==': { id: 'equality-negation', replacement: '!=' },
  '!=': { id: 'equality-negation', replacement: '==' },
  and: { id: 'logical-connector', replacement: 'or' },
  or: { id: 'logical-connector', replacement: 'and' },
  '&&': { id: 'logical-connector', replacement: '||' },
  '||': { id: 'logical-connector', replacement: '&&' },
  '+': { id: 'arithmetic-operator', replacement: '-' },
  '-': { id: 'arithmetic-operator', replacement: '+' },
};

const PYTHON_LANGUAGE_ALIASES = new Set(['py', 'py.py3', 'py.pypy3', 'python', 'python3']);
const CPP_LANGUAGE_ALIASES = new Set(['cc', 'cc.cc17', 'cpp', 'cpp17', 'c++17']);

export function getMutationGateMode(value?: string): MutationGateMode {
  return value === 'off' || value === 'observe' || value === 'enforce'
    ? value
    : 'observe';
}

export function normalizeMutationLanguage(value: string): MutationLanguage | undefined {
  const normalized = value.trim().toLowerCase();
  if (PYTHON_LANGUAGE_ALIASES.has(normalized)) return 'python';
  if (CPP_LANGUAGE_ALIASES.has(normalized)) return 'cpp';
  return undefined;
}

function isIdentifierChar(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_]/.test(value);
}

function previousNonWhitespace(source: string, index: number): string | undefined {
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    if (!/\s/.test(source[cursor])) return source[cursor];
  }
  return undefined;
}

function nextNonWhitespace(source: string, index: number): string | undefined {
  for (let cursor = index; cursor < source.length; cursor++) {
    if (!/\s/.test(source[cursor])) return source[cursor];
  }
  return undefined;
}

function isBinaryArithmeticOperator(source: string, start: number, end: number): boolean {
  const before = previousNonWhitespace(source, start);
  const after = nextNonWhitespace(source, end);
  const leftOperand = before !== undefined && (isIdentifierChar(before) || /[\])}]/.test(before));
  const rightOperand = after !== undefined && (isIdentifierChar(after) || '([{'.includes(after));
  return leftOperand && rightOperand;
}

function readCanonicalInteger(source: string, start: number): SourceToken | undefined {
  let end = start;
  while (end < source.length && /[0-9]/.test(source[end])) end++;
  const before = source[start - 1];
  const after = source[end];
  if (isIdentifierChar(before)
    || isIdentifierChar(after)
    || before === '+'
    || before === '-'
    || before === '.'
    || after === '.') return undefined;
  const text = source.slice(start, end);
  if (text.length > 1 && text.startsWith('0')) return undefined;
  const value = Number(text);
  if (!Number.isSafeInteger(value)) return undefined;
  return { start, end, text, kind: 'integer' };
}

function readOperator(
  source: string,
  start: number,
  language: MutationLanguage,
): SourceToken | undefined {
  const two = source.slice(start, start + 2);
  if (['<=', '>=', '==', '!='].includes(two)
    || (language === 'cpp' && ['&&', '||'].includes(two))) {
    return { start, end: start + 2, text: two, kind: 'operator' };
  }
  const one = source[start];
  if (['<', '>'].includes(one)
    || (['+', '-'].includes(one) && isBinaryArithmeticOperator(source, start, start + 1))) {
    return { start, end: start + 1, text: one, kind: 'operator' };
  }
  if (language === 'python') {
    for (const word of ['and', 'or']) {
      if (source.startsWith(word, start)
        && !isIdentifierChar(source[start - 1])
        && !isIdentifierChar(source[start + word.length])) {
        return { start, end: start + word.length, text: word, kind: 'operator' };
      }
    }
  }
  return undefined;
}

function skipQuotedString(source: string, start: number): number {
  const quote = source[start];
  const triple = source.slice(start, start + 3) === quote.repeat(3);
  const delimiter = triple ? quote.repeat(3) : quote;
  let cursor = start + delimiter.length;
  while (cursor < source.length) {
    if (source[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (source.startsWith(delimiter, cursor)) return cursor + delimiter.length;
    cursor++;
  }
  return source.length;
}

function scanPythonTokens(source: string): SourceToken[] {
  const tokens: SourceToken[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    if (source[cursor] === '#') {
      const newline = source.indexOf('\n', cursor + 1);
      cursor = newline === -1 ? source.length : newline + 1;
      continue;
    }
    if (source[cursor] === '\'' || source[cursor] === '"') {
      cursor = skipQuotedString(source, cursor);
      continue;
    }
    if (/[0-9]/.test(source[cursor])) {
      const token = readCanonicalInteger(source, cursor);
      let end = cursor + 1;
      while (end < source.length && /[A-Za-z0-9_.]/.test(source[end])) end++;
      if (token) tokens.push(token);
      cursor = Math.max(end, token?.end || cursor + 1);
      continue;
    }
    const operator = readOperator(source, cursor, 'python');
    if (operator) {
      tokens.push(operator);
      cursor = operator.end;
      continue;
    }
    cursor++;
  }
  return tokens;
}

function isPreprocessorStart(source: string, start: number): boolean {
  let cursor = start - 1;
  while (cursor >= 0 && source[cursor] !== '\n') {
    if (!/[ \t\r]/.test(source[cursor])) return false;
    cursor--;
  }
  return true;
}

function skipCppPreprocessor(source: string, start: number): number {
  let cursor = start;
  while (cursor < source.length) {
    const newline = source.indexOf('\n', cursor);
    if (newline === -1) return source.length;
    let before = newline - 1;
    while (before >= start && source[before] === '\r') before--;
    if (source[before] !== '\\') return newline + 1;
    cursor = newline + 1;
  }
  return source.length;
}

function skipCppRawString(source: string, start: number): number | undefined {
  const prefix = ['u8R"', 'uR"', 'UR"', 'LR"', 'R"']
    .find(candidate => source.startsWith(candidate, start));
  if (!prefix) return undefined;
  const delimiterStart = start + prefix.length;
  const delimiterEnd = source.indexOf('(', delimiterStart);
  if (delimiterEnd === -1 || delimiterEnd - delimiterStart > 16) return undefined;
  const delimiter = source.slice(delimiterStart, delimiterEnd);
  if (/\s|\\|\)/.test(delimiter)) return undefined;
  const close = `)${delimiter}"`;
  const closeIndex = source.indexOf(close, delimiterEnd + 1);
  return closeIndex === -1 ? source.length : closeIndex + close.length;
}

function skipCppTemplateArguments(source: string, start: number): number | undefined {
  if (source[start] !== '<'
    || (!isIdentifierChar(source[start - 1]) && source[start - 1] !== '>')) return undefined;
  let depth = 0;
  let cursor = start;
  while (cursor < source.length) {
    if (source.startsWith('//', cursor)) {
      const newline = source.indexOf('\n', cursor + 2);
      cursor = newline === -1 ? source.length : newline + 1;
      continue;
    }
    if (source.startsWith('/*', cursor)) {
      const close = source.indexOf('*/', cursor + 2);
      cursor = close === -1 ? source.length : close + 2;
      continue;
    }
    const rawStringEnd = skipCppRawString(source, cursor);
    if (rawStringEnd !== undefined) {
      cursor = rawStringEnd;
      continue;
    }
    if (source[cursor] === '\'' || source[cursor] === '"') {
      cursor = skipQuotedString(source, cursor);
      continue;
    }
    if (source[cursor] === '<') depth++;
    else if (source[cursor] === '>') {
      depth--;
      if (depth === 0) return cursor + 1;
    }
    cursor++;
  }
  return undefined;
}

function scanCppTokens(source: string): SourceToken[] {
  const tokens: SourceToken[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    if (source[cursor] === '#' && isPreprocessorStart(source, cursor)) {
      cursor = skipCppPreprocessor(source, cursor);
      continue;
    }
    if (source.startsWith('//', cursor)) {
      const newline = source.indexOf('\n', cursor + 2);
      cursor = newline === -1 ? source.length : newline + 1;
      continue;
    }
    if (source.startsWith('/*', cursor)) {
      const close = source.indexOf('*/', cursor + 2);
      cursor = close === -1 ? source.length : close + 2;
      continue;
    }
    const rawStringEnd = skipCppRawString(source, cursor);
    if (rawStringEnd !== undefined) {
      cursor = rawStringEnd;
      continue;
    }
    if (source[cursor] === '\'' || source[cursor] === '"') {
      cursor = skipQuotedString(source, cursor);
      continue;
    }
    const templateEnd = skipCppTemplateArguments(source, cursor);
    if (templateEnd !== undefined) {
      cursor = templateEnd;
      continue;
    }
    if (/[0-9]/.test(source[cursor])) {
      const token = readCanonicalInteger(source, cursor);
      let end = cursor + 1;
      while (end < source.length && /[A-Za-z0-9_.]/.test(source[end])) end++;
      if (token) tokens.push(token);
      cursor = Math.max(end, token?.end || cursor + 1);
      continue;
    }
    const operator = readOperator(source, cursor, 'cpp');
    if (operator) {
      tokens.push(operator);
      cursor = operator.end;
      continue;
    }
    cursor++;
  }
  return tokens;
}

function replaceToken(source: string, token: SourceToken, replacement: string): string {
  return source.slice(0, token.start) + replacement + source.slice(token.end);
}

function mutationForToken(token: SourceToken): {
  id: Exclude<MutationOperatorId, 'historical-submission'>;
  replacement: string;
} | undefined {
  if (token.kind === 'operator') return OPERATOR_REPLACEMENTS[token.text];
  const value = Number(token.text);
  if (!Number.isSafeInteger(value)) return undefined;
  return {
    id: 'constant-off-by-one',
    replacement: String(value % 2 === 0 ? value + 1 : value - 1),
  };
}

export function generateMutationCandidates(
  source: string,
  language: MutationLanguage,
): MutationCandidate[] {
  if (!source.trim()) return [];
  const tokens = language === 'python' ? scanPythonTokens(source) : scanCppTokens(source);
  const grouped = new Map<MutationOperatorId, Array<{ token: SourceToken; replacement: string }>>();
  for (const token of tokens) {
    const mutation = mutationForToken(token);
    if (!mutation) continue;
    const existing = grouped.get(mutation.id) || [];
    if (existing.length < MAX_POSITIONS_PER_OPERATOR) {
      existing.push({ token, replacement: mutation.replacement });
      grouped.set(mutation.id, existing);
    }
  }

  const candidates: MutationCandidate[] = [];
  const seen = new Set<string>();
  for (const operatorId of GENERATED_OPERATOR_ORDER) {
    for (const item of grouped.get(operatorId) || []) {
      const mutated = replaceToken(source, item.token, item.replacement);
      if (mutated === source || seen.has(mutated)) continue;
      seen.add(mutated);
      candidates.push({ origin: 'generated', language, operatorId, source: mutated });
      if (candidates.length >= MAX_GENERATED_MUTATION_CANDIDATES) return candidates;
    }
  }
  return candidates;
}

export function mergeMutationCandidates(
  generated: readonly MutationCandidate[],
  historical: readonly HistoricalMutationCandidate[],
): MutationCandidate[] {
  const merged: MutationCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of generated) {
    if (merged.length >= MAX_GENERATED_MUTATION_CANDIDATES) break;
    if (!candidate.source.trim() || seen.has(candidate.source)) continue;
    seen.add(candidate.source);
    merged.push({ ...candidate, origin: 'generated' });
  }
  let historicalCount = 0;
  for (const candidate of historical) {
    if (historicalCount >= MAX_HISTORICAL_MUTATION_CANDIDATES
      || merged.length >= MAX_TOTAL_MUTATION_CANDIDATES) break;
    if (!candidate.source.trim() || seen.has(candidate.source)) continue;
    seen.add(candidate.source);
    merged.push({
      origin: 'historical',
      language: candidate.language,
      operatorId: 'historical-submission',
      source: candidate.source,
    });
    historicalCount++;
  }
  return merged;
}
