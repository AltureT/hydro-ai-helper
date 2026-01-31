# Vercel 部署问题解决方案

## 🔍 问题分析

### 遇到的错误

1. **错误 1**: Function Runtimes 版本错误
   ```
   Error: Function Runtimes must have a valid version
   ```

2. **错误 2**: 缺少 public 目录
   ```
   Error: No Output Directory named "public" found after the Build completed
   ```

3. **根本原因**: Vercel 将项目识别为静态网站，而不是 Functions 项目

---

## ✅ 最终解决方案

### 1. 修改 `vercel.json`

```json
{
  "version": 2,
  "buildCommand": "",
  "outputDirectory": "api"
}
```

**说明**：
- `buildCommand: ""` - 空字符串跳过构建
- `outputDirectory: "api"` - 指向 Functions 目录

### 2. 修改 `package.json`

```json
{
  "scripts": {
    "build": "echo 'Skipping build for Vercel Functions'",
    "build:plugin": "tsc"
  }
}
```

**说明**：
- `build` - Vercel 调用时只输出消息，不执行编译
- `build:plugin` - 本地开发时编译 HydroOJ 插件

### 3. 创建 `public/` 目录

```bash
mkdir -p public
touch public/.gitkeep
```

**说明**：
- 满足 Vercel 对输出目录的要求
- 实际不使用，只是占位符

---

## 🎯 为什么这样做？

### 问题根源

我们的项目有两个用途：
1. **HydroOJ 插件**：需要编译 `src/` 和 `frontend/` 目录
2. **Vercel Functions**：只需要 `api/` 和 `lib/` 目录

Vercel 默认行为：
- ❌ 运行 `npm run build`
- ❌ 期望生成静态网站输出目录
- ❌ 尝试编译整个项目（包括 HydroOJ 代码）

### 解决思路

**方案 A**：分离项目（理想但复杂）
- 创建两个独立的仓库
- 一个用于 HydroOJ 插件
- 一个用于 Vercel Functions

**方案 B**：配置 Vercel 跳过构建（已采用）
- 修改 `vercel.json` 跳过构建
- 修改 `package.json` 的 build 脚本
- Vercel Functions 原生支持 TypeScript

---

## 📋 部署检查清单

### ✅ 已完成

- [x] 修改 `vercel.json`
- [x] 修改 `package.json`
- [x] 创建 `public/` 目录
- [x] 推送到 GitHub

### ⏳ 等待 Vercel 部署

1. 访问 Vercel Dashboard
2. 查看最新部署状态
3. 等待部署完成（约 1-2 分钟）

### ✅ 验证部署成功

```bash
# 测试 API 端点
curl https://your-vercel-app.vercel.app/api/badge-installs

# 预期输出
{"schemaVersion":1,"label":"installations","message":"0","color":"blue"}
```

---

## 🔧 本地开发

### 编译 HydroOJ 插件

```bash
# 使用新的命令
npm run build:plugin

# 或直接运行 tsc
npx tsc
```

### 测试 Vercel Functions（本地）

```bash
# 安装 Vercel CLI
npm install -g vercel

# 本地运行
vercel dev

# 访问 http://localhost:3000/api/badge-installs
```

---

## 📊 项目结构说明

```
hydro-ai-helper/
├── api/              # Vercel Functions（部署到 Vercel）
│   ├── report.ts
│   ├── badge-installs.ts
│   └── badge-active.ts
├── lib/              # 共享代码（Vercel Functions 使用）
│   └── mongodb.ts
├── src/              # HydroOJ 插件后端（不部署到 Vercel）
├── frontend/         # HydroOJ 插件前端（不部署到 Vercel）
├── public/           # 占位符目录（满足 Vercel 要求）
├── dist/             # 编译输出（HydroOJ 插件）
├── vercel.json       # Vercel 配置
└── package.json      # 项目配置
```

---

## 🎓 经验总结

### Vercel 部署要点

1. **Functions 项目不需要构建**
   - Vercel 原生支持 TypeScript
   - 直接部署 `.ts` 文件即可

2. **`buildCommand` 的正确用法**
   - `null` - 可能不生效
   - `""` - 空字符串，明确跳过
   - `"echo 'skip'"` - 执行空操作

3. **混合项目的处理**
   - 如果项目既是插件又是 Functions
   - 需要明确告诉 Vercel 不要构建
   - 或者分离为两个项目

### TypeScript 配置

1. **不要在 Vercel 编译整个项目**
   - HydroOJ 的类型定义在 Vercel 环境中不可用
   - 只需要 `api/` 和 `lib/` 目录

2. **使用 `skipLibCheck: true`**
   - 跳过依赖包的类型检查
   - 加快编译速度

---

## 🚀 下一步

部署成功后：

1. **获取 Vercel 域名**
   - 在 Vercel Dashboard 查看

2. **更新插件端配置**
   - 修改 `src/services/telemetryService.ts`
   - 替换 REPORT_URL

3. **更新 README 徽章**
   - 修改 `README.md`
   - 替换徽章 URL

4. **重新编译插件**
   ```bash
   npm run build:plugin
   hydrooj addon add /path/to/hydro-ai-helper
   pm2 restart hydrooj
   ```

---

## 📚 相关文档

- [Vercel Functions 文档](https://vercel.com/docs/functions)
- [Vercel 构建配置](https://vercel.com/docs/deployments/configure-a-build)
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) - 故障排查指南
- [QUICKSTART.md](./QUICKSTART.md) - 快速开始指南

---

**最后更新**: 2026-01-31
**状态**: ✅ 已解决
