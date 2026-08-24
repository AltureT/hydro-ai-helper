# Testdata Mutation and Historical Differential Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add privacy-safe, sandbox-authoritative mutation scoring over deterministic generated mutants and permission-filtered historical wrong submissions.

**Architecture:** Keep source acquisition in the Handler, deterministic single-site mutation in a pure service, and compile/run classification in a sandbox runner service. `TestdataGenService` only orchestrates those pieces after authoritative cases exist, then attaches a bounded summary, applies the independent mutation gate, and emits closed telemetry.

**Tech Stack:** TypeScript, Jest/ts-jest, React 17 server rendering tests, HydroOJ Mongo/permission APIs, go-judge, Cloudflare Worker/D1, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-24-testdata-mutation-history-design.md`

## Global Constraints

- Work only in `/private/tmp/hydro-ai-helper-task9-12` on `claude/testdata-phase-c`; preserve every existing untracked `task-*` file.
- Strict RED → minimal GREEN for every task; do not begin R4 benchmark/replay or R5 rollout work.
- Generated and historical source, source digests, token positions, record IDs, stdin/stdout/stderr, sandbox details, and user identity remain request-local.
- Do not send mutation or historical source to any model and do not add model calls.
- `AI_HELPER_TESTDATA_MUTATION_GATE=off|observe|enforce`; invalid or missing values normalize to `observe`.
- `observe` never changes `verified`; it sets `wouldBlock` only when the same completed evidence would fail explicit mutation enforce.
- Only explicit mutation `enforce` applies the 0.8 threshold or evidence-unavailable hard failure; reliability mode alone never enables the mutation gate.
- Mutant selection is deterministic: at most 3 positions per operator, 12 generated mutants, 8 historical candidates, and 20 total candidates.
- Mutation has a 120,000 ms sub-budget bounded by the remaining 300,000 ms correctness budget; explicit program TLE is distinct from infrastructure deadline exhaustion.
- Import Hydro runtime symbols from `hydrooj` only after verifying the existing type declaration/source; import `ObjectId` only from `src/utils/mongo.ts`.
- `dist/` is tracked: every TypeScript production commit runs `npm run build:plugin` and stages matching `dist/` output with `src/`.
- Every commit runs its focused Jest suites, `npm run lint`, `npm run build:plugin`, and `git diff --check`; telemetry commits also run Worker tests and Dashboard build; locale commits run `npm run gen:locale`.

---

### Task 1: Deterministic Mutation Engine and Bounded Summary

**Files:**
- Create: `src/services/testdata/mutation.ts`
- Create: `src/__tests__/services/testdataMutation.test.ts`
- Create via build: `dist/services/testdata/mutation.js`
- Create via build: `dist/services/testdata/mutation.js.map`

**Interfaces:**
- Consumes: self-contained Python 3 or C++17 source chosen by the existing pipeline.
- Produces:

```ts
export type MutationLanguage = 'python' | 'cpp';

export const MUTATION_OPERATOR_IDS = [
  'comparison-boundary',
  'equality-negation',
  'logical-connector',
  'arithmetic-operator',
  'constant-off-by-one',
  'historical-submission',
] as const;

export type MutationOperatorId = typeof MUTATION_OPERATOR_IDS[number];
export type MutationGateMode = 'off' | 'observe' | 'enforce';

export interface MutationCandidate {
  origin: 'generated' | 'historical';
  language: MutationLanguage;
  operatorId: MutationOperatorId;
  source: string;
}

export interface HistoricalMutationCandidate {
  language: MutationLanguage;
  source: string;
  expectedStatus: 'wrong-answer' | 'runtime-error' | 'time-limit';
}

export function getMutationGateMode(value?: string): MutationGateMode;
export function normalizeMutationLanguage(value: string): MutationLanguage | undefined;
export function generateMutationCandidates(
  source: string,
  language: MutationLanguage,
): MutationCandidate[];
export function mergeMutationCandidates(
  generated: readonly MutationCandidate[],
  historical: readonly HistoricalMutationCandidate[],
): MutationCandidate[];
```

- [ ] **Step 1: Write tokenizer and contract failures first**

Add tests proving the public contract before the module exists:

```ts
describe.each([
  ['python', '# a < b\nprint("x <= y")\nif a < b:\n    pass', '<='],
  ['cpp', '#define KEEP(x) x < 2\n// a < b\nconst char* s = "x <= y";\nif (a < b) {}', '<='],
] as const)('generateMutationCandidates %s', (language, source, replacement) => {
  it('changes code tokens but never comments, strings, or preprocessor text', () => {
    const candidates = generateMutationCandidates(source, language);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].source).toContain(replacement);
    expect(candidates[0].source).toContain('"x <= y"');
  });
});

it('normalizes only allowlisted Hydro language aliases', () => {
  expect(normalizeMutationLanguage('py.py3')).toBe('python');
  expect(normalizeMutationLanguage('cc.cc17')).toBe('cpp');
  expect(normalizeMutationLanguage('java')).toBeUndefined();
});

it('uses observe for missing or invalid mutation gate values', () => {
  expect(getMutationGateMode()).toBe('observe');
  expect(getMutationGateMode('invalid')).toBe('observe');
  expect(getMutationGateMode('enforce')).toBe('enforce');
});
```

- [ ] **Step 2: Run focused tests and capture the RED**

Run: `npx jest src/__tests__/services/testdataMutation.test.ts --runInBand`

Expected: FAIL because `src/services/testdata/mutation.ts` and its exports do not exist.

- [ ] **Step 3: Implement language-aware single-site token scanning**

Implement two small scanners in `mutation.ts`. Both return byte ranges and token text; Python tracks single/double/triple strings and `#` comments, while C++ tracks line/block comments, quoted character/string literals, escapes, and preprocessor lines. Apply replacements only to returned code tokens:

```ts
interface SourceToken {
  start: number;
  end: number;
  text: string;
  kind: 'operator' | 'integer';
}

const OPERATOR_REPLACEMENTS: Readonly<Record<string, {
  id: Exclude<MutationOperatorId, 'constant-off-by-one' | 'historical-submission'>;
  replacement: string;
}>> = {
  '<': { id: 'comparison-boundary', replacement: '<=' },
  '<=': { id: 'comparison-boundary', replacement: '<' },
  '>': { id: 'comparison-boundary', replacement: '>=' },
  '>=': { id: 'comparison-boundary', replacement: '>' },
  '==': { id: 'equality-negation', replacement: '!=' },
  '!=': { id: 'equality-negation', replacement: '==' },
  'and': { id: 'logical-connector', replacement: 'or' },
  'or': { id: 'logical-connector', replacement: 'and' },
  '&&': { id: 'logical-connector', replacement: '||' },
  '||': { id: 'logical-connector', replacement: '&&' },
  '+': { id: 'arithmetic-operator', replacement: '-' },
  '-': { id: 'arithmetic-operator', replacement: '+' },
};

function replaceToken(source: string, token: SourceToken, replacement: string): string {
  return source.slice(0, token.start) + replacement + source.slice(token.end);
}
```

For `constant-off-by-one`, accept canonical decimal integers only, reject signs embedded in another token, reject values outside `Number.MIN_SAFE_INTEGER..Number.MAX_SAFE_INTEGER`, and generate exactly one of `value - 1` or `value + 1` by stable parity so one location never creates two candidates.

- [ ] **Step 4: Add operator, isolation, determinism, and cap tests**

Add table tests for all five generated operator IDs, exactly-one-token changes, duplicate source removal, 3 positions/operator, 12 generated, 8 historical, 20 total, and two identical calls returning byte-identical arrays. Add 100 deterministic generated sources per language to prove every candidate differs once and remains non-empty.

- [ ] **Step 5: Run GREEN and repository checks**

Run:

```bash
npx jest src/__tests__/services/testdataMutation.test.ts --runInBand
npm run lint
npm run build:plugin
git diff --check
```

Expected: all commands exit 0; built mutation JS/maps exist and contain no source fixtures.

- [ ] **Step 6: Commit the engine with tracked dist**

```bash
git add src/services/testdata/mutation.ts src/__tests__/services/testdataMutation.test.ts dist/services/testdata/mutation.js dist/services/testdata/mutation.js.map
git commit -m "feat: add deterministic testdata mutation engine"
```

---

### Task 2: Sandbox-Authoritative Mutation Evaluation

**Files:**
- Create: `src/services/testdata/mutationRunner.ts`
- Create: `src/__tests__/services/testdataMutationRunner.test.ts`
- Modify only if required by a failing contract: `src/services/goJudgeSandboxService.ts`
- Modify only if required by a failing contract: `src/__tests__/services/goJudgeSandboxService.test.ts`
- Create via build: `dist/services/testdata/mutationRunner.js`
- Create via build: `dist/services/testdata/mutationRunner.js.map`

**Interfaces:**
- Consumes: `MutationCandidate[]`, authoritative formal cases, the existing `TestdataSandboxRunner`, optional checker adapter, AbortSignal, and a caller-owned global deadline.
- Produces:

```ts
export const MUTATION_BUDGET_MS = 120_000;
export const MUTATION_SCORE_THRESHOLD = 0.8;

export type MutationSkipReason =
  | 'gate-off'
  | 'sandbox-unavailable'
  | 'unsupported-source'
  | 'no-candidates'
  | 'no-viable-candidates'
  | 'checker-infra'
  | 'sandbox-infra'
  | 'budget-exhausted';

export interface MutationFormalCase {
  input: string;
  answer: string;
}

export interface MutationOperatorSummary {
  id: MutationOperatorId;
  viable: number;
  killed: number;
}

export interface MutationVerificationSummary {
  mode: MutationGateMode;
  status: 'completed' | 'partial' | 'skipped';
  generated: number;
  historical: number;
  viable: number;
  killed: number;
  survived: number;
  score?: number;
  operators: MutationOperatorSummary[];
  skippedReason?: MutationSkipReason;
}

export type MutationCheckerJudge = (
  cases: Array<{ input: string; output: string; answer: string }>,
  opts: { signal?: AbortSignal; deadlineAt: number },
) => Promise<Array<'accept' | 'reject' | 'infra-error'>>;

export async function evaluateMutationCandidates(input: {
  mode: Exclude<MutationGateMode, 'off'>;
  candidates: readonly MutationCandidate[];
  cases: readonly MutationFormalCase[];
  runner: TestdataSandboxRunner;
  customChecker: boolean;
  judgeWithChecker?: MutationCheckerJudge;
  signal?: AbortSignal;
  correctnessDeadlineAt: number;
}): Promise<MutationVerificationSummary>;
```

- [ ] **Step 1: Write classification and cleanup failures**

Add mock-runner tests with one candidate per outcome:

```ts
function baseInput(runner: TestdataSandboxRunner) {
  return {
    mode: 'observe' as const,
    candidates: [{
      origin: 'generated' as const,
      language: 'python' as const,
      operatorId: 'comparison-boundary' as const,
      source: 'print(0)',
    }],
    cases: [{ input: '1\n', answer: '1\n' }],
    runner,
    customChecker: false,
    correctnessDeadlineAt: Date.now() + 300_000,
  };
}

it.each([
  ['Wrong Answer', false, false, 'killed'],
  ['Runtime Error', false, false, 'killed'],
  ['Memory Limit Exceeded', false, false, 'killed'],
  ['Time Limit Exceeded', false, true, 'killed'],
  ['Accepted', true, false, 'survived'],
] as const)('classifies explicit program status %s', async (status, accepted, timedOut, expected) => {
  runner.runPythonBatchDetailed.mockResolvedValue([{ status, accepted, timedOut, stdout: 'x', stderr: '' }]);
  const summary = await evaluateMutationCandidates(baseInput(runner));
  expect(expected === 'killed' ? summary.killed : summary.survived).toBe(1);
});

it('does not credit transport or unknown infrastructure failures as killed', async () => {
  runner.runPythonBatchDetailed.mockRejectedValue(new Error('transport failed'));
  const summary = await evaluateMutationCandidates(baseInput(runner));
  expect(summary).toMatchObject({ status: 'partial', viable: 0, killed: 0, skippedReason: 'sandbox-infra' });
});
```

For C++, assert compile failure is non-viable, compile infra is partial, and every successful `fileId` is passed to `deleteCachedFile` exactly once on success, error, cancellation, and budget exhaustion.

- [ ] **Step 2: Run focused tests and capture RED**

Run: `npx jest src/__tests__/services/testdataMutationRunner.test.ts --runInBand`

Expected: FAIL because the runner module does not exist.

- [ ] **Step 3: Implement candidate execution with two deadlines**

Compute `deadlineAt = Math.min(input.correctnessDeadlineAt, Date.now() + MUTATION_BUDGET_MS)`. Abort immediately if the caller signal is aborted. Python uses `runPythonBatchDetailed`; C++ uses `compileCpp` then `runCompiledBatchDetailed`. Treat these go-judge statuses as explicit candidate failures: Runtime Error, Memory Limit Exceeded, Output Limit Exceeded, and Time Limit Exceeded. Treat thrown errors, System Error, missing details, length mismatch, and deadline exhaustion as infrastructure/partial.

For accepted executions, use the checker adapter only when `customChecker === true`; missing adapter or any `infra-error` produces partial `checker-infra` and never text comparison. Otherwise compare normalized output with the existing line-ending/trailing-space semantics copied into a small local helper, without exporting raw outputs.

Always dispose compiled files:

```ts
let fileId: string | undefined;
try {
  const compiled = await input.runner.compileCpp!(candidate.source, {
    signal: input.signal,
    deadlineAt,
  });
  if (!compiled.ok) return compiled.kind === 'compile' ? 'non-viable' : 'infra';
  fileId = compiled.fileId;
  return await runCompiledCandidate(fileId, input.cases, deadlineAt);
} finally {
  if (fileId) {
    try { await input.runner.deleteCachedFile?.(fileId); } catch { /* best-effort */ }
  }
}
```

- [ ] **Step 4: Add score and aggregate consistency tests**

Prove `score === killed / viable`, zero viable omits score, `killed + survived === viable`, generated/historical counts match inputs, operator rows are unique and closed, and partial candidates do not enter viable. Prove the runner never mutates the candidate array or returns source/error text.

- [ ] **Step 5: Run GREEN and repository checks**

Run:

```bash
npx jest src/__tests__/services/testdataMutation.test.ts src/__tests__/services/testdataMutationRunner.test.ts src/__tests__/services/goJudgeSandboxService.test.ts --runInBand
npm run lint
npm run build:plugin
git diff --check
```

Expected: all exit 0.

- [ ] **Step 6: Commit runner and matching dist**

```bash
git add src/services/testdata/mutationRunner.ts src/__tests__/services/testdataMutationRunner.test.ts src/services/goJudgeSandboxService.ts src/__tests__/services/goJudgeSandboxService.test.ts dist/services/testdata/mutationRunner.js dist/services/testdata/mutationRunner.js.map dist/services/goJudgeSandboxService.js dist/services/goJudgeSandboxService.js.map
git commit -m "feat: evaluate testdata mutations in sandbox"
```

If `goJudgeSandboxService.ts` did not change, omit it and its dist/tests from the exact `git add` list rather than staging unrelated files.

---

### Task 3: Permission-Filtered Historical Wrong Submission Loader

**Files:**
- Modify: `src/handlers/testdataGenHandler.ts:14,180-310,749-900,968-1140,1230-1420`
- Modify: `src/__tests__/handlers/testdataGenHandler.test.ts`
- Modify via build: `dist/handlers/testdataGenHandler.js`
- Modify via build: `dist/handlers/testdataGenHandler.js.map`

**Interfaces:**
- Consumes: Handler user permissions, current `domainId`, current `ProblemDocLite`, Hydro `record` rows, and `ContestModel.get/isDone`.
- Produces:

```ts
export async function loadHistoricalMutationCandidates(
  handler: Handler,
  domainId: string,
  problemDocId: number,
): Promise<HistoricalMutationCandidate[]>;
```

- [ ] **Step 1: Write permission and query RED tests**

Add tests that mock `db.collection('record')`, `ContestModel.get`, and `ContestModel.isDone`:

```ts
function record(overrides: Record<string, unknown>) {
  return {
    _id: new ObjectId('64b000000000000000000001'),
    domainId: 'd1',
    pid: 7,
    status: STATUS.STATUS_WRONG_ANSWER,
    lang: 'py.py3',
    code: 'print(0)',
    contest: null,
    ...overrides,
  };
}

it('does not query record code without independent code-read permission', async () => {
  handler.user.hasPriv.mockReturnValue(false);
  handler.user.hasPerm.mockReturnValue(false);
  await expect(loadHistoricalMutationCandidates(handler, 'd1', 7)).resolves.toEqual([]);
  expect(mockRecordCollection.find).not.toHaveBeenCalled();
});

it('keeps only same-domain same-problem WA RE TLE from non-contest or completed contests', async () => {
  mockRecords([
    record({ status: STATUS.STATUS_WRONG_ANSWER, contest: null, code: 'print(0)', lang: 'py.py3' }),
    record({ status: STATUS.STATUS_RUNTIME_ERROR, contest: 'done', code: 'int main(){}', lang: 'cc.cc17' }),
    record({ status: STATUS.STATUS_TIME_LIMIT_EXCEEDED, contest: 'open', code: 'while True: pass', lang: 'py.py3' }),
    record({ status: STATUS.STATUS_ACCEPTED, contest: null, code: 'print(1)', lang: 'py.py3' }),
  ]);
  ContestModel.isDone.mockImplementation(doc => doc._id === 'done');
  const result = await loadHistoricalMutationCandidates(handler, 'd1', 7);
  expect(result.map(item => item.expectedStatus)).toEqual(['wrong-answer', 'runtime-error']);
});
```

Add rejection tests for code placeholders, over-limit source, unsupported language, duplicate source, unknown/missing contest, contest lookup failure, and more than 8 valid records.

- [ ] **Step 2: Run handler tests and capture RED**

Run: `npx jest src/__tests__/handlers/testdataGenHandler.test.ts --runInBand --testNamePattern="historical mutation"`

Expected: FAIL because the loader is missing and the generate paths do not pass candidates.

- [ ] **Step 3: Implement fail-closed loading**

Import `ContestModel` from the verified `hydrooj` export and mutation types from `../services/testdata/mutation`. Return before the DB query unless `canReadAllRecordCodes(handler)` is true. Query only same-domain/pid, allowlisted statuses, allowlisted languages, non-empty string code, project only `_id/status/lang/code/contest`, newest first, and cap the DB cursor at 64 rows before in-process filtering.

Use a per-request contest cache:

```ts
const contestDone = new Map<string, boolean>();
async function isEligibleContest(contest: unknown): Promise<boolean> {
  if (contest === undefined || contest === null) return true;
  const key = String(contest);
  if (contestDone.has(key)) return contestDone.get(key) as boolean;
  try {
    const tdoc = await ContestModel.get(domainId, contest);
    const done = !!tdoc && ContestModel.isDone(tdoc);
    contestDone.set(key, done);
    return done;
  } catch {
    contestDone.set(key, false);
    return false;
  }
}
```

Digest only in memory with Node `createHash('sha256')`; do not return or log it. Do not fall back to the current user's own code when code-read permission is absent.

- [ ] **Step 4: Wire both synchronous and background starts without persistence**

Load candidates after permission/config/statement validation and before constructing the service call. Add `historicalMutationCandidates` to `BackgroundGenerationParams`, pass it through the immediate `runBackgroundGeneration` closure, and pass it to both `service.generate()` calls. Do not add it to `TestdataGenerationJob`, checkpoint hashes, job serialization, or request/response bodies.

- [ ] **Step 5: Prove source cannot persist or leak**

Add tests that inspect `jobModel.createOrGetActive`, `jobModel.updateCheckpoint`, completed plan serialization, and telemetry mocks. Seed a unique sentinel source and assert it is absent from every persisted/emitted JSON value while it is present only in the `service.generate` parameter captured by the test.

- [ ] **Step 6: Run GREEN and repository checks**

Run:

```bash
npx jest src/__tests__/handlers/testdataGenHandler.test.ts --runInBand
npm run lint
npm run build:plugin
git diff --check
```

Expected: all exit 0.

- [ ] **Step 7: Commit loader and tracked dist**

```bash
git add src/handlers/testdataGenHandler.ts src/__tests__/handlers/testdataGenHandler.test.ts dist/handlers/testdataGenHandler.js dist/handlers/testdataGenHandler.js.map
git commit -m "feat: load eligible historical mutation candidates"
```

---

### Task 4: Pipeline Orchestration, Gate, Failure Semantics, and Checkpoint Privacy

**Files:**
- Modify: `src/services/testdataGenService.ts:420-470,7333-7420,8560-8660,9150-9995`
- Modify: `src/services/testdata/failures.ts`
- Modify: `src/models/testdataGenerationJob.ts` only if compile-time serialization proof requires an explicit omission assertion; do not add mutation source fields
- Modify: `src/__tests__/services/testdataGenService.test.ts`
- Modify: `src/__tests__/services/testdataFailures.test.ts`
- Modify: `src/__tests__/models/testdataGenerationJob.test.ts`
- Modify via build: matching `dist/services/testdataGenService.js`, `dist/services/testdata/failures.js`, and maps

**Interfaces:**
- Consumes: Task 1 candidate generation/merge, Task 2 evaluator, Task 3 request-only historical candidates, `materializationCache.correctnessBudgetRemainingMs`, authoritative `response.cases`, and `CheckerExecutor.runBatch`.
- Produces: `PlanVerification.mutation?: MutationVerificationSummary`, `mutation_testing` progress/failure stage, `MUTATION_EVIDENCE_UNAVAILABLE`, and gate behavior.

- [ ] **Step 1: Write gate matrix RED tests**

Add focused cases with deterministic evaluator mocks:

```ts
function mockMutationSummary(input: {
  status: 'completed' | 'partial' | 'skipped';
  viable: number;
  killed: number;
  survived: number;
  score?: number;
}) {
  evaluateMutationCandidatesMock.mockResolvedValue({
    mode: getMutationGateMode(process.env.AI_HELPER_TESTDATA_MUTATION_GATE),
    generated: input.viable,
    historical: 0,
    operators: [{ id: 'comparison-boundary', viable: input.viable, killed: input.killed }],
    ...input,
  });
}

function baseParams() {
  return {
    problemTitle: 'mutation gate',
    statementMarkdown: groupedCoinStatement,
    options: { ...baseOptions, problemKind: 'traditional' as const },
    historicalMutationCandidates: [],
  };
}

it.each([
  ['observe', 0.70, false, true],
  ['observe', 0.80, false, false],
  ['enforce', 0.70, true, false],
] as const)('applies mutation gate %s at score %s', async (gate, score, throws, wouldBlock) => {
  process.env.AI_HELPER_TESTDATA_MUTATION_GATE = gate;
  mockMutationSummary({ status: 'completed', viable: 10, killed: score * 10, survived: 10 - score * 10, score });
  const action = service.generate(baseParams());
  if (throws) await expect(action).rejects.toMatchObject({ code: 'MUTATION_SCORE_TOO_LOW', retryPolicy: 'no-retry' });
  else await expect(action).resolves.toMatchObject({ verification: { verified: true, wouldBlock } });
});
```

Add explicit cases for `off` making zero evaluator calls, observe partial/no-viable setting `wouldBlock`, enforce partial/no-viable throwing `MUTATION_EVIDENCE_UNAVAILABLE`, direct mode with mutation enforce failing without AI repair/escalation, custom checker infra not falling back to text, and a passing mutation result never changing an already false `verified` to true.

- [ ] **Step 2: Run service/failure tests and capture RED**

Run:

```bash
npx jest src/__tests__/services/testdataGenService.test.ts src/__tests__/services/testdataFailures.test.ts src/__tests__/models/testdataGenerationJob.test.ts --runInBand --testNamePattern="mutation|failure code"
```

Expected: FAIL because plan verification, params, stage, and evidence-unavailable code are missing.

- [ ] **Step 3: Extend only bounded public types**

Add `historicalMutationCandidates?: HistoricalMutationCandidate[]` to `GenerateTestdataParams`, `mutation?: MutationVerificationSummary` to `PlanVerification`, and `'mutation_testing'` to progress and canonical failure stages. Add `MUTATION_EVIDENCE_UNAVAILABLE` to the TypeScript failure-code allowlist and map both mutation failures to `no-retry`; Task 5 mirrors the new code into the Worker allowlist when telemetry changes. Extend safe detail keys only with `viable`, `killed`, `survived`, `score`, `threshold`, and a closed `failureKind`; do not allow source-like fields.

- [ ] **Step 4: Add an isolated gate helper**

Implement and export for tests:

```ts
export function applyMutationGate(
  verification: Pick<PlanVerification, 'verified' | 'wouldBlock'>,
  summary: MutationVerificationSummary,
): void {
  const unavailable = summary.status !== 'completed' || summary.viable === 0 || summary.score === undefined;
  const tooLow = summary.score !== undefined && summary.score < MUTATION_SCORE_THRESHOLD;
  if (summary.mode === 'observe') {
    if (unavailable || tooLow) verification.wouldBlock = true;
    return;
  }
  if (summary.mode !== 'enforce') return;
  if (unavailable) throw mutationEvidenceUnavailable(summary);
  if (tooLow) throw mutationScoreTooLow(summary);
}
```

Both error constructors use `stage=mutation_testing`, `artifact=mutation`, `retryPolicy=no-retry`, and bounded counts only.

- [ ] **Step 5: Orchestrate after authoritative materialization**

Immediately after `materializeSandboxBlueprint` returns and before repair/final plan assembly:

1. Read the gate mode once per run.
2. If off, attach a skipped summary without evaluator calls.
3. Generate candidates from `response.oracleCode`/`response.oracleLanguage`; merge request-only history only for traditional problems.
4. Compute `correctnessDeadlineAt = Date.now() + (materializationCache.correctnessBudgetRemainingMs || 0)` so mutation cannot reset the 300-second correctness budget.
5. Adapt `checkerExecutor.runBatch` to `MutationCheckerJudge` when custom checker is configured.
6. Evaluate, attach to `response.verification.mutation`, then call `applyMutationGate`.

Emit `mutation_testing` progress between discrimination and assembling. Do not put candidate source in notes, errors, checkpoints, `GenerationResponse` client fields, or model prompts.

- [ ] **Step 6: Add checkpoint/resume and no-model-call proofs**

Seed checkpoints containing solution/artifacts/verifier/killTargets, run resume twice with changed historical candidates, and prove the evaluator sees fresh candidates while checkpoint payload equality is unchanged. Assert `modelCallCount` and role client invocation counts are byte-for-byte equal with mutation off versus observe.

- [ ] **Step 7: Run GREEN and repository checks**

Run:

```bash
npx jest src/__tests__/services/testdataMutation.test.ts src/__tests__/services/testdataMutationRunner.test.ts src/__tests__/services/testdataGenService.test.ts src/__tests__/services/testdataFailures.test.ts src/__tests__/models/testdataGenerationJob.test.ts --runInBand
npm run lint
npm run build:plugin
git diff --check
```

Expected: all exit 0; the service file has orchestration only and no tokenizer/DB query implementation.

- [ ] **Step 8: Commit orchestration and tracked dist**

```bash
git add src/services/testdataGenService.ts src/services/testdata/failures.ts src/models/testdataGenerationJob.ts src/__tests__/services/testdataGenService.test.ts src/__tests__/services/testdataFailures.test.ts src/__tests__/models/testdataGenerationJob.test.ts dist/services/testdataGenService.js dist/services/testdataGenService.js.map dist/services/testdata/failures.js dist/services/testdata/failures.js.map dist/models/testdataGenerationJob.js dist/models/testdataGenerationJob.js.map
git commit -m "feat: integrate mutation evidence gate"
```

Omit unchanged model files from staging.

---

### Task 5: Privacy-Bounded Mutation Telemetry and D1 Storage

**Files:**
- Modify: `src/services/testdata/runTelemetry.ts`
- Modify: `src/__tests__/services/testdataRunTelemetry.test.ts`
- Modify: `cloudflare/telemetry-worker/worker.js`
- Modify: `cloudflare/telemetry-worker/testdataQuality.test.mjs`
- Create: `cloudflare/telemetry-worker/migrations/0014_testdata_mutation.sql`
- Modify: `cloudflare/telemetry-dashboard/src/types.ts`
- Modify: `cloudflare/telemetry-dashboard/src/api.ts`
- Modify: `cloudflare/telemetry-dashboard/api.test.mjs`
- Modify via build: `dist/services/testdata/runTelemetry.js` and map

**Interfaces:**
- Consumes: browser-safe `PlanVerification.mutation` only.
- Produces event fields: `mutationGate`, `mutationStatus`, `mutationGenerated`, `mutationHistorical`, `mutationViable`, `mutationKilled`, `mutationSurvived`, `mutationScore`, and `mutationOperators` as a bounded closed array of `{id, viable, killed}`.

- [ ] **Step 1: Write local telemetry RED tests**

Add a completed plan with mutation summary and assert the emitted event contains only the allowed aggregates. Add malicious objects containing `source`, `recordId`, `input`, `output`, `position`, oversized operators, duplicate IDs, negative counts, inconsistent totals, and score mismatch; event construction must drop the entire mutation observation rather than partially trust it.

- [ ] **Step 2: Write Worker/migration RED tests**

Require migration 0014 to add nullable columns:

```sql
ALTER TABLE testdata_runs ADD COLUMN mutation_gate TEXT;
ALTER TABLE testdata_runs ADD COLUMN mutation_status TEXT;
ALTER TABLE testdata_runs ADD COLUMN mutation_generated INTEGER;
ALTER TABLE testdata_runs ADD COLUMN mutation_historical INTEGER;
ALTER TABLE testdata_runs ADD COLUMN mutation_viable INTEGER;
ALTER TABLE testdata_runs ADD COLUMN mutation_killed INTEGER;
ALTER TABLE testdata_runs ADD COLUMN mutation_survived INTEGER;
ALTER TABLE testdata_runs ADD COLUMN mutation_score REAL;
ALTER TABLE testdata_runs ADD COLUMN mutation_operators TEXT;
```

Add fail-open POST tests, allowlist validation tests, idempotent migration-ledger checks, upsert checks, and a privacy assertion that the stored JSON does not contain sentinel source/input/output/record strings.
Also add `MUTATION_EVIDENCE_UNAVAILABLE` to the Worker failure-code allowlist and `mutation_testing` to the Worker stage allowlist before accepting corresponding failure events.

- [ ] **Step 3: Run RED suites**

Run:

```bash
npx jest src/__tests__/services/testdataRunTelemetry.test.ts --runInBand
node --test cloudflare/telemetry-worker/*.test.mjs
node --test cloudflare/telemetry-dashboard/*.test.mjs
```

Expected: TypeScript compile/test failure for missing event fields and Worker failures for missing migration/allowlist/upsert.

- [ ] **Step 4: Implement one shared bounded-summary validator**

In `runTelemetry.ts`, accept counts only when they are safe integers in `0..20`, `generated + historical <= 20`, `killed + survived === viable`, operator IDs are unique/closed, operator sums equal viable/killed, and score is absent iff viable is zero or equals `killed / viable` within `Number.EPSILON`. Return no mutation fields on any inconsistency.

Mirror the same closed checks in Worker JavaScript before D1 binding. Serialize `mutationOperators` with `JSON.stringify` only after validation; cap serialized length to 1024 bytes.

- [ ] **Step 5: Add D1 upsert and dashboard transport types**

Extend the `run_completed` insert/update columns and binds. The dashboard API response may expose mutation aggregates in its typed testdata-quality object, but Task R3 does not add a dashboard panel; R5 owns panel presentation. Preserve old rows with null fields.

- [ ] **Step 6: Run GREEN and repository checks**

Run:

```bash
npx jest src/__tests__/services/testdataRunTelemetry.test.ts --runInBand
node --test cloudflare/telemetry-worker/*.test.mjs
node --test cloudflare/telemetry-dashboard/*.test.mjs
npm --prefix cloudflare/telemetry-dashboard run build
npm run lint
npm run build:plugin
git diff --check
```

Expected: all exit 0 and the Worker unauthorized-token behavior remains fail-open exactly as before.

- [ ] **Step 7: Commit telemetry, migration, dashboard transport, and dist**

```bash
git add src/services/testdata/runTelemetry.ts src/__tests__/services/testdataRunTelemetry.test.ts cloudflare/telemetry-worker/worker.js cloudflare/telemetry-worker/testdataQuality.test.mjs cloudflare/telemetry-worker/migrations/0014_testdata_mutation.sql cloudflare/telemetry-dashboard/src/types.ts cloudflare/telemetry-dashboard/src/api.ts cloudflare/telemetry-dashboard/api.test.mjs dist/services/testdata/runTelemetry.js dist/services/testdata/runTelemetry.js.map
git commit -m "feat: emit bounded mutation quality telemetry"
```

---

### Task 6: Fail-Closed Frontend Evidence, Locales, and Final R3 Gate

**Files:**
- Modify: `frontend/testdataGen/VerificationSummaryView.tsx`
- Modify: `frontend/testdataGen/TestdataGenPanel.tsx`
- Modify: `src/__tests__/frontend/testdataVerificationSummaryView.test.ts`
- Modify: `locales/en.yaml`
- Modify: `locales/zh.yaml`
- Regenerate: `frontend/generated/localeFallback.ts`
- Modify via build: any changed tracked `dist/` output

**Interfaces:**
- Consumes: `MutationVerificationSummary` from `PlanVerification.mutation`.
- Produces: a bounded mutation evidence row with no source-specific details.

- [ ] **Step 1: Write rendering RED tests**

Add server-rendered cases for completed 8/10 score 0.8, observe 7/10 warning, partial, skipped, and malicious payloads. A valid completed row must render translated mode, `8/10`, `80%`, generated/history counts, and closed operator aggregates. Invalid totals, duplicate/unknown operator IDs, score mismatch, more than 20 candidates, negative counts, or arbitrary skip reason must render only the unavailable label and never a green status.

- [ ] **Step 2: Run frontend RED**

Run: `npx jest src/__tests__/frontend/testdataVerificationSummaryView.test.ts --runInBand`

Expected: FAIL because the frontend type and bounded validator do not support mutation evidence.

- [ ] **Step 3: Implement bounded validation and rendering**

Add mutation fields to `VerificationSummaryData`, closed sets matching the backend, and `isTrustedMutationSummary(value)` with the same count/score/operator invariants. Append one evidence row:

```ts
const mutation = isTrustedMutationSummary(verification.mutation)
  ? verification.mutation
  : undefined;
rows.push(evidenceRow([
  React.createElement('strong', { key: 'mutation' }, translate('ai_helper_testdata_mutation_title')),
  React.createElement('span', { key: 'score' }, mutation?.score === undefined
    ? translate('ai_helper_testdata_mutation_unavailable')
    : `${mutation.killed}/${mutation.viable} (${Math.round(mutation.score * 100)}%)`),
]));
```

Render only aggregate operator labels and counts. Never render candidate source, history identity, locations, inputs, outputs, or raw failure strings.

- [ ] **Step 4: Add and regenerate locales**

Add matching English/Chinese keys for title, off/observe/enforce, completed/partial/skipped, generated/history/viable/killed/survived, unavailable, and every closed skip/operator ID. Run `npm run gen:locale` and assert the generated file contains equal en/zh key counts.

- [ ] **Step 5: Run focused and full authoritative gates**

Run in this order and preserve each exit status:

```bash
npx jest src/__tests__/services/testdataMutation.test.ts src/__tests__/services/testdataMutationRunner.test.ts src/__tests__/handlers/testdataGenHandler.test.ts src/__tests__/services/testdataGenService.test.ts src/__tests__/services/testdataFailures.test.ts src/__tests__/services/testdataRunTelemetry.test.ts src/__tests__/models/testdataGenerationJob.test.ts src/__tests__/frontend/testdataVerificationSummaryView.test.ts --runInBand
node --test cloudflare/telemetry-worker/*.test.mjs
node --test cloudflare/telemetry-dashboard/*.test.mjs
npm --prefix cloudflare/telemetry-dashboard run build
npm run gen:locale
npm run lint
npm test -- --runInBand --silent
npm run build:plugin
git diff --check
```

Expected: every command exits 0. Run `npm run build:plugin` a second time and require `git diff --exit-code` over tracked `dist/` to prove idempotence relative to the first build.

After the first build, stage only `dist/`, run `npm run build:plugin` again, then run `git diff --exit-code -- dist`; exit 0 proves the second build produced no working-tree delta relative to the staged first build.

- [ ] **Step 6: Commit frontend/locales/final dist**

```bash
git add frontend/testdataGen/VerificationSummaryView.tsx frontend/testdataGen/TestdataGenPanel.tsx src/__tests__/frontend/testdataVerificationSummaryView.test.ts locales/en.yaml locales/zh.yaml frontend/generated/localeFallback.ts dist
git commit -m "feat: present mutation verification evidence"
```

Before committing, inspect `git diff --cached --name-status`; remove any staged file not listed in Tasks 1-6.

- [ ] **Step 7: Perform final read-only review and repair loop**

Review `git diff 47dc183...HEAD` against the approved spec with at most 10 findings in `severity | file:line | issue | fix` format. Required review points: tokenizer isolation, permission conjunction, contest completion, source non-persistence, compile cleanup, TLE versus infra, global/sub-budget accounting, custom-checker no-fallback, observe/enforce semantics, telemetry/frontend fail-closed validation, no model-call increase, and no R4/R5 expansion.

For every Critical/Important finding, add a focused failing regression, apply the minimal fix, rerun the affected focused suites plus the full gate above, rebuild dist, and commit:

```bash
git add src/services/testdata/mutation.ts src/services/testdata/mutationRunner.ts src/services/testdataGenService.ts src/services/testdata/failures.ts src/services/testdata/runTelemetry.ts src/handlers/testdataGenHandler.ts src/models/testdataGenerationJob.ts src/__tests__/services/testdataMutation.test.ts src/__tests__/services/testdataMutationRunner.test.ts src/__tests__/services/testdataGenService.test.ts src/__tests__/services/testdataFailures.test.ts src/__tests__/services/testdataRunTelemetry.test.ts src/__tests__/handlers/testdataGenHandler.test.ts src/__tests__/models/testdataGenerationJob.test.ts src/__tests__/frontend/testdataVerificationSummaryView.test.ts frontend/testdataGen/VerificationSummaryView.tsx frontend/testdataGen/TestdataGenPanel.tsx frontend/generated/localeFallback.ts locales/en.yaml locales/zh.yaml cloudflare/telemetry-worker/worker.js cloudflare/telemetry-worker/testdataQuality.test.mjs cloudflare/telemetry-worker/migrations/0014_testdata_mutation.sql cloudflare/telemetry-dashboard/src/types.ts cloudflare/telemetry-dashboard/src/api.ts cloudflare/telemetry-dashboard/api.test.mjs dist
git diff --cached --name-status
git commit -m "fix: close mutation verification review gaps"
```

- [ ] **Step 8: Final evidence report**

Report exact branch/HEAD, commit list after `47dc183`, `git status --short`, focused/full counts, command exits, dist idempotence, review result, changed-file inventory, and `UNVERIFIED` for live model, production go-judge, real Mongo interruption/resume, HydroOJ browser/accessibility, deployment, remote CI, PR, and merge.
