/**
 * 偏题规则表单的纯逻辑（FR-038、FR-039），与服务端 applyTopicGuardConfigPatch 的校验一致
 */

export const MAX_OFF_TOPIC_KEYWORDS = 200;
export const MAX_OFF_TOPIC_KEYWORD_LENGTH = 50;

export interface TopicGuardSettings {
  customOffTopicKeywords: string[];
  codeExemptMinChars: number;
  strikeWindowHours: number;
}

export const DEFAULT_TOPIC_GUARD: TopicGuardSettings = {
  customOffTopicKeywords: [],
  codeExemptMinChars: 30,
  strikeWindowHours: 24,
};

export type TopicGuardError = 'too_many' | 'too_long' | 'code_chars' | 'window';

/** 每行一个关键词：去掉首尾空白、空行和重复 */
export function parseKeywordLines(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const keyword = line.trim();
    if (keyword && !out.includes(keyword)) out.push(keyword);
  }
  return out;
}

export function parseTopicGuardForm(form: { keywordsText: string; codeChars: string; windowHours: string }):
  { settings: TopicGuardSettings; errors: TopicGuardError[] } {
  const keywords = parseKeywordLines(form.keywordsText);
  const errors: TopicGuardError[] = [];
  if (keywords.length > MAX_OFF_TOPIC_KEYWORDS) errors.push('too_many');
  if (keywords.some((keyword) => keyword.length > MAX_OFF_TOPIC_KEYWORD_LENGTH)) errors.push('too_long');
  const codeChars = /^\d+$/.test(form.codeChars.trim()) ? Number(form.codeChars.trim()) : NaN;
  if (!Number.isInteger(codeChars) || codeChars > 10000) errors.push('code_chars');
  const windowHours = /^\d+$/.test(form.windowHours.trim()) ? Number(form.windowHours.trim()) : NaN;
  if (!Number.isInteger(windowHours) || windowHours < 1 || windowHours > 168) errors.push('window');
  return {
    settings: { customOffTopicKeywords: keywords, codeExemptMinChars: codeChars, strikeWindowHours: windowHours },
    errors,
  };
}

export function sameTopicGuard(a: TopicGuardSettings, b: TopicGuardSettings): boolean {
  return a.codeExemptMinChars === b.codeExemptMinChars
    && a.strikeWindowHours === b.strikeWindowHours
    && a.customOffTopicKeywords.length === b.customOffTopicKeywords.length
    && a.customOffTopicKeywords.every((keyword, index) => keyword === b.customOffTopicKeywords[index]);
}
