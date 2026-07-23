# 测试数据生成难题基准

这个基准用于回答一个具体问题：某个模型能否在真实的两阶段生成、题面样例、独立 BRUTE、60 组压力对拍和 Hydro go-judge 沙箱全部开启时，稳定生成正确测试数据。

它不是日常 Jest 测试，默认不会运行，也不会在 CI 中产生模型费用。只有显式传入 `--confirm-cost` 才会调用模型。

## 当前题集

- `xor-subarrays-less-than-k`：前缀异或 + 01 Trie 计数
- `dynamic-connectivity-offline`：带删除动态连通性、可撤销并查集
- `range-flip-longest-ones`：区间翻转、懒标记线段树

每题除了公开样例，还包含至少三组不会发送给模型的隐藏探针。隐藏探针直接执行最终 `std.py`，用于发现 ORACLE 与内部 BRUTE 因共同误读题意而“错误一致”的情况。

## 从管理页运行（推荐）

在「AI 助手 → AI 配置」中：

1. 在「API 端点配置」完成端点、API Key 和模型配置；
2. 在「场景模型」为「测试数据生成」配置首选模型与后备模型；
3. **先保存配置**，确认免费就绪检查中的模型配置和沙箱均可用；
4. 首次先运行「快速验证 · 1 题」，通过后再运行「完整基准 · 3 题」。

就绪检查只读取已保存配置并探测沙箱，不会发起付费模型请求。管理页会明确显示当前评估的模型链；若场景模型链为空，则跟随全局模型链。页面还提供可展开的功能与三道题说明、实时进度、取消、结果建议、完整报告与隐私安全汇总下载。只有系统管理员可以调用，每小时最多运行 2 次，且每次都需要明确确认费用。结果不写入数据库，也不会自动上传。

## 从 CLI 运行

CLI 适合插件开发者做自动化对比，它使用独立环境变量，不会读取平台数据库中的 AI 配置。

```bash
export TESTDATA_BENCHMARK_API_BASE="https://api.example.com/v1"
export TESTDATA_BENCHMARK_API_KEY="..."
export TESTDATA_BENCHMARK_MODELS="primary-model,deeper-fallback-model"
export TESTDATA_BENCHMARK_SANDBOX_HOST="http://127.0.0.1:5050"
```

可用 `TESTDATA_BENCHMARK_MODEL` 指定单模型；`TESTDATA_BENCHMARK_TIMEOUT_SECONDS` 控制单次模型调用超时，默认 600 秒。

先查看题集，不需要 API 配置，也不会产生费用：

```bash
npm run benchmark:testdata -- --list
```

运行全部题目：

```bash
npm run benchmark:testdata -- --confirm-cost --output=artifacts/testdata-benchmark.json
```

同时生成一份可以用于趋势系统的最小聚合快照：

```bash
npm run benchmark:testdata -- \
  --confirm-cost \
  --output=artifacts/testdata-benchmark-full.json \
  --aggregate-output=artifacts/testdata-benchmark-aggregate.json
```

聚合快照只包含题目 ID、通过状态、耗时、Token、失败阶段和探针通过数量；不包含题面、生成代码、探针输入输出、错误正文、API base 或 API key。目前它只写入本地文件，不会自动上传。

只运行部分题目，并要求至少 2/3 通过：

```bash
npm run benchmark:testdata -- \
  --confirm-cost \
  --case=xor-subarrays-less-than-k,dynamic-connectivity-offline \
  --min-pass-rate=0.67 \
  --output=artifacts/testdata-benchmark.json
```

## 通过条件

一道题只有同时满足以下条件才记为 PASS：

1. 生成计划经过 sandbox 模式；
2. 题面样例全部通过；
3. VALIDATOR 实际执行；
4. 60 组独立压力输入全部完成对拍且输出一致；
5. 压力输入至少 80% 唯一，正式测试点至少 75% 唯一；
6. `.in/.out`、`std.py`、生成器、BRUTE、VALIDATOR 等关键文件不存在 `ai-only` 来源；
7. 最终 `std.py` 通过全部隐藏正确性探针。

报告包含模型链、耗时、Token 用量、验证证据、隐藏探针结果和失败阶段。API key 不会写入报告。

## 比较模型或提示词版本

每次变更前后使用相同题集、相同沙箱和相同 `--min-pass-rate` 各运行数轮。不要只比较单次总通过率，还要观察：

- `solution_blueprint`：解题或公开样例阶段失败；
- `hidden_probe`：内部验证自洽，但标程真实逻辑仍错误；
- `stress-generator` / `brute`：独立验证制品质量不足；
- `sandbox_budget`：验证时间超过硬预算；
- 总耗时和 Token 是否因成功率提升而失控。

真实模型存在随机性。重要模型升级建议每个版本至少运行三轮，再比较平均通过率与失败阶段分布。

## 比较历史报告

运行新基准时直接与旧报告比较：

```bash
npm run benchmark:testdata -- \
  --confirm-cost \
  --compare=artifacts/baseline.json \
  --output=artifacts/current.json
```

也可以完全不调用模型，只比较两份已有报告：

```bash
npm run benchmark:testdata -- \
  --compare-reports=artifacts/baseline.json,artifacts/current.json
```

比较结果会列出通过率、总耗时、Token、失败阶段数量的变化，以及每道题的 `IMPROVED` / `REGRESSED`。检测到通过率下降或题目回退时，比较命令返回非零退出码，便于接入手动发布检查。
