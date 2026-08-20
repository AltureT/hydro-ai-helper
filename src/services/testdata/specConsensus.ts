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

function fieldKeys(spec: ProblemSpecV1): Map<string, string> {
  return new Map(spec.inputFields.map(field => [field.id, text(field.name).toLowerCase()]));
}

function constraintKeys(spec: ProblemSpecV1): Map<string, string> {
  return new Map(spec.constraints.map(constraint => [constraint.id, text(constraint.expression)]));
}

function subtaskScore(spec: ProblemSpecV1, id: number): number | undefined {
  return spec.subtasks.find(subtask => subtask.id === id)?.score;
}

function normalizedSpec(spec: ProblemSpecV1): Record<string, unknown> {
  const fields = fieldKeys(spec);
  const constraints = constraintKeys(spec);
  const sortObjects = <T>(items: T[]): T[] => [...items].sort((left, right) => (
    JSON.stringify(left).localeCompare(JSON.stringify(right))
  ));
  return {
    problemKind: spec.problemKind,
    testCaseMode: spec.testCaseMode.kind === 'single'
      ? { kind: 'single' }
      : { kind: 'counted', countField: fields.get(spec.testCaseMode.countField) || 'missing' },
    inputFields: sortObjects(spec.inputFields.map(field => ({
      name: text(field.name).toLowerCase(),
      type: field.type,
      encoding: text(field.encoding),
      dependsOn: [...(field.dependsOn || [])]
        .map(id => fields.get(id) || 'missing')
        .sort(),
    }))),
    constraints: sortObjects(spec.constraints.map(constraint => ({
      expression: text(constraint.expression),
      machineCheckable: constraint.machineCheckable,
      scope: constraint.scope === 'global'
        ? 'global'
        : { subtaskScore: subtaskScore(spec, constraint.scope.subtaskId) },
    }))),
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
      constraints: subtask.constraintIds.map(id => constraints.get(id) || 'missing').sort(),
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
      if (!input.snapshot.normalizedMarkdown.includes(resolution.evidenceQuote)) {
        throw new TestdataPipelineError(
          '裁决证据无法在完整题面中定位。',
          'SPEC_EVIDENCE_NOT_FOUND',
          'spec_consensus',
          'spec',
          'manual-review',
        );
      }
    }
    const resolvedSpec = validateExtractedSpec(JSON.stringify(object.resolvedSpec), input);
    const normalizedResolved = normalizedSpec(resolvedSpec);
    for (const resolution of resolutions) {
      if (resolution.selected === 'new') continue;
      const conflict = conflicts.find(item => item.path === resolution.path);
      const expected = resolution.selected === 'A'
        ? conflict?.primaryValue
        : conflict?.criticValue;
      if (!conflict || !isDeepStrictEqual(normalizedResolved[resolution.path], expected)) {
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
    const adjudication = parseAdjudication(adjudicatorResult.content, conflicts, input);
    return {
      status: 'adjudicated',
      conflictCount: conflicts.length,
      unresolvedConflictCount: 0,
      conflicts,
      resolvedSpec: adjudication.resolvedSpec,
      resolutions: adjudication.resolutions,
      results,
      rolesUsed,
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
    };
  }
}
