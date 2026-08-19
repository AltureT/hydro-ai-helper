# Task 3 Hard Template and Checker Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Make every selected Python, Java, and C++ template plus any configured custom checker a fail-closed, server-owned verification gate.

**Architecture:** Extend the go-judge adapter with a shared cached-compilation lifecycle and Java-specific commands, then add a focused template verifier whose only external policy dependency is a narrow adjudicator interface. Keep typed failure mapping, reliability-mode behavior, risk gating, plan assembly, and checkpoint preservation in the existing service/handler layers, and make the frontend render the server-owned result without recomputing it.

**Tech Stack:** TypeScript, Jest/ts-jest, React 17 server rendering, Axios, HydroOJ go-judge HTTP protocol, YAML locale generation.

**Spec:** docs/superpowers/specs/2026-08-19-task3-hard-template-checker-verification-design.md

## Global Constraints

- Work from origin/main commit e430768989c418351ac034b2a7b08c6a61d1f98d on codex/task3-hard-template-checker-verification.
- Execute strict RED-GREEN-REFACTOR: each behavior test must fail for the intended reason before production code is changed.
- Do not add Task 4 dedicated telemetry, dual-model ProblemSpec, or mutation testing.
- Do not reduce generated/sample/formal test points and do not omit a selected language.
- Preserve TestdataPipelineError, retry policies, risk assessment, direct-fallback confirmation, checkpoint identity, and complete existing config fields.
- Never convert sandbox/checker infrastructure, timeout, cancellation, or budget failures into wrong answers.
- Never use plain-text equality when a custom checker is configured.
- Run npm run build:plugin and npm run lint before every code commit; include tracked dist output.
- Do not stage the temporary node_modules symlink.

---

## File Responsibility Map

- src/services/goJudgeSandboxService.ts: go-judge protocol, deadline/cancellation, cached artifact lifecycle, and language/checker commands.
- src/services/testdata/templateVerifier.ts: py/java/cc assembly, all-case execution, adjudication, result records, and verifier-local classified errors.
- src/services/testdataGenService.ts: AI section contract, repairs, checker policy, typed failures, materialization, origins, and authoritative verified state.
- src/handlers/testdataGenHandler.ts: explicit checker configuration/path/storage read state and synchronous/background propagation.
- src/models/testdataGenerationJob.ts: checkpoint identity includes checker state and per-language solutions.
- frontend/testdataGen/VerificationSummaryView.tsx: testable rendering of server-owned evidence.
- frontend/testdataGen/TestdataGenPanel.tsx: integrates the summary and removes client-side green-state inference.
- locales/en.yaml, locales/zh.yaml, frontend/generated/localeFallback.ts: matching hard-gate copy.
- docs/reports/2026-08-19-task3-go-judge-smoke.md: real Python/C++/Java evidence.

---

### Task 1: Java Cached Artifact Support

**Files:**
- Modify: src/services/goJudgeSandboxService.ts:34-72,204-278,358-534
- Test: src/__tests__/services/goJudgeSandboxService.test.ts:268-486
- Generated: dist/services/goJudgeSandboxService.js, declarations, and source maps

**Interfaces:**
- Consumes: PythonBatchOptions, CppCompileOptions, CppCompileResult, SandboxBudgetExceededError, runBatchDetailed().
- Produces:

~~~ts
export interface JavaCompileOptions {
  signal?: AbortSignal;
  deadlineAt?: number;
}

export type JavaCompileResult =
  | { ok: true; fileId: string }
  | { ok: false; kind: 'compile' | 'infra'; error: string };

export interface TestdataSandboxRunner {
  compileJava?(
    mainSource: string,
    solutionSource: string,
    opts?: JavaCompileOptions,
  ): Promise<JavaCompileResult>;
  runJavaBatchDetailed?(
    fileId: string,
    inputs: string[],
    opts?: PythonBatchOptions,
  ): Promise<PythonRunDetail[]>;
}
~~~

Budget is the third classification and remains SandboxBudgetExceededError with code SANDBOX_BUDGET_EXHAUSTED; callers must not flatten it into infra.

- [ ] **Step 1: Add failing Java protocol tests**

~~~ts
it('compileJava builds Main.jar from Main.java and Solution.java', async () => {
  const runner = new GoJudgeSandboxRunner('http://localhost:5050', http);
  await expect(runner.compileJava('public class Main {}', 'class Solution {}'))
    .resolves.toEqual({ ok: true, fileId: 'cached-main-1' });
  expect(http.post).toHaveBeenCalledWith(
    'http://localhost:5050/run',
    { cmd: [expect.objectContaining({
      args: [
        '/usr/bin/bash', '-c',
        'javac -d /w -encoding utf8 ./Main.java ./Solution.java && jar cvf Main.jar *.class >/dev/null',
      ],
      copyIn: {
        'Main.java': { content: 'public class Main {}' },
        'Solution.java': { content: 'class Solution {}' },
      },
      copyOutCached: ['Main.jar'],
    })] },
    expect.objectContaining({ proxy: false }),
  );
});

it('runJavaBatchDetailed executes a cached Main.jar', async () => {
  await runner.runJavaBatchDetailed('cached-main-1', ['2 3\n']);
  expect(http.post.mock.calls[0][1].cmd[0]).toEqual(expect.objectContaining({
    args: ['/usr/bin/java', '-cp', 'Main.jar', 'Main'],
    copyIn: { 'Main.jar': { fileId: 'cached-main-1' } },
  }));
});
~~~

- [ ] **Step 2: Run tests and observe RED**

Run: npx jest src/__tests__/services/goJudgeSandboxService.test.ts --runInBand -t 'compileJava|runJavaBatchDetailed'

Expected: FAIL because both Java methods are absent.

- [ ] **Step 3: Add failing classification and lifecycle tests**

Assert javac nonzero exit returns kind compile; HTTP/protocol failure returns kind infra; an expired/late deadline throws SANDBOX_BUDGET_EXHAUSTED; caller cancellation rethrows the identical abort error; late and malformed responses delete every returned cache ID; cached Java batch uses existing chunk/deadline semantics.

~~~ts
await expect(runner.compileJava(main, solution, { deadlineAt: Date.now() - 1 }))
  .rejects.toMatchObject({ code: 'SANDBOX_BUDGET_EXHAUSTED' });
expect(http.delete).toHaveBeenCalledWith(
  'http://localhost:5050/file/late-main',
  expect.anything(),
);
~~~

- [ ] **Step 4: Run the edge tests and observe RED**

Run: npx jest src/__tests__/services/goJudgeSandboxService.test.ts --runInBand -t 'Java'

Expected: FAIL only on unimplemented Java behavior.

- [ ] **Step 5: Implement one cached compiler lifecycle**

Add private compileCachedArtifact(command, cachedName, opts), retaining the current C++ result contract and cleanup/cancellation/deadline behavior. Route compileCpp through it. Add buildJavaCompileCommand, buildJavaCommand, compileJava, and runJavaBatchDetailed. Reuse current compile CPU/clock/memory/proc/HTTP limits.

~~~ts
async compileJava(
  mainSource: string,
  solutionSource: string,
  opts: JavaCompileOptions = {},
): Promise<JavaCompileResult> {
  return this.compileCachedArtifact(
    buildJavaCompileCommand(mainSource, solutionSource),
    'Main.jar',
    opts,
  );
}
~~~

- [ ] **Step 6: Verify runner behavior**

Run: npx jest src/__tests__/services/goJudgeSandboxService.test.ts --runInBand

Expected: PASS including unchanged Python/C++/checker tests.

- [ ] **Step 7: Build, lint, and commit**

Run:

~~~bash
npm run build:plugin
npm run lint
git diff --check
~~~

Expected: all exit 0.

Commit:

~~~bash
git add src/services/goJudgeSandboxService.ts src/__tests__/services/goJudgeSandboxService.test.ts dist/services/goJudgeSandboxService.*
git commit -m "feat: add cached Java sandbox execution"
~~~

---

### Task 2: Per-language Solution Blueprint and Repair Contract

**Files:**
- Modify: src/services/testdataGenService.ts:154-232,1230-1685,2188-2370,5147-5520,5560-5620
- Modify: src/models/testdataGenerationJob.ts:36-163
- Test: src/__tests__/services/testdataGenService.test.ts
- Test: src/__tests__/services/testdataCurrentGuarantees.test.ts
- Test: src/__tests__/models/testdataGenerationJob.test.ts
- Generated: matching dist/services and dist/models output

**Interfaces:**
- Produces:

~~~ts
export type TemplateSolutions = Partial<Record<TemplateLang, string>>;

export interface SandboxSolutionBlueprint {
  solutions?: TemplateSolutions;
  solutionCode?: string; // compatibility alias for solutions.py
}

export interface SandboxGenerationBlueprint {
  solutions?: TemplateSolutions;
  solutionCode?: string;
}

export interface GenerationResponse {
  solutions?: TemplateSolutions;
  solutionCode?: string;
}
~~~

- [ ] **Step 1: Add failing qualified-section tests**

~~~ts
const blueprint = parseSolutionBlueprint([
  '@@@META@@@', 'problemType: function',
  '@@@ORACLE@@@', 'print(3)',
  '@@@SOLUTION:py@@@', 'def add(a, b): return a + b',
  '@@@SOLUTION:java@@@', 'class Solution { int add(int a,int b){ return a+b; } }',
  '@@@SOLUTION:cc@@@', 'int add(int a,int b){ return a+b; }',
].join('\n'), {
  problemKind: 'function', caseCount: 3, languages: ['py', 'java', 'cc'],
});
expect(blueprint.solutions).toEqual(expect.objectContaining({
  py: expect.any(String), java: expect.any(String), cc: expect.any(String),
}));
expect(blueprint.solutionCode).toBe(blueprint.solutions?.py);
~~~

Also prove legacy @@@SOLUTION@@@ satisfies Python only and selected Java/C++ omissions throw with the missing language name.

- [ ] **Step 2: Run parser tests and observe RED**

Run: npx jest src/__tests__/services/testdataGenService.test.ts --runInBand -t 'qualified solution|selected solution'

Expected: FAIL because only solutionCode exists.

- [ ] **Step 3: Implement one section parser and update copies**

~~~ts
function parseTemplateSolutions(sections: ParsedSection[]): TemplateSolutions {
  const solutions: TemplateSolutions = {};
  for (const section of sections) {
    const [rawKind, rawLanguage] = section.header.split(':');
    if (rawKind.trim().toUpperCase() !== 'SOLUTION') continue;
    const content = normalizeExecutableContent(trimBlankEdges(section.content));
    const language = rawLanguage?.trim().toLowerCase() as TemplateLang | undefined;
    if (!language && !solutions.py) solutions.py = content;
    else if (language && SUPPORTED_TEMPLATE_LANGS.includes(language)) solutions[language] = content;
  }
  return solutions;
}
~~~

Use it in parseSolutionBlueprint and parseSandboxBlueprint. Reject missing selected-language solutions for new function responses. Copy solutions through checkpoint conversion, artifact merge, final response, and semantic fallback. Preserve solutionCode = solutions.py for old checkpoints/current std.py behavior.

- [ ] **Step 4: Add failing prompt and repair tests**

Assert selected prompts contain @@@SOLUTION:py@@@, @@@SOLUTION:java@@@, and @@@SOLUTION:cc@@@. Extend SandboxRepairScope with template-java and template-cc. Prove Java repair requests exactly SOLUTION:java plus TEMPLATE:java and preserves Python/C++ byte-for-byte; repeat for C++.

- [ ] **Step 5: Run repair tests and observe RED**

Run: npx jest src/__tests__/services/testdataGenService.test.ts --runInBand -t 'solution marker|template-java|template-cc|repair scope'

Expected: FAIL because repair routing is Python-only.

- [ ] **Step 6: Update prompts, routing, and checkpoints**

~~~ts
export type SandboxRepairScope =
  | 'generator' | 'stress-generator' | 'function-samples' | 'accepted-std'
  | 'validator' | 'oracle' | 'brute'
  | 'template-py' | 'template-java' | 'template-cc' | 'full';
~~~

Map each language with artifactForTemplateLanguage(). Ensure solutions are serialized in checkpoint payloads and do not weaken existing option/config/checker hash identity.

- [ ] **Step 7: Verify contracts and preservation**

Run:

~~~bash
npx jest src/__tests__/services/testdataGenService.test.ts src/__tests__/services/testdataCurrentGuarantees.test.ts src/__tests__/models/testdataGenerationJob.test.ts --runInBand
npm run build:plugin
npm run lint
git diff --check
~~~

Expected: all exit 0; config preservation and checkpoint invalidation remain green.

- [ ] **Step 8: Commit**

~~~bash
git add src/services/testdataGenService.ts src/models/testdataGenerationJob.ts src/__tests__/services/testdataGenService.test.ts src/__tests__/services/testdataCurrentGuarantees.test.ts src/__tests__/models/testdataGenerationJob.test.ts dist/services/testdataGenService.* dist/models/testdataGenerationJob.*
git commit -m "feat: require selected-language solution blueprints"
~~~

---

### Task 3: Unified Python, C++, and Java Template Verifier

**Files:**
- Create: src/services/testdata/templateVerifier.ts
- Create: src/__tests__/services/testdataTemplateVerifier.test.ts
- Generated: dist/services/testdata/templateVerifier.js, declarations, and source maps

**Interfaces:**

~~~ts
export type TemplateVerificationLanguage = 'py' | 'java' | 'cc';
export type TemplateVerificationFailureKind =
  | 'compile' | 'runtime' | 'budget' | 'mismatch' | 'checker-infra';

export interface TemplateVerificationCheck {
  compiled: boolean;
  executed: boolean;
  total: number;
  passed: number;
  failureKind?: TemplateVerificationFailureKind;
}

export type TemplateChecks =
  Partial<Record<TemplateVerificationLanguage, TemplateVerificationCheck>>;
export type TemplateAdjudicationVerdict = 'accept' | 'reject' | 'infra-error';

export interface TemplateOutputAdjudicator {
  readonly customChecker: boolean;
  adjudicate(cases: Array<{ input: string; output: string; answer: string }>):
    Promise<TemplateAdjudicationVerdict[]>;
}

export class TemplateVerificationError extends Error {
  constructor(
    readonly language: TemplateVerificationLanguage,
    readonly kind: TemplateVerificationFailureKind,
    readonly check: TemplateVerificationCheck,
    readonly caseIndex?: number,
  );
}

export async function verifySelectedTemplates(input: {
  languages: TemplateVerificationLanguage[];
  solutions: Partial<Record<TemplateVerificationLanguage, string>>;
  templates: Partial<Record<TemplateVerificationLanguage, string>>;
  cases: Array<{ input: string; answer: string }>;
  runner: TestdataSandboxRunner;
  adjudicator: TemplateOutputAdjudicator;
  signal?: AbortSignal;
  deadlineAt?: number;
  allowCheckerInfraResult: boolean;
}): Promise<TemplateChecks>;
~~~

- [ ] **Step 1: Write RED success tests for exact layouts**

Use four inputs identified as sample/small/medium/large. Assert Python receives solution + newline + template, C++ compilation receives template with extraFiles foo.cc, Java receives template as Main.java and solution as Solution.java, cached runners receive all four inputs, and both cache IDs are deleted.

~~~ts
expect(checks).toEqual({
  py: { compiled: true, executed: true, total: 4, passed: 4 },
  java: { compiled: true, executed: true, total: 4, passed: 4 },
  cc: { compiled: true, executed: true, total: 4, passed: 4 },
});
~~~

- [ ] **Step 2: Run the suite and observe RED**

Run: npx jest src/__tests__/services/testdataTemplateVerifier.test.ts --runInBand

Expected: FAIL because the module is absent.

- [ ] **Step 3: Implement preparation and all-case execution**

Use runPythonBatchDetailed, compileCpp plus runCompiledBatchDetailed, and compileJava plus runJavaBatchDetailed. Set executed true only after the exact expected result count exists. Wrap each cache ID in finally and call deleteCachedFile.

- [ ] **Step 4: Add RED failure/adjudication tests**

Prove C++/Java compiler nonzero => compile; missing compile/run capability => compile rather than skip; runtime non-Accepted/count mismatch => runtime; SandboxBudgetExceededError => budget; cancellation identity survives cleanup; plain mismatch => mismatch; custom checker reject => mismatch; custom checker infra => checker-infra and never mismatch. With allowCheckerInfraResult true, return failed evidence instead of throwing.

- [ ] **Step 5: Run failure tests and observe RED**

Run: npx jest src/__tests__/services/testdataTemplateVerifier.test.ts --runInBand -t 'compile|runtime|budget|checker|cleanup|cancellation'

Expected: FAIL until classifications and adjudication exist.

- [ ] **Step 6: Implement one adjudication path**

For ordinary problems compare normalized file content. For custom checker pass every executed output/input/answer to adjudicate and never call text comparison. Validate verdict count. Count accept as passed, reject as semantic mismatch, and missing/infra verdict as checker infrastructure.

- [ ] **Step 7: Verify and commit**

Run:

~~~bash
npx jest src/__tests__/services/testdataTemplateVerifier.test.ts --runInBand
npm run build:plugin
npm run lint
git diff --check
~~~

Expected: all exit 0.

Commit:

~~~bash
git add src/services/testdata/templateVerifier.ts src/__tests__/services/testdataTemplateVerifier.test.ts dist/services/testdata/templateVerifier.*
git commit -m "feat: verify every selected template language"
~~~

---

### Task 4: Explicit Checker State and Enforce/Observe Contract

**Files:**
- Modify: src/handlers/testdataGenHandler.ts:79-151,610-660,870-900,1070-1092
- Modify: src/services/testdataGenService.ts:2617-2775,5520-5600,5650-5840,6500-6565
- Modify: src/models/testdataGenerationJob.ts:55-163
- Test: src/__tests__/handlers/testdataGenHandler.test.ts:169-211,395-480
- Test: src/__tests__/services/testdataGenService.test.ts
- Test: src/__tests__/services/testdataCurrentGuarantees.test.ts
- Test: src/__tests__/models/testdataGenerationJob.test.ts
- Generated: matching dist output

**Interfaces:**

~~~ts
export type CheckerArtifactFailureKind = 'invalid-path' | 'missing' | 'read';

export interface TestlibCheckerArtifacts {
  configured: boolean;
  read: boolean;
  failureKind?: CheckerArtifactFailureKind;
  checkerSource?: string;
  checkerHeaders?: Record<string, string>;
}

export interface GenerateTestdataParams {
  checkerArtifacts?: TestlibCheckerArtifacts;
}

export interface TestdataCheckpointContext {
  checkerArtifacts?: Pick<
    TestlibCheckerArtifacts,
    'configured' | 'read' | 'failureKind' | 'checkerSource' | 'checkerHeaders'
  >;
}

export interface CheckerVerificationCheck {
  configured: boolean;
  read: boolean;
  compiled: boolean;
  executed: boolean;
  total: number;
  passed: number;
  infraFailures: number;
  failureKind?: 'unavailable' | 'compile' | 'infra' | 'budget' | 'reject';
}
~~~

- [ ] **Step 1: Write RED loader tests**

Assert no checker => { configured:false, read:false }; missing file => configured true/read false/failureKind missing; storage failure => failureKind read; traversal path => invalid-path without storage call; success => configured/read true plus source/headers.

- [ ] **Step 2: Run handler tests and observe RED**

Run: npx jest src/__tests__/handlers/testdataGenHandler.test.ts --runInBand -t 'loadTestlibCheckerArtifacts|checker source'

Expected: FAIL because unavailable states return undefined.

- [ ] **Step 3: Implement explicit loading and checkpoint identity**

Return a state on every path. Pass the full state into synchronous/background service calls. Extend TestdataCheckpointContext hashing with configured/read/failureKind plus current source/header hashes so state changes invalidate old checkpoints.

- [ ] **Step 4: Add RED enforce/observe tests**

~~~ts
await expect(enforceService.generate(paramsWithUnreadableChecker))
  .rejects.toMatchObject({
    code: 'CHECKER_REQUIRED_UNAVAILABLE',
    artifact: 'checker',
    retryPolicy: 'manual-review',
  });
await expect(enforceService.generate(paramsWithCompileFailure))
  .rejects.toMatchObject({ code: 'CHECKER_COMPILE_FAILED', artifact: 'checker' });
expect(observePlan.verification).toMatchObject({
  verified: false,
  wouldBlock: true,
});
~~~

Add checker TLE/budget/malformed/transport tests mapping to CHECKER_RUNTIME_FAILED in enforce. Add reject proof that semantic rejection is not infrastructure.

- [ ] **Step 5: Run checker tests and observe RED**

Run: npx jest src/__tests__/services/testdataGenService.test.ts src/__tests__/services/testdataCurrentGuarantees.test.ts --runInBand -t 'checker|infrastructure|observe|enforce'

Expected: FAIL because current checker behavior is best-effort and can skip comparisons.

- [ ] **Step 6: Implement hard mapping and no-text custom checker policy**

Refactor CheckerExecutor to expose CheckerVerificationCheck while preserving tri-state verdicts. In enforce, map unreadable to CHECKER_REQUIRED_UNAVAILABLE, compile failure to CHECKER_COMPILE_FAILED, runtime infra/budget to CHECKER_RUNTIME_FAILED with bounded failureKind. In observe, retain failed evidence, verified false, wouldBlock true, and zero credit for unadjudicated cases. A direct custom-checker plan must copy configured/read evidence but set compiled=false and executed=false, so confirmed Task 2 fallback can be delivered only as unverified/wouldBlock output. Remove custom-checker text comparisons/skips in sample, brute/stress, template, discrimination, and fallback paths. Expected rejection of a deliberately wrong discrimination target remains successful checker execution. Pass reliabilityMode into semantic fallback service construction.

- [ ] **Step 7: Verify preserved contracts**

Run:

~~~bash
npx jest src/__tests__/handlers/testdataGenHandler.test.ts src/__tests__/services/testdataGenService.test.ts src/__tests__/services/testdataCurrentGuarantees.test.ts src/__tests__/services/testdataFailures.test.ts src/__tests__/models/testdataGenerationJob.test.ts --runInBand
npm run build:plugin
npm run lint
git diff --check
~~~

Expected: all exit 0; CHECKER failures retain manual-review; risk/direct confirmation/config/checkpoint tests remain green.

- [ ] **Step 8: Commit**

~~~bash
git add src/handlers/testdataGenHandler.ts src/services/testdataGenService.ts src/models/testdataGenerationJob.ts src/__tests__/handlers/testdataGenHandler.test.ts src/__tests__/services/testdataGenService.test.ts src/__tests__/services/testdataCurrentGuarantees.test.ts src/__tests__/services/testdataFailures.test.ts src/__tests__/models/testdataGenerationJob.test.ts dist/handlers/testdataGenHandler.* dist/services/testdataGenService.* dist/models/testdataGenerationJob.*
git commit -m "feat: enforce custom checker verification"
~~~

---

### Task 5: Integrate Verifier and Authoritative Hard Gate

**Files:**
- Modify: src/services/testdataGenService.ts:297-326,3710-4335,4585-4675,4764-4970,5948-6108,7050-7090
- Modify: src/__tests__/services/testdataGenService.test.ts:4723-5745
- Modify: src/__tests__/services/testdataCurrentGuarantees.test.ts
- Test: src/__tests__/services/testdataTemplateVerifier.test.ts
- Generated: matching dist/services output

**Interfaces:**

~~~ts
export interface PlanVerification {
  mode: 'sandbox' | 'direct';
  oracleKind: 'provided-std' | 'accepted-record' | 'ai-solution';
  verified: boolean;
  wouldBlock: boolean;
  templateChecks?: TemplateChecks;
  checkerCheck?: CheckerVerificationCheck;
  // existing sample/brute/stress/validator/discrimination fields remain
}

export function finalizePlanVerification(
  plan: GenerationPlan,
  selectedLanguages: TemplateLang[],
  customChecker: boolean,
  reliabilityMode: TestdataReliabilityMode,
): GenerationPlan;
~~~

- [ ] **Step 1: Write RED materialization tests**

Use two statement samples plus three formal small/medium/large cases and all three selected languages. Assert each check total is 5 and passed is 5. Prove any language compile/runtime/mismatch/budget maps to existing TEMPLATE or PIPELINE_BUDGET_EXHAUSTED typed failures with its language artifact. Prove TLE is not skipped and total is never reduced.

- [ ] **Step 2: Run tests and observe RED**

Run: npx jest src/__tests__/services/testdataGenService.test.ts --runInBand -t 'selected languages|templateChecks|template budget'

Expected: FAIL because materialization is Python-only.

- [ ] **Step 3: Replace Python-only phase**

Pass all formal inputs and all statement sample inputs with oracle answers to verifySelectedTemplates. Cache templateChecks as one resume unit. Remove pyTemplateExecuted, templateCheck, and skippedTimeout. Map TemplateVerificationError with existing codes and safe details caseIndex/failureKind.

- [ ] **Step 4: Write RED hard-gate and origin table tests**

Prove:
- existing sample/stress-or-legacy-brute/discrimination green plus all selected language checks green => verified true;
- absent/compile false/execute false/passed less than total => false;
- custom checker not read/compiled/executed or with infra => false and observe wouldBlock true;
- ai-only case-in/case-out/selected template/std/generator/brute/validator => false;
- direct and legacy missing evidence => false;
- risk.wouldBlock remains separate and unchanged.

- [ ] **Step 5: Run gate tests and observe RED**

Run: npx jest src/__tests__/services/testdataGenService.test.ts src/__tests__/services/testdataCurrentGuarantees.test.ts --runInBand -t 'verified|ai-only|hard gate|legacy'

Expected: FAIL because frontend currently derives the green state.

- [ ] **Step 6: Implement server finalization and origins**

~~~ts
const check = response.verification?.templateChecks?.[lang];
const origin: PlannedFileOrigin = sandbox
  && check?.compiled === true
  && check.executed === true
  && check.passed === check.total
  ? 'executed'
  : 'ai-only';
~~~

Call finalizePlanVerification after direct/sandbox plans have verification and files. Preserve stress-first/legacy-brute and discrimination rules. Require a present sample check to be fully passed when samples exist. Do not overwrite plan.risk.wouldBlock.

- [ ] **Step 7: Verify focused integration**

Run:

~~~bash
npx jest src/__tests__/services/testdataTemplateVerifier.test.ts src/__tests__/services/testdataGenService.test.ts src/__tests__/services/testdataCurrentGuarantees.test.ts --runInBand
npm run build:plugin
npm run lint
git diff --check
~~~

Expected: all exit 0 with no skipped language or reduced point count.

- [ ] **Step 8: Commit**

~~~bash
git add src/services/testdataGenService.ts src/__tests__/services/testdataGenService.test.ts src/__tests__/services/testdataCurrentGuarantees.test.ts src/__tests__/services/testdataTemplateVerifier.test.ts dist/services/testdataGenService.* dist/services/testdata/templateVerifier.*
git commit -m "feat: make template evidence a hard verification gate"
~~~

---

### Task 6: Render Server-owned Evidence

**Files:**
- Create: frontend/testdataGen/VerificationSummaryView.tsx
- Create: src/__tests__/frontend/testdataVerificationSummaryView.test.ts
- Modify: frontend/testdataGen/TestdataGenPanel.tsx:40-84,1185-1230,1320-1405
- Modify: locales/en.yaml:1198-1217
- Modify: locales/zh.yaml:1198-1217
- Generate: frontend/generated/localeFallback.ts

**Interfaces:**

~~~tsx
export interface VerificationSummaryData {
  verified?: boolean;
  wouldBlock?: boolean;
  templateChecks?: Partial<Record<'py' | 'java' | 'cc', {
    compiled: boolean;
    executed: boolean;
    total: number;
    passed: number;
    failureKind?: string;
  }>>;
  checkerCheck?: {
    configured: boolean;
    read: boolean;
    compiled: boolean;
    executed: boolean;
    total: number;
    passed: number;
    infraFailures: number;
    failureKind?: string;
  };
}

export function VerificationSummaryView(props: {
  verification: VerificationSummaryData;
  translate?: (key: string, ...args: Array<string | number>) => string;
}): React.ReactElement;
~~~

- [ ] **Step 1: Write RED real-render tests**

With renderToStaticMarkup, prove full green renders Verified, three language rows, 4/4, and checker read/compiled/executed. Prove observe infra renders Would block and never Verified. Prove legacy { mode:'sandbox' } renders Unverified.

- [ ] **Step 2: Run test and observe RED**

Run: npx jest src/__tests__/frontend/testdataVerificationSummaryView.test.ts --runInBand

Expected: FAIL because the component is absent.

- [ ] **Step 3: Implement and integrate the view**

Render py/java/cc in stable order. Show compiled, executed, and passed/total independently. Show checker read/compiled/executed, infra count, and failureKind. Use only verification.verified === true for the outer success alert. Remove verificationAllGreen, hasAiOnlyCases, templateSkipped, and client green inference while retaining informational sample/stress/discrimination rows.

- [ ] **Step 4: Add locale keys and generate fallback**

Add matching English/Chinese keys for Verified, Unverified, Would block, language, Compiled, Executed, Checker read, failure kind, and pass count. Stop using old copy that says checker compile failure is downgraded.

Run: npm run gen:locale

Expected: exit 0 and identical language key sets.

- [ ] **Step 5: Verify rendering/locales/build/lint**

Run:

~~~bash
npx jest src/__tests__/frontend/testdataVerificationSummaryView.test.ts src/__tests__/lib/localeFallback.test.ts --runInBand
npm run build:plugin
npm run lint
git diff --check
~~~

Expected: all exit 0.

- [ ] **Step 6: Commit**

~~~bash
git add frontend/testdataGen/VerificationSummaryView.tsx frontend/testdataGen/TestdataGenPanel.tsx src/__tests__/frontend/testdataVerificationSummaryView.test.ts locales/en.yaml locales/zh.yaml frontend/generated/localeFallback.ts
git commit -m "feat: show hard verification evidence"
~~~

---

### Task 7: Real go-judge Smoke, Review, and Final Gates

**Files:**
- Create: docs/reports/2026-08-19-task3-go-judge-smoke.md
- Modify only for review-proven in-scope defects: files from Tasks 1-6 and their tests/generated output

- [ ] **Step 1: Run focused regression bundle**

~~~bash
npx jest src/__tests__/services/goJudgeSandboxService.test.ts src/__tests__/services/testdataTemplateVerifier.test.ts src/__tests__/services/testdataGenService.test.ts src/__tests__/services/testdataCurrentGuarantees.test.ts src/__tests__/handlers/testdataGenHandler.test.ts src/__tests__/models/testdataGenerationJob.test.ts src/__tests__/frontend/testdataVerificationSummaryView.test.ts --runInBand
~~~

Expected: all listed suites pass.

- [ ] **Step 2: Run real Python/C++/Java smoke through built adapter**

Create a temporary script under /private/tmp importing dist/services/goJudgeSandboxService.js. Use TESTDATA_GO_JUDGE_URL or http://localhost:5050. Inputs are 1 2, 10 20, 1000 2000, 1000000 2000000; outputs are 3, 30, 3000, 3000000.

Exercise:
- Python solution plus template.py via runPythonBatchDetailed;
- C++ foo.cc plus template.cc via compileCpp, runCompiledBatchDetailed, deleteCachedFile;
- Java Solution.java plus public Main.java via compileJava, runJavaBatchDetailed, deleteCachedFile.

Record availability/version class, compile kind, four statuses, output comparisons, absolute deadline, redacted cache ID, cleanup result, exit status, and wall time. Unavailable endpoint is UNVERIFIED, never PASS.

- [ ] **Step 3: Write observed smoke report**

Create docs/reports/2026-08-19-task3-go-judge-smoke.md with exact branch SHA, endpoint class without credentials, availability/version, per-language compiled/executed/passed counts, cleanup evidence, EXIT values, budget milliseconds, and deviations. The committed report must contain observed values rather than template markers.

- [ ] **Step 4: Run complete mandated gates**

~~~bash
npm run gen:locale
npm test -- --runInBand
npm run lint
npm run build:plugin
git diff --check
git status --short
~~~

Expected: generation/Jest/lint/build/diff all exit 0; only Task 3 files and temporary node_modules link appear.

- [ ] **Step 5: Request independent review**

Use superpowers:requesting-code-review with base e430768989c418351ac034b2a7b08c6a61d1f98d and current HEAD. Require inspection of no checker text fallback, infra not WA, selected-language gates, deadline/cancellation/cleanup, observe/enforce, ai-only false-green prevention, and absence of Task 4 telemetry/ProblemSpec/mutation/risk-retry-config regression.

- [ ] **Step 6: Resolve findings with RED-GREEN evidence**

For each in-scope finding, add or identify a focused failing test, run it red, make the smallest fix, and rerun focused tests. Record why any suggestion outside Task 3 is excluded.

- [ ] **Step 7: Re-run final gates**

~~~bash
npm test -- --runInBand
npm run lint
npm run build:plugin
git diff --check
~~~

Expected: all exit 0 after the final code change.

- [ ] **Step 8: Commit evidence and review fixes**

Run build and lint immediately before commit. Force-add the ignored smoke report, then explicitly add only review-changed scoped files shown by git status.

~~~bash
git add -f docs/reports/2026-08-19-task3-go-judge-smoke.md
git commit -m "test: record hard verification smoke evidence"
~~~

If review fixes exist, commit those source/tests/dist files separately before the evidence commit.

- [ ] **Step 9: Remove temporary dependency link and verify branch**

Confirm /private/tmp/hydro-ai-helper-task3-hard-verification/node_modules is a symlink, unlink only that path, then run:

~~~bash
git status --short --branch
git log --oneline --decorate origin/main..HEAD
~~~

Expected: clean branch with only Task 3 commits ahead of origin/main.
