# GitHub Actions 自动发布配置指南

## 📦 功能说明

当你推送新的 git tag（如 `v1.8.6`）到 GitHub 时，会自动：
1. ✅ 构建 TypeScript 代码
2. ✅ 验证版本号一致性
3. ✅ 发布到 npm
4. ✅ 创建 GitHub Release

---

## 🔧 配置步骤

### Step 1: 创建 npm Automation Token

1. **访问** npm Tokens 页面：
   https://www.npmjs.com/settings/npmdwhguieg/tokens

2. **点击** "Generate New Token"

3. **选择配置**：
   - **Token Type**: `Granular Access Token` 或 `Automation`
   - **Expiration**: 建议 `No expiration` 或 `365 days`
   - **Packages and scopes**:
     - Permissions: `Read and write`
     - Packages: `hydro-ai-helper` 或 `All packages`

4. **完成安全验证**（指纹/密钥）

5. **复制生成的 token**（格式：`npm_xxxxxxxxxxxxx`）
   - ⚠️ **重要**：token 只会显示一次，请立即保存

---

### Step 2: 添加 GitHub Secret

1. **访问** 你的 GitHub 仓库设置：
   https://github.com/AltureT/hydro-ai-helper/settings/secrets/actions

2. **点击** "New repository secret"

3. **填写信息**：
   - **Name**: `NPM_TOKEN`（必须完全一致）
   - **Secret**: 粘贴你刚才复制的 npm token

4. **点击** "Add secret"

---

### Step 3: 验证配置

运行以下命令测试自动发布：

```bash
# 1. 确保代码已提交
git status

# 2. 升级版本号（例如 1.8.5 → 1.8.6）
npm version patch  # 或 minor/major

# 3. 推送代码和 tag
git push origin main --tags

# 4. 查看 GitHub Actions 执行情况
# 访问：https://github.com/AltureT/hydro-ai-helper/actions
```

---

## 🚀 使用流程

### 发布新版本的完整流程

```bash
# 1. 修改代码并测试
npm run build:plugin
npm test  # 如果有测试

# 2. 提交代码
git add .
git commit -m "feat: 新功能描述"

# 3. 升级版本（自动修改 package.json 并创建 git tag）
npm version patch  # 小版本：1.8.5 → 1.8.6
# 或
npm version minor  # 中版本：1.8.6 → 1.9.0
# 或
npm version major  # 大版本：1.9.0 → 2.0.0

# 4. 推送（触发自动发布）
git push origin main --tags
```

**自动执行**：
- ✅ GitHub Actions 检测到新 tag
- ✅ ���动构建、测试、发布
- ✅ 创建 GitHub Release
- ✅ 5-10 分钟后在 npm 上可见

---

## 🚦 版本通道与测试工作流（stable / edge）

插件的"应用内一键更新 / 覆盖更新"按钮通过环境变量 `AI_HELPER_UPDATE_CHANNEL` 区分两个通道：

| 通道 | 更新目标 | 适用对象 |
| --- | --- | --- |
| `stable`（默认） | 最新正式发布标签 `git tag vX.Y.Z` | 所有真实用户的生产服务器 |
| `edge` | `main` 分支最新代码 | **仅你自己的测试服务器** |

**关键点**：

- **不设置即为 `stable`**。普通用户即使点"覆盖更新"，也只会拿到你正式 `git tag` 发布、且经过 GPG 签名校验的版本——推到 `main` 的未测试代码不会影响他们。
- 版本检测（"有新版本"提示）与一键更新使用**同一套规则**：stable 比较最新发布标签，edge 比较 `main` 的 `package.json`。
- 预发布标签（如 `v2.3.0-beta.1`）会被 stable 通道忽略，因此 beta 不会推送给普通用户。

### 开发者推荐工作流

1. 日常在 `main`（或 feature 分支）开发并正常推送：

   ```bash
   git push origin main
   ```

   → 普通用户**不受影响**（他们在 stable 通道）。

2. 在你的**学校测试服务器**上一次性切到 edge：

   ```bash
   export AI_HELPER_UPDATE_CHANNEL=edge   # 写入 pm2 ecosystem env 或 shell profile
   pm2 restart hydrooj --update-env
   ```

   之后在该服务器点"覆盖更新"即可一键拉取 `main` 最新代码进行测试。

3. 测试通过、准备发布给所有人时，打 tag 发布（详见下方"使用流程"）：

   ```bash
   npm version patch   # 或 minor / major，自动改 package.json 并打 tag
   git push origin main --tags
   ```

   → tag 触发自动发布；所有 stable 用户随后会收到"有新版本"提示，并能安全地一键更新到该发布版本。

> 切换通道后需重启服务（`pm2 restart hydrooj --update-env`）才会生效；版本缓存按通道隔离，最长 24 小时刷新（点"刷新"可立即重查）。

---

## 📋 版本号规范

遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)：

- **Patch** (1.8.5 → 1.8.6)：Bug 修复、小改进
- **Minor** (1.8.6 → 1.9.0)：新功能（向后兼容）
- **Major** (1.9.0 → 2.0.0)：破坏性变更（不向后兼容）

**Tag 格式**：
- ✅ 正确：`v1.8.6`, `v2.0.0`, `v1.9.0-beta.1`
- ❌ 错误：`1.8.6`, `version-1.8.6`, `release-v1.8.6`

---

## 🔍 故障排查

### 问题 1：发布失败 - "401 Unauthorized"

**原因**：NPM_TOKEN 未配置或已过期

**解决**：
1. 检查 GitHub Secret 是否存在
2. 重新生成 npm token
3. 更新 GitHub Secret

---

### 问题 2：发布失败 - "版本已存在"

**原因**：npm 上已有相同版本号

**解决**：
```bash
# 删除本地 tag
git tag -d v1.8.6

# 删除远程 tag
git push origin :refs/tags/v1.8.6

# 升级版本号
npm version patch

# 重新推送
git push origin main --tags
```

---

### 问题 3：版本号不一致错误

**原因**：Tag 版本与 package.json 版本不匹配

**解决**：
```bash
# 始终使用 npm version 命令（自动同步）
npm version patch

# 不要手动修改 package.json 后创建 tag
```

---

### 问题 4：如何手动触发发布？

如果自动发布失败，可以手动触发：

```bash
# 方法 1：使用 GitHub CLI
gh workflow run npm-publish.yml

# 方法 2：在 GitHub 网页手动触发
# 访问：https://github.com/AltureT/hydro-ai-helper/actions
# 选择 "Publish to npm" → "Run workflow"
```

---

## 📊 监控发布状态

### 查看 Actions 执行日志

访问：https://github.com/AltureT/hydro-ai-helper/actions

**成功标志**：
- ✅ 绿色勾号
- ✅ 日志中显示 "🎉 成功发布"

**失败标志**：
- ❌ 红色叉号
- ❌ 日志中显示错误信息

---

### 验证发布成功

```bash
# 检查 npm 版本
npm view hydro-ai-helper version

# 检查 GitHub Release
gh release list

# 检查徽章
curl https://img.shields.io/github/v/release/AltureT/hydro-ai-helper
```

---

## 🔒 安全注意事项

1. ✅ **NPM_TOKEN 是敏感信息**，仅保存在 GitHub Secrets 中
2. ✅ **不要提交 token** 到代码仓库或 .npmrc
3. ✅ **定期轮换 token**（建议 90-180 天）
4. ✅ **限制 token 权限**（仅授予必要的包）
5. ✅ **启用 2FA**（双因素认证）

---

## 📚 参考资源

- GitHub Actions 文档：https://docs.github.com/en/actions
- npm Publishing 指南：https://docs.npmjs.com/packages-and-modules/contributing-packages-to-the-registry
- Semantic Versioning：https://semver.org/lang/zh-CN/

---

## ❓ 常见问题

### Q1: 能否同时发布到多个 npm registry？

可以，在 workflow 中添加多个发布步骤：

```yaml
- name: 发布到 npm
  run: npm publish --access public
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}

- name: 发布到 GitHub Packages
  run: npm publish --registry=https://npm.pkg.github.com
  env:
    NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

---

### Q2: 如何发布 beta 版本？

```bash
# 创建 beta 版本
npm version prerelease --preid=beta
# 例如：1.8.5 → 1.8.6-beta.0

# 推送
git push origin main --tags

# npm 上会标记为 beta
npm install hydro-ai-helper@beta
```

---

### Q3: 能否在发布前自动运行测试？

可以，在 workflow 中添加测试步骤：

```yaml
- name: 运行测试
  run: npm test

- name: 发布到 npm
  if: success()  # 仅测试通过时发布
  run: npm publish
```

---

**配置完成后，你只需要运行 `npm version patch && git push --tags`，其余全部自动化！**
