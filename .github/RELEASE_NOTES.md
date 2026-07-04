<!--
  This file IS the GitHub Release body (the publish workflow reads it via
  body_path). Auto-generation is disabled on purpose. Keep it user-facing and
  update it before each release tag.
-->
## v2.5.0

- **新增「AI 生成测试数据」（Beta）**：在题目文件页（`/p/:pid/files`）根据 Markdown 题面一键生成完整测试数据集——测试点 `N.in`/`N.out`、函数题评测模板（`template.py`/`template.java`/`template.cc` 与 `compile.sh`）、评测配置 `config.yaml`（写入后评测设置自动同步）与参考标程。所有文件先预览、可编辑、勾选确认后才写入，覆盖已有文件前明确提示。
  - 支持传统题与 LeetCode 风格函数题（含 `class Solution` 类方法签名、类/列表实现的链表题）
  - 支持填空题（完善代码）：自动识别题面中的待完善代码（可手动指定），标程与测试点输出严格匹配题面代码的打印格式
  - 可粘贴已有标准答案：所有测试点输出以该代码为唯一权威推演，并作为 std 文件一并写入
  - 数据规模小/中/大三档可调；测试点强制覆盖题面示例与边界组，每个测试点标注设计意图
  - 骨架模式（AI 故障降级）：不调用 AI 直接产出评测配置、编译脚本、模板骨架与空白测试点，教师手动填写数据
  - 权限与 Hydro 题目文件管理一致（题目所有者或题目编辑权限），学生无法访问；生成端点限流 5 次/5 分钟
- 新增 AI 场景「测试数据生成」，可在管理端为其单独指定模型链（建议使用最强模型）；该场景调用不限输出长度、单次超时 10 分钟
- AI 输出采用分节文本契约（代码零转义），修复 JSON 嵌入代码时的转义解析失败；面板加载失败时显示可操作的错误提示而非静默消失
- 升级注意：更新插件后需重启 Hydro 以重建前端资源；若部署在 nginx 反代之后，建议将 `proxy_read_timeout` 调至 600 秒以上
