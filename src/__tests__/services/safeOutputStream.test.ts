import { SafeOutputStream } from '../../services/safeOutputStream';
import { OutputSafetyService } from '../../services/outputSafetyService';

function createStream() {
  const safety = new OutputSafetyService();
  return new SafeOutputStream(content => safety.sanitize(content, { questionType: 'understand' }));
}

describe('SafeOutputStream', () => {
  it.each([false, true])('streams prose after the internal thinking marker (split tags: %s)', (split) => {
    const stream = createStream();
    const marker = '<think>(thinking...)</think>';
    for (const chunk of split ? [...marker] : ['<think>(thinking...)', '</think>']) stream.push(chunk);
    expect(stream.push('先检查输入。')).toBe(marker + '先检查输入。');
    expect(stream.push('再比较条件。')).toBe(marker + '先检查输入。再比较条件。');
    stream.push('```python\ndef solve():\n');
    expect(stream.content).toBe(marker + '先检查输入。再比较条件。');
  });

  it('does not treat arbitrary thinking markup as trusted metadata', () => {
    const stream = createStream();
    expect(stream.push('<think>def solve():\n')).toBeUndefined();
    expect(stream.push('</think>先检查输入。')).toBeUndefined();
  });

  it('publishes completed prose sentences while the answer is still being generated', () => {
    const stream = createStream();
    expect(stream.push('先检查')).toBeUndefined();
    expect(stream.push('输入。')).toBe('先检查输入。');
    expect(stream.push('再比较')).toBeUndefined();
    expect(stream.push('条件。')).toBe('先检查输入。再比较条件。');
  });

  it('checks off-topic words split across provider chunks before publishing', () => {
    const stream = createStream();
    expect(stream.push('原')).toBeUndefined();
    expect(stream.push('神。')).toBe('该话题。');
    expect(stream.content).not.toContain('原神');
  });

  it.each([
    '```python\ndef solve():\n n = int(input())\n print(n)\n```\n',
    'def solve():\n n = int(input())\n print(n)\n',
    '例如 print(input())。',
    'x = 1\ny = 2\nz = 3\na = 4\nb = 5\nc = 6\n',
    '```\n',
  ])('defers possible code until the complete-response safety scan: %s', (code) => {
    const stream = createStream();
    expect(stream.push('先分析题意。')).toBe('先分析题意。');
    for (const character of code) stream.push(character);
    expect(stream.content).toBe('先分析题意。');
    expect(stream.push('后面的解释。')).toBeUndefined();
  });

  it('allows simple inline identifiers and numbers in explanations', () => {
    expect(createStream().push('变量 `ans` 表示答案，数字 `3` 表示周三。'))
      .toBe('变量 `ans` 表示答案，数字 `3` 表示周三。');
  });

  it.each([
    '时间复杂度是 O(n log n)，空间复杂度是 O(1)。',
    '用 for 循环遍历数组，在 if 判断里更新答案。',
    '比较 `a[i]` 和 `dp[i-1]` 的大小。',
  ])('keeps streaming prose that only names code concepts: %s', (sentence) => {
    const stream = createStream();
    expect(stream.push(sentence)).toBe(sentence);
    expect(stream.push('后面的解释。')).toBe(sentence + '后面的解释。');
  });

  it.each([
    'for i in range(n)，累加答案。',
    'if x > 0 就输出。',
    '可以写 return 答案(x)。',
  ])('still defers keywords used as statements: %s', (sentence) => {
    const stream = createStream();
    expect(stream.push(sentence)).toBeUndefined();
    expect(stream.content).toBe('');
  });

  it('publishes long Chinese sentences clause by clause', () => {
    const stream = createStream();
    expect(stream.push('先读入数据，')).toBe('先读入数据，');
    expect(stream.push('再统计答案')).toBeUndefined();
  });

  it('resets both the previous prose and deferred code before fallback', () => {
    const stream = createStream();
    stream.push('第一条提示。\n```python\n');
    stream.reset();
    expect(stream.content).toBe('');
    expect(stream.push('备用模型的提示。')).toBe('备用模型的提示。');
  });
});
