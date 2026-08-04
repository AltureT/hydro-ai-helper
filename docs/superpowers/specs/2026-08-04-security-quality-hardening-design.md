# Security and Quality Hardening Design

## Goal

Reduce the repository's actionable dependency and supply-chain risk without breaking the single-maintainer release workflow, while strengthening GitHub's built-in security coverage and keeping the plugin's existing behavior unchanged.

## Current Baseline

- `main`, `origin/main`, GitHub Release, and npm are on version `3.1.0`.
- The isolated baseline passes 61 Jest suites and 1,293 tests.
- GitHub reports 58 open Dependabot alerts: 27 high, 23 medium, and 8 low. Fifty-five are development-scoped and three are runtime-scoped.
- A production-only npm audit additionally reports `ip-address`, for a total of three high and one low runtime vulnerability in the current lockfile.
- Dependency graph and Dependabot alerts are enabled.
- Secret scanning, push protection, secret validity checks, Dependabot security updates, private vulnerability reporting, and CodeQL default setup are disabled or not configured.
- The active `main` ruleset requires Lint, Test, and Build and blocks deletion/non-fast-forward updates, but does not require a pull request, signed commits, or resolved review threads.
- The repository has one administrator, `AltureT`, so a mandatory approving review would make normal single-maintainer delivery depend on a bypass.

## Approaches Considered

### 1. Settings-only quick hardening

Enable GitHub security switches and leave dependencies, workflows, and rulesets unchanged. This is fast and low-risk, but it leaves known runtime vulnerabilities and release-chain weaknesses unresolved.

### 2. Phased comprehensive hardening (selected)

Patch dependencies and repository files on an isolated branch, validate them, deliver them through a pull request, and then enable enforcement that depends on the merged workflow. Independently safe GitHub features can be enabled without waiting for the pull request. This addresses the complete finding set while preserving rollback points.

### 3. Maximum enforcement immediately

Require one approving review, enable SHA pinning before workflow migration, and replace the npm token with Trusted Publishing in one step. This offers the strictest target state but can lock out the sole maintainer or break releases if npm's publisher binding is not already configured.

## Selected Design

### Dependency remediation

Update the root and telemetry-dashboard lockfiles within declared semver ranges. The first gate is zero known production vulnerabilities from `npm audit --omit=dev`; the broader goal is to remove every fixable alert that can be resolved without an intentional major-version migration.

The runtime paths receive explicit verification:

- `linkify-it` must resolve to `5.0.2` or newer because markdown rendering enables linkification on untrusted content.
- `form-data` must resolve to `4.0.6` or newer through Axios.
- `dompurify` must resolve to `3.4.12` or newer even though the current sanitizer does not use the affected custom-element hook.
- `ip-address` must resolve above the affected range through the MongoDB/SOCKS chain.

No application behavior or public API changes are planned. Lockfile-only transitive upgrades are preferred; direct dependency ranges change only when the existing range cannot select a patched version.

### GitHub security features

Enable the following repository-level features through GitHub's authenticated API:

- Dependabot security updates
- Private vulnerability reporting
- Secret scanning
- Secret scanning push protection
- Secret validity checks, when supported for this public repository
- CodeQL default setup for Actions, JavaScript/TypeScript, and TypeScript

Each mutation must be followed by a read-back of the same setting. Unsupported optional features are reported explicitly rather than treated as enabled.

### Workflow supply-chain hardening

Pin every `uses:` reference in the four active workflows to a full 40-character commit SHA and retain a version comment for maintainability. After the workflow changes are merged, enable repository-level SHA-pinning enforcement.

The npm release workflow will:

- run lint, tests, and the plugin build before publishing;
- verify that the release tag version equals `package.json`;
- verify that the tagged commit is contained in `origin/main`;
- require GitHub to report valid signatures for both the annotated tag and tagged commit;
- publish with npm provenance using GitHub OIDC while retaining `NPM_TOKEN` until npm Trusted Publishing is confirmed on the npm package;
- keep job permissions explicit and minimal for the release and workflow-dispatch steps.

The Gitee mirror workflows will avoid interpolating dispatch inputs directly into shell source, pin host keys instead of trusting a first-seen SSH key, and stop ignoring tag-push failures. Forced mirror updates remain intentional because Gitee is a mirror, but failures become visible.

### Branch and tag rulesets

Extend the `main` ruleset after the hardened workflows are merged:

- require changes to arrive through a pull request;
- require review-thread resolution;
- require signed commits;
- retain strict Lint, Test, and Build checks;
- retain deletion and non-fast-forward protection;
- require zero approving reviews because there is only one administrator.

Create a release-tag ruleset for `v*` tags that blocks deletion and non-fast-forward updates, requires signed commits/tags where GitHub supports the rule, and restricts creation through the existing administrator/integration bypass model. The exact ruleset payload is read back after creation to ensure it does not block the maintainer's signed release process.

### Security documentation

Update `.github/SECURITY.md` to support the current `3.x` line, remove the misleading claim that private reporting is available until the setting is verified enabled, and describe the supported private-reporting and email channels accurately.

Update `.github/AUTOMATION.md` to describe the current `3.x` release path, signed-tag requirement, complete verification gates, provenance, and the fact that npm Trusted Publishing remains a separate npm-side migration until confirmed.

## Testing and Verification

The implementation must pass:

1. A focused workflow-policy test that fails on unpinned actions or a release workflow missing tag/source/signature/test gates.
2. YAML parsing for all workflow files.
3. `npm audit --omit=dev` for the root plugin and telemetry dashboard, with zero known production vulnerabilities.
4. `npm run build:plugin`.
5. `npm run lint` with zero warnings or errors.
6. `npm test -- --runInBand --silent` with all suites passing.
7. A diff check confirming tracked `dist/` remains synchronized when TypeScript output changes; dependency/config-only changes must not introduce unrelated `dist/` churn.
8. GitHub API read-backs for every changed security setting and ruleset.

## Rollout and Rollback

Repository file changes travel through a feature branch and pull request. Security switches that do not depend on workflow changes can be disabled through the same API if they cause an unexpected operational issue. SHA-pinning enforcement and stricter rulesets are enabled only after the pinned workflows reach `main`; their previous JSON payloads are recorded before mutation so they can be restored.

The existing long-lived npm token remains available during the provenance transition. Removing it is explicitly outside this change until npm Trusted Publishing is confirmed from npm's package settings.

## Success Criteria

- No known production dependency vulnerability remains in either npm project.
- All active workflow actions are pinned by full SHA.
- Release tags cannot publish code outside `main` or code lacking valid GitHub signature verification.
- Secret scanning, push protection, Dependabot security updates, private vulnerability reporting, and CodeQL are confirmed active where GitHub supports them.
- `main` requires the pull-request path, resolved threads, signed commits, and the existing three CI gates without requiring an unavailable second reviewer.
- Security and automation documentation matches version `3.1.0` and the actual repository settings.
- The original working directory's unrelated files remain untouched.
