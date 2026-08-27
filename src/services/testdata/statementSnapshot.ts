import { createHash } from 'crypto';
import { TestdataPipelineError } from './failures';
import {
  extractStatementSamples,
  type StatementSample,
} from './statementSamples';

export const STATEMENT_CHUNK_TARGET_LENGTH = 12_000;
export const STATEMENT_SNAPSHOT_HARD_LIMIT = 256 * 1024;

export interface StatementSnapshot {
  schemaVersion: 1;
  normalizedMarkdown: string;
  statementHash: string;
  length: number;
  sections: Array<{
    heading: string;
    start: number;
    end: number;
  }>;
  samples: StatementSample[];
  chunks: Array<{
    index: number;
    start: number;
    end: number;
    content: string;
  }>;
}

interface SourceLine {
  start: number;
  end: number;
  text: string;
  fenced: boolean;
}

interface ProtectedRange {
  start: number;
  end: number;
}

function splitSourceLines(markdown: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  while (start < markdown.length) {
    const newline = markdown.indexOf('\n', start);
    const end = newline === -1 ? markdown.length : newline + 1;
    lines.push({
      start,
      end,
      text: markdown.slice(start, newline === -1 ? markdown.length : newline),
      fenced: false,
    });
    start = end;
  }
  return lines;
}

function findFencedRanges(lines: SourceLine[], length: number): ProtectedRange[] {
  const ranges: ProtectedRange[] = [];
  let active: { marker: '`' | '~'; length: number; start: number } | undefined;

  for (const line of lines) {
    if (active) {
      line.fenced = true;
      const escapedMarker = active.marker === '`' ? '`' : '~';
      const closing = new RegExp(`^[ \\t]{0,3}${escapedMarker}{${active.length},}[ \\t]*$`);
      if (closing.test(line.text)) {
        ranges.push({ start: active.start, end: line.end });
        active = undefined;
      }
      continue;
    }

    const opening = line.text.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
    if (!opening) continue;
    const marker = opening[1][0] as '`' | '~';
    if (marker === '`' && opening[2].includes('`')) continue;
    line.fenced = true;
    active = { marker, length: opening[1].length, start: line.start };
  }

  if (active) ranges.push({ start: active.start, end: length });
  return ranges;
}

function parseAtxHeading(text: string): string | undefined {
  const match = text.match(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*$/);
  if (!match) return undefined;
  return match[1].replace(/[ \t]+#+[ \t]*$/, '').trim();
}

function findSections(lines: SourceLine[], length: number): StatementSnapshot['sections'] {
  const headings = new Map<number, string>();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.fenced) continue;
    const atx = parseAtxHeading(line.text);
    if (atx) {
      headings.set(line.start, atx);
      continue;
    }
    if (!/^[ \t]{0,3}(?:=+|-+)[ \t]*$/.test(line.text) || index === 0) continue;
    const previous = lines[index - 1];
    const heading = previous.text.trim();
    if (!previous.fenced && heading) headings.set(previous.start, heading);
  }

  const ordered = [...headings.entries()]
    .map(([start, heading]) => ({ heading, start }))
    .sort((left, right) => left.start - right.start);
  return ordered.map((section, index) => ({
    ...section,
    end: ordered[index + 1]?.start ?? length,
  }));
}

function findProtectedRangeAt(
  ranges: ProtectedRange[],
  offset: number,
): ProtectedRange | undefined {
  return ranges.find(range => offset > range.start && offset < range.end);
}

function buildChunks(
  markdown: string,
  lines: SourceLine[],
  sections: StatementSnapshot['sections'],
  protectedRanges: ProtectedRange[],
): StatementSnapshot['chunks'] {
  if (!markdown) return [];
  const safeBreaks = new Set<number>([0, markdown.length]);
  for (const line of lines) {
    if (!line.fenced) safeBreaks.add(line.end);
  }
  for (const range of protectedRanges) {
    safeBreaks.add(range.start);
    safeBreaks.add(range.end);
  }
  for (const section of sections) safeBreaks.add(section.start);
  const orderedBreaks = [...safeBreaks].sort((left, right) => left - right);

  const chunks: StatementSnapshot['chunks'] = [];
  let start = 0;
  while (start < markdown.length) {
    const target = Math.min(markdown.length, start + STATEMENT_CHUNK_TARGET_LENGTH);
    let end = target;
    if (target < markdown.length) {
      const protectedRange = findProtectedRangeAt(protectedRanges, target);
      const ceiling = protectedRange?.start ?? target;
      const safeEnd = orderedBreaks.reduce((best, candidate) => (
        candidate > start && candidate <= ceiling ? candidate : best
      ), -1);
      if (safeEnd > start) end = safeEnd;
      else if (protectedRange) end = protectedRange.end;
    }
    if (end <= start) end = Math.min(markdown.length, start + STATEMENT_CHUNK_TARGET_LENGTH);
    chunks.push({
      index: chunks.length,
      start,
      end,
      content: markdown.slice(start, end),
    });
    start = end;
  }
  return chunks;
}

export function createStatementSnapshot(statementMarkdown: string): StatementSnapshot {
  const normalizedMarkdown = String(statementMarkdown || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  if (normalizedMarkdown.length > STATEMENT_SNAPSHOT_HARD_LIMIT) {
    throw new TestdataPipelineError(
      '题面超过 ProblemSpec 可安全处理的系统硬上限。',
      'SPEC_STATEMENT_TOO_LONG',
      'pipeline',
      'statement',
      'no-retry',
      {
        actualCount: normalizedMarkdown.length,
        expectedCount: STATEMENT_SNAPSHOT_HARD_LIMIT,
      },
    );
  }

  const lines = splitSourceLines(normalizedMarkdown);
  const protectedRanges = findFencedRanges(lines, normalizedMarkdown.length);
  const sections = findSections(lines, normalizedMarkdown.length);
  return {
    schemaVersion: 1,
    normalizedMarkdown,
    statementHash: createHash('sha256').update(normalizedMarkdown, 'utf8').digest('hex'),
    length: normalizedMarkdown.length,
    sections,
    samples: extractStatementSamples(normalizedMarkdown),
    chunks: buildChunks(normalizedMarkdown, lines, sections, protectedRanges),
  };
}
