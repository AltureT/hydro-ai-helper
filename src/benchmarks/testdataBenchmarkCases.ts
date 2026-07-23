import type { GenerateOptions } from '../services/testdataGenService';

export interface TestdataBenchmarkProbe {
  name: string;
  input: string;
  output: string;
}

export interface TestdataBenchmarkCase {
  id: string;
  title: string;
  difficulty: 'hard';
  tags: string[];
  statementMarkdown: string;
  options: GenerateOptions;
  hiddenProbes: TestdataBenchmarkProbe[];
}

const DEFAULT_OPTIONS: GenerateOptions = {
  problemKind: 'traditional',
  fillInMode: 'no',
  caseCount: 8,
  dataScale: 'auto',
  languages: [],
};

/**
 * 固定难题集：隐藏探针不放进题面，专门检测“ORACLE 与 BRUTE 一致但共同误读题意”。
 * 题目均为传统题，确保基准可以直接执行生成计划中的 std.py。
 */
export const TESTDATA_HARD_BENCHMARK_CASES: readonly TestdataBenchmarkCase[] = [
  {
    id: 'xor-subarrays-less-than-k',
    title: '子数组异或小于 K',
    difficulty: 'hard',
    tags: ['binary-trie', 'prefix-xor', 'counting'],
    options: { ...DEFAULT_OPTIONS },
    statementMarkdown: `# 子数组异或小于 K

给定长度为 n 的非负整数数组 a 和非负整数 K。计算有多少个非空连续子数组，其所有元素的按位异或结果严格小于 K。

## 输入格式

第一行两个整数 n、K。第二行 n 个整数 a_1...a_n。

## 输出格式

输出满足条件的连续子数组数量。答案可能超过 32 位有符号整数范围。

## 数据范围

- 1 <= n <= 200000
- 0 <= K < 2^31
- 0 <= a_i < 2^31

## 样例

\`\`\`input1
5 4
1 2 3 4 5
\`\`\`

\`\`\`output1
10
\`\`\`
`,
    hiddenProbes: [
      { name: 'K 为 0', input: '1 0\n0\n', output: '0\n' },
      { name: '重复前缀异或', input: '4 8\n7 7 7 7\n', output: '10\n' },
      { name: '严格小于边界', input: '6 3\n0 1 2 3 4 5\n', output: '12\n' },
      { name: '高位混合', input: '8 16\n15 1 7 8 3 12 4 6\n', output: '36\n' },
    ],
  },
  {
    id: 'dynamic-connectivity-offline',
    title: '带删除的动态连通性',
    difficulty: 'hard',
    tags: ['rollback-dsu', 'segment-tree-over-time', 'offline'],
    options: { ...DEFAULT_OPTIONS },
    statementMarkdown: `# 带删除的动态连通性

有 n 个点，初始没有边。依次执行 q 个操作：

- ADD u v：加入无向边 (u,v)，保证加入前该边不存在；
- DEL u v：删除无向边 (u,v)，保证删除前该边存在；
- ASK u v：询问当前图中 u 与 v 是否连通。

## 输入格式

第一行两个整数 n、q。随后 q 行，每行是上述一种操作。

## 输出格式

对每个 ASK 输出一行：连通输出 Yes，否则输出 No。大小写必须完全一致。

## 数据范围

- 1 <= n,q <= 200000
- 1 <= u,v <= n，u != v
- 图中同一时刻不存在重边

## 样例

\`\`\`input1
5 9
ADD 1 2
ADD 2 3
ASK 1 3
DEL 2 3
ASK 1 3
ADD 3 4
ADD 4 5
ASK 3 5
ASK 1 5
\`\`\`

\`\`\`output1
Yes
No
Yes
No
\`\`\`
`,
    hiddenProbes: [
      {
        name: '单边反复加入删除',
        input: '2 5\nASK 1 2\nADD 1 2\nASK 1 2\nDEL 1 2\nASK 1 2\n',
        output: 'No\nYes\nNo\n',
      },
      {
        name: '删除桥后由另一条链恢复',
        input: '6 13\nADD 1 2\nADD 2 3\nADD 4 5\nASK 1 5\nADD 3 4\nASK 1 5\nDEL 2 3\nASK 1 5\nADD 2 6\nADD 6 5\nASK 1 4\nDEL 3 4\nASK 3 4\n',
        output: 'No\nYes\nNo\nYes\nNo\n',
      },
      {
        name: '路径与替代边交错',
        input: '4 10\nADD 1 2\nADD 2 3\nADD 3 4\nASK 1 4\nDEL 2 3\nASK 1 4\nADD 1 4\nASK 2 3\nDEL 1 2\nASK 2 4\n',
        output: 'Yes\nNo\nYes\nNo\n',
      },
    ],
  },
  {
    id: 'range-flip-longest-ones',
    title: '区间翻转与最长连续 1',
    difficulty: 'hard',
    tags: ['lazy-segment-tree', 'range-flip', 'range-query'],
    options: { ...DEFAULT_OPTIONS },
    statementMarkdown: `# 区间翻转与最长连续 1

给定一个长度为 n 的 01 字符串，执行 q 个操作：

- FLIP l r：把闭区间 [l,r] 内所有位取反；
- QUERY l r：输出当前闭区间 [l,r] 内最长连续 1 的长度。

下标从 1 开始，所有操作按输入顺序生效。

## 输入格式

第一行 n、q；第二行一个长度为 n 的 01 字符串；随后 q 行为操作。

## 输出格式

对每个 QUERY 输出一行整数。

## 数据范围

- 1 <= n,q <= 200000
- 1 <= l <= r <= n

## 样例

\`\`\`input1
8 6
00111001
QUERY 1 8
FLIP 2 7
QUERY 1 8
QUERY 3 6
FLIP 1 8
QUERY 1 8
\`\`\`

\`\`\`output1
3
3
1
3
\`\`\`
`,
    hiddenProbes: [
      {
        name: '单点反复翻转',
        input: '1 5\n0\nQUERY 1 1\nFLIP 1 1\nQUERY 1 1\nFLIP 1 1\nQUERY 1 1\n',
        output: '0\n1\n0\n',
      },
      {
        name: '跨段合并与局部查询',
        input: '10 7\n1111100000\nQUERY 1 10\nFLIP 3 8\nQUERY 1 10\nQUERY 3 8\nFLIP 5 5\nQUERY 4 6\nQUERY 5 10\n',
        output: '5\n3\n3\n2\n4\n',
      },
      {
        name: '全区间与嵌套翻转',
        input: '6 6\n010101\nFLIP 1 6\nQUERY 1 6\nFLIP 2 5\nQUERY 1 6\nFLIP 3 4\nQUERY 2 5\n',
        output: '1\n2\n2\n',
      },
    ],
  },
] as const;

export function selectTestdataBenchmarkCases(ids: string[] = []): TestdataBenchmarkCase[] {
  if (ids.length === 0) return [...TESTDATA_HARD_BENCHMARK_CASES];
  const requested = new Set(ids);
  const selected = TESTDATA_HARD_BENCHMARK_CASES.filter(item => requested.has(item.id));
  const missing = ids.filter(id => !selected.some(item => item.id === id));
  if (missing.length > 0) throw new Error(`未知基准题目：${missing.join('、')}`);
  return [...selected];
}
