import { isDeepStrictEqual } from 'util';
import type {
  ChatCallOptions,
  MultiModelChatResult,
  MultiModelClient,
} from '../openaiClient';
import type { TestdataFailureCode } from './failures';
import { TestdataPipelineError } from './failures';
import {
  parseProblemSpecV1,
  locateStatementEvidence,
  summarizeProblemSpec,
  validateProblemSpecEvidence,
  validateProblemSpecV1,
  type ProblemSpecSummary,
  type ProblemSpecV1,
} from './problemSpec';
import { buildProblemSpecPrompt } from './problemSpecPrompts';
import type { StatementSnapshot } from './statementSnapshot';
import type { TestdataModelIdentity } from './modelRoles';
import type { TestdataModelRole } from '../../models/aiConfig';

const ADJUDICATION_MAX_LENGTH = 768 * 1024;
const RESOLUTION_REASON_MAX_LENGTH = 2048;
const RESOLUTION_EVIDENCE_MAX_LENGTH = 4096;

export interface SpecConflict {
  path: string;
  kind: 'value-mismatch';
  primaryValue: unknown;
  criticValue: unknown;
}

export interface SpecResolution {
  path: string;
  selected: 'A' | 'B' | 'new';
  evidenceQuote: string;
  reason: string;
}

export interface SpecConsensusClient {
  role: Extract<TestdataModelRole, 'specPrimary' | 'specCritic' | 'adjudicator'>;
  identity?: TestdataModelIdentity;
  client: Pick<MultiModelClient, 'chat'>;
}

export type SpecConsensusStatus = 'consensus' | 'adjudicated' | 'unresolved';

export interface SpecConsensusSafeSummary extends ProblemSpecSummary {
  status: SpecConsensusStatus;
  conflictCount: number;
  unresolvedConflictCount: number;
  rolesUsed: TestdataModelRole[];
}

export interface SpecConsensusResult {
  status: SpecConsensusStatus;
  conflictCount: number;
  unresolvedConflictCount: number;
  conflicts: SpecConflict[];
  resolvedSpec?: ProblemSpecV1;
  resolutions?: SpecResolution[];
  failureCode?: Extract<TestdataFailureCode,
    'SPEC_PARSE_FAILED' | 'SPEC_EVIDENCE_NOT_FOUND' | 'SPEC_CONSENSUS_REQUIRED'>;
  results: MultiModelChatResult[];
  rolesUsed: TestdataModelRole[];
  roleIdentities: Partial<Record<TestdataModelRole, TestdataModelIdentity>>;
  safeSummary?: SpecConsensusSafeSummary;
}

interface RunSpecConsensusInput {
  snapshot: StatementSnapshot;
  requestedProblemKind: 'auto' | 'traditional' | 'function';
  hasCustomChecker: boolean;
  primary: SpecConsensusClient;
  critic: SpecConsensusClient;
  adjudicator?: SpecConsensusClient;
  callOptions?: ChatCallOptions;
}

function text(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function signature(value: unknown): string {
  return JSON.stringify(value);
}

function normalizedSpec(spec: ProblemSpecV1): Record<string, unknown> {
  const sortObjects = <T>(items: T[]): T[] => [...items].sort((left, right) => (
    signature(left).localeCompare(signature(right))
  ));
  // Input order is part of the input encoding, so field references deliberately use
  // their canonical position. Names and model-generated IDs remain non-semantic.
  const fields = new Map(spec.inputFields.map((field, index) => [
    field.id,
    `field:${index}:${signature({ type: field.type, encoding: text(field.encoding) })}`,
  ]));

  // Constraints and subtasks are sets. First derive ID-free constraint bases, then
  // ID-free subtask signatures, and finally scoped constraint signatures. Sorting the
  // final arrays preserves duplicate multiplicity without depending on source order.
  const constraintBases = new Map(spec.constraints.map(constraint => [
    constraint.id,
    signature({
      expression: text(constraint.expression),
      machineCheckable: constraint.machineCheckable,
    }),
  ]));
  const subtaskSignatures = new Map(spec.subtasks.map(subtask => [
    subtask.id,
    signature({
      score: subtask.score,
      constraints: subtask.constraintIds
        .map(id => constraintBases.get(id) || 'missing')
        .sort(),
    }),
  ]));
  const normalizedConstraints = spec.constraints.map(constraint => ({
    expression: text(constraint.expression),
    machineCheckable: constraint.machineCheckable,
    scope: constraint.scope === 'global'
      ? 'global'
      : subtaskSignatures.get(constraint.scope.subtaskId) || 'missing',
  }));
  const constraintSignatures = new Map(spec.constraints.map((constraint, index) => [
    constraint.id,
    signature(normalizedConstraints[index]),
  ]));
  return {
    problemKind: spec.problemKind,
    testCaseMode: spec.testCaseMode.kind === 'single'
      ? { kind: 'single' }
      : { kind: 'counted', countField: fields.get(spec.testCaseMode.countField) || 'missing' },
    inputFields: spec.inputFields.map(field => ({
      type: field.type,
      encoding: text(field.encoding),
      dependsOn: [...(field.dependsOn || [])]
        .map(id => fields.get(id) || 'missing')
        .sort(),
    })),
    constraints: sortObjects(normalizedConstraints),
    invariants: sortObjects(spec.invariants.map(invariant => ({
      kind: invariant.kind,
      expression: text(invariant.expression),
      machineCheckable: invariant.machineCheckable,
    }))),
    outputPolicy: { ...spec.outputPolicy },
    operations: sortObjects((spec.operations || []).map(operation => ({
      name: text(operation.name),
      arguments: operation.arguments.map(text),
      preconditions: operation.preconditions.map(text).sort(),
      effects: operation.effects.map(text).sort(),
    }))),
    subtasks: sortObjects(spec.subtasks.map(subtask => ({
      score: subtask.score,
      constraints: subtask.constraintIds
        .map(id => constraintSignatures.get(id) || 'missing')
        .sort(),
    }))),
    uncertainties: sortObjects(spec.uncertainties.map(uncertainty => ({
      description: text(uncertainty.description),
      ...(uncertainty.evidence !== undefined ? { evidence: text(uncertainty.evidence) } : {}),
    }))),
  };
}

const DIFF_PATHS = [
  'problemKind', 'testCaseMode', 'inputFields', 'constraints', 'invariants',
  'outputPolicy', 'operations', 'subtasks', 'uncertainties',
] as const;

export function diffProblemSpecs(primary: ProblemSpecV1, critic: ProblemSpecV1): SpecConflict[] {
  const left = normalizedSpec(primary);
  const right = normalizedSpec(critic);
  return DIFF_PATHS.flatMap(path => isDeepStrictEqual(left[path], right[path])
    ? []
    : [{ path, kind: 'value-mismatch' as const, primaryValue: left[path], criticValue: right[path] }]);
}

function isCancellation(error: unknown): boolean {
  const candidate = error as { name?: string; code?: string; category?: string } | null;
  return !!candidate && (
    candidate.name === 'AbortError' || candidate.name === 'CanceledError'
    || candidate.code === 'ERR_CANCELED' || candidate.category === 'aborted'
  );
}

function failureCode(error: unknown): SpecConsensusResult['failureCode'] {
  if (error instanceof TestdataPipelineError && error.code === 'SPEC_EVIDENCE_NOT_FOUND') {
    return 'SPEC_EVIDENCE_NOT_FOUND';
  }
  if (error instanceof TestdataPipelineError && error.code === 'SPEC_CONSENSUS_REQUIRED') {
    return 'SPEC_CONSENSUS_REQUIRED';
  }
  return 'SPEC_PARSE_FAILED';
}

function validateExtractedSpec(
  raw: string,
  input: Pick<RunSpecConsensusInput, 'snapshot' | 'requestedProblemKind' | 'hasCustomChecker'>,
): ProblemSpecV1 {
  const parsed = parseProblemSpecV1(raw);
  const validated = validateProblemSpecV1(parsed, {
    hasCustomChecker: input.hasCustomChecker,
    ...(input.requestedProblemKind === 'auto'
      ? {}
      : { expectedProblemKind: input.requestedProblemKind }),
  });
  return validateProblemSpecEvidence(validated, input.snapshot);
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))
    || allowed.some(key => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new TypeError('invalid adjudication keys');
  }
}

function parseAdjudication(
  raw: string,
  conflicts: SpecConflict[],
  primary: ProblemSpecV1,
  critic: ProblemSpecV1,
  input: Pick<RunSpecConsensusInput, 'snapshot' | 'requestedProblemKind' | 'hasCustomChecker'>,
): { resolvedSpec: ProblemSpecV1; resolutions: SpecResolution[] } {
  try {
    if (!raw || raw.length > ADJUDICATION_MAX_LENGTH) throw new TypeError('length');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('object');
    const object = parsed as Record<string, unknown>;
    exactKeys(object, ['resolvedSpec', 'resolutions']);
    if (!Array.isArray(object.resolutions) || object.resolutions.length > 512) throw new TypeError('resolutions');
    const resolutions = object.resolutions.map(rawResolution => {
      if (!rawResolution || typeof rawResolution !== 'object' || Array.isArray(rawResolution)) {
        throw new TypeError('resolution');
      }
      const resolution = rawResolution as Record<string, unknown>;
      exactKeys(resolution, ['path', 'selected', 'evidenceQuote', 'reason']);
      if (typeof resolution.path !== 'string' || !resolution.path) throw new TypeError('path');
      if (!['A', 'B', 'new'].includes(String(resolution.selected))) throw new TypeError('selected');
      if (typeof resolution.evidenceQuote !== 'string' || !resolution.evidenceQuote
        || resolution.evidenceQuote.length > RESOLUTION_EVIDENCE_MAX_LENGTH) throw new TypeError('evidence');
      if (typeof resolution.reason !== 'string' || !resolution.reason
        || resolution.reason.length > RESOLUTION_REASON_MAX_LENGTH) throw new TypeError('reason');
      return resolution as unknown as SpecResolution;
    });
    const expectedPaths = conflicts.map(conflict => conflict.path);
    const actualPaths = resolutions.map(resolution => resolution.path);
    if (new Set(actualPaths).size !== actualPaths.length
      || actualPaths.length !== expectedPaths.length
      || actualPaths.some(path => !expectedPaths.includes(path))) {
      throw new TestdataPipelineError(
        '裁决结果未覆盖全部题意冲突。',
        'SPEC_CONSENSUS_REQUIRED',
        'spec_consensus',
        'spec',
        'manual-review',
        { conflictCount: expectedPaths.length, resolutionCount: actualPaths.length },
      );
    }
    for (const resolution of resolutions) {
      locateStatementEvidence(input.snapshot, { quote: resolution.evidenceQuote });
    }
    const resolvedSpec = validateExtractedSpec(JSON.stringify(object.resolvedSpec), input);
    const normalizedResolved = normalizedSpec(resolvedSpec);
    const normalizedPrimary = normalizedSpec(primary);
    const normalizedCritic = normalizedSpec(critic);
    const conflictPaths = new Set(conflicts.map(conflict => conflict.path));
    for (const path of DIFF_PATHS) {
      if (conflictPaths.has(path)) continue;
      if (!isDeepStrictEqual(normalizedPrimary[path], normalizedCritic[path])
        || !isDeepStrictEqual(normalizedResolved[path], normalizedPrimary[path])) {
        throw new TestdataPipelineError(
          '裁决结果修改了无冲突字段。',
          'SPEC_CONSENSUS_REQUIRED',
          'spec_consensus',
          'spec',
          'manual-review',
        );
      }
    }
    for (const resolution of resolutions) {
      const conflict = conflicts.find(item => item.path === resolution.path);
      const actual = normalizedResolved[resolution.path];
      const matchesA = !!conflict && isDeepStrictEqual(actual, conflict.primaryValue);
      const matchesB = !!conflict && isDeepStrictEqual(actual, conflict.criticValue);
      const consistent = resolution.selected === 'A'
        ? matchesA
        : resolution.selected === 'B'
          ? matchesB
          : !matchesA && !matchesB;
      if (!conflict || !consistent) {
        throw new TestdataPipelineError(
          '裁决选择与 resolvedSpec 不一致。',
          'SPEC_CONSENSUS_REQUIRED',
          'spec_consensus',
          'spec',
          'manual-review',
        );
      }
    }
    return { resolvedSpec, resolutions };
  } catch (error) {
    if (error instanceof TestdataPipelineError) throw error;
    throw new TestdataPipelineError(
      '裁决输出不符合严格契约。',
      'SPEC_CONSENSUS_REQUIRED',
      'spec_consensus',
      'spec',
      'manual-review',
    );
  }
}

function buildAdjudicatorPrompts(
  snapshot: StatementSnapshot,
  primary: ProblemSpecV1,
  critic: ProblemSpecV1,
  conflicts: SpecConflict[],
): { systemPrompt: string; userPrompt: string } {
  return {
    systemPrompt: '你是 OJ 题意裁决器。只输出严格 JSON：resolvedSpec 和 resolutions。不得生成 ORACLE、validator、生成器或代码。每个冲突必须恰好一条 resolution，selected 只能是 A、B、new，evidenceQuote 必须逐字来自题面。',
    userPrompt: [
      '=== COMPLETE STATEMENT ===',
      snapshot.normalizedMarkdown,
      '=== SPEC A ===',
      JSON.stringify(primary),
      '=== SPEC B ===',
      JSON.stringify(critic),
      '=== SERVER CONFLICTS ===',
      JSON.stringify(conflicts),
    ].join('\n'),
  };
}

function safeSummary(
  status: SpecConsensusStatus,
  conflicts: SpecConflict[],
  unresolvedConflictCount: number,
  rolesUsed: TestdataModelRole[],
  spec?: ProblemSpecV1,
): SpecConsensusSafeSummary | undefined {
  if (!spec) return undefined;
  return {
    ...summarizeProblemSpec(spec),
    status,
    conflictCount: conflicts.length,
    unresolvedConflictCount,
    rolesUsed,
  };
}

export async function runProblemSpecConsensus(
  input: RunSpecConsensusInput,
): Promise<SpecConsensusResult> {
  const prompt = buildProblemSpecPrompt(input);
  const extract = async (source: SpecConsensusClient) => {
    try {
      const result = await source.client.chat(
        [{ role: 'user', content: prompt.userPrompt }],
        prompt.systemPrompt,
        input.callOptions,
      );
      return { result, spec: validateExtractedSpec(result.content, input) };
    } catch (error) {
      if (isCancellation(error)) throw error;
      return { error };
    }
  };
  const [primary, critic] = await Promise.all([extract(input.primary), extract(input.critic)]);
  const results = [primary.result, critic.result].filter(Boolean) as MultiModelChatResult[];
  const rolesUsed: TestdataModelRole[] = ['specPrimary', 'specCritic'];
  const roleIdentities: Partial<Record<TestdataModelRole, TestdataModelIdentity>> = {};
  if (primary.result) roleIdentities.specPrimary = { ...primary.result.usedModel };
  if (critic.result) roleIdentities.specCritic = { ...critic.result.usedModel };
  if (!primary.spec || !critic.spec) {
    const error = primary.error || critic.error;
    return {
      status: 'unresolved',
      conflictCount: 0,
      unresolvedConflictCount: 1,
      conflicts: [],
      failureCode: failureCode(error),
      results,
      rolesUsed,
      roleIdentities,
    };
  }

  const conflicts = diffProblemSpecs(primary.spec, critic.spec);
  if (conflicts.length === 0) {
    return {
      status: 'consensus',
      conflictCount: 0,
      unresolvedConflictCount: 0,
      conflicts,
      resolvedSpec: primary.spec,
      results,
      rolesUsed,
      roleIdentities,
      safeSummary: safeSummary('consensus', conflicts, 0, rolesUsed, primary.spec),
    };
  }
  if (!input.adjudicator) {
    return {
      status: 'unresolved',
      conflictCount: conflicts.length,
      unresolvedConflictCount: conflicts.length,
      conflicts,
      failureCode: 'SPEC_CONSENSUS_REQUIRED',
      results,
      rolesUsed,
      roleIdentities,
    };
  }

  const adjudicatorPrompt = buildAdjudicatorPrompts(
    input.snapshot, primary.spec, critic.spec, conflicts,
  );
  rolesUsed.push('adjudicator');
  let adjudicatorResult: MultiModelChatResult;
  try {
    adjudicatorResult = await input.adjudicator.client.chat(
      [{ role: 'user', content: adjudicatorPrompt.userPrompt }],
      adjudicatorPrompt.systemPrompt,
      input.callOptions,
    );
    results.push(adjudicatorResult);
    roleIdentities.adjudicator = { ...adjudicatorResult.usedModel };
    const adjudication = parseAdjudication(
      adjudicatorResult.content,
      conflicts,
      primary.spec,
      critic.spec,
      input,
    );
    return {
      status: 'adjudicated',
      conflictCount: conflicts.length,
      unresolvedConflictCount: 0,
      conflicts,
      resolvedSpec: adjudication.resolvedSpec,
      resolutions: adjudication.resolutions,
      results,
      rolesUsed,
      roleIdentities,
      safeSummary: safeSummary(
        'adjudicated', conflicts, 0, rolesUsed, adjudication.resolvedSpec,
      ),
    };
  } catch (error) {
    if (isCancellation(error)) throw error;
    return {
      status: 'unresolved',
      conflictCount: conflicts.length,
      unresolvedConflictCount: conflicts.length,
      conflicts,
      failureCode: failureCode(error),
      results,
      rolesUsed,
      roleIdentities,
    };
  }
}
