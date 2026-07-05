<!--
  This file IS the GitHub Release body (the publish workflow reads it via
  body_path). Auto-generation is disabled on purpose. Keep it user-facing and
  update it before each release tag.
-->
## v3.0.0

- **「AI 生成测试数据」升级为沙箱实跑 + 双重验证（本版本核心）**：
  - 测试数据不再由 AI 直接给出：数据生成器与标程（ORACLE）在 Hydro 判题沙箱（go-judge）中实际运行产出 `.in`/`.out`，AI 只提供"蓝图"
  - 三道机器关卡：独立暴力解对拍、函数题 solution+模板组合实跑比对、输入校验器逐点校验；传统题标程必须先通过题面样例回归
  - 验证失败时自动把失败阶段、出错测试点、输入内容与 traceback 关键行回喂 AI 修复一轮；教师中途取消不再误报为验证失败
  - 生成的 `std.py` / `oracle.py` / `generator.py` / `brute.py` / `validator.py` / `template.*` 首行自带用途注释，方便识别与复验
  - 沙箱不可达时自动降级为兼容直出模式并明确标注"未验证"（可用 `AI_HELPER_TESTDATA_GENERATION_MODE=sandbox` 强制要求沙箱）；骨架模式继续可用
- 强模型提醒：题目文件页与管理端「场景模型」页醒目提示为该场景配置最强模型——弱模型生成的生成器与标程常自相矛盾，反复无法通过沙箱验证
- 遥测与告警增强：错误上报携带 AI 失败详情、启动失败金丝雀告警、功能用量累计、长活跃窗口与实例来源省份
- 升级注意：沙箱验证依赖 `hydrojudge.sandbox_host`（默认 `http://localhost:5050/`）可达；更新插件后需重启 Hydro 重建前端资源

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
