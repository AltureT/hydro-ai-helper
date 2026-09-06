"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildProblemSpecPrompt = buildProblemSpecPrompt;
function buildProblemSpecPrompt(input) {
    const systemPrompt = `你是 OJ 题意规范提取器。只输出一个严格 JSON 对象：禁止 Markdown 代码围栏、前后说明、注释或额外字段。

ProblemSpecV1 格式示例（虚构题目，只说明结构）：
=== VALID JSON EXAMPLE ===
{
  "schemaVersion": 1,
  "statementHash": "0000000000000000000000000000000000000000000000000000000000000000",
  "problemKind": "traditional",
  "testCaseMode": {
    "kind": "single"
  },
  "inputFields": [
    {
      "id": "n",
      "name": "n",
      "type": "integer",
      "encoding": "line:1 token:1"
    }
  ],
  "constraints": [
    {
      "id": "c_n",
      "expression": "1 <= n <= 100",
      "machineCheckable": true,
      "scope": "global",
      "evidence": {
        "quote": "1 <= n <= 100."
      }
    }
  ],
  "invariants": [],
  "outputPolicy": {
    "kind": "exact"
  },
  "subtasks": [],
  "uncertainties": []
}
=== END EXAMPLE ===
示例中的字段、约束和引文不得照搬。实际 statementHash 必须使用本次用户消息提供的值，证据必须来自本次完整题面。
字段规则与可选形式（不是 JSON 内容）：
- problemKind：traditional 或 function。
- testCaseMode：{"kind":"single"}；题面明确以数量字段给出多组时使用 {"kind":"counted","countField":"t"}，t 必须在 inputFields 中声明为 integer。
- inputFields.type：integer、number、string、array、matrix、permutation、tree、graph、operations、custom。dependsOn 可省略，提供时只引用已声明字段 ID。
- constraints 的每项字段：id、expression、machineCheckable、scope、evidence。scope 为 "global" 或 {"subtaskId":1}，后者必须对应已声明子任务。
- invariants 的每项字段：id、kind、expression、machineCheckable、evidence。kind 只能是 unique、sorted、permutation、tree、connected、dag、simple-graph、stateful-precondition、custom。
- evidence 必须包含 quote。section 可省略；没有可定位的标题时省略，不填空字符串、null 或虚构标题。constraints 的 evidence 可有 startOffset/endOffset 非负整数；invariants 的 evidence 不带 offset。
- outputPolicy.kind：exact、token、float、unordered、multiple-valid、custom-checker；integer 不是合法值。非 float 输出省略 tolerance；float 必须提供大于 0 且不超过 1 的 tolerance。caseSensitive 可省略，提供时为布尔值。不要用 tolerance:0 或 null 代替省略。
- operations 可省略；每项字段为 name、arguments、preconditions、effects，后三项均为不含重复项的字符串数组。
- subtasks 每项为 {"id":1,"score":100,"constraintIds":["c_n"]}；所有分数合计 100，引用已声明约束；无子任务时用 []。
- uncertainties 每项包含唯一 code、description，可选 evidence 为非空题面引文字符串；无歧义时用 []。
- ID 以英文字母开头，只包含英文字母、数字、下划线、点、冒号、连字符，最多 64 字符。不要输出占位符、用竖线拼接枚举值或填入多余字段。

规则：
1. 所有 field、constraint、invariant ID 全局唯一；引用只能指向已声明 ID。
2. evidence.quote 必须逐字来自完整题面；不要改写。section 使用不含 # 的标题文本。
3. startOffset/endOffset 不作为可信输入，服务端会重新计算；不得用 offset 代替 quote。
4. 约束、状态操作前置条件、子任务继承、多组测试、函数题调用形式和输出比较策略不得遗漏。
5. 不确定内容写入 uncertainties，不得猜测；可选 evidence 必须是题面中的逐字引文。
6. outputPolicy 只能使用封闭枚举；只有题目当前配置了自定义 checker 时才使用 custom-checker。
7. 不要输出 metadata 或任何契约外字段。

可精确表达时，约束 expression 优先使用以下机器语法，引用字段 id（不要把 name 当作 id）：
- 整数边界：1 <= n <= 200000，或 n >= 1、n <= 200000。
- 数组元素边界：-1000000000 <= nums[i] <= 1000000000；分开写时可用 nums[i] >= -1000000000、nums[i] <= 1000000000。
- 数组长度：length(nums) = n；元素不重复：allDistinct(nums)。
- 无空白 ASCII 字符串长度：length(s) = n，字符串字段 dependsOn:["n"]；二进制字符集：characters(s) in [01]，小写字母字符集：characters(s) in [a-z]。
- 每条操作的区间边界：for every operation, 1 <= l <= r <= n；l、r 是每次操作的 integer 参数，不是 q 个端点组成的 array；可声明 {"id":"l","name":"l","type":"integer","encoding":"operation-argument:l"} 和对应的 r 字段。不要为单个参数添加 length(l) = q 之类数组约束。operations 中保留按输入顺序排列的 arguments:["l","r"]，preconditions 使用 1 <= l <= r <= n。其他前置条件和 effects 按题意完整保留。
上述只是表示约定，不得改写题面含义、删掉无法表示的约束或把未支持的语义标为已验证；其他约束继续准确表达并保留证据。

inputFields.encoding 的机器编码约定（位置从 1 开始，引用使用字段 id）：
- 整数或无空白字符串，例如第一行第一个值：line:1 token:1。
- n 个数组/排列元素单独占第二行：line:2 tokens:1..n，并声明 dependsOn:["n"]；n 必须是已声明的整数计数字段。
- n 行 m 列矩阵从第二行开始：lines:2..n+1 tokens:1..m，dependsOn:["n","m"]。
- n 个顶点的树边从第二行开始：lines:2..n tokens:1,2，dependsOn:["n"]。
- m 条图边从第二行开始：lines:2..m+1 tokens:1,2，dependsOn 同时引用顶点数和边数。
- q 个操作从第二行开始：lines:2..q+1 operations，dependsOn:["q"]；操作参数 x 的独立字段可用 operation-argument:x，operations.arguments 引用参数字段 id。
- q 个操作从第三行开始：lines:3..q+2 operations，dependsOn:["q"]；计数字段可以位于前两行的明确 token 位置。每条操作占一行，首 token 为操作名，其余为按 arguments 顺序排列的参数。
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
//# sourceMappingURL=problemSpecPrompts.js.map