# GitHub Actions 发布与安全门禁

## 发布原则

稳定版只从受信任的 `main` 提交发布。日常改动必须通过 feature 分支和 Pull Request 进入 `main`：GitHub CI 的 lint、测试和构建均须通过，然后使用 GitHub 网页的 squash-merge 合并。网页合并产生的 `web-flow` 签名提交满足稳定更新器的受信任签名要求；不要用 CLI/API 合并或直接推送绕过该流程。

每个稳定版使用 `vX.Y.Z` 格式的**已签名 annotated tag**。标签必须直接指向一个已验证签名的提交，且该提交必须是 `origin/main` 的祖先。发布工作流会以完整历史执行 `node scripts/verifyReleaseRef.js`，拒绝轻量标签、未验证签名、非 `main` 祖先和标签目标不一致的发布。

## 发布前检查

在提交 Pull Request 前运行：

```bash
npm run lint
npm test -- --runInBand --silent
npm run build:plugin
```

发布工作流再次执行同一组 lint、测试和构建门禁，并在所有门禁通过后才执行：

```bash
npm publish --provenance --access public
```

`--provenance` 使用 GitHub Actions 的 OIDC `id-token: write` 权限生成 npm provenance。发布标签与 `package.json` 版本必须一致，并且 `CHANGELOG.md` 中必须存在该标签对应的发布说明。

## 发行流程

1. 在 feature 分支完成改动并通过本地检查。
2. 创建面向 `main` 的 Pull Request，等待 CI 通过。
3. 在 GitHub 网页使用 squash-merge 合并，确认生成受信任签名的 `web-flow` 提交。
4. 在该 `main` 提交上创建已签名 annotated tag，例如：

   ```bash
   npm version patch --sign-git-tag
   git push origin main --tags
   ```

5. 观察 `Publish to npm` 工作流；它会验证发布引用、执行门禁、以 provenance 发布 npm 包、创建 GitHub Release，并触发 Gitee Release 同步。

## Trusted Publishing 与凭据迁移

当前发布工作流使用 OIDC provenance，同时保留令牌认证：`NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` 仍为 npm 发布提供认证，以保证现有发布链不断裂。

**Trusted Publishing 尚待 npm 包设置和一次受控发布确认**。在该迁移完成并确认不再需要令牌前，**暂不删除 `NPM_TOKEN`**。届时应先更新工作流和发布验证，再移除 GitHub Secret；不得在未验证的情况下删除凭据或将令牌写入仓库、日志或 `.npmrc`。

## 版本通道

`AI_HELPER_UPDATE_CHANNEL=stable`（默认）只跟踪正式、已验证签名的发布标签；`edge` 跟踪 `main`，仅供维护者自己的测试服务器使用。预发布标签不会进入 stable 通道。切换通道后需重启 HydroOJ，并使用 `--update-env` 使环境变量生效。

## 故障排查

- 发布引用验证失败：确认标签是已签名 annotated tag，直接指向 `main` 祖先中的已验证提交。
- lint、测试或构建失败：在修复后重新提交 Pull Request；不要将关键步骤标记为 `continue-on-error`。
- npm 发布失败：检查 GitHub Actions 日志和 npm Trusted Publishing 配置。保留 `NPM_TOKEN` 的过渡期内，也检查该 Secret 是否可用。
