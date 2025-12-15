# HydroOJ AI 学习助手

一个以教学为优先的 AI 辅助学习插件，帮助学生在解题过程中获得思路引导而非直接答案。

## 核心特性

**学生端**：题目页面浮动对话面板、自动读取题目、强制选择问题类型并描述思路、可选附带代码、多轮对话

**教师端**：查看学生对话记录、按时间/题目/班级/学生筛选、导出 CSV（支持脱敏）、统计分析

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

1. 访问题目详情页，右下角展开 AI 面板
2. 选择问题类型（理解题意/理清思路/分析错误/检查代码思路）
3. 描述你的理解和尝试（至少 20 字）
4. 可选附带代码
5. 发送后查看 AI 引导式回答

### 教师

- **对话记录**：控制面板 → AI 对话记录（`/ai-helper/conversations`）
- **统计分析**：控制面板 → AI 使用统计（`/ai-helper/analytics`）
- **数据导出**：对话列表页点击"导出数据"

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

## 许可证

MIT License
