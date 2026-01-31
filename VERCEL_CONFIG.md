# 配置 Vercel 统计服务

## 📝 概述

完成 Phase 2 部署后，需要更新以下位置的 Vercel URL：

## 🔧 需要更新的文件

### 1. 插件端：`src/services/telemetryService.ts`

**位置**：第 43 行

**当前值**：
```typescript
private readonly REPORT_URL = 'https://your-vercel-app.vercel.app/api/report';
```

**更新为**：
```typescript
private readonly REPORT_URL = 'https://你的实际域名.vercel.app/api/report';
```

**示例**：
```typescript
private readonly REPORT_URL = 'https://hydro-ai-helper.vercel.app/api/report';
```

### 2. README 徽章：`README.md`

**位置**：第 7-8 行

**当前值**：
```markdown
![Installations](https://img.shields.io/endpoint?url=https://hydro-ai-helper.vercel.app/api/badge-installs)
![Active Users (7d)](https://img.shields.io/endpoint?url=https://hydro-ai-helper.vercel.app/api/badge-active)
```

**更新为**：
```markdown
![Installations](https://img.shields.io/endpoint?url=https://你的实际域名.vercel.app/api/badge-installs)
![Active Users (7d)](https://img.shields.io/endpoint?url=https://你的实际域名.vercel.app/api/badge-active)
```

## 🚀 完整更新流程

### 步骤 1: 获取 Vercel 域名

部署完成后，在 Vercel Dashboard 中找到你的项目域名，例如：
```
https://hydro-ai-helper-abc123.vercel.app
```

### 步骤 2: 更新插件端配置

```bash
# 编辑文件
vim src/services/telemetryService.ts

# 或使用 sed 批量替换
sed -i '' 's|https://your-vercel-app.vercel.app|https://你的实际域名.vercel.app|g' src/services/telemetryService.ts
```

### 步骤 3: 更新 README

```bash
# 编辑文件
vim README.md

# 或使用 sed 批量替换
sed -i '' 's|https://hydro-ai-helper.vercel.app|https://你的实际域名.vercel.app|g' README.md
```

### 步骤 4: 重新构建并部署

```bash
# 构建插件
npm run build

# 部署到 HydroOJ
hydrooj addon add /path/to/hydro-ai-helper
pm2 restart hydrooj

# 提交到 GitHub（更新 README 徽章）
git add .
git commit -m "chore: update Vercel URLs"
git push origin main
```

## ✅ 验证配置

### 验证插件端

查看 HydroOJ 日志，确认遥测服务启动：
```bash
pm2 logs hydrooj | grep TelemetryService
```

预期输出：
```
[TelemetryService] Initialized successfully
[TelemetryService] Report sent successfully (install)
```

### 验证 README 徽章

1. 推送到 GitHub 后，访问仓库页面
2. 查看 README 顶部的徽章
3. 徽章应显示实际的安装数和活跃用户数

**注意**：徽章可能需要 5-10 分钟才能更新（Shields.io 缓存）

## 🔍 故障排查

### 问题 1: 徽章显示 "invalid"

**原因**：Vercel URL 不正确或 API 端点返回错误

**解决方案**：
```bash
# 测试 API 端点
curl https://你的实际域名.vercel.app/api/badge-installs
curl https://你的实际域名.vercel.app/api/badge-active

# 应返回 Shields.io 格式的 JSON
```

### 问题 2: 插件日志显示 "Report failed"

**原因**：REPORT_URL 不正确或网络问题

**解决方案**：
```bash
# 测试心跳端点
curl -X POST https://你的实际域名.vercel.app/api/report \
  -H "Content-Type: application/json" \
  -d '{"instance_id":"test","event":"install","version":"1.8.0","installed_at":"2024-01-01T00:00:00Z","stats":{"active_users_7d":0,"total_conversations":0},"domain_hash":"test","timestamp":"2024-01-01T00:00:00Z"}'

# 应返回 {"success": true}
```

### 问题 3: 徽章显示 "error"

**原因**：MongoDB 连接失败或数据库中没有数据

**解决方案**：
1. 检查 Vercel 环境变量（MONGODB_URI, MONGODB_DB）
2. 查看 Vercel 函数日志
3. 确认至少有一个插件实例上报过数据

## 📚 相关文档

- [DEPLOYMENT_PHASE2.md](./DEPLOYMENT_PHASE2.md) - Phase 2 部署指南
- [PHASE2_SUMMARY.md](./PHASE2_SUMMARY.md) - Phase 2 实施总结
- [Shields.io Endpoint 文档](https://shields.io/endpoint)

## 💡 提示

### 使用自定义域名

如果你有自己的域名，可以在 Vercel 中配置：

1. Vercel Dashboard → 项目 → Settings → Domains
2. 添加自定义域名（如 `stats.yourdomain.com`）
3. 配置 DNS CNAME 记录
4. 更新插件端和 README 中的 URL

### 多环境配置

如果你有开发和生产环境，可以使用环境变量：

```typescript
// src/services/telemetryService.ts
private readonly REPORT_URL = process.env.TELEMETRY_URL || 'https://hydro-ai-helper.vercel.app/api/report';
```

然后在 HydroOJ 启动时设置：
```bash
export TELEMETRY_URL=https://dev.yourdomain.com/api/report
pm2 restart hydrooj
```
