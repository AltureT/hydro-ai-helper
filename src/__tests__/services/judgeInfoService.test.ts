import { formatJudgeInfo, type RecordJudgeProjection } from '../../services/judgeInfoService';

describe('formatJudgeInfo', () => {
  it('should return undefined for null/undefined input', () => {
    expect(formatJudgeInfo(null as any)).toBeUndefined();
    expect(formatJudgeInfo(undefined as any)).toBeUndefined();
  });

  it('should return undefined when record has no useful data', () => {
    expect(formatJudgeInfo({} as RecordJudgeProjection)).toBeUndefined();
    expect(formatJudgeInfo({ status: undefined, testCases: [], compilerTexts: [] })).toBeUndefined();
  });

  it('should format basic AC result', () => {
    const result = formatJudgeInfo({ status: 1, score: 100, lang: 'cpp' });

    expect(result).toContain('【评测结果摘要】');
    expect(result).toContain('语言: cpp');
    expect(result).toContain('AC(1)');
    expect(result).toContain('分数: 100');
  });

  it('should format WA result with test cases', () => {
    const result = formatJudgeInfo({
      status: 2,
      score: 60,
      lang: 'python3',
      testCases: [
        { id: 1, status: 1, time: 10, memory: 1024 },
        { id: 2, status: 1, time: 20, memory: 2048 },
        { id: 3, status: 2, time: 15, memory: 1500, message: 'Expected: 42, Got: 0' },
        { id: 4, status: 3, time: 1000, memory: 512 },
        { id: 5, status: 1, time: 5, memory: 128 },
      ],
    });

    expect(result).toContain('WA(2)');
    expect(result).toContain('3/5 通过');
    expect(result).toContain('【失败测试点');
    expect(result).toContain('#3 status=WA(2)');
    expect(result).toContain('Expected: 42, Got: 0');
    expect(result).toContain('#4 status=TLE(3)');
  });

  it('should limit failed test cases to 5', () => {
    const testCases = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      status: 2, // WA
      time: 10,
      memory: 1024,
    }));
    const result = formatJudgeInfo({ status: 2, testCases });

    expect(result).toContain('还有 5 个失败测试点');
    // Count occurrences of "#N status="
    const matches = result!.match(/#\d+ status=/g);
    expect(matches).toHaveLength(5);
  });

  it('should include compiler output', () => {
    const result = formatJudgeInfo({
      status: 7, // CE
      compilerTexts: ['error: expected \';\' before \'}\' token\nline 42: int x = 5'],
    });

    expect(result).toContain('【编译/语法输出（节选）】');
    expect(result).toContain("expected ';' before '}'");
  });

  it('should include judge text output', () => {
    const result = formatJudgeInfo({
      status: 2,
      judgeTexts: ['Wrong answer on test 3'],
    });

    expect(result).toContain('【判题输出（节选）】');
    expect(result).toContain('Wrong answer on test 3');
  });

  it('should handle templated messages with params', () => {
    const result = formatJudgeInfo({
      status: 2,
      judgeTexts: [{ message: 'Expected {0} but got {1}', params: ['42', '0'] }],
    });

    expect(result).toContain('Expected 42 but got 0');
  });

  it('should handle templated test case messages', () => {
    const result = formatJudgeInfo({
      status: 2,
      testCases: [
        {
          id: 1,
          status: 2,
          message: { message: 'Wrong answer: {0}', params: ['line 1 differs'] },
        },
      ],
    });

    expect(result).toContain('Wrong answer: line 1 differs');
  });

  it('should strip ANSI escape sequences from compiler output', () => {
    const ansiText = '\u001B[31merror\u001B[0m: undefined variable';
    const result = formatJudgeInfo({
      status: 7,
      compilerTexts: [ansiText],
    });

    expect(result).not.toContain('\u001B');
    expect(result).toContain('error: undefined variable');
  });

  it('should truncate long compiler output', () => {
    // Single long line gets truncated by limitLines first (320 char max per line)
    const longOutput = 'x'.repeat(2000);
    const result = formatJudgeInfo({
      status: 7,
      compilerTexts: [longOutput],
    });

    expect(result).toContain('...(truncated line)');
    // The compiler section should be bounded
    const compilerSection = result!.split('【编译/语法输出（节选）】\n')[1]?.split('\n\n')[0] || '';
    expect(compilerSection.length).toBeLessThanOrEqual(1020);
  });

  it('should truncate multi-line compiler output exceeding limit', () => {
    // Create many lines that total over 1000 chars after limitLines
    const lines = Array.from({ length: 20 }, (_, i) => `error line ${i}: ${'e'.repeat(80)}`);
    const result = formatJudgeInfo({
      status: 7,
      compilerTexts: [lines.join('\n')],
    });

    expect(result).toContain('【编译/语法输出（节选）】');
    const compilerSection = result!.split('【编译/语法输出（节选）】\n')[1]?.split('\n\n')[0] || '';
    expect(compilerSection.length).toBeLessThanOrEqual(1020);
  });

  it('should truncate message field to 300 chars', () => {
    const longMessage = 'a'.repeat(500);
    const result = formatJudgeInfo({
      status: 2,
      testCases: [{ id: 1, status: 2, message: longMessage }],
    });

    expect(result).toContain('...(truncated)');
  });

  it('should enforce total hard limit of 2600 chars', () => {
    const record: RecordJudgeProjection = {
      status: 2,
      score: 0,
      lang: 'cpp',
      testCases: Array.from({ length: 80 }, (_, i) => ({
        id: i,
        status: 2,
        time: 1000,
        memory: 500000,
        message: 'Very long message: ' + 'x'.repeat(200),
      })),
      compilerTexts: ['y'.repeat(800)],
      judgeTexts: ['z'.repeat(600)],
    };

    const result = formatJudgeInfo(record);
    expect(result!.length).toBeLessThanOrEqual(2600 + 20); // 2600 + "...(truncated)\n"
  });

  it('should handle missing test case fields gracefully', () => {
    const result = formatJudgeInfo({
      status: 2,
      testCases: [
        { status: 2 }, // No id, time, memory, message
      ],
    });

    expect(result).toContain('#? status=WA(2)');
    expect(result).not.toContain('time=');
    expect(result).not.toContain('memory=');
  });

  it('should not include passing/non-failure test cases in failed section', () => {
    const result = formatJudgeInfo({
      status: 2,
      testCases: [
        { id: 1, status: 1 },  // AC
        { id: 2, status: 0 },  // Waiting
        { id: 3, status: 20 }, // Judging
        { id: 4, status: 30 }, // Ignored
        { id: 5, status: 2 },  // WA - only failure
      ],
    });

    // Only the WA case should appear in failed section
    expect(result).toContain('#5 status=WA(2)');
    expect(result).not.toContain('#1 status=');
    expect(result).not.toContain('#2 status=');
    expect(result).not.toContain('#3 status=');
    expect(result).not.toContain('#4 status=');
  });

  it('should display unknown status code with number', () => {
    const result = formatJudgeInfo({ status: 99 });

    expect(result).toContain('Unknown(99)');
  });

  it('should normalize line endings in compiler output', () => {
    const result = formatJudgeInfo({
      status: 7,
      compilerTexts: ['line1\r\nline2\rline3'],
    });

    expect(result).not.toContain('\r');
    expect(result).toContain('line1\nline2\nline3');
  });

  it('should handle non-string compilerTexts gracefully', () => {
    const result = formatJudgeInfo({
      status: 7,
      compilerTexts: [42 as any, null as any, 'valid text'],
    });

    expect(result).toContain('valid text');
  });

  it('should truncate lines exceeding max line length', () => {
    const longLine = 'L'.repeat(400);
    const result = formatJudgeInfo({
      status: 7,
      compilerTexts: [longLine],
    });

    expect(result).toContain('...(truncated line)');
  });

  it('should show score without language if lang is missing', () => {
    const result = formatJudgeInfo({ status: 2, score: 50 });

    expect(result).toContain('分数: 50');
    expect(result).not.toContain('语言:');
  });

  it('should handle empty testCases array', () => {
    const result = formatJudgeInfo({ status: 1, testCases: [] });

    expect(result).toContain('AC(1)');
    expect(result).not.toContain('测试点:');
  });
});
