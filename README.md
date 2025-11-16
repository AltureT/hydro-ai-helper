# HydroOJ AI 学习助手

一个以教学为优先的 AI 辅助学习插件，帮助学生在解题过程中获得思路引导而非直接答案。

## 功能特性

### 学生端
- 在题目详情页提供 AI 对话面板
- 强制学生描述思路后才能提问
- AI 回答仅提供引导和伪代码，不输出完整可提交代码

### 教师端
- 查看学生对话记录（按时间/题目/班级筛选）
- 标记和导出有效对话
- 统计分析学生使用情况

### 管理员端
- 配置 AI 服务（支持 OpenAI 兼容 API）
- API Key 加密存储
- 频率限制和成本控制

## 安装

本插件需要 HydroOJ 4.0 或更高版本。

### 从本地目录安装

```bash
# 克隆代码仓库
git clone https://github.com/your-org/hydro-ai-helper.git
cd hydro-ai-helper

# 安装依赖
npm install

# 编译 TypeScript
npm run build

# 添加插件到 HydroOJ
hydrooj addon add /path/to/hydro-ai-helper
```

### 从 npm 安装（未来支持）

```bash
hydrooj addon add @hydrooj/hydro-ai-helper
```

## 配置

插件安装后，管理员需要在后台配置 AI 服务：

1. 访问 `/ai-helper/admin/config`
2. 填写 API Base URL（如 `https://api.openai.com/v1`）
3. 填写 API Key
4. 选择模型（推荐 `gpt-4` 或 `gpt-3.5-turbo`）
5. 点击"测试连接"确认配置正确
6. 保存配置

## 开发

```bash
# 安装依赖
npm install

# 开发模式（监听文件变化）
npm run dev

# 构建
npm run build

# 运行测试
npm test
```

## 项目结构

```
src/
├── index.ts                   # 插件入口
├── models/                    # 数据模型
├── services/                  # 业务逻辑
├── handlers/                  # 路由处理器
├── lib/                       # 工具函数
└── constants.ts               # 常量定义

frontend/                      # 前端代码
├── student/                   # 学生端组件
├── teacher/                   # 教师端组件
└── admin/                     # 管理员端组件

public/                        # 静态资源
locales/                       # 多语言文件
```

## 技术架构

- **后端**: TypeScript + HydroOJ Plugin API
- **数据库**: MongoDB（通过 HydroOJ 提供）
- **前端**: React 17+
- **AI 服务**: OpenAI 兼容 API

## 教学原则

本插件严格遵循以下教学原则：

1. **引导式学习**：AI 不会提供完整的可提交代码
2. **强制思考**：学生必须先描述自己的理解和尝试
3. **过程可追溯**：所有对话记录保存，教师可查看
4. **隐私保护**：API Key 服务端加密存储，前端不可见

## 许可证

MIT License

## 贡献

欢迎提交 Issue 和 Pull Request！

详细的开发文档请参考 [`.specify/specs/ai-learning-assistant/`](./.specify/specs/ai-learning-assistant/) 目录。
