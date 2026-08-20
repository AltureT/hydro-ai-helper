import { createHash } from 'crypto';
import { TestdataPipelineError } from '../../services/testdata/failures';
import {
  STATEMENT_CHUNK_TARGET_LENGTH,
  STATEMENT_SNAPSHOT_HARD_LIMIT,
  createStatementSnapshot,
} from '../../services/testdata/statementSnapshot';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('StatementSnapshot', () => {
  it('normalizes only line endings while preserving headings, tables, fences, samples, and body text', () => {
    const source = [
      '# 题目说明',
      '',
      '| 字段 | 含义 |',
      '| --- | --- |',
      '| n | 元素个数 |',
      '',
      '## Input',
      '```input1',
      '2',
      '1 2',
      '```',
      '',
      '## 输出格式',
      '```output1',
      '3',
      '```',
      '',
      '正文结尾。',
    ].join('\r\n');

    const snapshot = createStatementSnapshot(source);

    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.normalizedMarkdown).toBe(source.replace(/\r\n/g, '\n'));
    expect(snapshot.normalizedMarkdown).toContain('| n | 元素个数 |');
    expect(snapshot.samples).toEqual([{ id: '1', input: '2\n1 2\n', output: '3\n' }]);
    expect(snapshot.sections.map(section => section.heading)).toEqual([
      '题目说明', 'Input', '输出格式',
    ]);
    expect(snapshot.length).toBe(snapshot.normalizedMarkdown.length);
    expect(snapshot.statementHash).toBe(sha256(snapshot.normalizedMarkdown));
  });

  it('ignores heading-like text inside multiple fenced input/output blocks', () => {
    const source = [
      '# Problem',
      '```input',
      '# not a heading',
      '```',
      '## Output',
      '~~~output',
      '## still not a heading',
      '~~~',
      '## Constraints',
      'n <= 10',
    ].join('\n');

    const snapshot = createStatementSnapshot(source);

    expect(snapshot.sections.map(section => section.heading)).toEqual([
      'Problem', 'Output', 'Constraints',
    ]);
    expect(snapshot.chunks.map(chunk => chunk.content).join('')).toBe(source);
  });

  it('reconstructs a long statement exactly and retains constraints at the tail', () => {
    const source = [
      '# Description\n',
      'a'.repeat(STATEMENT_CHUNK_TARGET_LENGTH + 500),
      '\n## Constraints\n',
      '1 <= n <= 200000\nAll operations are valid.',
    ].join('');

    const snapshot = createStatementSnapshot(source);
    const reconstructed = snapshot.chunks.map(chunk => chunk.content).join('');

    expect(snapshot.chunks.length).toBeGreaterThan(1);
    expect(reconstructed).toBe(snapshot.normalizedMarkdown);
    expect(reconstructed.endsWith('1 <= n <= 200000\nAll operations are valid.')).toBe(true);
    expect(sha256(reconstructed)).toBe(snapshot.statementHash);
    expect(snapshot.chunks.every((chunk, index) => (
      chunk.index === index
      && chunk.content === snapshot.normalizedMarkdown.slice(chunk.start, chunk.end)
    ))).toBe(true);
  });

  it('uses an exact target boundary without changing content or hash', () => {
    const source = `${'x'.repeat(STATEMENT_CHUNK_TARGET_LENGTH)}y`;

    const snapshot = createStatementSnapshot(source);

    expect(snapshot.chunks).toHaveLength(2);
    expect(snapshot.chunks[0]).toMatchObject({
      index: 0,
      start: 0,
      end: STATEMENT_CHUNK_TARGET_LENGTH,
      content: 'x'.repeat(STATEMENT_CHUNK_TARGET_LENGTH),
    });
    expect(snapshot.chunks[1].content).toBe('y');
    expect(snapshot.chunks.map(chunk => chunk.content).join('')).toBe(source);
    expect(snapshot.statementHash).toBe(sha256(source));
  });

  it('keeps a fenced block larger than the suggested chunk size atomic', () => {
    const fence = `\`\`\`text\n${'x'.repeat(STATEMENT_CHUNK_TARGET_LENGTH + 1000)}\n\`\`\`\n`;
    const source = `before\n${fence}after`;

    const snapshot = createStatementSnapshot(source);
    const fenceContainingChunks = snapshot.chunks.filter(chunk => chunk.content.includes('```text'));

    expect(fenceContainingChunks).toHaveLength(1);
    expect(fenceContainingChunks[0].content).toContain(fence);
    expect(fenceContainingChunks[0].content.length).toBeGreaterThan(STATEMENT_CHUNK_TARGET_LENGTH);
    expect(snapshot.chunks.map(chunk => chunk.content).join('')).toBe(source);
  });

  it('never places a chunk boundary inside a fenced code block', () => {
    const prefix = `${'p'.repeat(STATEMENT_CHUNK_TARGET_LENGTH - 20)}\n`;
    const fence = `\`\`\`python\n${'code\n'.repeat(100)}\`\`\`\n`;
    const source = `${prefix}${fence}tail`;
    const fenceStart = source.indexOf('```python');
    const fenceEnd = source.indexOf('```\n', fenceStart + 3) + 4;

    const snapshot = createStatementSnapshot(source);
    const internalBoundaries = snapshot.chunks.slice(0, -1).map(chunk => chunk.end);

    expect(internalBoundaries.some(boundary => boundary > fenceStart && boundary < fenceEnd)).toBe(false);
    expect(snapshot.chunks.map(chunk => chunk.content).join('')).toBe(source);
  });

  it('rejects statements above the explicit hard limit with SPEC_STATEMENT_TOO_LONG', () => {
    expect(() => createStatementSnapshot('x'.repeat(STATEMENT_SNAPSHOT_HARD_LIMIT + 1)))
      .toThrow(expect.objectContaining({
        name: 'TestdataPipelineError',
        code: 'SPEC_STATEMENT_TOO_LONG',
        artifact: 'statement',
      }));

    try {
      createStatementSnapshot('x'.repeat(STATEMENT_SNAPSHOT_HARD_LIMIT + 1));
    } catch (error) {
      expect(error).toBeInstanceOf(TestdataPipelineError);
      expect((error as TestdataPipelineError).safeDetails).toEqual({
        actualCount: STATEMENT_SNAPSHOT_HARD_LIMIT + 1,
        expectedCount: STATEMENT_SNAPSHOT_HARD_LIMIT,
      });
    }
  });
});
