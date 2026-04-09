# HydroOJ AI 学习助手

<div align="center">

**中文 | [English](README.md)**

![GitHub release (latest by date)](https://img.shields.io/github/v/release/AltureT/hydro-ai-helper?label=版本)
![GitHub all releases](https://img.shields.io/github/downloads/AltureT/hydro-ai-helper/total?label=下载量&color=brightgreen)
![Installations](https://img.shields.io/endpoint?url=https://stats.how2learns.com/api/badge-installs)
![Active Users (7d)](https://img.shields.io/endpoint?url=https://stats.how2learns.com/api/badge-active)
![Conversations](https://img.shields.io/endpoint?url=https://stats.how2learns.com/api/badge-conversations)
![Version (mode)](https://img.shields.io/endpoint?url=https://stats.how2learns.com/api/badge-version)
![GitHub stars](https://img.shields.io/github/stars/AltureT/hydro-ai-helper?style=social)
![License](https://img.shields.io/github/license/AltureT/hydro-ai-helper)

</div>

一个以教学为优先的 [HydroOJ](https://github.com/hydro-dev/Hydro) AI 辅助学习插件 — 引导思考，不给答案。支持中英文界面。

## 截图预览

<img src="assets/screenshots/1.png" alt="学生端 - 宽屏" width="800">

<img src="assets/screenshots/2.png" alt="学生端 - 窄屏" width="400">

<details>
<summary><b>管理后台截图</b></summary>

<img src="assets/screenshots/3.png" alt="后台 - 对话记录" width="800">

<img src="assets/screenshots/4.png" alt="后台 - 使用统计" width="800">

<img src="assets/screenshots/5.png" alt="后台 - AI 配置" width="800">

<img src="assets/screenshots/6.png" alt="后台 - 越狱记录" width="400">

<img src="assets/screenshots/7.png" alt="后台 - 成本看板" width="500">

</details>

## 功能特性

### 学生端

- 题目页 AI 对话面板，SSE 实时流式响应，LaTeX 公式自动渲染
- 差异化问题类型：**理解题意** / **理清思路** / **分析错误** / **代码优化**（AC 后专属）
- 多轮对话自动恢复；选中不理解的文字一键追问
- 响应式 UI — 宽屏侧边栏，窄屏浮动面板

### 教师端

- 浏览学生对话记录，按时间/题目/班级/学生/用户ID 筛选
- 班级和题目筛选支持自动补全
- 多维有效性指标与问题类型分布
- CSV 导出，支持脱敏及指标列

### 管理员端

- 统一入口：对话记录/使用统计/AI 配置 Tab 切换
- 多端点 API 管理，自动获取模型列表，拖拽排序优先级，自动 Failover
- 成本控制：Token 用量追踪、预算限制、成本看板
- 频率限制、自定义系统提示词、一键更新

<details>
<summary><b>安全特性</b></summary>

- 多层级越狱检测（输入/提示词/输出），跨轮次防护
- CSRF Token 校验、SSRF 防护、API Key AES-256-GCM 加密存储
- 越狱记录分页审计

</details>

## 安装

```bash
# 克隆（二选一）
git clone https://github.com/AltureT/hydro-ai-helper.git   # GitHub
git clone https://gitee.com/alture/hydro-ai-helper.git      # Gitee（镜像）

cd hydro-ai-helper
npm install
npm run build

# 安装到 HydroOJ
hydrooj addon add /path/to/hydro-ai-helper
pm2 restart hydrooj
```

验证：访问 `/ai-helper/hello` 返回 JSON 即表示成功。

## 配置

### 环境变量

设置 `ENCRYPTION_KEY`（32 字符）用于加密 API Key：

```bash
export ENCRYPTION_KEY="your-32-character-secret-key!!!"
```

生成随机密钥：`openssl rand -base64 24 | head -c 32`

### 管理员配置

登录后访问 **控制面板 → AI 助手**（`/ai-helper`）→"AI 配置" Tab：

1. **添加 API 端点** — 填写端点名称、API Base URL、API Key → 点击「获取模型」
2. **选择模型与优先级** — 选择模型，拖拽排序；首选不可用时自动切换
3. **调整设置** — 频率限制（默认 5 次/分钟/用户）、自定义系统提示词
4. **测试并保存** — 点击「测试连接」验证后保存

## 遥测与隐私

收集**匿名统计数据**（安装数、活跃用户、对话数、版本），用于 GitHub 徽章和开发参考。

- 完全匿名（随机 UUID，无个人信息），域 ID 经 SHA-256 哈希
- 不收集代码、对话内容或个人数据；90 天未上报自动清理

<details>
<summary><b>关闭遥测</b></summary>

```javascript
use your_hydro_db
db.ai_plugin_install.updateOne(
  { _id: 'install' },
  { $set: { telemetryEnabled: false } }
)
```

</details>

## 更新日志

<details>
<summary><b>v1.20.0</b> — 教师端分析增强</summary>

- 班级、题目、学生筛选支持自动补全
- 用户ID 筛选与统一筛选面板布局
- SVG 图标替换 emoji 指标图标
- 成本统计周期准确性修复

</details>

<details>
<summary><b>v1.19.0</b> — 国际化 & 有效性指标</summary>

- 前后端全面中英文国际化
- 多维对话有效性指标，替代简单二值标记
- 统计表格和 CSV 导出新增指标列

</details>

<details>
<summary><b>v1.18.0</b> — 遥测看板 & 错误诊断</summary>

- 遥测看板 SPA，监控插件安装状态
- 增强错误诊断，含端点级上下文
- 管理端反馈收集 UI

</details>

<details>
<summary><b>v1.16.x</b> — 稳定性 & 安全</summary>

- Docker 环境遥测 ID 稳定性修复
- DOMPurify 升级修复 XSS 漏洞
- 越狱记录默认折叠

</details>

<details>
<summary><b>v1.14.x</b> — SSE 流式响应 & 成本控制</summary>

- SSE 流式输出，AI 回复实时逐字显示
- Token 用量追踪、预算限制、成本看板
- CSRF 保护、SSRF 防护、Prompt 注入三层防御
- 作业/竞赛模式支持

</details>

<details>
<summary><b>v1.12.0 及更早版本</b></summary>

- v1.12.0：评测数据集成，竞赛模式，Token 减少约 45%
- v1.11.0：引导式回答优化，跨轮次越狱防护
- v1.10.x：匿名遥测统计，一键更新
- v1.9.0：全面安全审计与加固
- v1.8.x：「代码优化」问题类型（AC 后专属）
- v1.6.0：统一管理入口，Tab 切换
- v1.4.0：多端点配置，优先级 Failover
- v1.2.0：差异化问题类型
- v1.0.0：初始发布

</details>

## 关于

[HydroOJ](https://github.com/hydro-dev/Hydro) 开源在线评测系统的第三方插件。如有问题或建议，欢迎提交 Issue。

## 许可证

MIT License
