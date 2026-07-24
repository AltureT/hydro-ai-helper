import { parseKillTargetsResponse } from '../../services/testdataGenService';

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
});
