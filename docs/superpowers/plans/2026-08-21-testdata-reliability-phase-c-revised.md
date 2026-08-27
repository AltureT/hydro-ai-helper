# 测试数据生成可靠性加固 — 剩余工作修订计划（Phase C 修订版）

> 本计划修订自 `2026-08-19-testdata-generation-reliability-hardening.md`（下称"原计划"）。
> 原计划 Task 0–8 已按原文执行完毕（Task 0–7 已合并 main，Task 8 = PR #68）。
> 两轮代码审计（2026-08-21）发现原计划执行结果存在若干偏差与缺口，本修订版：
> 1. 新增 **Task R1（共识成本收敛与缺口闭合）**，置于一切 Phase C 工作之前；
> 2. 对原 Task 9–11 附加修订条款；
> 3. 将原 Task 12 收缩为本会话可完成的范围。
>
> 原计划的「全局约束」「必须保留的现有能力」「禁止的捷径」全部继续生效，另加：
> - **遥测 ingest 必须保持 fail-open**（无 token 配置时放行；2026-06 事故红线，见 worker.js isAuthorized 注释）。
> - 每次生成运行的 AI 调用次数必须有可测试的硬上限。
> - 不得为通过测试而放宽既有 enforce 门槛。

**基线：** branch `claude/testdata-phase-c`，基于 `codex/task8-validator-rejection-probes` 头（76d2e7c）。
**验证命令（每任务收尾必跑）：** `git diff --check && npm run lint && npm test -- --runInBand --silent && npm run build:plugin`；涉及 locale 加跑 `npm run gen:locale`；涉及 Worker/Dashboard 加跑 `node --test cloudflare/telemetry-worker/*.test.mjs` 与 `npm --prefix cloudflare/telemetry-dashboard run build`；提交需包含重建的 `dist/`。

---

## Task R1：共识成本收敛与缺口闭合（P0，先于一切 Phase C 工作）

**依据（审计结论，含 file:line 均以 76d2e7c 为准）：**

1. Spec 共识比较是 9 桶整桶 `isDeepStrictEqual`，表达式仅做空白折叠（`specConsensus.ts:81-83, 168-179`），无数值/符号规范化；`uncertainties` 本身是 diff path。两个不同模型对同一题产出字节级一致规范的概率极低 → **裁决（第 3 次模型调用）几乎每次触发**。
2. 双 Spec + 裁决在每次非 legacy 运行**无条件**执行（`testdataGenService.ts:7422, 7735`）；`risk.requiresSpecConsensus` 只用于前端展示，未参与门控。
3. **无任何 AI 调用/token 预算**；`PIPELINE_BUDGET_EXHAUSTED` 只挂沙箱毫秒。
4. `boundedProblemSpecObservation`（`runTelemetry.ts:291-311`）在发出前丢弃 `consensusStatus/conflictCount/unresolvedConflictCount/rolesUsed` → 共识系统在生产不可观测。
5. `statementTruncated` 在两处生产调用点写死 `false`（`testdataGenService.ts:7407`、`testdataGenHandler.ts:643`），blocked 触发条件一半失效。
6. enforce + auto 模式 + 沙箱不可用 + low tier + env 开启时仍可直出未验证数据；对应测试断言的是 `SPEC_PARSE_FAILED` 而非 `SANDBOX_REQUIRED`（`testdataGenService.test.ts:7393-7412`）。
7. observe 模式下 `wouldBlock === requiresSandbox`，默认配置下几乎每次运行都亮警告横幅 → 噪音而非信号。
8. `parseKillTargetsResponse` 无 max-2 硬上限（`testdataGenService.ts:2658-2696`），仅提示词约定。
9. 样例验证循环中自定义 checker 单点 `infra-error` 裁定既不比较也不记 skip 原因，仅靠聚合门槛兜底（`testdataGenService.ts:5489-5516`）。
10. 冻结 kill-target 提示中样例 I/O `slice(0, 1000)` 截断无标记（`testdataGenService.ts:2141-2142`）。

**要求（TDD：每项先补失败测试再实现）：**

- [ ] **R1.1 共识按风险分级门控**：`low` tier → 仅 `specPrimary` 单模型抽取（无 critic、无 adjudicator）；`medium/high/blocked` → 保持双 Spec + 裁决。以 `risk.requiresSpecConsensus` 为唯一门控来源（先算初始风险，再决定角色链）。`legacy` 行为不变。保留一个 env 开关 `AI_HELPER_TESTDATA_SPEC_CONSENSUS`（`auto`(默认，按风险)/`always`/`off`）作为可测试的回滚/强制开关。
- [ ] **R1.2 比较归一化，缩小冲突面**：
  - `text()` 归一化增加：全角→半角、`≤/≥/≠` → `<=/>=/!=`、`10^5/1e5/100000` 等数值科学计数与幂次的规范化（保守实现：能确定性等值的才归一，其余保持原样）；
  - `uncertainties` 移出 DIFF_PATHS：双方 uncertainty 取并集记入 resolvedSpec，不作为冲突；
  - `constraints/invariants` 冲突粒度从整桶降到条目级：以归一化签名对齐后，仅把无法配对的条目列为冲突项，裁决输入/输出也只针对未配对条目（裁决合同相应收窄，仍保持"逐项 evidence 服务端验证"）；
  - 目标（写入测试断言）：语义等价但写法不同的两份 spec（如 `1 <= n <= 10^5` vs `1 ≤ n ≤ 100000`）必须判 consensus，不触发裁决。
- [ ] **R1.3 每运行 AI 调用预算**：新增运行级计数器（含语义 fallback 重跑累计），默认上限 40 次（常量可配 env `AI_HELPER_TESTDATA_MAX_MODEL_CALLS`），超限抛 `PIPELINE_BUDGET_EXHAUSTED`（`no-retry`，safeDetails 记录 callCount/limit）。所有角色客户端调用走同一计数入口，测试用回环 mock 验证：a) 正常管线远低于上限；b) 人为循环触发上限即终止且不进入修复。
- [ ] **R1.4 共识遥测可观测**：`boundedProblemSpecObservation` 透传 `consensusStatus`（枚举）、`conflictCount`、`unresolvedConflictCount`、`rolesUsed`（数量或枚举列表）；Worker `/api/testdata-events` 白名单接受这些字段（长度/枚举校验），D1 migration `0011_testdata_spec_consensus.sql` 为 `testdata_runs` 增列；Dashboard 类型同步（面板展示可延至 R5）。**ingest 保持 fail-open。** 隐私红线不变：仅枚举与计数，无原文。
- [ ] **R1.5 truncated/blocked 信号接真**：StatementSnapshot 超硬限已抛错（不截断），故 `statementTruncated` 语义改为"快照阶段检出超限/分块失败"并从真实信号传入（两处调用点），或若确认该信号在新架构下恒不可达，则从 risk 输入中删除该参数并同步测试与注释——二选一，不得保留写死的 `false`。
- [ ] **R1.6 enforce 沙箱缺席闭环**：enforce 模式下沙箱不可用时，无论 tier/env/确认状态一律 `SANDBOX_REQUIRED`（observe 保持现行为）；修正 `testdataGenService.test.ts:7393-7412` 使其真实断言该路径（mock 到达沙箱决策点）。
- [ ] **R1.7 wouldBlock 降噪**：`wouldBlock` 仅在"本次运行实际发生了 enforce 下会被阻断的事件"时为 true（实际走了 direct、共识 unresolved、checker/模板未完成等），而非静态等于 `requiresSandbox`。前端横幅联动。
- [ ] **R1.8 kill-target 解析硬上限**：`parseKillTargetsResponse` 截取前 2 个（超出记 warning note），测试覆盖 5 段响应→2 目标。
- [ ] **R1.9 样例 checker infra 裁定显式化**：样例循环中 `infra-error` 裁定记入每样例 skip 原因（结构上可见），不再无声落空；聚合门槛行为不变。
- [ ] **R1.10 截断标记**：冻结 kill-target 提示样例 I/O 1000 字符截断处追加显式标记（如"（样例过长已截断）"）；legacy 路径 `analysis.slice` 同样加标记（不改变截断长度）。

**文件（预计）：** `src/services/testdata/specConsensus.ts`、`risk.ts`、`runTelemetry.ts`、`src/services/testdataGenService.ts`、`src/handlers/testdataGenHandler.ts`、`frontend/testdataGen/TestdataGenPanel.tsx`、`cloudflare/telemetry-worker/worker.js` + migration `0011` + 测试、`cloudflare/telemetry-dashboard/src/types.ts|api.ts`、对应测试文件、locales（新增文案）。

**提交：** `fix: converge spec consensus cost and close reliability gaps`

---

## Task R2 = 原 Task 9（语义覆盖矩阵与受信生成器 DSL），附加修订

按原计划 Task 9 执行，附加：

- [ ] DSL materializer 是纯服务端确定性代码（不经 AI、不进沙箱执行任意代码），必须带属性式测试（随机种子重放）覆盖每种结构的合法性（树连通无环、图无自环重边约束、permutation 完备性等）。
- [ ] 覆盖特征计算失败（结构解析不出）不得让整体生成失败：标记 `coverageMode = ai-generator-unverified` 并继续（observe/enforce 同），仅 high risk + enforce + 关键缺口才 `COVERAGE_REQUIREMENT_MISSING`。
- [ ] 新增模型调用（若 GeneratorPlan 需要）计入 R1.3 预算。
- [ ] 不支持的题型必须诚实标记，禁止 label 自报覆盖（原计划红线）。

---

## Task R3 = 原 Task 10（mutation 与历史提交差分），附加修订

按原计划 Task 10 执行，附加：

- [ ] **mutation score 门槛先 observe 后 enforce**：首版所有模式下只计算、展示、上报 mutationScore，不做硬阻断；`enforce` 下的 0.8 阻断门槛留待线上数据校准后另行开启（实现开关但默认关闭：`AI_HELPER_TESTDATA_MUTATION_GATE=off|observe|enforce`，默认 `observe`）。
- [ ] 历史提交读取权限规则照原计划（题目编辑者 + 代码读取权限 + 排除未结束竞赛 + 学生代码不出 go-judge、不进遥测、不发模型）。
- [ ] mutant 运行计入沙箱毫秒预算（复用现有 SANDBOX_TOTAL_BUDGET_MS 体系，独立子预算），TLE 判定用独立预算，infra 超时不计为已杀（原计划红线）。
- [ ] 遥测仅上报 operator ID、viable/killed 计数与 score，无源码。

---

## Task R4 = 原 Task 11（基准扩展与 replay fixtures），附加修订

按原计划 Task 11 执行，附加：

- [ ] 新基准用例必须覆盖 R1 的行为：consensus 单/双模型路径、语义等价 spec 判 consensus 的归一化用例。
- [ ] 付费基准仍不进默认 CI；`npm test` 内只跑离线 fixture 校验。
- [ ] 报告字段按原计划 Step 4，另加 `specConsensusStatus`、`modelCallCount`。

---

## Task R5 = 原 Task 12 收缩版（observe 收尾与文档）

本会话仅执行：

- [ ] 原 Step 1：确认默认 `AI_HELPER_TESTDATA_RELIABILITY_MODE=observe`、`AI_HELPER_TESTDATA_ALLOW_DIRECT_FALLBACK=false`，env example 与 README/README_en/CHANGELOG 更新（新增 env：SPEC_CONSENSUS、MAX_MODEL_CALLS、MUTATION_GATE）。
- [ ] rollout 测试：三种 reliability mode × 关键路径的回归测试若有缺口补齐。
- [ ] 原 Step 5 文档：模型角色、reliability mode、风险分级、ProblemSpec/共识（含 R1 修订语义）、checker/模板门槛、教师 outcome 与隐私、benchmark 运行、回滚方式。
- [ ] Dashboard：TestdataQualityPanel 增加共识状态与 model call 数展示（消费 R1.4 字段）。

**明确延后（生产指标门控，不在本会话执行）：** 原 Task 12 Step 2（enforce 试点）、Step 3（默认 enforce）、Step 4（删除旧控制流，含 `classifySandboxRepairScope` 导出与 legacy analysis 路径）。这些进入运营检查单，随 observe 数据达标后另行执行。

---

## 执行顺序与纪律

R1 → R2 → R3 → R4 → R5，严格串行；每任务一个提交（或紧密小批次），TDD，收尾跑全量验证命令并重建 `dist/`。实现者为 Codex CLI（workspace-write，worktree 内不可 git 操作，由控制器提交）；每任务完成后由独立审查 agent 做规格+质量双裁定，Critical/Important 必须修复并复审后才进入下一任务。
