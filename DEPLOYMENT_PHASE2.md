# Phase 2 部署指南 - Vercel Functions 统计服务

## 📦 概述

Phase 2 实现了服务端统计功能，包括：
- 接收插件心跳数据的 API 端点
- 生成动态徽章的 Shields.io 兼容端点
- MongoDB 数据存储和 TTL 自动清理

## 🏗️ 架构

```
插件实例 (HydroOJ)
    ↓ 每 24 小时发送心跳
Vercel Functions (/api/report)
    ↓ 存储到 MongoDB
MongoDB Atlas (plugin_stats 集合)
    ↓ 查询统计数据
Vercel Functions (/api/badge-*)
    ↓ 返回 Shields.io JSON
GitHub README 徽章
```

## 📋 前置准备

### 1. MongoDB Atlas 配置

1. 访问 [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) 并创建免费集群
2. 创建数据库用户（Database Access）
3. 配置网络访问（Network Access）：添加 `0.0.0.0/0`（允许所有 IP，Vercel 需要）
4. 获取连接字符串：
   ```
   mongodb+srv://<username>:<password>@<cluster>.mongodb.net/?retryWrites=true&w=majority
   ```

### 2. Vercel 账号

1. 访问 [Vercel](https://vercel.com) 并注册账号
2. 安装 Vercel CLI（可选）：
   ```bash
   npm install -g vercel
   ```

## 🚀 部署步骤

### 步骤 1: 安装依赖

```bash
cd /path/to/hydro-ai-helper
npm install
```

这会安装新增的依赖：
- `mongodb@^6.3.0` - MongoDB 驱动
- `@vercel/node@^3.0.0` - Vercel 类型定义（devDependencies）

### 步骤 2: 推送代码到 GitHub

```bash
git add .
git commit -m "feat: add Phase 2 Vercel Functions for telemetry"
git push origin main
```

### 步骤 3: 在 Vercel 导入项目

1. 登录 [Vercel Dashboard](https://vercel.com/dashboard)
2. 点击 **New Project**
3. 选择 GitHub 仓库 `hydro-ai-helper`
4. 配置项目：
   - **Framework Preset**: Other
   - **Root Directory**: `./`（保持默认）
   - **Build Command**: 留空
   - **Output Directory**: 留空

### 步骤 4: 配置环境变量

在 Vercel 项目设置中添加环境变量：

| 变量名 | 值 | 说明 |
|--------|-----|------|
| `MONGODB_URI` | `mongodb+srv://...` | MongoDB Atlas 连接字符串 |
| `MONGODB_DB` | `hydro_ai_stats` | 数据库名称 |

**注意**：如果密码包含特殊字符，需要 URL 编码：
- `@` → `%40`
- `#` → `%23`
- `%` → `%25`

### 步骤 5: 部署

点击 **Deploy** 按钮，等待部署完成（约 1-2 分钟）。

部署完成后，Vercel 会提供一个域名，例如：
```
https://hydro-ai-helper.vercel.app
```

## ✅ 验证部署

### 1. 测试心跳接收端点

```bash
curl -X POST https://hydro-ai-helper.vercel.app/api/report \
  -H "Content-Type: application/json" \
  -d '{
    "instance_id": "test-uuid-123",
    "event": "install",
    "version": "1.8.0",
    "installed_at": "2024-01-01T00:00:00Z",
    "stats": {
      "active_users_7d": 10,
      "total_conversations": 50
    },
    "domain_hash": "abc123",
    "timestamp": "2024-01-01T00:00:00Z"
  }'
```

**预期响应**：
```json
{"success": true}
```

### 2. 测试安装数徽章

```bash
curl https://hydro-ai-helper.vercel.app/api/badge-installs
```

**预期响应**：
```json
{
  "schemaVersion": 1,
  "label": "installations",
  "message": "1",
  "color": "blue"
}
```

### 3. 测试活跃用户徽章

```bash
curl https://hydro-ai-helper.vercel.app/api/badge-active
```

**预期响应**：
```json
{
  "schemaVersion": 1,
  "label": "active users (7d)",
  "message": "10",
  "color": "green"
}
```

### 4. 验证 MongoDB 数据

使用 [MongoDB Compass](https://www.mongodb.com/products/compass) 或 mongosh 连接到 Atlas：

```javascript
use hydro_ai_stats

// 查看所有记录
db.plugin_stats.find().pretty()

// 验证 TTL 索引
db.plugin_stats.getIndexes()
```

**预期索引**：
```json
[
  { "v": 2, "key": { "_id": 1 }, "name": "_id_" },
  {
    "v": 2,
    "key": { "lastReportAt": 1 },
    "name": "lastReportAt_ttl_90d",
    "expireAfterSeconds": 7776000
  }
]
```

## 🔧 更新插件端配置

编辑 `src/services/telemetryService.ts`，将 REPORT_URL 更新为实际的 Vercel 域名：

```typescript
private readonly REPORT_URL = 'https://hydro-ai-helper.vercel.app/api/report';
```

重新构建并部署插件：
```bash
npm run build
hydrooj addon add /path/to/hydro-ai-helper
pm2 restart hydrooj
```

## 📊 API 端点文档

### POST /api/report

接收插件心跳数据。

**请求体**：
```typescript
{
  instance_id: string;        // 插件实例 UUID
  event: 'install' | 'heartbeat';
  version: string;            // 插件版本
  installed_at: string;       // ISO 8601 时间戳
  first_used_at?: string;     // 首次使用时间（可选）
  stats: {
    active_users_7d: number;  // 最近 7 天活跃用户数
    total_conversations: number;
    last_used_at?: string;    // 最近使用时间（可选）
  };
  domain_hash: string;        // 域 ID 的 SHA-256 哈希
  timestamp: string;          // 当前时间戳
}
```

**响应**：
```json
{"success": true}
```

**错误响应**：
```json
{"success": false, "error": "错误信息"}
```

### GET /api/badge-installs

返回安装数徽章（Shields.io 格式）。

**响应**：
```json
{
  "schemaVersion": 1,
  "label": "installations",
  "message": "1.2K",
  "color": "blue"
}
```

**缓存策略**：`s-maxage=300`（CDN 缓存 5 分钟）

### GET /api/badge-active

返回活跃用户数徽章（Shields.io 格式）。

**响应**：
```json
{
  "schemaVersion": 1,
  "label": "active users (7d)",
  "message": "345",
  "color": "green"
}
```

**缓存策略**：`s-maxage=300`（CDN 缓存 5 分钟）

## 🛠️ 故障排查

### 问题 1: MongoDB 连接失败

**错误信息**：
```
MongoServerError: bad auth : authentication failed
```

**解决方案**：
1. 检查 MongoDB Atlas 用户名和密码是否正确
2. 确保密码中的特殊字符已 URL 编码
3. 验证网络访问白名单包含 `0.0.0.0/0`
4. 检查 Vercel 环境变量是否正确设置

### 问题 2: Vercel 函数超时

**错误信息**：
```
Function execution timed out
```

**解决方案**：
1. 检查 MongoDB Atlas 集群是否暂停（免费集群会自动暂停）
2. 在 MongoDB Atlas 中手动唤醒集群
3. 检查 Vercel 函数日志（Dashboard → Functions → Logs）

### 问题 3: 徽章显示 "error"

**可能原因**：
- MongoDB 连接失败
- 数据库中没有数据
- 聚合查询错误

**解决方案**：
1. 查看 Vercel 函数日志
2. 使用 curl 测试 API 端点，查看详细错误信��
3. 验证 MongoDB 中是否有数据

### 问题 4: CORS 错误

**错误信息**：
```
Access to fetch at '...' from origin '...' has been blocked by CORS policy
```

**解决方案**：
- 徽章端点已配置 CORS 头（`Access-Control-Allow-Origin: *`）
- 如果仍有问题，检查是否使用了 HTTPS（Vercel 自动提供）

## 📈 监控与维护

### Vercel Dashboard

- **Deployments**: 查看部署历史和回滚
- **Functions**: 查看函数调用日志和性能指标
- **Analytics**: 查看流量统计（需要升级到 Pro 计划）

### MongoDB Atlas

- **Metrics**: 查看数据库性能指标（连接数、操作数、存储）
- **Real-time Performance**: 实时查询监控
- **Alerts**: 配置告警规则（如连接数过高、存储空间不足）

### 数据清理

TTL 索引会自动删除 90 天未上报的记录，无需手动清理。

## 🎯 下一步：Phase 3

完成 Phase 2 后，继续 Phase 3：更新 README 添加动态徽章。

徽章 URL 格式：
```markdown
![Installations](https://img.shields.io/endpoint?url=https://hydro-ai-helper.vercel.app/api/badge-installs)
![Active Users](https://img.shields.io/endpoint?url=https://hydro-ai-helper.vercel.app/api/badge-active)
```
