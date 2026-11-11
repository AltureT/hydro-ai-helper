# 配置说明

**中文 | [English](configuration_en.md)**

插件通过 Hydro 进程的环境变量配置。修改后需要重启 Hydro；用 pm2 运行时执行 `pm2 restart hydrooj --update-env && pm2 save`，新的环境变量才会生效并在重启后保留。

## 加密密钥

`ENCRYPTION_KEY`：用于加密保存在数据库中的 API Key，至少 16 个字符。

- 不设置时，插件使用内置的默认密钥并在日志中警告。正式环境务必设置。
- 生成一个随机密钥：`openssl rand -base64 24`。

**更换密钥**：直接修改 `ENCRYPTION_KEY` 会让已保存的 API Key 无法解密。按以下步骤更换：

1. 把当前密钥设为 `OLD_ENCRYPTION_KEY`，新密钥设为 `ENCRYPTION_KEY`，然后重启 Hydro。
2. 启动时插件会用新密钥重新加密所有 API Key，日志中出现 `Key rotation: re-encrypted ...`。
3. 确认后删除 `OLD_ENCRYPTION_KEY`，再重启一次。

## 可选环境变量

`AI_HELPER_UPDATE_CHANNEL`：「AI 配置」页一键更新使用的通道。

- `stable`（默认）：只更新到正式发布版本（`vX.Y.Z` 标签），并校验 GPG 签名。所有正式使用的服务器都应使用此通道。
- `edge`：跟踪 `main` 分支的最新代码，仅用于维护者自己的测试服务器。

`AI_HELPER_JAILBREAK_LOG_RETENTION_DAYS`：安全策略拦截日志的保留天数。

- 默认 `180` 天，可设置范围 `7`–`3650` 天。
- 新日志从创建时开始计算；历史日志从升级时开始逐步过期，不会在部署时立即删除。

`AI_HELPER_TESTDATA_GENERATION_MODE`：测试数据生成是否必须使用判题沙箱（`hydrojudge.sandbox_host`）。

- `auto`（默认）：沙箱可访问时实际运行并验证；不可访问时降级为直接输出，并明确标注「未验证」。
- `sandbox`：必须使用沙箱，沙箱不可用时停止生成。
- `direct`：始终直接输出，不推荐。

`AI_HELPER_TESTDATA_MODEL_TIMEOUT_SECONDS`：测试数据生成中单次模型调用的最长时间。

- 默认 `300` 秒，可设置范围 `30`–`1800` 秒；非法值使用默认值。
- 只限制卡住的单次调用，不减少模型输出长度、推理强度或验证步骤。

`AI_HELPER_TESTDATA_MUTATION_CONCURRENCY`：变异测试同时在沙箱中运行的数量。

- 默认 `2`，可设置范围 `1`–`4`；非法值使用默认值。
- 结果仍按原始顺序记录；并发时第一次超时的候选会单独重跑确认，避免把短暂拥塞误判为已被测试数据卡住。

## 关闭遥测

插件默认上报匿名统计数据（安装数、活跃用户数、对话数、功能用量和版本），不包含代码、对话内容或个人信息。关闭方法：在 Hydro 使用的 MongoDB 数据库中执行

```javascript
db.ai_plugin_install.updateOne(
  { _id: 'install' },
  { $set: { telemetryEnabled: false } }
)
```
