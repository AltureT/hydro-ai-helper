# 测试数据生成低延迟改造设计

## 目标

在不减少现有模型角色、测试点、压力数据、validator、oracle、BRUTE、模板、区分度与 mutation 正确性门槛的前提下，降低 AI 测试数据生成的固定等待与长尾延迟，并让线上阶段耗时可量化。

## 已确认的约束

- 基线为 `origin/main@35bece3`，默认 `observe`、风险门控 Spec 共识、frozen ProblemSpec、沙箱 fail-closed、角色独立性和模型调用总预算全部保留。
- 不启用 `direct` 或 `legacy`，不减少 60 组内部压力数据，不关闭 mutation，不更改 `verified` / `wouldBlock` / enforce 判定。
- 不把题面、Spec、输入输出、源码、模型 URL、API Key 或原始错误加入浏览器、Job 或遥测。
- 生产 TypeScript 变更必须同步重建并提交 `dist/`。
- 本批不改变模型选择、推理强度或输出 token 上限；这些必须经过真实模型非劣 benchmark 后另行实施。

## 方案选择

### 采用：测量先行 + 无损重叠 + 保守有界并发

本批只优化彼此独立、最终仍由原门槛汇合的工作：让 observe 模式的沙箱健康检查与 Spec 提取重叠；为测试数据模型请求设置独立、可配置的长任务截止时间，超时只能切换既有 fallback 或失败；对 mutation 候选做顺序稳定的有界并发，并对并发环境中的 TLE 串行复验。现有 stage duration 继续作为唯一耗时事实源，Worker 聚合固定桶后在 Dashboard 展示 P50/P95。

### 不采用：直接削减验证

关闭 Spec 共识、kill target、mutation、BRUTE，降低压力数据数量，或使用 direct/legacy 虽然能缩短时间，但会减少机器证据，与目标冲突。

### 延后：完整沙箱 DAG 重排

Generator/Validator/Oracle/Template/BRUTE 的跨阶段并行会改变 go-judge 资源竞争和 TLE 语义。先用本批阶段 P50/P95 识别真实瓶颈，再单独设计带资源令牌和串行 TLE 复验的 DAG；本批不触碰这条高风险边界。

## 设计

### 1. 阶段耗时聚合

`TestdataRunTelemetrySession` 已发送 `stage_completed.durationMs`，D1 也已保存该字段。本批不新增原始遥测字段或迁移，只在 Worker 的测试数据质量查询中按 `stage` 聚合固定延迟桶，并由服务端从桶计数推导近似 P50/P95。返回结构为：

```ts
interface TestdataStageLatency {
  stage: string;
  runs: number;
  p50Ms: number | null;
  p95Ms: number | null;
}
```

Dashboard 增加“阶段耗时”表，按 P95 降序显示阶段、样本数、P50、P95。固定桶只暴露计数和时长，不增加隐私面；无样本返回空数组，旧 Worker 响应在前端规范化为 `[]`。

### 2. 模型长尾截止时间

新增纯函数 `getTestdataModelTimeoutMs()`，读取 `AI_HELPER_TESTDATA_MODEL_TIMEOUT_SECONDS`：默认 300 秒，允许 30–1800 秒，非法值回退默认值。`TestdataGenService.getCallOptions()` 不再传 `timeoutMs: null`，而是传该有界值；`retryTimeouts: false` 保持不变，因此超时不会在同一模型盲目重试，而会沿既有模型链 fallback。kill-target 与 hack-candidate 已有更窄预算，继续覆盖通用值。

截止时间只影响可用性，不改变成功计划的验收：截断、超时或不完整响应仍不能进入 plan，后续 schema、Spec、沙箱和 mutation 门槛保持原样。管理员现有普通聊天 timeout 不复用于测试数据，避免默认 30 秒误伤长任务。

### 3. observe 模式健康检查重叠

当模式不是 `direct`、存在 sandbox runner、且 reliability 不是 `enforce` 时，在 Spec 提取前启动一次 `isAvailable(signal)` Promise，完成 Spec 后复用该结果。`enforce` 继续先确认沙箱可用再调用模型，保持 fail-closed 和“不为必失败请求付模型成本”的现有语义。

重叠只改变等待顺序：不增加健康检查次数，不改变 fallback 决策，不吞掉取消或网络错误。

### 4. mutation 有界并发与 TLE 串行复验

新增 `AI_HELPER_TESTDATA_MUTATION_CONCURRENCY`，默认 2，允许 1–4，非法值回退 2。mutation 候选按原数组切成固定窗口，每个窗口内并行执行，窗口结果按原顺序消费；到达预算、取消或 fail-closed 条件后不再领取新窗口。

执行分类把首次 `timedOut` 暂记为 `timeout-pending`。窗口全部收束后，该候选在没有其他 mutation 候选运行时串行复验：再次 TLE 才计为 killed；复验遇到预算或基础设施问题按现有 partial/skipped 语义处理，绝不把 infra 当作 killed。最终 generated/historical/viable/killed/survived/operator 汇总结构不变。

### 5. 回滚

- 模型截止时间可设为 1800 秒回到接近旧行为，但不再允许无限等待。
- mutation 并发可设为 1，保留新的 TLE 串行复验并恢复候选串行调度。
- 健康检查重叠和 Dashboard 聚合均为内部实现，无数据迁移；可独立回退。

## 测试与验收

- TDD：每项生产行为先新增失败测试并记录 RED，再最小实现至 GREEN。
- `openaiClient`/`testdataGenService`：验证默认/边界/非法 timeout，验证 testdata 请求不再禁用 deadline，验证 observe 健康检查在 Spec 未完成时已经启动且只调用一次，enforce 顺序不变。
- `testdataMutationRunner`：验证最大并发不超过配置、输出按候选顺序汇总、首次 TLE 串行复验、第二次 TLE 才 killed、预算/infra 不误计。
- Worker/Dashboard：验证桶聚合、P50/P95 边界、空数据和旧响应兼容、表格排序与格式。
- 最终门槛：`npm run gen:locale`（仅新增文案时）、`npm run build:plugin`、`npm run lint`、相关 Jest、全量 Jest、Worker tests、Dashboard build、`git diff --check`；重建 `dist/`。

## 明确不在本批

- 快模型首跑/强模型升级、reasoning effort、角色模型重配。
- 动态降低压力数据、mutation 数量、caseCount 或语言模板验证。
- 跨运行结果缓存、教师标程跳过 Oracle 模型、完整沙箱 DAG。
- 真实模型和 go-judge 性能结论；代码合并后仍需以线上 P50/P95 和付费 benchmark 验证。
