# 性能测试指南（T027）

本指南用于在测试环境快速验证 HydroOJ 插件 **@hydrooj/hydro-ai-helper** 的关键接口性能。工具选择保持轻量，默认提供 k6 脚本，也可替换为 `ab`/`wrk` 等等。

## 前置条件
- 已在测试环境部署 HydroOJ 与本插件，核心配置（`ENCRYPTION_KEY`、AI 访问配置等）已填写，并能正常完成对话请求。
- 拥有测试用 **学生账号 Cookie**（用于 `/ai-helper/chat`），以及 **教师/管理员 Cookie**（用于列表、导出接口）。
- 本地安装了 [k6](https://k6.io/docs/get-started/installation/)；或在说明中使用容器镜像 `grafana/k6` 运行。
- 测试环境与生产环境隔离，且压力测试期间监控 CPU、内存、MongoDB 慢查询日志。

## 测试数据准备
- 目标数据量（建议）：Conversation 数量 1k / 5k / 10k；每个会话约 5-10 条消息。
- 快速生成数据的两种方式：
  1) 使用学生账号循环调用 `/ai-helper/chat`：

     ```bash
     export HYDRO_BASE_URL=http://127.0.0.1
     export HYDRO_STUDENT_COOKIE="sid=..."
     for i in {1..200}; do
       curl -s -X POST "$HYDRO_BASE_URL/ai-helper/chat" \
         -H 'Content-Type: application/json' \
         -H "Cookie: $HYDRO_STUDENT_COOKIE" \
         -d '{"problemId":"demo","questionType":"understand","userThinking":"我想熟悉这道题的双指针思路"}' >/dev/null
     done
     ```

  2) 在 MongoDB 中批量插入模拟数据：参考 `tests/performance/data/prepare-sample-data.md` 给出的脚本示例。

## 关键接口与关注点
- 学生端高频接口：`POST /ai-helper/chat`
- 教师端列表/详情：`GET /ai-helper/conversations`、`GET /ai-helper/conversations/:id`
- 导出接口：`GET /ai-helper/export?format=csv`
- 统计接口：`GET /ai-helper/analytics`

## 压测脚本与运行方式（k6）
所有脚本位于 `tests/performance/scripts/`。必要环境变量：
- `HYDRO_BASE_URL`：HydroOJ 基础地址（默认 `http://127.0.0.1`）
- `HYDRO_STUDENT_COOKIE`：学生登录 Cookie，用于聊天接口
- `HYDRO_TEACHER_COOKIE`：教师/管理员 Cookie，用于列表/导出接口
- 可选：`VUS`、`DURATION`、`SLEEP` 用于覆盖并发与节奏

1. **学生对话接口**

   ```bash
   k6 run tests/performance/scripts/student-chat-k6.js \
     --env HYDRO_BASE_URL=http://127.0.0.1 \
     --env HYDRO_STUDENT_COOKIE="sid=..."
   ```

2. **教师对话列表接口**

   ```bash
   k6 run tests/performance/scripts/teacher-conversations-k6.js \
     --env HYDRO_BASE_URL=http://127.0.0.1 \
     --env HYDRO_TEACHER_COOKIE="sid=..." \
     --env PAGE_LIMIT=50
   ```

3. **导出接口（小批量）**

   ```bash
   k6 run tests/performance/scripts/export-csv-k6.js \
     --env HYDRO_BASE_URL=http://127.0.0.1 \
     --env HYDRO_TEACHER_COOKIE="sid=..." \
     --env EXPORT_DAYS=7
   ```

> 如果未安装 k6，可使用 Docker：`docker run --rm -i grafana/k6 run - < tests/performance/scripts/student-chat-k6.js`（通过 `-e` 传递环境变量）。

## 推荐性能门槛（可按硬件微调）
- `/ai-helper/chat`：10 并发、30s 压测下，P95 ≤ 2s
- `/ai-helper/conversations`：10 并发、30s 压测下，P95 ≤ 1s
- `/ai-helper/export`：在 1k 会话量级内，P95 ≤ 3s

满足以上门槛即可视为通过；若不满足，请结合 MongoDB `explain`、慢查询日志定位瓶颈。

## 结果解读与记录
- 关注 k6 输出中的 `http_req_duration`（总耗时）和 `http_req_waiting`（服务端处理耗时）。
- 以 P95/P99 作为参考；若 P50 与 P95 差距过大，说明尾延迟需要优化。
- 将测试参数与结果追加记录到 `tests/integration/README.md` 或新建记录文件，便于回溯。

## 风险与注意事项
- 不要在生产环境直接做大流量压测；优先在隔离的测试服执行。
- 导出接口请从小批量开始（如 7 天或 500~1000 条数据），确认无内存/超时风险后再扩大范围。
- 压测期间留意 HydroOJ 进程 CPU/内存、MongoDB 连接数和慢查询日志，必要时降低并发或缩短持续时间。
