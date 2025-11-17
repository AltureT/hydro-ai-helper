# Phase 2 部署和验证指南

## 已完成的任务

✅ **T004** - 实现 OpenAI 客户端最小版本 ([src/services/openaiClient.ts](src/services/openaiClient.ts))
✅ **T005** - 实现 Prompt 构造服务最小版本 ([src/services/promptService.ts](src/services/promptService.ts))
✅ **T006** - 实现学生端对话 API Handler 基础版 ([src/handlers/studentHandler.ts](src/handlers/studentHandler.ts))
✅ **T007** - 实现学生端前端对话框最小版本 ([frontend/student/AIAssistantPanel.tsx](frontend/student/AIAssistantPanel.tsx) 和 [frontend/problem_detail.page.tsx](frontend/problem_detail.page.tsx))

## 修改的文件列表

### 新增文件

1. **后端服务层**
   - `src/services/openaiClient.ts` - OpenAI API 客户端封装
   - `src/services/promptService.ts` - System Prompt 和 User Prompt 构造

2. **后端 Handler**
   - `src/handlers/studentHandler.ts` - 学生端对话 API Handler

3. **前端组件**
   - `frontend/student/AIAssistantPanel.tsx` - React 对话面板组件
   - `frontend/problem_detail.page.tsx` - 题目详情页挂载脚本

### 修改的文件

1. **src/index.ts** - 新增 `/ai-helper/chat` 路由注册
2. **package.json** - 添加 React 和 TypeScript 类型依赖

## 部署步骤

### 1. 安装依赖

```bash
npm install
```

这将安装新增的依赖:
- `react` (^17.0.2)
- `react-dom` (^17.0.2)
- `@types/react` (^17.0.0)
- `@types/react-dom` (^17.0.0)

### 2. 编译代码

```bash
npm run build
```

编译输出到 `dist/` 目录。

### 3. 配置环境变量

在服务器环境设置以下环境变量:

```bash
# OpenAI API 配置 (必填)
export OPENAI_API_KEY="sk-your-api-key-here"

# 可选配置 (有默认值)
export OPENAI_API_BASE="https://api.openai.com/v1"
export OPENAI_MODEL="gpt-3.5-turbo"
```

**重要**: API Key 必须在服务器端配置,绝不能写入代码或前端。

### 4. 部署到 HydroOJ

将插件目录复制到 HydroOJ 插件目录:

```bash
# 假设 HydroOJ 插件目录为 ~/.hydro/addons/
cp -r /path/to/hydro-ai-helper ~/.hydro/addons/hydro-ai-helper
```

或使用 HydroOJ 插件管理命令:

```bash
hydrooj addon add /path/to/hydro-ai-helper
```

### 5. 重启 HydroOJ

```bash
pm2 restart hydrooj
```

## 验证步骤

### 1. 验证后端路由

使用 curl 测试 `/ai-helper/chat` API:

```bash
curl -X POST http://127.0.0.1/ai-helper/chat \
  -H "Content-Type: application/json" \
  -d '{
    "problemId": "1",
    "questionType": "understand",
    "userThinking": "我觉得这道题需要使用动态规划,因为有重叠子问题和最优子结构。但是我不确定状态定义应该是什么。"
  }'
```

**期望响应**:

```json
{
  "conversationId": "temp-1234567890",
  "message": {
    "role": "ai",
    "content": "...(AI 生成的回答)...",
    "timestamp": "2025-11-16T12:00:00.000Z"
  }
}
```

### 2. 验证前端界面

1. 在浏览器中访问任意题目详情页 (URL 格式: `/p/{problemId}`)
2. 应在页面右下角看到 AI 助手面板 (白色浮动框)
3. 尝试以下交互:
   - 选择问题类型
   - 输入思路描述 (至少 20 字)
   - 可选: 勾选"附带代码"并输入代码
   - 点击"提交问题"
4. 等待 AI 回答显示 (可能需要几秒)
5. 检查回答是否以 Markdown 格式正确渲染 (代码块、换行等)

### 3. 检查日志

查看 HydroOJ 日志确认插件加载和路由注册:

```bash
pm2 logs hydrooj
```

应看到:

```
[AI Helper] Plugin loaded successfully
[AI Helper] Routes registered:
  - GET /ai-helper/hello (test route)
  - POST /ai-helper/chat (student chat API)
```

## 常见问题排查

### 问题 1: API 返回 "AI 服务未配置"

**原因**: 环境变量 `OPENAI_API_KEY` 未设置

**解决**:
```bash
export OPENAI_API_KEY="sk-your-api-key-here"
pm2 restart hydrooj
```

### 问题 2: 前端面板不显示

**可能原因**:
1. 不在题目详情页 (URL 不匹配 `/p/{id}` 格式)
2. 前端脚本未正确打包

**检查**:
- 打开浏览器控制台,查看是否有 `[AI Helper]` 日志
- 检查 Network 面板,确认 `problem_detail.page.js` 已加载

### 问题 3: AI 调用超时

**原因**: OpenAI API 响应慢或网络问题

**调整超时时间**: 修改 [src/handlers/studentHandler.ts:76](src/handlers/studentHandler.ts#L76):

```typescript
timeoutSeconds: 60  // 改为 60 秒
```

### 问题 4: Markdown 渲染不正确

**当前限制**: Phase 2 的 Markdown 渲染仅支持代码块,不支持:
- 粗体/斜体
- 列表 (有序/无序)
- 链接
- 公式

**后续改进**: 在 Phase 3+ 可引入完整的 Markdown 渲染库 (如 `marked` 或 `react-markdown`)。

## 架构说明

### 后端架构

```
POST /ai-helper/chat
  ↓
ChatHandler (studentHandler.ts)
  ↓
PromptService.buildSystemPrompt() - 生成教学原则 prompt
PromptService.buildUserPrompt()   - 组合学生输入
  ↓
OpenAIClient.chat()                - 调用 OpenAI API
  ↓
返回 AI 回答 JSON
```

### 前端架构

```
题目详情页 (/p/{id})
  ↓
problem_detail.page.tsx 初始化
  ↓
挂载 AIAssistantPanel 组件
  ↓
用户填写表单 → 提交
  ↓
fetch('/ai-helper/chat', POST)
  ↓
显示 AI 回答 (Markdown 渲染)
```

### 安全设计

- ✅ API Key 仅存储在服务器端环境变量
- ✅ 前端代码无任何凭证
- ✅ 所有 AI 调用经过后端代理
- ✅ 输入验证 (思路长度 20-2000 字,代码最多 5000 字符)

### 教学优先设计

- ✅ System Prompt 明确禁止输出完整 AC 代码
- ✅ 强制学生描述思路 (至少 20 字)
- ✅ 回答结构化 (复述、肯定、诊断、引导、伪代码、建议)
- ✅ 前端 UI 要求选择问题类型和描述思路

## 后续任务 (Phase 3)

Phase 2 完成后,下一步实现 Phase 3 任务 (T008~T013):

1. **T008** - 定义数据模型 (会话和消息) → 数据持久化
2. **T009** - 更新学生端 API 以支持数据持久化
3. **T010** - 实现教师端对话列表 API
4. **T011** - 实现教师端对话详情 API
5. **T012** - 实现教师端对话列表前端页面
6. **T013** - 实现教师端对话详情前端页面

当前版本对话数据**未持久化**,每次提交视为新对话。

## 文档版本

- **版本**: Phase 2 Complete
- **日期**: 2025-11-16
- **任务范围**: T004~T007
- **下一个里程碑**: Phase 3 - 数据持久化与教师端查看
