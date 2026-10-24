import type { SanitizeResult } from './outputSafetyService';

/** Stream checked prose sentences; defer potentially executable content to final validation. */
export class SafeOutputStream {
  private pending = '';
  private checkedSource = '';
  private deferred = false;
  content = '';

  constructor(private sanitize: (content: string) => SanitizeResult) {}

  reset(): void {
    this.pending = '';
    this.checkedSource = '';
    this.deferred = false;
    this.content = '';
  }

  push(chunk: string): string | undefined {
    if (this.deferred) return undefined;
    this.pending += chunk;
    // Clause-level boundaries keep the preview moving inside long Chinese sentences.
    const boundaries = /[。！？；，\n]|[.!?](?=\s)/g;
    let match: RegExpExecArray | null;
    let changed = false;
    // OpenAIClient adds this fixed placeholder for separate reasoning deltas.
    // It is metadata, not executable markup; leave all other tags behind the gate.
    const thinkingMarker = '<think>(thinking...)</think>';
    if (!this.checkedSource && this.pending.startsWith(thinkingMarker)) {
      this.checkedSource = thinkingMarker;
      this.pending = this.pending.slice(thinkingMarker.length);
      this.content = this.sanitize(this.checkedSource).content;
      changed = true;
    }
    while ((match = boundaries.exec(this.pending))) {
      const end = match.index + match[0].length;
      const sentence = this.pending.slice(0, end);
      // Only simple inline identifiers/numbers are safe to expose before the full scan.
      // Complexity notation and keywords named in Chinese prose ("for 循环") are not code,
      // but stopping on them used to defer nearly every tutoring answer to the end.
      const prose = sentence
        .replace(/`([\w\u4e00-\u9fff.+*/%^[\]-]+)`/g, 'identifier')
        .replace(/\bO\([\w\s^*+/]{1,20}\)/g, 'complexity')
        .replace(/\b(?:for|while|if|elif|else|try|except|with|return|import)\s*(?=(?:循环|语句|判断|分支|条件|结构|关键字|代码块|里|中|内|的|后|前))/g, 'keyword ');
      if (/[`~<>{};=]|\b(?:def|class|return|import|from|yield|raise|assert|using)\b|\b[A-Za-z_]\w*\s*\(|\b(?:int|long|double|float|char|bool|string|void|auto|vector|map|set|queue|stack)\s+[A-Za-z_]|\b(?:for|while|if|elif|else|try|except|with)\b|#include|std::|cin\s*>>|cout\s*<</.test(prose)) {
        this.deferred = true;
        break;
      }
      this.checkedSource += sentence;
      const checked = this.sanitize(this.checkedSource);
      this.content = checked.content;
      changed = true;
      this.pending = this.pending.slice(end);
      boundaries.lastIndex = 0;
    }
    return changed ? this.content : undefined;
  }
}
