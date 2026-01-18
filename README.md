# HydroOJ AI 学习助手

一个以教学为优先的 AI 辅助学习插件，帮助学生在解题过程中获得思路引导而非直接答案。

## 特色功能

### 多轮对话与上下文理解

- **连续追问**：学生可以在同一对话中持续追问，AI 能够理解并引用之前的对话内容
- **对话持久化**：页面刷新后对话记录自动恢复，按题目隔离
- **智能截断**：对话历史超过 6 条时自动截取最近消息，防止 token 超限

### 选中答疑（"我不理解"功能）

- **精准追问**：在 AI 回复中选中不理解的文字，弹出"我不理解"按钮
- **选中高亮保持**：点击按钮时选中状态保留，清晰标识追问内容
- **简洁回复**：针对选中内容的解释限制在 2 段以内，直击要点
- **支持历史消息**：可对任意一条 AI 历史回复使用选中答疑

### 差异化问题类型

| 类型 | 说明 | 回复风格 |
|------|------|----------|
| 理解题意 | 对题目要求不太清楚 | 详细解释，循序渐进 |
| 理清思路 | 需要帮助梳理解题思路 | 结构化框架，有层次 |
| 分析错误 | 代码有问题，需要找出原因 | 简洁直接，快速定位 |

### 教师端数据分析

- **多维度统计**：按班级/学生/题目查看 AI 使用情况
- **可排序表格**：点击表头对任意列升序/降序排序
- **快捷跳转**：点击题目名称跳转详情页，点击对话数跳转筛选后的记录列表
- **数据导出**：支持 CSV 导出

### 现代化 UI

- **三列布局**：宽屏设备（≥1200px）自动切换 LeetCode 风格布局（题目 | 代码 | AI 对话）
- **响应式设计**：窄屏设备显示浮动对话面板
- **统一主题**：紫色渐变主色调，圆角卡片设计

## 核心特性

**学生端**：题目页面浮动对话面板、自动读取题目、问题类型选择、可选附带代码、多轮对话、选中答疑

**教师端**：查看学生对话记录、按时间/题目/班级/学生筛选、可排序统计表格、导出 CSV（支持脱敏）

**管理员端**：配置 AI 服务（API URL/模型/Key）、频率限制、System Prompt 自定义

## 安装

```bash
# 克隆并构建
git clone https://github.com/AltureT/hydro-ai-helper.git
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

登录后访问 **控制面板 → AI 配置**（`/ai-helper/admin/config`）：

| 字段 | 说明 | 示例 |
|------|------|------|
| API Base URL | AI 服务地址 | `https://api.openai.com/v1` |
| 模型名称 | 使用的模型 | `gpt-4` / `gpt-3.5-turbo` |
| API Key | API 密钥 | `sk-...` |
| 频率限制 | 每用户每分钟请求数 | `5` |

配置后点击"测试连接"验证，然后保存。

## 使用

### 学生

1. 访问题目详情页，右下角展开 AI 面板（宽屏自动显示右侧栏）
2. 选择问题类型（理解题意/理清思路/分析错误）
3. 可选：描述你的理解和尝试
4. 可选：附带当前代码
5. 发送后查看 AI 引导式回答
6. 如有不理解的地方，选中文字点击"我不理解"继续追问

### 教师

- **对话记录**：控制面板 → AI 对话记录（`/ai-helper/conversations`）
- **统计分析**：控制面板 → AI 使用统计（`/ai-helper/analytics`）
- **数据导出**：对话列表页点击"导出数据"

### 示例截图

**学生端问答面板与题目联动示例：**

<img src="assets/screenshots/1.png" alt="学生端示例" width="800">

<img src="assets/screenshots/2.png" alt="学生端示例" width="400">

**后台管理：**

<img src="assets/screenshots/3.png" alt="后台管理示例" width="800">

<img src="assets/screenshots/4.png" alt="后台管理示例" width="800">

<img src="assets/screenshots/5.png" alt="后台管理示例" width="800">

<img src="assets/screenshots/6.png" alt="后台管理示例" width="400">

<img src="assets/screenshots/7.png" alt="后台管理示例" width="500">

## 项目结构

```
hydro-ai-helper/
├── src/                # 后端（TypeScript）
│   ├── models/         # 数据模型
│   ├── services/       # 业务逻辑
│   ├── handlers/       # 路由处理器
│   └── lib/            # 工具函数
├── frontend/           # 前端（React）
│   ├── student/        # 学生端组件
│   ├── teacher/        # 教师端组件
│   └── admin/          # 管理员组件
└── dist/               # 编译输出
```

## 开发

```bash
npm run dev      # 开发模式（watch）
npm run build    # 构建
npm run lint     # 代码检查
```

## 关于本项目

本项目是 [HydroOJ](https://github.com/hydro-dev/Hydro) 开源在线评测系统的第三方插件，由 AI 辅助开发完成。如有问题或建议，欢迎提交 Issue。

## 许可证

MIT License
