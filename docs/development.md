# 开发者文档 - HydroOJ AI 学习助手

本文档面向开发者,介绍如何在本地开发、调试和贡献代码。

---

## 目录

- [快速开始](#快速开始)
- [开发环境搭建](#开发环境搭建)
- [目录结构详解](#目录结构详解)
- [开发工作流](#开发工作流)
- [测试指南](#测试指南)
- [代码规范](#代码规范)
- [调试技巧](#调试技巧)
- [常见开发问题](#常见开发问题)

---

## 快速开始

```bash
# 1. 克隆代码仓库
git clone https://github.com/your-org/hydro-ai-helper.git
cd hydro-ai-helper

# 2. 安装依赖
npm install

# 3. 配置环境变量（开发环境）
echo 'ENCRYPTION_KEY="dev-32-character-key-for-test!"' > .env

# 4. 启动开发模式（TypeScript watch 模式）
npm run dev

# 5. 在另一个终端加载插件到 HydroOJ
hydrooj addon add /path/to/hydro-ai-helper
pm2 restart hydrooj

# 6. 查看日志
pm2 logs hydrooj --follow
```

---

## 开发环境搭建

### 前置要求

- **Node.js**: 18+ (推荐使用 LTS 版本)
- **npm**: 8+ (随 Node.js 安装)
- **HydroOJ**: 4.0+ (需要先搭建 HydroOJ 开发/测试环境)
- **MongoDB**: 4.4+ (HydroOJ 依赖)
- **pm2**: 用于管理 HydroOJ 进程

### HydroOJ 开发环境搭建

参考 [HydroOJ 官方文档](https://hydro.js.org/docs/) 完成 HydroOJ 的安装和配置。

推荐使用 Docker 快速搭建 MongoDB:

```bash
docker run -d \
  --name hydro-mongo \
  -p 27017:27017 \
  -e MONGO_INITDB_ROOT_USERNAME=hydro \
  -e MONGO_INITDB_ROOT_PASSWORD=hydro \
  mongo:4.4
```

### 插件依赖安装

```bash
npm install
```

主要依赖:

- `hydrooj` (^4.0.0): HydroOJ 插件 API
- `typescript` (^5.0.0): TypeScript 编译器
- `axios` (^1.6.0): HTTP 客户端（调用 OpenAI API）
- `markdown-it` (^14.1.0): Markdown 渲染
- `highlight.js` (^11.11.1): 代码高亮
- `react` (^17.0.2): 前端框架

---

## 目录结构详解

```
hydro-ai-helper/
├── src/                       # 后端源码（TypeScript）
│   ├── index.ts               # 插件入口，注册路由和数据库模型
│   ├── models/                # 数据模型层
│   │   ├── conversation.ts    # 对话记录模型（CRUD 操作 + 索引）
│   │   ├── message.ts         # 消息模型（CRUD 操作 + 索引）
│   │   ├── aiConfig.ts        # AI 配置模型（单例配置）
│   │   └── rateLimitRecord.ts # 频率限制记录模型（TTL 索引）
│   ├── services/              # 业务逻辑层
│   │   ├── openaiClient.ts    # OpenAI API 客户端（封装 chat completions 调用）
│   │   ├── promptService.ts   # Prompt 构造服务（system/user prompt 生成）
│   │   ├── conversationService.ts # 对话管理服务（多轮对话上下文管理）
│   │   ├── rateLimitService.ts    # 频率限制服务（基于 MongoDB 的分钟级频率限制）
│   │   ├── effectivenessService.ts # 有效对话判定服务（基于关键词和轮次）
│   │   └── exportService.ts   # 数据导出服务（CSV 生成）
│   ├── handlers/              # 路由处理器层（HydroOJ Handler）
│   │   ├── testHandler.ts     # 测试路由（GET /ai-helper/hello）
│   │   ├── studentHandler.ts  # 学生端对话 API（POST /ai-helper/chat）
│   │   ├── teacherHandler.ts  # 教师端对话列表/详情 API
│   │   ├── analyticsHandler.ts # 统计分析 API
│   │   ├── exportHandler.ts   # 数据导出 API（返回 CSV 文件）
│   │   ├── adminHandler.ts    # 管理员配置 API（GET/PUT /ai-helper/admin/config）
│   │   └── adminConfigHandler.ts # 管理员配置页面 Handler
│   ├── lib/                   # 工具函数层
│   │   ├── crypto.ts          # API Key 加密/解密工具（AES-256-GCM）
│   │   └── validation.ts      # 输入验证工具（未来扩展）
│   ├── utils/                 # 通用工具
│   │   └── mongo.ts           # MongoDB ObjectId 工具（类型安全）
│   └── constants.ts           # 常量定义（问题类型、限制值等）
│
├── frontend/                  # 前端源码（React + TypeScript）
│   ├── problem_detail.page.tsx        # 题目详情页脚本（挂载 AI 面板）
│   ├── student/               # 学生端组件
│   │   └── AIAssistantPanel.tsx # AI 助手面板（浮动对话框、拖拽、Markdown 渲染）
│   ├── teacher/               # 教师端组件
│   │   ├── ConversationList.tsx   # 对话列表页（筛选、分页）
│   │   ├── ConversationDetail.tsx # 对话详情页（查看完整对话）
│   │   ├── ExportDialog.tsx       # 导出对话框（配置导出选项）
│   │   └── AnalyticsPage.tsx      # 统计分析页（多维度统计）
│   ├── admin/                 # 管理员端组件
│   │   └── ConfigPanel.tsx    # 配置面板（AI 服务配置、测试连接）
│   ├── ai_helper_conversations.page.tsx # 对话列表页面路由
│   ├── ai_helper_conversation_detail.page.tsx # 对话详情页面路由
│   ├── ai_helper_analytics.page.tsx # 统计分析页面路由
│   └── ai_helper_admin_config.page.tsx # 管理员配置页面路由
│
├── dist/                      # 编译输出目录（.gitignore）
├── docs/                      # 文档目录
│   └── development.md         # 本文档
├── .specify/                  # 设计文档和规格说明
│   └── specs/ai-learning-assistant/
│       ├── spec.md            # 功能规格说明
│       ├── plan.md            # 实现计划
│       └── tasks.md           # 任务分解
├── package.json               # npm 配置和依赖
├── tsconfig.json              # TypeScript 配置
├── README.md                  # 用户文档
└── LICENSE                    # 许可证（MIT）
```

---

## 开发工作流

### 1. 后端开发（src/）

#### 新增路由 Handler

**步骤**:

1. 在 `src/handlers/` 下创建新的 Handler 文件（如 `exampleHandler.ts`）
2. 继承 `Handler` 基类,实现路由方法（`get()`, `post()`, `put()` 等）
3. 在 `src/index.ts` 中注册路由

**示例**:

```typescript
// src/handlers/exampleHandler.ts
import { Handler, PRIV } from 'hydrooj';

export class ExampleHandler extends Handler {
  async get() {
    this.response.body = { message: 'Example API' };
    this.response.type = 'application/json';
  }
}

export const ExampleHandlerPriv = PRIV.PRIV_USER_PROFILE;
```

```typescript
// src/index.ts
import { ExampleHandler, ExampleHandlerPriv } from './handlers/exampleHandler';

// ...在 apply 函数中注册路由
ctx.Route('example', '/ai-helper/example', ExampleHandler, ExampleHandlerPriv);
```

#### 新增数据模型

**步骤**:

1. 在 `src/models/` 下创建新的模型文件（如 `exampleModel.ts`）
2. 定义 TypeScript 接口和 MongoDB Collection 操作
3. 实现 `ensureIndexes()` 方法创建索引
4. 在 `src/index.ts` 中初始化模型并注入到 `ctx`

**示例**:

```typescript
// src/models/exampleModel.ts
import { Db, Collection } from 'mongodb';

export interface Example {
  _id?: string;
  name: string;
  createdAt: Date;
}

export class ExampleModel {
  private collection: Collection<Example>;

  constructor(db: Db) {
    this.collection = db.collection<Example>('examples');
  }

  async ensureIndexes() {
    await this.collection.createIndex({ name: 1 });
  }

  async create(data: Omit<Example, '_id'>): Promise<string> {
    const result = await this.collection.insertOne({ ...data, createdAt: new Date() } as Example);
    return result.insertedId.toString();
  }
}
```

#### 调用 AI 服务

使用 `OpenAIClient` 服务:

```typescript
import { createOpenAIClientFromConfig } from '../services/openaiClient';

// 在 Handler 中调用
const aiClient = await createOpenAIClientFromConfig(this.ctx);
const response = await aiClient.chat(
  [{ role: 'user', content: 'Hello' }],
  'You are a helpful assistant.'
);
```

### 2. 前端开发（frontend/）

#### 新增前端页面

**步骤**:

1. 在 `frontend/` 下创建 `*.page.tsx` 文件（如 `example.page.tsx`）
2. 使用 `NamedPage` 注册页面挂载点
3. 编写 React 组件
4. 编译并刷新浏览器查看效果

**示例**:

```typescript
// frontend/example.page.tsx
import { NamedPage } from 'vj/misc/Page';
import React from 'react';
import ReactDOM from 'react-dom';

const ExampleComponent: React.FC = () => {
  return <div>Example Component</div>;
};

NamedPage(['problem_detail'], () => {
  const container = document.createElement('div');
  container.id = 'example-component';
  document.body.appendChild(container);

  ReactDOM.render(<ExampleComponent />, container);
});
```

#### 调用后端 API

使用 `fetch` API:

```typescript
// 示例: 调用学生端对话 API
const response = await fetch('/ai-helper/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    problemId: '1',
    questionType: 'understand',
    userThinking: '我认为这道题需要用动态规划...',
    includeCode: false
  })
});

const data = await response.json();
console.log(data.message.content); // AI 回答
```

### 3. 编译与重启

#### 后端修改（src/）

```bash
# 开发模式（watch 模式,文件修改自动编译）
npm run dev

# 或手动编译
npm run build

# 重启 HydroOJ
pm2 restart hydrooj
```

#### 前端修改（frontend/）

```bash
# 重新编译
npm run build

# 重启 HydroOJ（加载新的前端脚本）
pm2 restart hydrooj

# 刷新浏览器（Ctrl+Shift+R 或 Cmd+Shift+R 强制刷新）
```

---

## 测试指南

### 单元测试（未来支持）

```bash
npm test
```

### 手动集成测试

参考 `.specify/specs/ai-learning-assistant/tasks.md` 中的 T026 任务,使用 Postman 或 curl 测试各个 API。

**示例: 测试学生端对话 API**

```bash
curl -X POST http://127.0.0.1/ai-helper/chat \
  -H "Content-Type: application/json" \
  -H "Cookie: sid=YOUR_SESSION_ID" \
  -d '{
    "problemId": "1",
    "problemTitle": "A+B Problem",
    "questionType": "understand",
    "userThinking": "我认为这道题需要读入两个整数并输出它们的和。",
    "includeCode": false
  }'
```

**示例: 测试教师端对话列表 API**

```bash
curl -X GET "http://127.0.0.1/ai-helper/conversations?page=1&limit=10" \
  -H "Cookie: sid=YOUR_SESSION_ID"
```

**示例: 测试管理员配置 API**

```bash
# 获取配置
curl -X GET http://127.0.0.1/ai-helper/admin/config \
  -H "Cookie: sid=YOUR_ADMIN_SESSION_ID"

# 更新配置
curl -X PUT http://127.0.0.1/ai-helper/admin/config \
  -H "Content-Type: application/json" \
  -H "Cookie: sid=YOUR_ADMIN_SESSION_ID" \
  -d '{
    "apiBaseUrl": "https://api.openai.com/v1",
    "modelName": "gpt-3.5-turbo",
    "apiKey": "sk-...",
    "rateLimitPerMinute": 5,
    "timeoutSeconds": 30
  }'
```

### 安全测试清单

- [ ] 前端代码中无任何 API Key（`grep -r "sk-" frontend/`）
- [ ] 网络请求中无 API Key（浏览器 DevTools → Network 标签）
- [ ] 浏览器存储中无 API Key（DevTools → Application 标签）
- [ ] 学生无法访问教师端 API（返回 403）
- [ ] 输入验证正确（超长输入返回 400 错误）

---

## 代码规范

### TypeScript 规范

- **避免使用 `any` 类型**: 使用具体类型或 `unknown`
- **使用接口定义数据结构**: 如 `interface ChatRequest { ... }`
- **为公共 API 添加 JSDoc 注释**: 说明参数、返回值、错误情况

```typescript
/**
 * 检查用户频率限制
 * @param userId 用户 ID
 * @param limitPerMinute 每分钟最大请求次数
 * @returns 是否允许请求（true=允许, false=超过限制）
 */
async checkAndIncrement(userId: number, limitPerMinute: number): Promise<boolean> {
  // ...
}
```

### 命名规范

- **文件名**: 小驼峰（camelCase），如 `studentHandler.ts`, `openaiClient.ts`
- **类名**: 大驼峰（PascalCase），如 `ChatHandler`, `ConversationModel`
- **接口名**: 大驼峰（PascalCase），如 `ChatRequest`, `ChatResponse`
- **变量/函数名**: 小驼峰（camelCase），如 `userId`, `createConversation()`
- **常量**: 全大写下划线（SCREAMING_SNAKE_CASE），如 `DEFAULT_RATE_LIMIT_PER_MINUTE`

### ESLint 检查

```bash
npm run lint
```

---

## 调试技巧

### 后端调试

#### 使用 console.log

```typescript
// 在 Handler 中添加日志
console.log('[ChatHandler] Request body:', this.request.body);
console.log('[ChatHandler] User ID:', this.user._id);

// 查看日志
pm2 logs hydrooj --lines 100
```

#### 使用 Node.js 调试器（可选）

```bash
# 在 package.json 中添加 debug 脚本
"scripts": {
  "debug": "node --inspect-brk dist/index.js"
}

# 启动调试
npm run debug

# 在 Chrome 浏览器打开 chrome://inspect，连接调试器
```

### 前端调试

#### 浏览器开发者工具

- **Console 标签**: 查看 console.log 输出和 JavaScript 错误
- **Network 标签**: 查看 HTTP 请求和响应（检查 API 调用）
- **Application 标签**: 查看 localStorage, sessionStorage, cookies
- **Sources 标签**: 断点调试 JavaScript 代码

#### React DevTools

安装 React DevTools 浏览器扩展，可以查看 React 组件树和 state。

### 数据库调试

#### 使用 MongoDB 客户端

```bash
# 连接 MongoDB
mongo --host 127.0.0.1 --port 27017

# 查看数据库
show dbs;

# 使用 HydroOJ 数据库
use hydro;

# 查看插件集合
show collections;

# 查询对话记录
db.conversations.find().pretty();

# 查询消息记录
db.messages.find({ conversationId: "..." }).pretty();

# 查询 AI 配置
db.aiConfig.findOne();
```

#### 使用 MongoDB Compass（GUI 工具）

推荐使用 [MongoDB Compass](https://www.mongodb.com/products/compass) 进行可视化查询和调试。

---

## 常见开发问题

### 1. 编译错误: "Cannot find module 'hydrooj'"

**原因**: `hydrooj` 依赖未正确安装或版本不匹配。

**解决方法**:

```bash
npm install hydrooj@^4.0.0 --save-dev
npm run build
```

### 2. 插件加载失败: "Plugin not found"

**原因**: 插件路径错误或未编译。

**解决方法**:

```bash
# 确认编译成功
npm run build

# 确认 dist/ 目录存在且包含 index.js
ls -la dist/

# 使用绝对路径加载插件
hydrooj addon add /absolute/path/to/hydro-ai-helper

# 重启 HydroOJ
pm2 restart hydrooj
```

### 3. 前端面板不显示

**原因**: 前端脚本未正确编译或页面路径不匹配。

**解决方法**:

```bash
# 重新编译
npm run build

# 检查 frontend/problem_detail.page.tsx 中的 NamedPage 配置
# 确认页面标识符为 ['problem_detail']

# 清除浏览器缓存并强制刷新（Ctrl+Shift+R）

# 查看浏览器 Console 是否有 JavaScript 错误
```

### 4. API 调用返回 401 Unauthorized

**原因**: 用户未登录或 Session ID 无效。

**解决方法**:

```bash
# 确认已登录 HydroOJ
# 在浏览器中打开 DevTools → Application → Cookies
# 确认存在 'sid' cookie

# 在 curl 中使用正确的 Session ID
curl -H "Cookie: sid=YOUR_SESSION_ID" http://127.0.0.1/ai-helper/chat
```

### 5. AI 回答超时或失败

**原因**: OpenAI API 配置错误、网络问题或 API Key 无效。

**解决方法**:

```bash
# 在服务器上测试网络连接
curl https://api.openai.com/v1/models \
  -H "Authorization: Bearer YOUR_API_KEY"

# 检查管理员配置页面的 API Base URL 和 API Key
# 点击"测试连接"按钮，查看详细错误信息

# 查看 HydroOJ 日志中的错误信息
pm2 logs hydrooj --lines 100 | grep -i error
```

---

## 贡献代码

### Pull Request 流程

1. **Fork 仓库**: 在 GitHub 上 fork 本仓库
2. **创建分支**: `git checkout -b feature/your-feature-name`
3. **修改代码**: 遵循上述代码规范
4. **编译和测试**: 确保 `npm run build` 成功,手动测试功能
5. **提交代码**: `git commit -m "feat: add your feature"`
6. **推送分支**: `git push origin feature/your-feature-name`
7. **创建 PR**: 在 GitHub 上创建 Pull Request,描述修改内容

### Commit Message 规范

使用 [Conventional Commits](https://www.conventionalcommits.org/) 规范:

- `feat: 新功能`
- `fix: Bug 修复`
- `docs: 文档修改`
- `style: 代码格式（不影响功能）`
- `refactor: 重构（不是新功能,也不是修复 Bug）`
- `test: 测试相关`
- `chore: 构建工具或辅助工具修改`

---

## 参考资源

- [HydroOJ 官方文档](https://hydro.js.org/docs/)
- [TypeScript 官方文档](https://www.typescriptlang.org/docs/)
- [React 官方文档](https://react.dev/)
- [OpenAI API 文档](https://platform.openai.com/docs/api-reference)
- [MongoDB 官方文档](https://www.mongodb.com/docs/)

---

**文档版本**: 1.0.0
**最后更新**: 2025-11-18
**维护者**: HydroOJ AI 学习助手开发团队
