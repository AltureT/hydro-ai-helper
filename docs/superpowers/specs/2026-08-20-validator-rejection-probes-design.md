# Validator Rejection Probes and Subtask Validation Design

**Status:** Approved in chat on 2026-08-20

**Baseline:** `origin/main` at `86a2002d4d46399d7dfbe04abc3959730eb530c4`

**Scope:** Task 8 only. Prove that an Independent Verifier's `VALIDATOR` accepts legal inputs, rejects targeted illegal inputs, and enforces the Frozen ProblemSpec constraints for each server-assigned subtask.

## Goals

1. Require a strict Validator Manifest on every non-legacy Frozen ProblemSpec path.
2. Construct deterministic, server-trusted invalid probes for the first supported constraint families.
3. Execute legal and illegal Validator partitions separately in Hydro go-judge.
4. Pass a server-owned subtask ID through explicit process arguments rather than problem stdin.
5. Preserve legacy behavior while making observe and enforce outcomes explicit and testable.
6. Preserve Frozen ProblemSpec, role provenance, checkpoint invalidation, cancellation identity, and privacy guarantees across repair and resume.

## Non-goals

- No Task 9 positive Generator DSL or Semantic Coverage Matrix.
- No mutation testing or historical submission corpus.
- No benchmark corpus expansion.
- No cross-language function-signature parser.
- No Worker, D1, Dashboard, or telemetry schema changes.
- No runtime dependency additions.
- No execution of AI-generated code in the Hydro Web process.
- No broad rewrite of `src/services/testdataGenService.ts`.

## Current Behavior and Required Delta

The current materializer sends formal inputs, converted statement samples, and stress inputs to one stdin-only Validator batch. A rejected formal input is attributed to the Generator, a rejected sample to `VALIDATOR_FALSE_REJECT`, and excessive rejected stress inputs to the Stress Generator. Hack candidates receive another stdin-only Validator call. There is no invalid-input partition and no subtask argument.

Tiered generation already computes one `TieredSubtaskGenerationDecision` and uses its allocation in generation prompts and `config.yaml`. However, Validator execution ignores that allocation, and appended hack cases default to the last presumed-widest subtask. Task 8 must make that frozen allocation part of actual Validator execution and must replace the last-tier default with a stable server-owned extension algorithm.

## Architecture

### 1. Validator Manifest

Add a focused manifest module under `src/services/testdata/` with these public contracts:

```ts
export interface ValidatorManifest {
  constraintIds: string[];
  invariantIds: string[];
}

export interface ValidatorManifestValidation {
  manifest: ValidatorManifest;
  requiredConstraintIds: string[];
  requiredInvariantIds: string[];
  missingConstraintIds: string[];
  missingInvariantIds: string[];
}
```

The Independent Verifier Frozen Spec protocol becomes:

```text
@@@VALIDATOR_MANIFEST@@@
{"constraintIds":["C1","C2"],"invariantIds":["I1"]}
@@@VALIDATOR@@@
...
```

The parser accepts one strict JSON object only. The exact allowed and required keys are `constraintIds` and `invariantIds`. Both values must be duplicate-free arrays of non-empty strings. Unknown keys, unknown IDs, duplicate IDs, wrong types, prefixes, suffixes, and fenced JSON are invalid.

Required IDs are computed exclusively from the Frozen ProblemSpec:

- every `machineCheckable=true` global constraint;
- every `machineCheckable=true` scoped constraint, regardless of subtask;
- every `machineCheckable=true` invariant.

The model cannot provide scope metadata. For a declared scoped constraint, the service retrieves the subtask ID from the Frozen Spec. Non-machine-checkable targets do not need declaration. A spec with no machine-checkable targets requires two empty arrays.

Missing, invalid, or incomplete manifests use `VALIDATOR_CONSTRAINT_COVERAGE_MISSING`. A valid manifest is only a declaration; it never creates covered IDs without an executed rejected probe.

`IndependentVerifierBlueprint` gains these compatibility fields:

```ts
validatorManifest?: ValidatorManifest;
validatorManifestStatus?: 'valid' | 'invalid';
validatorProbeRecipes?: ValidatorProbeRecipe[];
```

Legacy parsing leaves all three fields undefined. A successful Frozen-path parse sets `validatorManifestStatus='valid'`; observe-mode recovery after a second invalid Manifest sets `validatorManifestStatus='invalid'` and does not synthesize a Manifest.

### 2. Prompt and Checkpoint Compatibility

Increment `TESTDATA_PIPELINE_PROMPT_VERSION` from `testdata-generation-v2` to `testdata-generation-v3`. Keep checkpoint schema version 2 unless implementation uncovers a persistence-shape incompatibility not covered by prompt-version invalidation.

Non-legacy resume continues to require an exact prompt version, statement hash, spec hash, and role dependency hashes. Consequently, a v2 Verifier checkpoint cannot be reused as v3 manifest evidence. A v3 checkpoint stores the strict manifest and bounded recipes but never stores a materialized probe input.

The parse sequence is mode-aware without weakening the strict parser:

1. Parse the initial Independent Verifier response strictly.
2. If the manifest or required verifier sections are invalid, ask the Verifier role for one full verifier repair.
3. If the repaired response is still invalid:
   - `enforce` returns the typed coverage failure and may advance only the failed Verifier model chain through the existing semantic fallback;
   - `observe` retains parsable BRUTE/STRESS_GENERATOR/VALIDATOR artifacts, records an invalid-manifest state, treats every required target as missing, and continues to preview;
   - `legacy` continues the old parser and behavior.

A Validator false-accept repair returns only `@@@VALIDATOR@@@`; the already validated manifest and probe recipes are retained. A manifest/parser repair remains a full Independent Verifier repair and cannot modify Generator, Oracle, Solution, Template, or Frozen Spec.

### 3. Deterministic Constraint Probes

Create `src/services/testdata/constraintProbes.ts` with request-local contracts equivalent to:

```ts
export interface ConstraintProbe {
  id: string;
  targetId: string;
  targetKind: 'constraint' | 'invariant';
  input: string;
  subtaskId?: number;
  constructionKind: string;
}

export interface ConstraintProbeGap {
  targetId: string;
  targetKind: 'constraint' | 'invariant';
  reasonCode: string;
  subtaskId?: number;
}

export interface ConstraintProbeBuildResult {
  probes: ConstraintProbe[];
  gaps: ConstraintProbeGap[];
}
```

The constructor receives the Frozen ProblemSpec, statement hash, spec hash, and legal seed inputs annotated with server-owned subtask allocations. Legal seeds are ordered as formal case index, statement sample ID, then retained stress index; scoped targets may select only a formal seed assigned to the matching subtask. It does not execute user or AI code. Its effective seed is exactly:

```text
legalSeedHash = sha256(canonical JSON of ordered {source,index,subtaskId,input} seeds)
effectiveSeed = sha256("constraint-probes-v1\0" + statementHash + "\0" + specHash + "\0" + legalSeedHash)
```

There is no process-random or clock-derived seed. `legalSeedHash` and `effectiveSeed` may be retained as bounded hashes; the canonical seed JSON may not leave request memory.

For each target it chooses the first deterministically ordered seed that is valid for the target's scope. It parses only closed, reviewable stdin shapes. If the encoding is ambiguous, a dependent field cannot be mapped, or a mutation cannot be isolated safely, it emits a gap instead of a probe.

The first implementation supports these construction kinds when the Frozen Spec encoding and a legal seed make them unambiguous:

- integer below a lower bound;
- integer above an upper bound;
- dependent array length mismatch;
- duplicate element for `unique`;
- duplicate or missing element for `permutation`;
- disallowed character in a string;
- graph self-loop;
- graph duplicate edge;
- disconnected graph;
- tree with too few edges;
- cyclic tree;
- cyclic DAG;
- `ADD` of an existing object;
- `DEL` of a missing object;
- operation argument outside a declared bound;
- value above a subtask-scoped upper bound.

Recognizers are intentionally conservative. They cover canonical whitespace-token, line-oriented array, edge-list graph/tree, and operation-sequence forms described by the Frozen Spec. They do not evaluate expressions, use `eval`, execute dynamic JavaScript, or claim support for an unrecognized free-text encoding.

Probe IDs are deterministic SHA-256-derived identifiers over statement hash, spec hash, target kind, target ID, subtask ID, construction kind, effective seed, and normalized mutation position. The ID may be persisted or reported; the input may not.

### 4. Bounded Custom-Invariant Recipes

The Independent Verifier may optionally return a strict `@@@VALIDATOR_PROBE_RECIPES@@@` JSON section for machine-checkable custom invariants that the deterministic recognizers cannot cover:

```ts
export interface ValidatorProbeRecipe {
  targetId: string;
  constructionKind:
    | 'integer-below-min'
    | 'integer-above-max'
    | 'array-length-mismatch'
    | 'duplicate-element'
    | 'permutation-duplicate-or-missing'
    | 'illegal-string-character'
    | 'graph-self-loop'
    | 'graph-duplicate-edge'
    | 'graph-disconnected'
    | 'tree-missing-edge'
    | 'tree-cycle'
    | 'dag-cycle'
    | 'add-existing-object'
    | 'delete-missing-object'
    | 'operation-argument-out-of-range'
    | 'subtask-upper-bound';
  fieldId?: string;
  operationName?: string;
}
```

The section is one strict object with the exact key `recipes`; `recipes` is a duplicate-free array of at most 64 strict recipe objects. Recipe objects allow only `targetId`, `constructionKind`, `fieldId`, and `operationName`. `targetId` and `constructionKind` are required. `fieldId`, when present, must name a Frozen Spec input field. `operationName`, when present, must exactly name a Frozen Spec operation. Duplicate recipes are rejected by their canonical JSON representation. Fields named `input`, `subtaskId`, `seedIndex`, `value`, `code`, or any other extra field are invalid.

This section is not a Generator DSL. It cannot create a positive test suite, execute code, provide an arbitrary full input, choose a seed, supply a subtask, provide replacement data, or define an expression language. Each recipe can only request one service-defined construction kind against a service-selected legal seed and Frozen Spec field.

The service:

1. accepts recipes only for known, still-uncovered `machineCheckable=true` targets;
2. obtains scope and subtask ID from the Frozen Spec;
3. chooses the legal seed itself;
4. applies an allowlisted bounded mutation;
5. validates normalized size and the recognized stdin shape;
6. runs the resulting input through go-judge;
7. counts coverage only after an explicit nonzero Validator rejection.

Recipes are deterministic and checkpoint-safe because they contain only target/field/operation identifiers and a closed construction kind, not materialized probe inputs. Invalid recipes become structured gaps. A model statement that a recipe is a counterexample is never proof.

### 5. Explicit Python Invocation Arguments

Extend the sandbox runner with a backward-compatible input union:

```ts
export interface PythonRunInvocation {
  stdin: string;
  argv?: string[];
}

export type PythonBatchInput = string | PythonRunInvocation;
```

Existing string inputs retain the exact `python3 main.py` behavior. Structured inputs append validated argument strings directly to the go-judge command array; no shell is involved and no argument is added to stdin.

Tiered Validator calls use:

```text
python3 main.py --subtask <id>
```

The verifier prompt requires the Validator to support either no subtask argument or exactly `--subtask <known-positive-integer>`. No argument means global constraints only. A known subtask means global constraints plus that subtask's scoped constraints. Unknown IDs, missing values, non-integers, extra arguments, and duplicate `--subtask` flags must exit nonzero.

### 6. Stable Subtask Allocation

The existing `TieredSubtaskGenerationDecision` remains the single source of allocation truth. Pass it into materialization and hack repair instead of re-deriving it.

Replace the last-tier append rule with a prefix-preserving weighted-deficit extension:

1. Never change an existing `caseNumber -> subtaskId` entry.
2. For each appended case, calculate each subtask's deficit against its score-weighted target for the new total.
3. Assign the case to the largest deficit; ties follow Frozen Spec subtask order.
4. Record the assignment before validating the candidate.
5. Invoke Validator with that subtask ID; only an accepted candidate can enter the plan.

This produces a stable, server-owned allocation without assuming the last subtask is widest. Repair, resume, materialization, hack validation, `caseCoverage`, and `config.yaml` consume the same allocation.

For tiered formal inputs, a rejection under the assigned subtask uses `SUBTASK_CONSTRAINT_VIOLATION` with Generator as the artifact. For a scoped invalid probe or invalid subtask protocol invocation that returns exit 0, the same code uses Validator as the artifact. Artifact ownership determines targeted repair.

### 7. Legal and Illegal Validator Partitions

Split the Validator phase into two explicit partitions without moving unrelated Oracle, template, checker, brute, or discrimination code.

#### Legal partition

The Validator must accept:

- every formal input, with its server-assigned subtask argument when tiering is active;
- every regressed statement sample, with global validation;
- every stress input retained by the existing stress-validity policy, with global validation;
- every accepted hack candidate, with its prospective server-assigned subtask argument.

Preserve current ownership rules for non-subtask inputs: formal rejection belongs to Generator, sample rejection to Validator, and excessive stress rejection to Stress Generator. Do not repair a false reject by weakening Validator.

#### Illegal partition

After legal seeds are known, construct deterministic and accepted custom probes. Execute only Validator on these inputs. Never send them to Oracle, BRUTE, templates, checker, kill targets, or hack output generation.

Also run two protocol probes when subtasks exist: one unknown numeric subtask and one malformed subtask value, both against a legal seed. These protocol probes have no coverage target but must exit nonzero.

An invalid invocation is rejected only when go-judge returns an explicit nonzero exit status without timeout or infrastructure error. Classification is:

- exit status 0: false accept; increment `invalidAccepted`;
- explicit nonzero exit: rejected; increment `invalidRejected`;
- timeout or malformed execution detail: no rejection proof and a structured execution gap;
- transport/protocol infrastructure failure: `SANDBOX_UNAVAILABLE`, never counted as rejected;
- result count mismatch: `SANDBOX_UNAVAILABLE` with counts, never silently ignored;
- total deadline expiry: existing `PIPELINE_BUDGET_EXHAUSTED`;
- user cancellation: rethrow the original cancellation reason object before repair or fallback.

In enforce mode, any exit-0 invalid probe throws `VALIDATOR_FALSE_ACCEPT`. An exit-0 scoped/protocol probe throws `SUBTASK_CONSTRAINT_VIOLATION`. Both target only the Validator repair scope.

### 8. Coverage Proof

For each machine-checkable target, retain request-local evidence with target kind, manifest declaration, probe construction status, subtask ID, execution classification, and rejection result. No raw input is included.

A target is covered only when:

1. its ID is present in the correct manifest array;
2. at least one server-constructed or server-accepted probe is bound to it;
3. go-judge actually returns an explicit nonzero Validator exit for that probe.

If a target has several probes, one rejection is enough for the target coverage predicate, but every executed exit-0 probe still increments `invalidAccepted` and prevents enforce success.

Public verification remains compatible:

```ts
validator: {
  ran: boolean;
  casesChecked: number;
  validAccepted: number;
  invalidRejected: number;
  invalidAccepted: number;
  coveredConstraintIds: string[];
  missingConstraintIds: string[];
}
```

`casesChecked` remains the legacy attempted-legal count. All ID arrays are sorted and deduplicated. The two public ID arrays contain the union of constraint and invariant target IDs for the requested compatibility shape. Internal evidence retains `targetKind`, so invariant results are not lost or reclassified.

The frontend prefers the new counts and coverage totals when present and falls back to `ran/casesChecked` for older plans. Direct mode does not synthesize manifest or probe proof.

### 9. Reliability Modes and Risk Tiers

#### legacy

- Old verifier parser, checkpoint compatibility, Validator calls, verification fields, and quality gate.
- No Manifest or invalid-probe requirement.
- No new hard block.

#### observe

- Run manifest validation, deterministic probes, bounded custom recipes, legal/illegal partitions, and subtask protocol checks.
- Record false accepts, execution gaps, missing coverage, and subtask gaps.
- Keep `verified=false` and set `wouldBlock=true` whenever the new proof is incomplete.
- Continue preview after proof-only failures unless an existing safety or infrastructure failure already requires stopping.

#### enforce

- Missing or incomplete required Manifest: `VALIDATOR_CONSTRAINT_COVERAGE_MISSING` for every risk tier.
- Any exit-0 invalid probe: hard `VALIDATOR_FALSE_ACCEPT`.
- Any exit-0 scoped/protocol probe: hard `SUBTASK_CONSTRAINT_VIOLATION`.
- High or blocked risk with an uncovered machine-checkable target: hard `VALIDATOR_CONSTRAINT_COVERAGE_MISSING`.
- Low or medium risk with a safe-construction gap: continue with `verified=false`; do not broaden the hard gate.

The authoritative finalizer requires complete new Validator proof only when new fields are present. Legacy verification keeps its old compatibility semantics. Direct mode remains unverified.

## Repair and Resume

- Formal global invalid input repairs Generator; formal scoped invalid input repairs Generator under `SUBTASK_CONSTRAINT_VIOLATION`.
- Sample false reject repairs Validator.
- Invalid-probe false accept repairs Validator only.
- Manifest/parser failure repairs the Independent Verifier role as a whole.
- Validator-only repair preserves Generator, Oracle, Solution, Template, manifest, recipes, Frozen Spec, and `specHash`.
- Full combined repair remains unavailable on the Frozen Spec path.
- Semantic fallback advances only the role attached to the typed failure.
- Materialization cache may retain only validation summaries and target evidence; it does not retain raw probe inputs.
- Process checkpoint stores manifest/recipes but no materialized probes. Resume reconstructs formal inputs, stable allocations, probes, and execution results from the same Frozen Spec and deterministic artifacts.
- `onCheckpoint(null)` clears restored role dependencies before any fallback checkpoint is emitted.
- Optional kill-target and hack calls never replace the Independent Verifier checkpoint provenance.

## Privacy and Safety

- Raw probe input is request-local and sent only to go-judge.
- Raw probe input is excluded from checkpoints, telemetry, `safeDetails`, plan notes, frontend verification, and error strings.
- Subtask failures expose only subtask ID, case index, counts, booleans, and bounded enum values.
- Manifest/coverage errors expose bounded counts and known IDs only in local plan verification; telemetry continues to export its current coarse completion/verdict fields.
- AI output remains untrusted data. The Web process parses bounded JSON and applies trusted mutations but never executes Verifier, Generator, Oracle, or supplemental code.

## Files and Responsibilities

Expected production changes are limited to:

- Create `src/services/testdata/validatorManifest.ts`: strict Manifest and bounded recipe parsing/validation.
- Create `src/services/testdata/constraintProbes.ts`: trusted seed parsing, deterministic mutation, gaps, stable IDs.
- Modify `src/services/testdataGenService.ts`: prompts, Independent Verifier parsing/repair, two Validator partitions, frozen allocation wiring, verification finalization.
- Modify `src/services/goJudgeSandboxService.ts`: backward-compatible per-invocation argv.
- Modify `src/services/testdata/failures.ts`: safe subtask/count detail allowlist and artifact-sensitive repair ownership where required.
- Modify `src/services/testdata/pipelineContext.ts`: prompt version 3.
- Modify `src/models/testdataGenerationJob.ts`: checkpoint type compatibility for the expanded verifier blueprint.
- Modify `frontend/testdataGen/TestdataGenPanel.tsx` and focused frontend tests for new fields with legacy fallback.
- Modify locale files only if new display labels cannot reuse existing keys; regenerate locale artifacts if changed.
- Rebuild tracked `dist/` after source changes.

Expected tests include:

- Create `src/__tests__/services/testdataConstraintProbes.test.ts`.
- Add focused Manifest/parser tests.
- Extend go-judge argv tests.
- Extend materialization, repair, resume, checkpoint, frontend, custom checker, language-template, stress, and benchmark regression tests.

No package file, Worker, D1, Dashboard, telemetry field, Task 9 file, or unrelated service should change.

## Test Matrix

The implementation plan must cover at least:

1. valid, missing, unknown-ID, duplicate-ID, wrong-type, extra-field, and incomplete Manifests;
2. omitted non-machine-checkable targets and empty target sets;
3. every listed deterministic construction kind plus unparseable/gap cases;
4. deterministic IDs and reconstruction across the same statement/spec/effective seed;
5. valid-only, reject-all, false-accept, multiple-probe, multiple-target, and claimed-without-execution cases;
6. invalid custom recipes and custom probes accepted by Validator;
7. legal and illegal scoped cases, global-plus-scoped enforcement, unknown and malformed subtask arguments;
8. timeout, infrastructure failure, cancellation identity, and result-count mismatch;
9. legacy, observe, enforce, and low/medium/high/blocked policy combinations;
10. Validator-only repair, Verifier manifest repair, full-repair prohibition, and role-scoped semantic fallback;
11. v2 prompt checkpoint invalidation, v3 resume reconstruction, stable allocation, and cleared provenance;
12. custom checker, Python/Java/C++ templates, stress validity/diversity/differential checking, and existing benchmark cases;
13. privacy assertions over checkpoint, verification, telemetry metadata, errors, and `safeDetails`.

## Verification and Delivery

Run focused tests first:

```bash
npx jest \
  src/__tests__/services/testdataConstraintProbes.test.ts \
  src/__tests__/services/testdataPipelineContext.test.ts \
  src/__tests__/services/testdataGenService.test.ts \
  src/__tests__/models/testdataGenerationJob.test.ts \
  src/__tests__/benchmarks/testdataBenchmark.test.ts \
  --runInBand
```

Then run:

```bash
git diff --check
npm run lint
npm test -- --runInBand --silent
npm run build:plugin
npm run build:plugin
```

The second build must create no new diff. Confirm that `package.json` and `package-lock.json` are unchanged, tracked `dist/` is synchronized, and no excluded subsystem changed.

The implementation is delivered on `codex/task8-validator-rejection-probes` with final implementation commit message:

```text
feat: verify validator rejection and subtask constraints
```

Create one independent Draft PR and do not merge it.
