# Security and Quality Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove known production dependency vulnerabilities, harden GitHub Actions and release provenance, enable GitHub security analysis, and strengthen protected refs without breaking the single-maintainer workflow.

**Architecture:** Repository changes are verified on `codex/security-quality-hardening`, delivered through a protected PR, and followed by enforcement that depends on the merged workflows. A tested Node verifier owns tag/main/signature validation; workflow-policy tests prevent mutable Action refs and missing release gates.

**Tech Stack:** Node.js 22, TypeScript, Jest/ts-jest, npm lockfiles, GitHub Actions YAML, GitHub REST API via `gh`, Git rulesets.

## Global Constraints

- Preserve plugin runtime behavior and public APIs.
- Preserve the original checkout's modified `.gitignore` and untracked `AGENTS.md` and `telemetry-improvements-kickoff.md`.
- Never use `npm audit fix --force` or intentional major-version upgrades.
- Keep `dist/` unchanged unless TypeScript production output changes.
- Keep `NPM_TOKEN` until npm Trusted Publishing is confirmed; add provenance without removing the fallback credential.
- Require zero approving reviews because `AltureT` is the only collaborator.
- Use GitHub web-UI squash merge for the trusted `web-flow` signature.
- Do not create a stable release tag in this plan.

---

### Task 1: Add a tested release-ref verifier

**Files:**
- Create: `scripts/verifyReleaseRef.js`
- Create: `src/__tests__/scripts/verifyReleaseRef.test.ts`

**Interfaces:**
- Consumes: `GITHUB_REF_NAME`, `GITHUB_REPOSITORY`, `GITHUB_TOKEN`, `origin/main`, and GitHub REST verification responses.
- Produces: `verifyReleaseRef(options?): Promise<{ tagName: string; commitSha: string }>` plus a CLI with non-zero failure exit.

- [ ] **Step 1: Write the failing test**

Create a Jest test that first asserts `scripts/verifyReleaseRef.js` exists, then injects a fake `git` runner and fake GitHub fetch responses. Cover one success case and rejection of: a commit outside `origin/main`, a lightweight tag, an unverified commit, and an unverified tag.

The success fixture is:

```typescript
const env = {
  GITHUB_REF_NAME: 'v3.2.0',
  GITHUB_REPOSITORY: 'AltureT/hydro-ai-helper',
  GITHUB_TOKEN: 'test-token',
};
await expect(verifyReleaseRef({ env, execFile, fetchImpl })).resolves.toEqual({
  tagName: 'v3.2.0',
  commitSha: 'a'.repeat(40),
});
```

- [ ] **Step 2: Verify RED**

```bash
npx jest src/__tests__/scripts/verifyReleaseRef.test.ts --runInBand
```

Expected: FAIL because `scripts/verifyReleaseRef.js` does not exist.

- [ ] **Step 3: Implement the minimal verifier**

Implement CommonJS `verifyReleaseRef` using `execFileSync` and Node 22 `fetch`:

```javascript
execFile('git', ['fetch', 'origin', 'main', '--no-tags']);
const commitSha = execFile('git', ['rev-list', '-n', '1', tagName]);
execFile('git', ['merge-base', '--is-ancestor', commitSha, 'origin/main']);
```

Require `/^v\d+\.\d+\.\d+$/`, GitHub `commit.verification.verified === true`, an annotated tag ref (`object.type === 'tag'`), tag-object `verification.verified === true`, and a direct tag-object commit SHA equal to `commitSha`. Export the function and add a CLI wrapper that prints the verified tag/SHA or sets `process.exitCode = 1`.

- [ ] **Step 4: Verify GREEN and commit**

```bash
npx jest src/__tests__/scripts/verifyReleaseRef.test.ts --runInBand
git add scripts/verifyReleaseRef.js src/__tests__/scripts/verifyReleaseRef.test.ts
git commit -m "test: verify signed release refs"
```

Expected: 5 verifier tests pass.

### Task 2: Remediate root and dashboard dependency vulnerabilities

**Files:**
- Modify: `package-lock.json`
- Modify: `cloudflare/telemetry-dashboard/package-lock.json`

**Interfaces:**
- Consumes: existing direct semver ranges.
- Produces: reproducible lockfiles with zero production audit findings.

- [ ] **Step 1: Capture RED audits**

```bash
npm audit --omit=dev
npm --prefix cloudflare/telemetry-dashboard audit --omit=dev
```

Expected: the root audit exits non-zero for the known production vulnerabilities.

- [ ] **Step 2: Apply only non-breaking fixes**

```bash
npm audit fix --package-lock-only
npm --prefix cloudflare/telemetry-dashboard audit fix --package-lock-only
```

If a vulnerable transitive package remains within an existing range, use `npm update --package-lock-only <package>` for only that package. Do not use `--force`.

- [ ] **Step 3: Reinstall and verify GREEN**

```bash
npm ci
npm --prefix cloudflare/telemetry-dashboard ci
npm ls dompurify linkify-it form-data ip-address
npm audit --omit=dev
npm --prefix cloudflare/telemetry-dashboard audit --omit=dev
```

Require `dompurify >= 3.4.12`, `linkify-it >= 5.0.2`, `form-data >= 4.0.6`, a patched `ip-address`, and zero production audit findings.

- [ ] **Step 4: Run focused tests and commit**

```bash
npx jest src/__tests__/services/openaiClient.test.ts src/__tests__/services/goJudgeSandboxService.test.ts --runInBand
git add package-lock.json cloudflare/telemetry-dashboard/package-lock.json
git commit -m "fix: remediate dependency vulnerabilities"
```

### Task 3: Pin Actions and harden release and mirror workflows

**Files:**
- Create: `src/__tests__/workflows/workflowSecurity.test.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/npm-publish.yml`
- Modify: `.github/workflows/sync-releases-to-gitee.yml`
- Modify: `.github/workflows/sync-to-gitee.yml`

**Interfaces:**
- Consumes: `scripts/verifyReleaseRef.js` and existing repository secrets.
- Produces: immutable Action references and enforced release/mirror invariants.

- [ ] **Step 1: Write failing workflow-policy tests**

Create `workflowSecurity.test.ts` that reads all four YAML files and asserts every `uses:` line matches a full 40-character SHA plus a `# vN` comment. It must also assert the release workflow contains:

```text
fetch-depth: 0
node scripts/verifyReleaseRef.js
npm run lint
npm test -- --runInBand --silent
npm run build:plugin
npm publish --provenance --access public
id-token: write
```

Add mirror assertions that `sync-to-gitee.yml` contains the pinned Ed25519 host key, contains no `ssh-keyscan`, and does not ignore tag-push failure; require `sync-releases-to-gitee.yml` to pass `github.event.inputs.tag_name` through `DISPATCH_TAG_NAME` environment data instead of inserting it into shell source.

- [ ] **Step 2: Verify RED**

```bash
npx jest src/__tests__/workflows/workflowSecurity.test.ts --runInBand
```

Expected: failures for mutable tags, missing release gates, `ssh-keyscan`, ignored tag failure, and direct input interpolation.

- [ ] **Step 3: Pin every Action**

Use these immutable refs, retaining the version comment exactly:

```yaml
actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5
actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6
actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f # v6
softprops/action-gh-release@3bb12739c298aeb8a4eeaf626c5b8d85266b0e65 # v2
```

- [ ] **Step 4: Harden npm publishing**

Set `fetch-depth: 0`; add `id-token: write`; call the verifier with `GITHUB_TOKEN`; run lint, tests, and build before publishing; change the publish command to `npm publish --provenance --access public` while retaining `NODE_AUTH_TOKEN`.

- [ ] **Step 5: Harden both Gitee workflows**

Use this trusted local host-key value and strict checking:

```bash
echo 'gitee.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEKxHSJ7084RmkJ4YdEi5tngynE8aZe2uEoVVsB/OvYN' >> ~/.ssh/known_hosts
```

Set `StrictHostKeyChecking yes`; remove `|| true` from `git push gitee --tags --force`; set workflow environment `DISPATCH_TAG_NAME` from the dispatch input and use `TAG_NAME="$DISPATCH_TAG_NAME"` inside shell.

- [ ] **Step 6: Parse YAML, verify GREEN, and commit**

```bash
node -e "const fs=require('fs');const yaml=require('js-yaml');for(const f of fs.readdirSync('.github/workflows').filter(x=>x.endsWith('.yml')))yaml.load(fs.readFileSync('.github/workflows/'+f,'utf8'));"
npx jest src/__tests__/workflows/workflowSecurity.test.ts src/__tests__/scripts/verifyReleaseRef.test.ts --runInBand
git add .github/workflows src/__tests__/workflows/workflowSecurity.test.ts
git commit -m "ci: harden release and mirror workflows"
```

### Task 4: Correct security and release documentation

**Files:**
- Modify: `.github/SECURITY.md`
- Modify: `.github/AUTOMATION.md`
- Modify: `src/__tests__/workflows/workflowSecurity.test.ts`

**Interfaces:**
- Consumes: verified workflow behavior and authenticated repository-admin access.
- Produces: accurate version `3.x`, private-reporting, signature, provenance, and release-gate guidance.

- [ ] **Step 1: Enable and verify private vulnerability reporting**

```bash
gh api --method PUT repos/AltureT/hydro-ai-helper/private-vulnerability-reporting
gh api repos/AltureT/hydro-ai-helper/private-vulnerability-reporting
```

Require `{"enabled":true}` before documenting the private-advisory route.

- [ ] **Step 2: Extend policy tests and confirm RED**

Add assertions that `.github/SECURITY.md` contains a `3.x` supported row, no `1.x` supported row, and the private-advisory route. Add assertions that `.github/AUTOMATION.md` contains `签名`, `npm run lint`, `npm test -- --runInBand --silent`, `npm publish --provenance`, and `Trusted Publishing`.

Run the focused test and require failure against the old documents.

- [ ] **Step 3: Update both documents**

List `3.x` as supported and earlier majors as unsupported. Keep email and verified private reporting. Document signed annotated tags, PR/CI/web-squash delivery, lint/test/build/main-ancestry/signature checks, npm provenance, and deferred `NPM_TOKEN` removal.

- [ ] **Step 4: Verify GREEN and commit**

```bash
npx jest src/__tests__/workflows/workflowSecurity.test.ts --runInBand
git add .github/SECURITY.md .github/AUTOMATION.md src/__tests__/workflows/workflowSecurity.test.ts
git commit -m "docs: align security and release guidance"
```

### Task 5: Enable remaining independent GitHub security features

**Files:**
- No repository files.
- Record rollback responses under `/private/tmp/hydro-ai-helper-security-backup/`.

**Interfaces:**
- Consumes: authenticated repository-admin access.
- Produces: Dependabot updates, secret scanning/push protection/validity checks where supported, and CodeQL default setup.

- [ ] **Step 1: Capture current remote state**

Save exact repository security analysis, automated fixes, and CodeQL responses before mutation. Preserve Task 4's private-reporting read-back in the same backup directory.

- [ ] **Step 2: Enable Dependabot security updates**

```bash
gh api --method PUT repos/AltureT/hydro-ai-helper/automated-security-fixes
```

- [ ] **Step 3: Enable secret capabilities separately**

```bash
gh api --method PATCH repos/AltureT/hydro-ai-helper -f 'security_and_analysis[secret_scanning][status]=enabled'
gh api --method PATCH repos/AltureT/hydro-ai-helper -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'
gh api --method PATCH repos/AltureT/hydro-ai-helper -f 'security_and_analysis[secret_scanning_validity_checks][status]=enabled'
```

If validity checks are unsupported, preserve core settings and report only that optional capability as unavailable.

- [ ] **Step 4: Configure CodeQL default setup**

```bash
gh api --method PATCH repos/AltureT/hydro-ai-helper/code-scanning/default-setup -f state=configured -f query_suite=default
```

- [ ] **Step 5: Read every setting back**

Require explicit enabled/configured responses before reporting success.

### Task 6: Run full verification and review

**Files:**
- Verify every file changed by Tasks 1-4.

**Interfaces:**
- Consumes: the complete branch diff and Task 5 read-backs.
- Produces: evidence suitable for protected delivery.

- [ ] **Step 1: Run authoritative local gates**

```bash
npm run build:plugin
npm run lint
npm test -- --runInBand --silent
npm audit --omit=dev
npm --prefix cloudflare/telemetry-dashboard run build
npm --prefix cloudflare/telemetry-dashboard audit --omit=dev
```

Require every command to exit 0, lint to have zero warnings, all Jest suites to pass, and both production audits to be clean.

- [ ] **Step 2: Verify scope and generated output**

```bash
git status --short
git diff origin/main -- dist
git diff --check origin/main...HEAD
```

Require a clean branch, no unrelated `dist/` changes, and no whitespace errors.

- [ ] **Step 3: Run repository-required code review**

Invoke `/code-review` on `origin/main...HEAD`. Fix every high/medium finding, rerun focused RED/GREEN tests and the full gates, and commit fixes narrowly.

### Task 7: Publish through PR, CI, and signed web squash merge

**Files:**
- No new files.

**Interfaces:**
- Consumes: reviewed exact branch HEAD.
- Produces: a signed `main` squash commit.

- [ ] **Step 1: Synchronize and reverify if needed**

```bash
git fetch origin --prune --tags
git rebase origin/main
```

Rerun Task 6 if rebase changes HEAD.

- [ ] **Step 2: Push and create a PR**

```bash
git push -u origin codex/security-quality-hardening
```

Create a PR summarizing dependency remediation, pinned workflows, release verification, documentation, audits, and remote feature settings. Record the exact pushed HEAD SHA.

- [ ] **Step 3: Require actual passing CI**

Wait for non-empty successful Lint, Test, and Build results on the recorded HEAD; pending or empty arrays are not success.

- [ ] **Step 4: Squash merge through GitHub web UI**

Use the web squash button, not CLI/API merge. Verify the merge commit has `verification.verified=true` and `reason=valid`.

- [ ] **Step 5: Fetch and verify remote main**

```bash
git fetch origin --prune
git rev-parse origin/main
```

Confirm GitHub `refs/heads/main` equals the fetched SHA and contains the tested content.

### Task 8: Enable post-merge SHA and ruleset enforcement

**Files:**
- No repository files.
- Record old/new settings under `/private/tmp/hydro-ai-helper-security-backup/`.

**Interfaces:**
- Consumes: pinned workflows already merged to `main`.
- Produces: SHA-pinning enforcement, stricter `main`, and protected signed release tags.

- [ ] **Step 1: Require Action SHA pinning**

```bash
gh api --method PUT repos/AltureT/hydro-ai-helper/actions/permissions -F enabled=true -f allowed_actions=all -F sha_pinning_required=true
```

- [ ] **Step 2: Update main ruleset `18160323`**

Preserve deletion, non-fast-forward, and strict Lint/Test/Build. Add `required_signatures`, `required_linear_history`, and this pull-request rule:

```json
{
  "type": "pull_request",
  "parameters": {
    "allowed_merge_methods": ["squash"],
    "dismiss_stale_reviews_on_push": false,
    "require_code_owner_review": false,
    "require_last_push_approval": false,
    "required_approving_review_count": 0,
    "required_review_thread_resolution": true
  }
}
```

Set repository-role bypass mode to `pull_request`; keep integration bypasses.

- [ ] **Step 3: Create the release-tag ruleset**

Create active `protect release tags` for `refs/tags/v*`, preserve administrator/integration `always` bypasses, and apply `creation`, `deletion`, `non_fast_forward`, and `required_signatures` rules.

- [ ] **Step 4: Read back all enforcement**

Confirm strict Lint/Test/Build, PR path, thread resolution, squash-only, signatures, linear history, release-tag protection, SHA pinning, and every Task 5 setting.

- [ ] **Step 5: Run the final remote audit**

Requery Dependabot, CodeQL, and secret-scanning alerts. Distinguish analysis still running from a clean result. Do not cut a stable tag; report that stable installations need a separately authorized signed patch release.
