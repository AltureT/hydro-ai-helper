# AGENTS.md — Hydro AI Helper

TypeScript plugin for HydroOJ. Preserve teaching-first tutoring behavior and tenant isolation through `domainId`.

## Scope and implementation

- Complete the requested implementation, relevant verification, and failure fixes. Ask only for a missing decision or an action not authorized by the task; an audit or plan remains bounded to that deliverable.
- Keep changes focused. Preserve unrelated tracked and untracked work; use one writer per worktree and do not stash or switch a shared checkout for convenience.
- Import ObjectId through `src/utils/mongo.ts`, not directly from mongodb. Verify Hydro core import paths before adding them; runtime BSON compatibility matters.
- Preserve domain filtering, input validation, permission checks, API-key encryption, and output safety. Use synthetic data and placeholders in tests and reports.
- Model injection, HTTP response patterns, frontend loading, and i18n details: read the relevant section of `agent-reference.md` only when changing those integrations.

## Verification

- Source changes: `npm run build:plugin`, `npm run lint`, and affected Jest tests, such as `npx jest path/to/test.ts --runInBand`. Broaden testing when changed behavior crosses modules or failures justify it.
- Tracked `dist/` is shipped and used by the updater. Include generated output for source changes; never hand-edit compiled files to hide a source failure.
- Frontend changes need evidence from Hydro's actual frontend loading path; plugin tsc alone does not verify browser behavior. Follow existing mock conventions in `src/__tests__/`.
- Documentation-only changes need relevant command/link and diff checks. Do not repeatedly run the full suite for prose edits.
- Report changes, exact verification exit codes, and unverified surfaces. Do not imply deployment or real-service verification from local tests.

## PR and release

- Use a feature branch and PR for main changes. Preserve branch protection and required checks; do not rely on account-specific bypass permissions.
- Follow the repository's GitHub web squash-merge path, then verify the resulting commit's trusted signature. Do not substitute a CLI/API merge without demonstrating the required signature policy is met.
- Stable follows release tags; edge follows main. Merging a PR is not a stable release.
- For an authorized release, make the version change on a feature branch without creating an early tag (`npm version <version> --no-git-tag-version`), submit it through the normal PR checks, then verify the merged commit, version and signature before tagging that exact commit. Push only the intended release tag; do not run npm version on main followed by a direct push or use `--tags` to publish unrelated tags.
- Do not tag an unsigned/untrusted commit. A signed tag alone does not substitute for the updater's commit-signature check. Release and deployment require the scope already authorized by the user.

## Local context and publication

- Keep personal paths, device identities, internal hostnames, account permissions, private logs, and real user data out of shared instructions and examples.
- Machine-specific notes may live in `AGENTS.local.md`, excluded locally through Git's `info/exclude`. Read them only for environment, deployment, or device work. Missing local notes do not block ordinary development.
- Local notes do not override task scope, repository safeguards, or authorization. In a new worktree, use available environment evidence; do not copy private notes into shared files.
- Review explicit file paths before staging. Publishing a document requires reviewing its contents and repository visibility; an instruction file is not automatically suitable for public release.
