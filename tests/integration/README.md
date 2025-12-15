HydroOJ AI Helper 集成测试说明
========================

本文件提供一套基于 `curl` 的接口级测试脚本，覆盖「管理员配置 → 学生提问 → 数据持久化 → 教师查看/导出/统计」核心链路，无需额外测试框架。

前置条件
--------
- HydroOJ 已安装并运行，且已加载本插件并执行 `npm run build`。
- 通过环境变量或 `.env` 配置了 `ENCRYPTION_KEY`（用于保存 AI Key）。
- 至少有一个具备 `PRIV.PRIV_EDIT_SYSTEM` 的管理员账号（教师端接口当前也要求此权限）。
- 准备若干题目与测试用户（学生/教师）。账号需已登录，以便获取 Cookie。
- 可用的 AI 配置（真实或假 API Key + 可用的 base URL/mock 服务）。请勿将真实 Key 写入仓库。
- 本地具备 `curl` 和 `python3`（仅用于解析 JSON 并保存 `conversationId`）。

获取登录 Cookie
---------------
1. 使用浏览器登录 HydroOJ，对应账号分别获取 `sid=...` Cookie（管理员/教师/学生）。
2. 在浏览器开发者工具的 Application/Storage 中复制 Cookie；或在请求头里复制整段 `Cookie: sid=xxxxx`。
3. 后续脚本通过环境变量读取这些 Cookie。

快速开始
--------
在仓库根目录执行：

```bash
cd tests/integration/curl
chmod +x *.sh

# 必需环境变量
export HYDRO_BASE_URL="http://127.0.0.1"
export HYDRO_ADMIN_COOKIE="sid=admin-cookie"
# 教师端接口目前同样需要系统权限，如无单独教师账号可复用管理员 Cookie
export HYDRO_TEACHER_COOKIE="sid=teacher-cookie"
export HYDRO_STUDENT_COOKIE="sid=student-cookie"

# 可选：AI 配置占位值
export HYDRO_AI_API_BASE_URL="https://api.openai.com/v1"
export HYDRO_AI_MODEL_NAME="gpt-3.5-turbo"
export HYDRO_AI_API_KEY="sk-REPLACE-ME"
export HYDRO_AI_RATE_LIMIT=5
export HYDRO_AI_TIMEOUT=30

# 依次执行核心链路
./01-admin-config-set.sh
./02-student-chat.sh
./03-teacher-list.sh
./04-teacher-detail.sh
./05-export.sh
./06-analytics.sh
```

- `02-student-chat.sh` 会把最新的 `conversationId` 写入 `.conversation_id`，供后续脚本复用；也可通过 `HYDRO_CONVERSATION_ID` 覆盖。
- 如需重新获取 Cookie 或更换 base URL，请重新导出环境变量后再运行脚本。

测试脚本一览
------------

脚本 | 场景 | 涉及接口 | 预期结果
---- | ---- | -------- | -------
01-admin-config-set.sh | 管理员设置 AI 配置并测试连接 | PUT /ai-helper/admin/config；POST /ai-helper/admin/test-connection | 200，返回配置摘要；测试连接返回 `success: true/false` 消息
02-student-chat.sh | 学生发起对话（含 questionType 与可选代码） | POST /ai-helper/chat | 200，返回 `conversationId` 与 `message.content`；写入 `.conversation_id`
03-teacher-list.sh | 教师查看对话列表，验证筛选参数 | GET /ai-helper/conversations | 200，包含列表与分页信息，可看到刚创建的会话；错误日期格式应返回 400
04-teacher-detail.sh | 教师查看对话详情 | GET /ai-helper/conversations/{id} | 200，返回会话元数据与消息数组
05-export.sh | 导出 CSV | GET /ai-helper/export | 200，`Content-Type: text/csv`，生成的 CSV 文件非空
06-analytics.sh | 查看统计数据 | GET /ai-helper/analytics | 200，返回 `dimension` 对应的统计结构；非法 dimension 返回 400

判定通过/失败
-------------
- HTTP 状态码：脚本中默认要求 200（部分错误场景除外），否则退出并打印响应体。
- 核心字段检查：
  - 配置：返回体含 `config` 字段；`test-connection` 返回 `success` 与 `message`。
  - 学生对话：返回 `conversationId`、`message.content` 非空；若触发频率限制会返回 429（可作为附加验证）。
  - 列表/详情：列表返回 `conversations` 数组、`total`；详情返回 `conversation` 与 `messages` 数组。
  - 导出：输出文件非空且首行包含 CSV 头；若 `format` 非 `csv` 应返回 400。
  - 统计：返回 `dimension` 与 `items` 数组；若缺失 `dimension` 参数（且请求 Accept JSON），应返回 400。
- 权限异常：不带 Cookie 或使用学生 Cookie 访问教师/管理员接口应返回 403/401（可手动去掉 Cookie 重试验证）。
- 时间范围参数：传入明显非法日期（示例见 03/05/06 脚本中的 `INVALID_DATE` 示例）应返回 400。

附加说明
--------
- 真实测试时请替换 `HYDRO_AI_API_KEY` 为有效 Key 或指向可用的 mock 服务；切勿将真实 Key 保存在仓库。
- 如果已存在历史会话，可设置 `HYDRO_CONVERSATION_ID` 跳过新建对话。
- 默认频率限制（学生端）为每分钟 1 次，请在 1 分钟内避免重复调用，以免收到 429。
