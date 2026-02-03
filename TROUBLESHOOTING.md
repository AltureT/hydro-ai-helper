# Vercel 部署故障排查

## 问题：构建失败 - TypeScript 编译错误

### 错误现象

```
Running "npm run build"
> hydro-ai-helper@1.8.0 build
> tsc
```

然后构建失败或超时。

### 原因分析

Vercel 默认会运行 `npm run build`，但我们的 `tsconfig.json` 是为 HydroOJ 插件设计的，包含了 `src/` 和 `frontend/` 目录，这些目录依赖 HydroOJ 的类型定义，在 Vercel 环境中无法编译。

### 解决方案

#### ✅ 方案 1：禁用构建命令（已实施）

在 `vercel.json` 中添加 `buildCommand: null`：

```json
{
  "version": 2,
  "buildCommand": null,
  "functions": {
    "api/*.ts": {
      "runtime": "nodejs20.x"
    }
  }
}
```

**原理**：Vercel Functions 原生支持 TypeScript，不需要预编译。

#### 方案 2：创建 Vercel 专用配置（备选）

创建 `tsconfig.vercel.json`，只编译 `api/` 和 `lib/` 目录：

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "outDir": ".vercel/output",
    "strict": false,
    "skipLibCheck": true
  },
  "include": ["api/**/*", "lib/**/*"],
  "exclude": ["node_modules", "src", "frontend", "dist"]
}
```

然后修改 `package.json`：

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.vercel.json",
    "build:plugin": "tsc"
  }
}
```

---

## 问题：MongoDB 连接失败

### 错误现象

Vercel 函数日志显示：
```
MongoServerError: bad auth : authentication failed
```

### 解决方案

1. **检查环境变量**
   - Vercel Dashboard → 项目 → Settings → Environment Variables
   - 确认 `MONGODB_URI` 和 `MONGODB_DB` 已设置

2. **检查密码编码**
   - 如果密码包含特殊字符，需要 URL 编码：
     - `@` → `%40`
     - `#` → `%23`
     - `%` → `%25`

3. **检查网络访问**
   - MongoDB Atlas → Network Access
   - 确认包含 `0.0.0.0/0`（允许所有 IP）

4. **测试连接字符串**
   ```bash
   # 使用 mongosh 测试
   mongosh "mongodb+srv://user:pass@cluster.mongodb.net/"
   ```

---

## 问题：函数超时

### 错误现象

```
Function execution timed out
```

### 解决方案

1. **检查 MongoDB 集群状态**
   - 免费集群会自动暂停
   - 在 MongoDB Atlas 中手动唤醒

2. **优化连接池**
   - 已在 `lib/mongodb.ts` 中实现
   - 使用全局变量缓存连接

3. **增加超时时间**（如果需要）
   ```json
   // vercel.json
   {
     "functions": {
       "api/*.ts": {
         "runtime": "nodejs20.x",
         "maxDuration": 10
       }
     }
   }
   ```

---

## 问题：徽章显示 "invalid"

### 错误现象

GitHub README 徽章显示灰色 "invalid"。

### 解决方案

1. **测试 API 端点**
   ```bash
   curl https://your-vercel-app.vercel.app/api/badge-installs
   ```

2. **检查返回格式**
   - 必须是 Shields.io JSON 格式：
     ```json
     {
       "schemaVersion": 1,
       "label": "installations",
       "message": "123",
       "color": "blue"
     }
     ```

3. **查看 Vercel 日志**
   - Vercel Dashboard → 项目 → Functions → Logs
   - 查看具体错误信息

4. **检查 CORS**
   - 徽章端点已配置 CORS
   - 确认 `Access-Control-Allow-Origin: *` 头存在

---

## 问题：徽章显示 "error"

### 错误现象

徽章显示红色 "error"。

### 解决方案

1. **检查数据库连接**
   - 确认 MongoDB 连接正常
   - 查看 Vercel 函数日志

2. **检查数据**
   ```javascript
   // 使用 MongoDB Compass 或 mongosh
   use hydro_ai_stats
   db.plugin_stats.find().pretty()
   ```

3. **检查聚合查询**
   ```javascript
   // 测试聚合查询
   db.plugin_stats.aggregate([
     {
       $group: {
         _id: null,
         total: { $sum: { $ifNull: ['$stats.activeUsers7d', 0] } }
       }
     }
   ])
   ```

---

## 问题：插件端上报失败

### 错误现象

HydroOJ 日志显示：
```
[TelemetryService] Report failed: 404 Not Found
```

### 解决方案

1. **检查上报端点**
   - 默认上报端点：`https://stats.how2learns.com/api/report`
   - 如需自定义/镜像上报端点：设置 `AI_HELPER_TELEMETRY_ENDPOINTS`
   ```bash
   echo "$AI_HELPER_TELEMETRY_ENDPOINTS"
   ```

2. **测试端点**
   ```bash
   curl -X POST https://stats.how2learns.com/api/report \
     -H "Content-Type: application/json" \
     -d '{
       "instance_id": "test",
       "event": "install",
       "version": "1.8.0",
       "installed_at": "2024-01-01T00:00:00Z",
       "stats": {
         "active_users_7d": 0,
         "total_conversations": 0
       },
       "domain_hash": "test",
       "timestamp": "2024-01-01T00:00:00Z"
     }'
   ```

3. **检查 Vercel 部署状态**
   - Vercel Dashboard → 项目 → Deployments
   - 确认最新部署成功

---

## 问题：依赖安装警告

### 错误现象

```
npm warn deprecated rimraf@3.0.2
npm warn deprecated eslint@8.57.1
```

### 解决方案

这些是警告，不是错误，不影响部署。可以忽略。

如果想消除警告，可以更新依赖：

```bash
npm update
npm audit fix
```

---

## 验证部署成功

### 1. 检查 Vercel 部署状态

访问 Vercel Dashboard，确认：
- ✅ 部署状态：Ready
- ✅ 函数列表：显示 3 个函数（report, badge-installs, badge-active）

### 2. 测试所有端点

```bash
# 测试心跳端点
curl -X POST https://your-vercel-app.vercel.app/api/report \
  -H "Content-Type: application/json" \
  -d '{"instance_id":"test","event":"install","version":"1.8.0","installed_at":"2024-01-01T00:00:00Z","stats":{"active_users_7d":10,"total_conversations":50},"domain_hash":"test","timestamp":"2024-01-01T00:00:00Z"}'

# 预期：{"success": true}

# 测试安装数徽章
curl https://your-vercel-app.vercel.app/api/badge-installs

# 预期：{"schemaVersion":1,"label":"installations","message":"1","color":"blue"}

# 测试活跃用户徽章
curl https://your-vercel-app.vercel.app/api/badge-active

# 预期：{"schemaVersion":1,"label":"active users (7d)","message":"10","color":"green"}
```

### 3. 检查 MongoDB 数据

```javascript
use hydro_ai_stats

// 查看数据
db.plugin_stats.find().pretty()

// 验证索引
db.plugin_stats.getIndexes()
```

### 4. 验证插件端

```bash
# 查看 HydroOJ 日志
pm2 logs hydrooj | grep TelemetryService

# 预期输出
[TelemetryService] Initialized successfully
[TelemetryService] Report sent successfully (install)
```

---

## 一键更新（后台）故障排查

### 1. 前置条件（必须）

- `git`、`npm`、`gpg`、`pm2` 在服务器上可用（可执行且在 PATH 中）。
- 插件目录包含 `assets/trusted-keys/publisher.asc`（用于校验发布者签名）。

### 2. 常见失败原因

1) **提示：未检测到可用的 gpg（GnuPG）**
- 解决：安装 `gpg` 后重试（例如：Debian/Ubuntu `sudo apt-get install gnupg`；macOS `brew install gnupg`）。

2) **提示：上游仓库未启用 GPG 签名 / 签名无效 / 指纹不在信任列表**
- 说明：为保证更新代码来源可信，“一键更新”会强制校验最新 commit 的 GPG 签名，并核对发布者主密钥指纹白名单。
- 解决：
  - 确认上游 main 分支最新 commit 已签名；
  - 确认签名主密钥指纹与插件内白名单一致；
  - 若发布者更换密钥，需要更新 `assets/trusted-keys/publisher.asc` 与白名单指纹后再更新。

3) **提示：依赖安装失败（默认禁用 npm scripts）**
- 说明：为降低供应链风险，更新过程默认使用 `npm ci/install --ignore-scripts`，不会执行依赖包的 `install/postinstall` 脚本。
- 解决（谨慎）：若确实需要执行 scripts 才能安装成功，可在运行 HydroOJ 的环境中设置：
  - `AI_HELPER_UPDATE_ALLOW_NPM_SCRIPTS=1`
  - 风险：启用后依赖包安装脚本可能在服务器上执行，请确认来源与变更可信。

4) **页面提示 502 / 连接中断**
- 说明：更新完成后会触发 `pm2 reload/restart hydrooj`，短时间内可能导致连接中断。
- 解决：等待 15–20 秒刷新页面；必要时查看 `pm2 logs hydrooj`。

---

## 常见问题汇总

| 问题 | 原因 | 解决方案 |
|------|------|---------|
| 构建失败 | TypeScript 配置不兼容 | 添加 `buildCommand: null` |
| MongoDB 连接失败 | 环境变量或网络访问 | 检查 Vercel 环境变量和 Atlas 配置 |
| 函数超时 | 集群暂停或连接慢 | 唤醒集群，优化连接池 |
| 徽章 invalid | API 返回格式错误 | 检查 API 端点返回 |
| 徽章 error | 数据库查询失败 | 检查数据库连接和数据 |
| 上报失败 | 端点不可达/被阻断 | 检查 `AI_HELPER_TELEMETRY_ENDPOINTS` 与机房出网策略 |

---

## 获取帮助

如果以上方案都无法解决问题：

1. **查看 Vercel 日志**
   - Vercel Dashboard → 项目 → Functions → Logs
   - 复制完整错误信息

2. **查看 MongoDB Atlas 日志**
   - MongoDB Atlas → Cluster → Metrics
   - 检查连接数和操作数

3. **提交 Issue**
   - 访问 https://github.com/AltureT/hydro-ai-helper/issues
   - 提供完整的错误日志和配置信息

---

## 相关文档

- [DEPLOYMENT_PHASE2.md](./DEPLOYMENT_PHASE2.md) - 详细部署指南
- [QUICKSTART.md](./QUICKSTART.md) - 快速开始指南
- [VERCEL_CONFIG.md](./VERCEL_CONFIG.md) - Vercel 配置指南
