# Testdata Latency Without Quality Loss Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce wall-clock latency of AI-generated testdata while preserving the current model roles, reasoning budgets, stress coverage, sandbox gates, and fail-closed semantics.

**Architecture:** Add two bounded runtime controls (model-call timeout and mutation concurrency), overlap only the observe-mode sandbox health probe with ProblemSpec generation, and expose existing per-stage durations as privacy-safe P50/P95 telemetry. Keep the authoritative generation and verification DAG unchanged; every optimization is bounded, deterministic, and covered by regression tests.

**Tech Stack:** TypeScript, Jest, Cloudflare Worker/D1, React 17, Node test runner.

**Design:** `docs/superpowers/specs/2026-08-26-testdata-latency-without-quality-loss-design.md`

---

### Task 1: Bound model calls and overlap the observe-mode health probe

**Files:**
- Create: `src/services/testdata/latency.ts`
- Create: `src/__tests__/services/testdataLatency.test.ts`
- Modify: `src/services/testdataGenService.ts`
- Modify: `src/__tests__/services/testdataGenService.test.ts`
- Modify: `README.md`
- Modify: `README_en.md`

- [ ] Write failing tests for `AI_HELPER_TESTDATA_MODEL_TIMEOUT_SECONDS`: default 300 seconds, accepted integer range 30–1800 seconds, and invalid/out-of-range fallback to the default.
- [ ] Write a failing service test proving that observe mode starts one sandbox availability probe before the deferred ProblemSpec request resolves, then reuses its settled result.
- [ ] Run `npx jest src/__tests__/services/testdataLatency.test.ts src/__tests__/services/testdataGenService.test.ts --runInBand` and confirm the new assertions fail for the intended missing behavior.
- [ ] Implement a pure timeout parser and use its value in `getCallOptions()` while retaining `maxTokens: null` and `retryTimeouts: false`.
- [ ] Start a caught/settled health-check promise before ProblemSpec generation only for non-direct, non-enforce runs; preserve enforce mode's current health-first ordering and reuse the result after Spec.
- [ ] Document the new environment variable in both READMEs.
- [ ] Re-run the targeted tests and commit the passing change.

### Task 2: Evaluate mutations in bounded deterministic windows

**Files:**
- Modify: `src/services/testdata/mutationRunner.ts`
- Modify: `src/__tests__/services/testdataMutationRunner.test.ts`
- Modify: `README.md`
- Modify: `README_en.md`

- [ ] Write failing tests for `AI_HELPER_TESTDATA_MUTATION_CONCURRENCY`: default 2, accepted range 1–4, invalid fallback to 2.
- [ ] Write failing tests proving a two-item window starts concurrently, results are consumed in original order, and no later window starts after budget exhaustion.
- [ ] Write a failing test proving a timed-out concurrent candidate is rerun alone and is counted as killed only if the isolated rerun also times out.
- [ ] Run `npx jest src/__tests__/services/testdataMutationRunner.test.ts --runInBand` and confirm RED.
- [ ] Replace the serial loop with ordered fixed-size windows. Use `Promise.all` only inside a window, check cancellation/budget before starting each window, and preserve candidate/operator accounting order.
- [ ] Represent an initial timeout as timeout-pending; rerun it alone, classify a second timeout as killed, and classify an accepted/infra rerun by the existing rules.
- [ ] Document the concurrency variable in both READMEs.
- [ ] Re-run the targeted test and commit the passing change.

### Task 3: Aggregate testdata stage P50/P95 from existing telemetry

**Files:**
- Modify: `cloudflare/telemetry-worker/worker.js`
- Modify: `cloudflare/telemetry-worker/testdataQuality.test.mjs`

- [ ] Add a failing Worker endpoint test with fixed duration buckets for multiple allowed stages; assert stage run counts and deterministic P50/P95 values, and assert unknown stages are excluded.
- [ ] Run `node --test cloudflare/telemetry-worker/testdataQuality.test.mjs` and confirm RED.
- [ ] Add one D1 aggregation query over existing `stage_completed.duration_ms` rows. Return only fixed bucket counts grouped by allowed stage; do not add a migration or raw duration fields.
- [ ] Convert the fixed buckets to conservative upper-bound P50/P95 milliseconds and return `stage_latency` in the quality response.
- [ ] Re-run the Worker tests and commit the passing change.

### Task 4: Show stage latency in the dashboard

**Files:**
- Modify: `cloudflare/telemetry-dashboard/src/types.ts`
- Modify: `cloudflare/telemetry-dashboard/src/testdataQualityView.ts`
- Modify: `cloudflare/telemetry-dashboard/src/panels/TestdataQualityPanel.tsx`
- Modify: `cloudflare/telemetry-dashboard/testdataQualityView.test.mjs`

- [ ] Write failing view-model tests for absent telemetry, stable stage ordering, and human-readable P50/P95 formatting.
- [ ] Run `node --test cloudflare/telemetry-dashboard/testdataQualityView.test.mjs` and confirm RED.
- [ ] Add the optional response type and a pure row builder that handles older Worker responses without errors.
- [ ] Add a compact stage-latency table to the existing quality panel; do not change unrelated dashboard layout.
- [ ] Run the dashboard test and dashboard TypeScript build, then commit the passing change.

### Task 5: Rebuild tracked output and run authoritative verification

**Files:**
- Modify: `dist/services/testdataGenService.js`
- Create: `dist/services/testdata/latency.js`
- Modify: `dist/services/testdata/mutationRunner.js`
- Modify any generated source maps/declarations produced by the existing build.

- [ ] Run `npm run build:plugin` and inspect the generated `dist/` diff for only the intended changes.
- [ ] Run `npm run lint` and fix every warning/error introduced by this work.
- [ ] Run targeted Worker and dashboard Node tests.
- [ ] Run `npm test -- --runInBand` and record suite/test counts and exit status.
- [ ] Inspect `git diff --check`, `git status --short`, and the full diff for privacy, fail-closed, cancellation, and deterministic-order regressions.
- [ ] Run a final fresh `npm run build:plugin`, `npm run lint`, and `npm test -- --runInBand` immediately before claiming completion.
- [ ] Commit generated output and final documentation, then report verified results and any remaining unverified production latency measurement separately.
