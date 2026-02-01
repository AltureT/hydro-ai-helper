# API 超时优化实施记录

## 实施日期
2026-02-01

## 优化目标
解决"代码优化"(optimize) 问题类型 API 响应超时问题

## 实施的优化 (阶段 1: 性能监控 + 数据库查询优化)

### 1. 导入依赖
- **文件**: `src/handlers/studentHandler.ts:6`
- **变更**: 从 `hydrooj` 导入 `db` 用于直接数据库访问
- **影响**: 允许绕过 Model 层,使用更高效的原生 MongoDB 查询

### 2. ChatHandler - AC 存在性检查优化
- **文件**: `src/handlers/studentHandler.ts:120-128`
- **原实现**:
  ```typescript
  const acRecords = await RecordModel.getMulti(domainId, {
    uid: userId,
    pid: pdoc.docId,
    status: STATUS.STATUS_ACCEPTED
  })
  .sort({ _id: -1 })  // ❌ 不需要排序
  .limit(1)
  .project({ _id: 1 })
  .toArray();
  ```
- **优化后**:
  ```typescript
  const dbStart = Date.now();
  const acRecord = await db.collection('record').findOne({
    domainId,
    uid: userId,
    pid: pdoc.docId,
    status: STATUS.STATUS_ACCEPTED
  }, { projection: { _id: 1 } });
  console.log(`[Perf] AC Check: ${Date.now() - dbStart}ms`);
  ```
- **优化原理**:
  - ✅ 移除不必要的 `sort` 操作 (只需验证存在性,无需最新记录)
  - ✅ 使用 `findOne` 替代 `getMulti(...).toArray()`,减少中间步骤
  - ✅ 添加 `Date.now()` 计时,避免并发冲突 (不使用 `console.time`)
- **预期收益**: AC 检查耗时从 ~200ms 降至 ~20-50ms (假设索引良好)

### 3. ChatHandler - AI 调用性能监控
- **文件**: `src/handlers/studentHandler.ts:339-341`
- **变更**:
  ```typescript
  const aiStart = Date.now();
  const result = await multiModelClient.chat(messages, systemPrompt);
  console.log(`[Perf] AI Response: ${Date.now() - aiStart}ms`);
  ```
- **目的**: 测量 AI 推理真实耗时,用于后续瓶颈分析

### 4. ProblemStatusHandler - AC 代码查询优化
- **文件**: `src/handlers/studentHandler.ts:457-468`
- **原实现**:
  ```typescript
  const acRecord = await RecordModel.getMulti(domainId, {
    uid: userId,
    pid: pdoc.docId,
    status: STATUS.STATUS_ACCEPTED
  })
  .sort({ _id: -1 })
  .limit(1)
  .project({ status: 1, code: 1, lang: 1 })
  .toArray();
  ```
- **优化后**:
  ```typescript
  const dbStart = Date.now();
  const acRecordDoc = await db.collection('record').findOne({
    domainId,
    uid: userId,
    pid: pdoc.docId,
    status: STATUS.STATUS_ACCEPTED
  }, {
    sort: { _id: -1 },  // ✅ 需要排序获取最新代码
    projection: { status: 1, code: 1, lang: 1 }
  });
  console.log(`[Perf] Status Check: ${Date.now() - dbStart}ms`);
  ```
- **优化原理**:
  - ✅ 保留 `sort` (需要最新 AC 代码)
  - ✅ 使用 `findOne` 替代 `getMulti(...).toArray()`
  - ✅ 添加性能计时

## 关键技术决策

### 为什么使用 `Date.now()` 而非 `console.time()`?
**Codex 和 Gemini 共同警告**: Node.js 的 `console.time(label)` 使用全局标签键,多个并发请求会相互干扰,导致:
- 计时结果错误
- 控制台警告 (Label 'xxx' already exists)

**正确做法**:
```typescript
const start = Date.now();
// ... 异步操作 ...
console.log(`[Perf] Operation: ${Date.now() - start}ms`);
```

### 为什么 ChatHandler 不需要 `sort` 而 ProblemStatusHandler 需要?
| Handler               | 目的               | 是否需要 sort | 原因                       |
| --------------------- | ------------------ | ------------- | -------------------------- |
| ChatHandler           | 验证用户是否 AC    | ❌ 否         | 任何 AC 记录都能证明通过   |
| ProblemStatusHandler  | 获取最新 AC 代码   | ✅ 是         | 需要最新提交的代码给用户   |

### 直接使用 `db.collection()` 的风险评估
**Codex 警告**: 绕过 Model 层可能失去:
- 租户隔离
- 软删除过滤
- 权限控制

**风险控制**:
- ✅ 查询包含 `domainId` → 租户隔离保留
- ✅ HydroOJ 导出 `db` 就是用于直接访问 → 框架支持
- ⚠️ 需确认 `record` 集合无软删除逻辑 (待验证)

## 验证方法

### 本地/测试环境
1. 选择已 AC 的题目 (如 P1000)
2. 在聊天窗口选择"代码优化"类型
3. 提交包含完整代码的请求 (模拟最坏情况)
4. 观察控制台日志:
   ```
   [Perf] AC Check: 45ms          <- 应显著低于 100ms
   [Perf] AI Response: 12300ms    <- 正常范围 10-30 秒
   [AI Helper] 使用模型: OpenAI/gpt-4
   ```
5. 对比其他问题类型 (understand, debug) 的耗时

### 性能基准预期
| 阶段        | 优化前     | 优化后目标 | 判断标准             |
| ----------- | ---------- | ---------- | -------------------- |
| AC Check    | ~200ms     | ~20-50ms   | 如 > 100ms 需检查索引 |
| AI Response | 10-30s     | 10-30s     | 取决于模型和 prompt  |
| 总响应时间  | 可能超时   | < 30s      | 正常情况不应超时     |

### 生产环境监控
- 收集 7 天日志
- 统计 `[Perf] AC Check` 和 `[Perf] AI Response` 的 P50/P95/P99
- 计算 optimize 类型的超时率变化
- 如 AC Check 仍 > 100ms → 执行阶段 3 (索引优化)

## 下一步 (视监控结果决定)

### 阶段 2: 根据瓶颈针对性优化
**如果 AC 检查仍慢 (> 100ms)**:
- 用 `db.collection('record').find(...).explain()` 分析查询计划
- 提交索引优化工单 (需 DBA 协作)

**如果 AI 调用是主瓶颈 (> 20s)**:
- 考虑限制 optimize 类型的历史消息数量 (从 7 条降至 3 条)
- 使用更快的模型或设置 `maxTokens`

**如果两者都不慢但仍超时**:
- 检查外部因素:
  - Nginx/负载均衡器的超时设置
  - AI 服务商的限流或区域延迟
  - MultiModelClient 的 fallback 重试累积延迟

### 阶段 3: 数据库索引优化 (长期)
```javascript
// 检查现有索引
db.record.getIndexes()

// 如缺少复合索引,建议添加:
db.record.createIndex({
  domainId: 1,
  uid: 1,
  pid: 1,
  status: 1
})
```

**注意事项**:
- 大型集合建索引有性能开销
- 需在维护窗口执行
- 索引会增加存储成本

## 专家审阅总结

### Codex 关键意见
- ✅ 必须先添加性能监控,用数据验证假设
- ✅ 使用 `Date.now()` 避免并发计时冲突
- ⚠️ "数据库是主瓶颈"是假设而非证据,需测量

### Gemini 关键优化
- ✅ ChatHandler 移除不必要的 `sort`
- ✅ 直接使用 `findOne` 比 cursor 更高效
- ✅ HydroOJ 的 `db` 导出就是用于直接访问

## TypeScript 类型检查
```bash
npx tsc --noEmit
```
✅ 通过,无类型错误

## 相关文件
- `src/handlers/studentHandler.ts` (已修改)
- `src/services/openaiClient.ts` (未修改)
- `src/services/promptService.ts` (未修改)

## 回滚方案
如出现问题,可恢复到 git commit:
```bash
git log --oneline -1  # 记录当前 commit
git revert HEAD       # 回滚本次优化
```
