import {
  buildKillTargetsSystemPrompt,
  buildKillTargetPromptSamples,
  buildKillTargetsUserPrompt,
  parseKillTargetsResponse,
} from '../../services/testdataGenService';

describe('parseKillTargetsResponse', () => {
  it('解析两个合法错误解靶子', () => {
    const raw = [
      '=== KILL_TARGET:boundary ===',
      'DESC: 忘记处理 n=1 的退化情形',
      '```python',
      'n = int(input())',
      'print(0 if n == 1 else n)',
      '```',
      '=== KILL_TARGET:wrong-algorithm ===',
      'DESC: 错误地始终选择局部最优',
      '```python',
      'values = list(map(int, input().split()))',
      'print(max(values))',
      '```',
    ].join('\n');

    expect(parseKillTargetsResponse(raw)).toEqual([
      {
        kind: 'boundary',
        description: '忘记处理 n=1 的退化情形',
        code: 'n = int(input())\nprint(0 if n == 1 else n)\n',
      },
      {
        kind: 'wrong-algorithm',
        description: '错误地始终选择局部最优',
        code: 'values = list(map(int, input().split()))\nprint(max(values))\n',
      },
    ]);
  });

  it('缺少 DESC 时保留可执行代码并使用空描述', () => {
    const raw = [
      '=== KILL_TARGET:overflow-sim ===',
      '```python',
      'print(int(input()) % (1 << 31))',
      '```',
    ].join('\n');

    expect(parseKillTargetsResponse(raw)).toEqual([{
      kind: 'overflow-sim',
      description: '',
      code: 'print(int(input()) % (1 << 31))\n',
    }]);
  });

  it('丢弃代码为空的分节', () => {
    const raw = [
      '=== KILL_TARGET:boundary ===',
      'DESC: 空实现',
      '```python',
      '```',
    ].join('\n');

    expect(parseKillTargetsResponse(raw)).toEqual([]);
  });

  it('丢弃非法 kind', () => {
    const raw = [
      '=== KILL_TARGET:random-bug ===',
      'DESC: 非法类型',
      '```python',
      'print(0)',
      '```',
    ].join('\n');

    expect(parseKillTargetsResponse(raw)).toEqual([]);
  });

  it('分节含未闭合代码围栏时丢弃，而真正无围栏的代码仍可解析', () => {
    const unclosed = [
      '=== KILL_TARGET:boundary ===',
      'DESC: 围栏损坏',
      '```python',
      'print(0)',
    ].join('\n');
    const unfenced = [
      '=== KILL_TARGET:boundary ===',
      'DESC: 无围栏但完整',
      'print(0)',
    ].join('\n');

    expect(parseKillTargetsResponse(unclosed)).toEqual([]);
    expect(parseKillTargetsResponse(unfenced)).toEqual([{
      kind: 'boundary',
      description: '无围栏但完整',
      code: 'print(0)\n',
    }]);
  });
});

describe('kill-target prompt', () => {
  it('只要求 0 至 2 个现实错误模式，不用人工靶子凑数', () => {
    const prompt = buildKillTargetsSystemPrompt();
    const userPrompt = buildKillTargetsUserPrompt({
      statement: '题面',
      analysis: '分析',
      samples: [],
    });

    expect(prompt).toContain('最多 2 种现实中学生确实可能犯');
    expect(prompt).toContain('允许只输出 1 个甚至 0 个分节，不要硬凑');
    expect(prompt).toContain('仅输出 0 至 2 个 KILL_TARGET 分节');
    expect(prompt).not.toContain('只输出两个分节');
    expect(prompt).toContain('=== KILL_TARGET:<kind> ===');
    expect(userPrompt).toContain('请选择最多 2 个');
    expect(userPrompt).toContain('没有合适靶子可输出 0 个');
    expect(userPrompt).not.toContain('请选择最可能的 2 种');
  });

  it('限制 analysis 与每个样例输入输出正文长度', () => {
    const prompt = buildKillTargetsUserPrompt({
      statement: 's'.repeat(6000),
      analysis: `${'a'.repeat(2000)}ANALYSIS_TAIL`,
      samples: [{
        input: `${'i'.repeat(1000)}INPUT_TAIL`,
        output: `${'o'.repeat(1000)}OUTPUT_TAIL`,
      }],
    });

    expect(prompt).not.toContain('ANALYSIS_TAIL');
    expect(prompt).not.toContain('INPUT_TAIL');
    expect(prompt).not.toContain('OUTPUT_TAIL');
    expect(prompt).toContain('a'.repeat(2000));
    expect(prompt).toContain('i'.repeat(1000));
    expect(prompt).toContain('o'.repeat(1000));
  });

  it('函数题用已验证的原始 stdin 转码替换展示形式样例', () => {
    expect(buildKillTargetPromptSamples({
      problemType: 'function',
      functionSampleInputs: [{ id: '1', input: '3\n1 2 3\n' }],
    }, [{
      id: '1',
      input: 'nums = [1, 2, 3]\n',
      output: '6\n',
    }])).toEqual([{
      input: '3\n1 2 3\n',
      output: '6\n',
    }]);
  });
});
