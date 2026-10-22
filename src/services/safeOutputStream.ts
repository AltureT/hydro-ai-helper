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
    const boundaries = /[。！？\n]|[.!?](?=\s)/g;
    let match: RegExpExecArray | null;
    let changed = false;
    while ((match = boundaries.exec(this.pending))) {
      const end = match.index + match[0].length;
      const sentence = this.pending.slice(0, end);
      // Only simple inline identifiers/numbers are safe to expose before the full scan.
      const prose = sentence.replace(/`([\w\u4e00-\u9fff.+*/%-]+)`/g, 'identifier');
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
