# 贡献指南

感谢您对 HydroOJ AI Helper 的关注！本文档将帮助您了解如何参与项目贡献。

## 开发环境配置

### 前置要求

- Node.js >= 18.0.0
- npm >= 8.0.0
- HydroOJ 开发环境（用于集成测试）

### 安装步骤

```bash
# 克隆仓库
git clone https://github.com/your-repo/hydro-ai-helper.git
cd hydro-ai-helper

# 安装依赖
npm install

# 编译 TypeScript
npm run build

# 运行代码检查
npm run lint

# 运行测试
npm test
```

## 代码规范

### TypeScript 规范

- 使用 TypeScript 严格模式
- 所有公开 API 必须有类型定义
- 避免使用 `any` 类型，必要时使用类型断言并添加注释说明原因

### ESLint 规范

项目使用 ESLint 进行代码检查。提交前请确保：

```bash
npm run lint
```

无任何错误或警告。

### 命名约定

- 文件名：使用 camelCase（如 `promptService.ts`）
- 类名：使用 PascalCase（如 `PromptService`）
- 函数/变量：使用 camelCase（如 `buildSystemPrompt`）
- 常量：使用 UPPER_SNAKE_CASE（如 `DEFAULT_RATE_LIMIT`）
- 接口：使用 PascalCase，无 `I` 前缀（如 `ChatRequest`）

### 目录结构

```
src/
├── handlers/       # HTTP 请求处理器
├── services/       # 业务逻辑服务
├── models/         # 数据模型
├── utils/          # 工具函数
├── types/          # 类型定义
├── constants/      # 常量定义
├── lib/            # 通用库函数
└── __tests__/      # 单元测试
    ├── services/
    ├── utils/
    └── __mocks__/
```

## 测试要求

### 单元测试

- 使用 Jest 作为测试框架
- 测试文件放在 `src/__tests__/` 目录下
- 测试文件命名：`*.test.ts`

运行测试：

```bash
# 运行所有测试
npm test

# 运行特定测试文件
npm test -- --testPathPattern="promptService"

# 生成覆盖率报告
npm test -- --coverage
```

### 集成测试

集成测试脚本位于 `tests/integration/` 目录，使用 curl 进行 API 测试。

## PR 提交流程

### 1. 创建分支

```bash
git checkout -b feature/your-feature-name
# 或
git checkout -b fix/your-bug-fix
```

### 2. 开发与测试

```bash
# 开发时使用 watch 模式
npm run dev

# 确保代码检查通过
npm run lint

# 确保测试通过
npm test

# 确保构建成功
npm run build
```

### 3. 提交规范

使用语义化提交信息：

- `feat:` 新功能
- `fix:` Bug 修复
- `docs:` 文档更新
- `style:` 代码格式调整（不影响逻辑）
- `refactor:` 代码重构
- `test:` 测试相关
- `chore:` 构建/工具链相关

示例：

```bash
git commit -m "feat: add rate limit service for API throttling"
git commit -m "fix: handle edge case in prompt validation"
```

### 4. 创建 Pull Request

- 标题简洁明了，说明改动内容
- 描述中说明改动原因和实现方式
- 关联相关 Issue（如有）
- 确保 CI 检查全部通过

## 问题反馈

如发现 Bug 或有功能建议，请通过 GitHub Issues 提交，并提供：

- 问题描述
- 复现步骤
- 预期行为
- 实际行为
- 环境信息（Node.js 版本、HydroOJ 版本等）

## 许可证

本项目采用 MIT 许可证。提交贡献即表示您同意将代码以 MIT 许可证发布。
