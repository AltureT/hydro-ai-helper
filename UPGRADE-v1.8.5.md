# 🚨 重要升级公告：v1.8.5

## 📢 所有用户请立即升级

**发布日期**：2026-02-01
**紧急程度**：⚠️ 高（影响统计功能）
**影响版本**：v1.8.4 及更早版本

---

## 🐛 修复的问题

v1.8.4 存在一个关键 bug，导致**所有统计数据上报失败**：

```typescript
// ❌ v1.8.4（错误）
REPORT_URL = 'https://hydro-ai-helper.vercel.app//api/report'
                                                     ^^
                                              双斜杠导致 404

// ✅ v1.8.5（修复）
REPORT_URL = 'https://hydro-ai-helper.vercel.app/api/report'
```

**影响**：
- ❌ GitHub README 徽章显示安装数为 0
- ❌ 遥测数据未成功上报
- ❌ 无法统计插件使用情况

---

## 🚀 升级步骤（3 分钟）

### Step 1: 更新插件

**方法 A：使用 HydroOJ CLI（推荐）**

```bash
hydrooj addon add hydro-ai-helper@latest
```

**方法 B：使用 npm**

```bash
cd /path/to/hydrooj  # 进入 HydroOJ 安装目录
npm install hydro-ai-helper@latest
```

### Step 2: 重启服务

```bash
# 如果使用 pm2
pm2 restart hydro

# 如果使用 systemd
systemctl restart hydrooj

# 如果使用 Docker
docker-compose restart backend
```

### Step 3: 验证升级（可选）

```bash
# 检查版本号
mongosh <<'EOF'
use hydro
db.package.findOne({ name: 'hydro-ai-helper' }, { version: 1 })
EOF

# 应该显示: { version: "1.8.5" }
```

---

## ✅ 预期效果

升级后 **24-48 小时内**：

1. ✅ 插件自动上报统计数据到 MongoDB
2. ✅ GitHub README 徽章显示正确数字
3. ✅ HydroOJ 日志显示上报成功：
   ```
   [TelemetryService] Report sent successfully (heartbeat)
   ```

---

## 🔍 如何确认修复成功？

### 检查日志（24 小时后）

```bash
pm2 logs hydro --lines 100 | grep -i telemetry
```

**✅ 成功的日志**：
```
[TelemetryService] Initialized successfully
[TelemetryService] Report sent successfully (heartbeat)
```

**❌ 如果仍然失败**：
```
[TelemetryService] Failed to send report: 404
```

如果看到 404 错误，说明升级未生效，请：
1. 确认版本号确实是 1.8.5
2. ��除 node_modules 缓存后重新安装
3. 在 [GitHub Issues](https://github.com/AltureT/hydro-ai-helper/issues) 报告问题

---

## 📊 诊断工具

如果升级后仍有问题，可以运行诊断脚本：

```bash
# 下载诊断脚本
curl -O https://raw.githubusercontent.com/AltureT/hydro-ai-helper/main/scripts/diagnose.sh

# 执行诊断
bash diagnose.sh

# 将输出发送给开发者
```

---

## 🙋 常见问题

### Q1: 升级会影响现有数据吗？
**A**: 不会。升级只修复了上报逻辑，不会改动数据库或配置。

### Q2: 升级后需要重新配置吗？
**A**: 不需要。所有配置自动保留。

### Q3: 升级后多久能看到徽章更新？
**A**:
- 插件每 24 小时上报一次数据
- 徽章 API 有 5 分钟缓存
- 总计最多 24 小时 + 5 分钟

### Q4: 我不想上报统计数据，怎么禁用？
**A**: 在 Admin 配置中设置 `telemetryEnabled: false`

### Q5: 升级后仍然显示 0 怎么办？
**A**:
1. 等待 24 小时（首次心跳周期）
2. 检查日志确认上报成功
3. 如果仍然失败，联系开发者

---

## 📦 版本信息

- **版本号**: 1.8.5
- **发布日期**: 2026-02-01
- **npm 包**: https://www.npmjs.com/package/hydro-ai-helper
- **GitHub Release**: https://github.com/AltureT/hydro-ai-helper/releases/tag/v1.8.5
- **修复提交**: [9b82068](https://github.com/AltureT/hydro-ai-helper/commit/9b82068)

---

## 🛠️ 技术细节

### 修复内容
- 文件：`src/services/telemetryService.ts:43`
- 修改：移除 URL 中的双斜杠
- 影响：所有 v1.8.4 及更早版本

### 根本原因
1. URL 拼接错误导致 HTTP 404
2. 所有上报请求被 Vercel 拒绝
3. MongoDB 数据库始终为空
4. 徽章 API 返回 countDocuments() = 0

### 验证方法
```bash
# 测试新 URL（应该返回 400，不是 404）
curl -X POST "https://hydro-ai-helper.vercel.app/api/report" \
  -H "Content-Type: application/json" \
  -d '{}'

# ✅ v1.8.5 返回: {"success":false,"error":"instance_id is required"}
# ❌ v1.8.4 返回: 404 Not Found
```

---

## 🙏 致谢

本次修复得到了以下 AI 工具的协助：
- **Claude Sonnet 4.5**: 问题诊断和修复
- **Gemini 2.0 Flash Thinking**: 交叉审阅
- **OpenAI Codex**: 代码分析

感谢所有用户的支持！

---

**如有问题，请在 [GitHub Issues](https://github.com/AltureT/hydro-ai-helper/issues) 反馈。**
