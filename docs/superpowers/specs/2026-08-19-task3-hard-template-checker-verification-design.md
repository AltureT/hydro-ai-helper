# Task 3 Hard Template and Checker Verification Design

## Goal

Make custom checkers and every user-selected template language mandatory verification gates for generated Hydro test-data packages. A plan may report `verified: true` only when the selected Python, C++, and/or Java templates have actually compiled where applicable, executed on every required input, and passed every adjudication, and when any configured custom checker has been read, compiled, and executed successfully.

This change is limited to reliability-plan Task 3. It does not add dedicated Task 4 telemetry, a dual-model `ProblemSpec`, mutation testing, reduced test coverage, or language skipping. Existing typed failures, retry policies, risk assessment, direct-fallback gating, and preserved generation configuration remain authoritative.

## Baseline and Preconditions

- The design is based on `origin/main` commit `e430768989c418351ac034b2a7b08c6a61d1f98d`, which includes PR #61 failure-contract work and PR #62 risk/direct-fallback gating.
- The isolated baseline passes 68 Jest suites and 1,456 tests, `npm run lint`, and `npm run build:plugin`.
- Current generation emits one sandbox solution and only executes the Python template. Java and C++ templates can therefore remain AI-only while the client still derives a green verification state.
- Current checker artifact loading is best-effort, checker infrastructure failures can be reduced to notes, and some custom-checker paths can fall back to textual equality. Those behaviors are incompatible with a hard verification gate.

## Approaches Considered

### 1. Add separate per-language checks inside the generation service

Keep the monolithic generation flow and add Java/C++ branches beside the existing Python branch. This minimizes new files but duplicates compilation, execution, adjudication, deadline, and cleanup logic. The branches would be likely to drift and make checker enforcement inconsistent.

### 2. Introduce a unified template verifier over a shared cached-artifact runner (selected)

Add a small verification service that owns language assembly and adjudication while extending `TestdataSandboxRunner` with Java compilation and cached Java execution. C++ and Java share internal cached-artifact lifecycle behavior; Python remains interpreted through the existing batch runner. This creates one fail-closed policy for every selected language and one checker adjudication path without replacing the existing typed-failure or risk layers.

### 3. Generate temporary Hydro problem packages and invoke the full import pipeline

Verify by importing each plan into a disposable Hydro instance and running submissions through the complete judge pipeline. This is closest to production, but it couples generation to persistent Hydro state and is too expensive and operationally fragile for every request. It remains useful as a manual smoke test, not the online verification architecture.

## Selected Design

### Multi-language solution contract

The generated blueprint gains language-qualified solution sections:

- `@@@SOLUTION:py@@@`
- `@@@SOLUTION:java@@@`
- `@@@SOLUTION:cc@@@`

Every newly generated response must contain a solution for every selected template language. The legacy `@@@SOLUTION@@@` section remains a compatibility alias for Python when resuming an old checkpoint, but it does not satisfy Java or C++ selection. Missing selected-language solutions produce a typed format or template failure and enter the existing artifact-repair workflow for the affected language; the service does not silently drop the language.

This is an execution blueprint only. It does not introduce or infer a `ProblemSpec`.

### TestdataSandboxRunner extension

`TestdataSandboxRunner` adds Java compilation and cached Java artifact execution. The go-judge Java build uses `Main.java` and `Solution.java`, compiles classes with UTF-8 encoding, and packages them as `Main.jar`; execution uses the returned cached artifact with `java -cp Main.jar Main`.

C++ and Java compilation use one internal cached-artifact lifecycle helper so that both languages consistently provide:

- absolute deadline and caller cancellation handling;
- `compile`, `infra`, and `budget` failure classification without converting budget exhaustion into wrong answer;
- deletion of returned cache IDs after malformed or late responses;
- deletion in `finally` after execution, including runtime, checker, cancellation, and verifier failures.

The public C++ result contract remains compatible. Java exposes the equivalent typed compile result and detailed cached batch execution needed by the verifier. Existing Python execution semantics remain intact.

### Unified template verifier

A new `templateVerifier` receives selected languages, per-language solutions/templates, the statement samples, every generated formal test point, the oracle outputs or custom-checker executor, the sandbox runner, signal, and absolute deadline.

It assembles the exact Hydro compilation layout:

- Python: solution followed by `template.py` in one executable source;
- C++: solution as `foo.cc`, with `template.cc` including it;
- Java: solution as `Solution.java`, with template content written as public `Main.java`.

For every selected language it executes all statement samples and all generated formal points. The verifier never reduces or subsamples the generation service's deterministic test plan; consequently every available small, medium, and large formal point is included. A timeout is a failed execution/budget result, not a skipped point.

Each selected language produces `verification.templateChecks.<lang>` with at least:

- `compiled`: whether the required compile step completed (`true` for successfully prepared Python source);
- `executed`: whether all required cases received an execution/adjudication result;
- `total` and `passed`;
- a bounded failure classification suitable for UI display and typed failure mapping.

A language passes only when `compiled === true`, `executed === true`, and `passed === total`. A missing result cannot be interpreted as success.

### Output adjudication

Ordinary single-answer problems compare template output against the existing oracle through the current normalized output policy. If a custom checker is configured, every sample, formal point, stress comparison, and discrimination comparison is adjudicated through that checker. Custom-checker problems never fall back to plain-text equality, including brute/oracle fallback paths.

Checker outcomes are tri-state:

- `accept`: counts as a passed case;
- `reject`: a semantic mismatch and maps to the relevant template/checker rejection failure;
- `infra-error`: checker protocol, execution, deadline, cancellation, or infrastructure failure. It does not count as WA and maps to a checker runtime typed failure.

### Checker artifact and execution state

Checker loading becomes explicit rather than best-effort. The handler reports whether the Hydro configuration named a checker, whether its source path resolved, whether the checker and required headers were read, and any bounded read failure. Source text, test input, and expected output remain excluded from safe failure details.

The verification result records checker state with at least:

- `configured`, `read`, `compiled`, and `executed`;
- `total`, `passed`, and `infraFailures`;
- `failureKind`: `unavailable`, `compile`, `infra`, `budget`, or `reject` when applicable.

In `enforce` reliability mode:

- missing/unreadable configured checker artifacts map to `CHECKER_REQUIRED_UNAVAILABLE`;
- checker compile failure maps to `CHECKER_COMPILE_FAILED`;
- checker infrastructure, timeout, cancellation, or budget failure maps to `CHECKER_RUNTIME_FAILED`;
- generation fails through the existing typed-failure and retry-policy path. A warning cannot preserve `verified: true`.

In `observe` mode, the service may return the generated plan, but it sets `verification.verified = false` and `verification.wouldBlock = true` whenever enforce mode would reject it. Unadjudicated cases do not count as passed. This also applies to direct generation: a custom-checker plan that did not actually read, compile, and execute the checker cannot be verified.

### Server-owned verification decision

The service, not the frontend, computes the authoritative `verification.verified`. It preserves every existing all-green prerequisite for sandbox execution, sample/stress or legacy brute coverage, discrimination, and current risk/fallback policy, then adds the Task 3 gates:

1. every selected language has a present template check with `compiled`, `executed`, and `passed === total`;
2. a configured custom checker was read and compiled and executed for every required adjudication, with no infrastructure failures;
3. no critical planned artifact has origin `ai-only`.

Critical artifacts include the generated case inputs/outputs and any selected template, standard/oracle solution, generator, brute solution, validator, or checker required by the chosen plan. Deterministic structural artifacts such as compile scripts and configuration remain governed by their existing origins. Old persisted jobs without the new evidence fields render as unverified; the client never upgrades them heuristically.

`verification.wouldBlock` is separate from the existing risk-assessment `wouldBlock`. The former explains Task 3 verification enforcement; the latter continues to describe Task 2 direct-fallback risk gating.

### Frontend presentation

The result panel consumes the server-owned `verified` and `wouldBlock` values. It displays one row per selected Python/Java/C++ template with compile, execute, and passed/total state, plus checker read/compile/execute status and a bounded failure reason. Observe-mode output clearly states that enforce mode would block it. Legacy or incomplete data is shown as unverified rather than treated as green.

English and Chinese locale catalogs and generated locale fallbacks are updated together.

## Error Handling and Data Safety

- The existing `TestdataGenerationFailure` registry remains the only hard-failure transport. Task 3 reuses `TEMPLATE_COMPILE_FAILED`, `TEMPLATE_RUNTIME_FAILED`, `TEMPLATE_OUTPUT_MISMATCH`, `CHECKER_REQUIRED_UNAVAILABLE`, `CHECKER_COMPILE_FAILED`, and `CHECKER_RUNTIME_FAILED`.
- Existing retry-policy decisions remain unchanged unless a test demonstrates that the already-declared artifact identity is not specific enough for the affected language. Any detail extension remains allowlisted and bounded.
- Checker infrastructure and sandbox budget failures never become wrong answers.
- Cancellation propagates promptly and still performs cache cleanup.
- Checkpoint content hashing, risk assessment, direct-fallback confirmation, and user-supplied configuration preservation remain in force.
- Generated source, checker source, stdin, expected output, credentials, and storage paths are not emitted in safe failure details or logs.

## TDD Strategy

Implementation proceeds in independently observed red-green slices:

1. **Runner contract:** failing tests for the exact Java compile payload, returned `Main.jar` cache ID, cached execution command, compile/infra/budget classification, caller cancellation, late/malformed responses, and cleanup; then the smallest runner changes.
2. **Blueprint parsing:** failing tests for required per-language solution sections, Python-only legacy compatibility, selected-language omissions, checkpoint compatibility, and language-specific repair; then parser and prompt changes.
3. **Unified verifier:** failing tests for Python/C++/Java success, compilation failure, runtime failure, timeout, mismatch, all samples/formal scales, cleanup, and checker accept/reject/infra behavior; then the verifier.
4. **Service integration:** failing tests for `templateChecks`, server-owned verification, critical `ai-only` rejection, enforce and observe checker behavior, direct custom-checker output, and preservation of typed failure/risk/config contracts; then service and handler integration.
5. **Frontend rendering:** failing real-render tests for per-language rows, checker failure state, `wouldBlock`, verified success, and legacy fail-closed rendering; then panel and locale changes.

Tests assert observable behavior and public contracts rather than helper call counts or source-text patterns. Time and cancellation tests use controlled promises/signals instead of wall-clock sleeps.

## Planned File Scope

Expected source changes are limited to:

- `src/services/goJudgeSandboxService.ts` and its existing tests;
- `src/services/testdataGenService.ts`, its existing service/guarantee tests, and failure artifacts only if language specificity is required;
- a new `src/services/testdata/templateVerifier.ts` and focused test;
- `src/handlers/testdataGenHandler.ts` and its existing tests;
- `frontend/testdataGen/TestdataGenPanel.tsx`, with a small extracted verification view only if needed for real rendering tests;
- English/Chinese locales and their generated fallback;
- tracked `dist/` produced by the normal build;
- this specification, the implementation plan, and the final manual-smoke report.

No Task 4 telemetry, `ProblemSpec`, mutation framework, or unrelated refactor belongs in this branch.

## Verification and Manual Smoke

Before completion the branch must pass, in this order after locale generation:

1. focused Jest tests for each TDD slice;
2. `npm test -- --runInBand` for the full 68-suite baseline plus new tests;
3. `npm run lint` with zero warnings or errors;
4. `npm run build:plugin` with tracked `dist/` synchronized;
5. `git diff --check`;
6. an independent diff review, followed by another full Jest/lint/build run after any fixes.

A real Hydro go-judge smoke uses the configured/local go-judge endpoint through the built `GoJudgeSandboxRunner`, not a mocked HTTP client. It records:

- Python solution plus `template.py` execution;
- C++ `template.cc` plus `foo.cc` compilation and cached artifact execution;
- Java `Main.java` plus `Solution.java` compilation and cached `Main.jar` execution;
- statement-style sample and small/medium/large inputs with expected output comparison;
- deadlines, response classifications, and successful cached-file cleanup.

The dated report records exact commands, endpoint class (without secrets), exit statuses, case counts, and any environmental limitation. An unavailable real go-judge is reported as unverified evidence, never as a pass.

## Success Criteria

- Every selected language has real compile/prepare and execution evidence for every required case.
- `verification.templateChecks.py`, `.java`, and/or `.cc` accurately reflect the selected languages and cannot be synthesized from requested language names alone.
- `verification.verified` is true only when all existing gates and all new language/checker/critical-origin gates pass.
- Enforce mode hard-fails unreadable, uncompilable, or unexecutable configured checkers through typed failures.
- Observe mode exposes output but is visibly unverified with `wouldBlock`.
- Checker infrastructure is never reported as WA, and custom-checker problems never use text equality as a fallback.
- No critical `ai-only` artifact can coexist with `verified: true`.
- Full Jest, lint, build, independent review, and real Python/C++/Java go-judge smoke evidence are recorded without starting Task 4 or adjacent reliability work.
