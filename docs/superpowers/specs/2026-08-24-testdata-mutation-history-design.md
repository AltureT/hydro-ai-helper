# 测试数据生成 R3：Mutation 与历史错误提交差分设计

日期：2026-08-24

状态：Owner 已确认

基线：`claude/testdata-phase-c@47dc183`

上游计划：`docs/superpowers/plans/2026-08-21-testdata-reliability-phase-c-revised.md` 的 Task R3

## 1. 背景与目标

Phase C 的 R1 已闭合共识成本、预算、沙箱缺席和遥测缺口，R2 已加入受信 Generator DSL 与服务端语义覆盖矩阵。R3 在此基础上回答另一个独立问题：当前生成的数据是否能卡掉一组可解释、可重放的错误程序，而不只是在字符串或结构特征上“看起来不同”。

原 Task 10 正文未落盘。本设计按 Owner 批准的方案 A 重建其最小、保守合同，并以 R3 修订条款为硬边界：

1. 对受信标程生成单点、封闭、语言感知的 mutants；
2. 在权限允许时，加入同题历史错误提交作为差分候选；
3. 在 go-judge 中实际运行候选，用已生成正式测试点判定 killed/ survived；
4. 默认只 observe、展示和上报 mutation score；只有独立环境开关显式设为 `enforce` 时才启用 0.8 门槛；
5. 学生源码、mutant 源码、输入输出、位置和记录 ID 只存在于请求内，不进入模型、checkpoint、Job、浏览器、日志或遥测。

## 2. 非目标

- 不修改 R1 的 ProblemSpec 共识、模型调用预算或风险分级。
- 不修改 R2 的 Generator DSL、覆盖矩阵或 `COVERAGE_REQUIREMENT_MISSING` 规则。
- 不使用 AI 生成 mutation，也不把任何历史源码发给模型。
- 不引入通用 AST 编译器、第三方 mutation 框架或任意脚本执行能力。
- 不读取未结束竞赛的提交，不把“题目编辑权限”误当作“源码读取权限”。
- 不让 mutation 结果把原本未验证的计划升级为 `verified=true`。
- 不在本任务启用默认 hard gate，不做 R4 benchmark/replay 或 R5 rollout 文档。

## 3. 总体架构

R3 分为三个窄边界：

1. **Handler 历史候选加载器**：在既有题目编辑权限检查之后，独立检查记录源码读取权限，查询并过滤同题历史错误提交，返回有界、请求级的候选数组。
2. **纯服务端 mutation 引擎**：从当前已验证的自包含 Python/C++ ORACLE 生成单点 mutants；解析、位置选择和源码变换均为确定性代码。
3. **沙箱 mutation 评估器**：编译/运行 generated mutants 与历史候选，按正式 `.in/.out` 或 checker 权威结果分类，生成仅含闭集 ID 和计数的摘要。

`TestdataGenService` 只编排这些组件。源码查询留在 Handler，源码变换与执行留在独立服务文件，避免继续膨胀 `testdataGenService.ts`。

## 4. 数据合同

### 4.1 请求内候选

```ts
interface HistoricalMutationCandidate {
  language: 'python' | 'cpp';
  source: string;
  expectedStatus: 'wrong-answer' | 'runtime-error' | 'time-limit';
}
```

该类型只允许从 Handler 传给本次 `service.generate()`。禁止加入 `GenerationPlan`、checkpoint、`TestdataGenerationJob` 或任何 telemetry 类型。用于去重的 digest 也只存在于请求内。

### 4.2 浏览器安全摘要

```ts
interface MutationVerificationSummary {
  mode: 'off' | 'observe' | 'enforce';
  status: 'completed' | 'partial' | 'skipped';
  generated: number;
  historical: number;
  viable: number;
  killed: number;
  survived: number;
  score?: number;
  operators: Array<{
    id: MutationOperatorId;
    viable: number;
    killed: number;
  }>;
  skippedReason?: MutationSkippedReason;
}
```

摘要可进入 `PlanVerification.mutation`、Job 和浏览器，但不得包含源码、记录 ID、用户名、语言原文、位置、输入输出、stderr、沙箱错误或源码 digest。`score = killed / viable`；`viable === 0` 时不制造 `0` 分，而是没有 score。

### 4.3 遥测

遥测只允许：gate mode、status、operator ID、generated/historical/viable/killed/survived 计数、score 和有界 skip reason。Worker 必须执行闭集枚举、非负安全整数、总量一致性和 score 范围校验；ingest 继续 fail-open。

## 5. Mutation 引擎

### 5.1 支持范围

首版只变换当前管线已经能作为自包含 ORACLE 执行的 Python 3 与 C++17。函数题仍可对其自包含 stdin→stdout ORACLE 做 generated mutation；历史提交首版只支持传统题，因为函数题提交需要题目专属 harness，不能在 R3 中猜测编译协议。

### 5.2 封闭 operator 集

- `comparison-boundary`：`<` 与 `<=`、`>` 与 `>=` 的单点互换；
- `equality-negation`：`==` 与 `!=` 的单点互换；
- `logical-connector`：Python `and/or`、C++ `&&/||` 的单点互换；
- `arithmetic-operator`：`+/-` 的单点互换；
- `constant-off-by-one`：仅对安全、有界的十进制整数常量生成 `n-1` 或 `n+1` 单点变体。

实现必须使用语言感知 tokenizer，跳过注释、字符串/字符字面量、预处理文本和不确定 token；禁止在原始源码上做全局正则替换。每个 mutant 恰好包含一个已知 operator 和一个位置变更。相同源码结果去重；位置、原文与 digest 不离开请求。

### 5.3 有界性与确定性

- 每个 operator 最多选择 3 个稳定位置；
- generated mutants 总数最多 12；
- 历史候选最多 8；
- 总候选最多 20；
- 选择顺序由 operator 固定顺序和源码 token 顺序决定，不依赖随机数；
- 超限只截取，不报错，不改变主生成结果。

这些上限是防止单题耗尽沙箱资源的合同，应以导出常量和边界测试固定。

## 6. 历史错误提交权限与过滤

历史候选加载必须同时满足：

1. 当前用户已通过现有 `checkEditPermission()`；
2. 当前用户具有 `PRIV_READ_RECORD_CODE` 或 `PERM_READ_RECORD_CODE`；
3. record 的 `domainId` 与 `pid` 精确匹配当前题目；
4. 状态属于 WA/RE/TLE，不包含 AC、CE、系统错误、等待/评测中状态；
5. 非竞赛提交可用；竞赛提交只有在服务端确认竞赛已结束后可用；未找到竞赛、状态不明或查询失败均排除；
6. 语言可安全规范化为 Python 3 或 C++17，源码非空、非文件占位、长度不超过现有源码上限；
7. 按请求内源码 digest 去重，并限制为最新 8 个不同候选。

缺少源码读取权限时返回空候选与内部 `permission-unavailable` 原因，不返回 403，不改变原有生成能力，也不降级到“只读自己的提交”。DB/竞赛查询失败同样 fail closed 为无历史候选；不得把查询细节放入用户错误或遥测。

同步生成和后台 Job 必须使用相同加载器。后台路径在创建任务时加载候选并仅捕获在内存闭包中，不写入 Job/checkpoint；进程重启后的重新生成应重新执行权限与竞赛状态检查。

## 7. 沙箱执行与判定

### 7.1 执行顺序

mutation 评估只在以下条件成立时运行：沙箱模式可用、正式 cases 和权威 outputs 已产生、主验证没有硬失败、gate 不为 `off`。它位于正式 materialization/正确性验证之后、最终 plan 收口之前。

先运行 generated mutants，再运行历史候选。候选只在 go-judge 中编译和执行；主进程不加载或执行源码。

### 7.2 viable 与 killed

- Python 可进入实际 batch 执行、C++ 编译成功后计为 viable；编译错误不进入分母。
- 任一正式测试点出现普通输出不一致、checker 明确拒绝、运行时错误、内存/输出限制或候选自身确定的 TLE，则记为 killed。
- 全部已执行正式测试点均与权威结果一致才记为 survived。
- 自定义 checker 的结果只能由现有 checker executor 判定；checker 不可用或 infra error 时，不得退化为文本比较。
- go-judge 传输错误、基础设施超时、取消、全局/子预算耗尽均不算 killed；相应候选不进入可证明结论，并使摘要成为 `partial`。

### 7.3 预算

新增独立 `MUTATION_BUDGET_MS = 120_000`，但它不是额外赠送的总预算。实际 deadline 为 mutation 子预算与现有 `SANDBOX_TOTAL_BUDGET_MS` 剩余时间的较小值；每次编译/运行都复用调用方 AbortSignal。

候选 TLE 使用受控的程序运行上限判定，与 HTTP/队列/基础设施 deadline 分开。只有 go-judge 明确返回候选程序 `Time Limit Exceeded` 才能记为 `killedBy=tle`；请求超时或 deadline 耗尽只能标记 partial/infra。

所有编译制品在 success、failure、cancel 和 budget-exhausted 路径都必须 best-effort 删除。

## 8. Gate 语义

环境变量：`AI_HELPER_TESTDATA_MUTATION_GATE=off|observe|enforce`，非法值回退 `observe`。

- `off`：完全跳过，摘要为 skipped，不调用沙箱；
- `observe`（默认）：计算、展示、上报；不改变 `verified`，但当同一证据在显式 mutation enforce 下会阻断时设置 `wouldBlock=true`；
- `enforce`：`score < 0.8`、无 viable evidence、checker/infra 导致无法形成完整证据时，以 typed failure 阻断，不进入模型修复或模型升级。

现有 `AI_HELPER_TESTDATA_RELIABILITY_MODE=enforce` 本身不能打开 mutation hard gate；只有独立 mutation gate 的显式 `enforce` 值可以。mutation 通过也只能保留现有 verified 状态，不能把 false 改为 true。

建议新增失败码：

- `MUTATION_SCORE_TOO_LOW`：完整证据且分数低于 0.8（复用仓库已预留失败码）；
- `MUTATION_EVIDENCE_UNAVAILABLE`：显式 mutation enforce 下没有完整、非基础设施的可用证据。

两者均为 `stage=mutation_testing`、`artifact=mutation`、`retryPolicy=no-retry`，不触发 AI repair；safeDetails 只含计数、score、门槛和闭集 reason。

## 9. Checkpoint、恢复与计划持久化

mutation 源码和候选列表不进入 checkpoint。恢复运行在 materialization 完成后重新构造 generated mutants，并重新加载当时仍有权限读取、仍满足竞赛状态的历史候选。

`PlanVerification.mutation` 是已完成运行的浏览器安全证据，可以随 completed Job 保存。它不得用于下一次运行跳过 mutation，因为环境 gate、权限、历史记录和沙箱状态都可能变化。

## 10. 前端呈现

在 `VerificationSummaryView` 增加 mutation 行或独立紧凑区块，展示：模式、killed/viable、score、generated/history 数量、operator 聚合和 partial/skipped 原因。前端必须重新校验所有计数、总量、闭集枚举和 score 一致性；不可信 payload 回退为“Mutation evidence unavailable”，不得显示绿色通过。

不展示具体错误源码、记录、用户、位置或触发输入。默认 observe 下的低分使用 warning，不宣称整个计划未经其他门槛验证；显式 enforce 阻断由后端 typed error 负责。

## 11. 测试策略

严格 RED → 最小实现 → GREEN，每一批先加入能证明真实行为的失败测试。

### 11.1 纯单元测试

- Python/C++ tokenizer 跳过注释、字符串、字符和预处理内容；
- 五类 operator 各有正例、不可变例、单点隔离和稳定顺序；
- 12/8/20 上限、去重、相同输入确定性；
- summary 计数、score、zero-viable 和闭集校验。

### 11.2 Handler 测试

- 编辑权限与源码读取权限必须同时满足；
- 无源码权限时不读取 record.code，也不回退自己的提交；
- domain/pid/status/语言/长度过滤；
- 非竞赛与已结束竞赛可用，进行中/未知/查询失败排除；
- 同步和后台路径传入相同请求级合同，Job/checkpoint 中无源码。

### 11.3 沙箱与服务测试

- compiled viable、WA/RE/TLE killed、survived、compile-invalid 不入分母；
- infra timeout/cancel/budget 不记 killed，compiled file 始终清理；
- custom checker infra 不文本回退；
- `off/observe/enforce` 与 reliability mode 的完整矩阵；
- observe 只设置真实 `wouldBlock`，不改 verified；enforce typed failure 不进 repair/escalation；
- checkpoint/resume 重新评估，不持久化源码；
- model call count 不因 mutation 增加。

### 11.4 前端与遥测测试

- 前端正常、低分、partial、skipped、恶意不一致 payload；
- bounded telemetry 允许闭集字段，拒绝源码、输入输出、位置、record ID 和任意字符串；
- Worker ingest 未配置 token 时继续 fail-open；
- D1 migration 可重复 ledger 应用且不破坏旧行。

## 12. 预计变更面

新建：

- `src/services/testdata/mutation.ts`
- `src/services/testdata/mutationRunner.ts`
- 对应 focused tests
- telemetry D1 migration（使用下一个未占用序号）

修改：

- `src/handlers/testdataGenHandler.ts`
- `src/services/testdataGenService.ts`
- `src/services/goJudgeSandboxService.ts`（仅在现有接口不足以区分候选 TLE/infra 或回收制品时做窄扩展）
- `src/services/testdata/runTelemetry.ts`
- `src/services/testdata/failures.ts`
- `frontend/testdataGen/VerificationSummaryView.tsx` 与对应测试
- `frontend/testdataGen/TestdataGenPanel.tsx` 的类型/进度阶段
- Worker、Dashboard 类型/API、locales
- tracked `dist/`

不得把 mutation engine、历史 DB 查询或源码装进 `testdataGenService.ts` 内部大段实现。

## 13. 验收标准

1. 所有候选均由封闭服务端规则或权限过滤的历史提交产生，并只在 go-judge 执行；
2. score 来自实际正式 cases，不信任模型 label；
3. 低分默认 observe，不阻断；显式 mutation enforce 才按 0.8 fail closed；
4. TLE 与 infra timeout 有测试证明不会混淆；
5. 学生源码、mutant 源码、输入输出、位置、记录 ID 不出请求边界；
6. mutation 不增加模型调用、不升级 verified、不弱化既有 gate；
7. `git diff --check`、`npm run lint`、focused Jest、全量 `npm test -- --runInBand --silent`、Worker tests、Dashboard build、`npm run gen:locale`、`npm run build:plugin` 全部通过；
8. 重建后的 tracked `dist/` 与 `src/` 同步；
9. 独立代码审查无 Critical/Important 后才算 R3 本地完成；真实模型、生产 go-judge、HydroOJ 浏览器、Mongo 中断恢复、部署与远端 CI 继续单独标记 `UNVERIFIED`。
