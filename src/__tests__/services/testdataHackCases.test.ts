import {
  mergeHackCases,
  parseHackCasesResponse,
  TestCase,
} from '../../services/testdataGenService';

describe('parseHackCasesResponse', () => {
  it('解析多个带说明的小规模 hack 输入', () => {
    const raw = [
      '=== HACK_CASE ===',
      'RATIONALE: 最小反例会破坏错误贪心',
      '```text',
      '3',
      '2 1 3',
      '```',
      '=== HACK_CASE ===',
      'RATIONALE: 重复值触发错误去重',
      '```',
      '4',
      '1 1 2 2',
      '```',
    ].join('\n');

    expect(parseHackCasesResponse(raw)).toEqual([
      {
        input: '3\n2 1 3\n',
        rationale: '最小反例会破坏错误贪心',
      },
      {
        input: '4\n1 1 2 2\n',
        rationale: '重复值触发错误去重',
      },
    ]);
  });

  it('缺少 RATIONALE 时保留输入，空输入分节则丢弃', () => {
    const raw = [
      '=== HACK_CASE ===',
      '```text',
      '1',
      '```',
      '=== HACK_CASE ===',
      'RATIONALE: 空输入',
      '```text',
      '```',
    ].join('\n');

    expect(parseHackCasesResponse(raw)).toEqual([{
      input: '1\n',
      rationale: '',
    }]);
  });

  it('丢弃超过 2000 字符的输入', () => {
    const raw = [
      '=== HACK_CASE ===',
      'RATIONALE: 过长',
      '```text',
      'x'.repeat(2001),
      '```',
    ].join('\n');

    expect(parseHackCasesResponse(raw)).toEqual([]);
  });
});

describe('mergeHackCases', () => {
  const existing: TestCase[] = [
    { label: '原测试点 1', input: '1\n', output: '1\n', dataScale: 'small' },
    { label: '原测试点 2', input: '2\n', output: '2\n', dataScale: 'large' },
  ];

  it('按现有数量顺延编号并追加 hack 测试点', () => {
    expect(mergeHackCases(existing, [
      { input: '3', output: '9' },
      { input: '4\n', output: '16\n' },
    ], 4)).toEqual([
      ...existing,
      {
        label: '定向补刀 #3',
        input: '3\n',
        output: '9\n',
        dataScale: 'small',
      },
      {
        label: '定向补刀 #4',
        input: '4\n',
        output: '16\n',
        dataScale: 'small',
      },
    ]);
  });

  it('按 maxCases 截断追加数量且不删除现有测试点', () => {
    const merged = mergeHackCases(existing, [
      { input: '3', output: '9' },
      { input: '4', output: '16' },
    ], 3);

    expect(merged).toHaveLength(3);
    expect(merged[2].label).toBe('定向补刀 #3');
  });

  it('空 hack 列表直接返回原测试点数组', () => {
    expect(mergeHackCases(existing, [], 30)).toBe(existing);
  });
});
