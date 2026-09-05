import type { StatementSnapshot } from './statementSnapshot';

export interface BuildProblemSpecPromptInput {
  snapshot: StatementSnapshot;
  requestedProblemKind: 'auto' | 'traditional' | 'function';
  hasCustomChecker: boolean;
}

export interface ProblemSpecPrompt {
  systemPrompt: string;
  userPrompt: string;
}

export function buildProblemSpecPrompt(input: BuildProblemSpecPromptInput): ProblemSpecPrompt {
  const systemPrompt = `你是 OJ 题意规范提取器。只输出一个严格 JSON 对象：禁止 Markdown 代码围栏、前后说明、注释或额外字段。

JSON 必须满足 ProblemSpecV1：
{
  "schemaVersion": 1,
  "statementHash": "服务端提供的 64 位 sha256",
  "problemKind": "traditional | function",
  "testCaseMode": {"kind":"single"} | {"kind":"counted","countField":"field-id"},
  "inputFields": [{"id":"唯一 ID","name":"字段名","type":"integer | number | string | array | matrix | permutation | tree | graph | operations | custom","encoding":"原始输入编码","dependsOn":["field-id"]}],
  "constraints": [{"id":"唯一 ID","expression":"约束","machineCheckable":true,"scope":"global" | {"subtaskId":1},"evidence":{"quote":"题面逐字引文","section":"可选标题","startOffset":0,"endOffset":1}}],
  "invariants": [{"id":"唯一 ID","kind":"unique | sorted | permutation | tree | connected | dag | simple-graph | stateful-precondition | custom","expression":"不变量","machineCheckable":true,"evidence":{"quote":"题面逐字引文","section":"可选标题"}}],
  "outputPolicy": {"kind":"exact | token | float | unordered | multiple-valid | custom-checker","tolerance":0.000001,"caseSensitive":true},
  "operations": [{"name":"操作名","arguments":["参数"],"preconditions":["前置条件"],"effects":["效果"]}],
  "subtasks": [{"id":1,"score":100,"constraintIds":["constraint-id"]}],
  "uncertainties": [{"code":"唯一代码","description":"无法从题面解决的歧义","evidence":"可选题面引文"}]
}

规则：
1. 所有 field、constraint、invariant ID 全局唯一；引用只能指向已声明 ID。
2. evidence.quote 必须逐字来自完整题面；不要改写。section 使用不含 # 的标题文本。
3. startOffset/endOffset 不作为可信输入，服务端会重新计算；不得用 offset 代替 quote。
4. 约束、状态操作前置条件、子任务继承、多组测试、函数题调用形式和输出比较策略不得遗漏。
5. 不确定内容写入 uncertainties，不得猜测；可选 evidence 必须是题面中的逐字引文。
6. outputPolicy 只能使用封闭枚举；只有题目当前配置了自定义 checker 时才使用 custom-checker。
7. 不要输出 metadata 或任何契约外字段。

inputFields.encoding 的机器编码约定（位置从 1 开始，引用使用字段 id）：
- 整数或无空白字符串，例如第一行第一个值：line:1 token:1。
- n 个数组/排列元素单独占第二行：line:2 tokens:1..n，并声明 dependsOn:["n"]；n 必须是已声明的整数计数字段。
- n 行 m 列矩阵从第二行开始：lines:2..n+1 tokens:1..m，dependsOn:["n","m"]。
- n 个顶点的树边从第二行开始：lines:2..n tokens:1,2，dependsOn:["n"]。
- m 条图边从第二行开始：lines:2..m+1 tokens:1,2，dependsOn 同时引用顶点数和边数。
- q 个操作从第二行开始：lines:2..q+1 operations，dependsOn:["q"]；操作参数 x 的独立字段可用 operation-argument:x，operations.arguments 引用参数字段 id。
只有题面实际布局与上述形式精确一致时才使用机器编码。加权边、变长/嵌套布局、带空格字符串、多参数状态操作等不能无损表达时，保留准确的文字编码与完整类型/语义，服务端会判断支持范围；禁止为了适配 DSL 丢掉权重、操作参数或状态前置条件。函数题未明确标准输入编码时不得凭空添加长度前缀或改写原调用形式。`;

  const chunks = input.snapshot.chunks.flatMap(chunk => [
    `--- STATEMENT CHUNK ${chunk.index + 1}/${input.snapshot.chunks.length} [${chunk.start},${chunk.end}) ---`,
    chunk.content,
  ]);
  const userPrompt = [
    `statementHash: ${input.snapshot.statementHash}`,
    `requestedProblemKind: ${input.requestedProblemKind}`,
    `customCheckerConfigured: ${input.hasCustomChecker ? 'true' : 'false'}`,
    `normalizedLength: ${input.snapshot.length}`,
    '',
    '以下 chunks 按顺序精确拼接为完整规范化题面，不得省略末尾内容：',
    ...chunks,
    '',
    '请只输出严格 JSON ProblemSpecV1。',
  ].join('\n');
  return { systemPrompt, userPrompt };
}
