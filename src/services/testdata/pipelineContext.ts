import { createHash } from 'crypto';
import type { TestdataModelRole } from '../../models/aiConfig';
import {
  type ProblemSpecV1,
  type ProblemSpecValidationOptions,
  validateProblemSpecEvidence,
  validateProblemSpecV1,
} from './problemSpec';
import type { TestdataRiskAssessment } from './risk';
import type { StatementSnapshot } from './statementSnapshot';
import { TestdataPipelineError } from './failures';

export const TESTDATA_CHECKPOINT_SCHEMA_VERSION = 2 as const;
export const TESTDATA_PIPELINE_PROMPT_VERSION = 'testdata-generation-v7' as const;

export interface TestdataPipelineContext {
  runId: string;
  promptVersion: string;
  statement: StatementSnapshot;
  spec: ProblemSpecV1;
  specHash: string;
  risk: TestdataRiskAssessment;
  roleIdentities: Partial<Record<TestdataModelRole, string>>;
}

export interface CreateTestdataPipelineContextInput {
  runId: string;
  promptVersion: string;
  statement: StatementSnapshot;
  spec: ProblemSpecV1;
  risk: TestdataRiskAssessment;
  roleIdentities: Partial<Record<TestdataModelRole, string>>;
  specValidation?: ProblemSpecValidationOptions;
}

function cloneJsonValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => cloneJsonValue(item)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, cloneJsonValue(item)])) as T;
  }
  return value;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => canonicalize(item));
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record)
      .filter(key => record[key] !== undefined)
      .sort()
      .map(key => [key, canonicalize(record[key])]));
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  return Object.freeze(value);
}

export function canonicalProblemSpec(spec: ProblemSpecV1): string {
  return JSON.stringify(canonicalize(spec));
}

export function computeProblemSpecHash(spec: ProblemSpecV1): string {
  return createHash('sha256').update(canonicalProblemSpec(spec), 'utf8').digest('hex');
}

export function hashTestdataRoleIdentity(identity: string): string {
  return createHash('sha256').update(identity, 'utf8').digest('hex');
}

function canonicalPart(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function referenceContract(spec: ProblemSpecV1): unknown {
  return {
    fields: spec.inputFields.map(field => ({ id: field.id, dependsOn: field.dependsOn || [] })),
    constraints: spec.constraints.map(constraint => ({ id: constraint.id, scope: constraint.scope })),
    invariants: spec.invariants.map(invariant => invariant.id),
    subtasks: spec.subtasks.map(subtask => ({
      id: subtask.id,
      constraintIds: subtask.constraintIds,
    })),
  };
}

export function assertProblemSpecUnchanged(
  context: TestdataPipelineContext,
  candidate: ProblemSpecV1 = context.spec,
): string {
  const grounded = validateProblemSpecEvidence(validateProblemSpecV1(candidate), context.statement);
  const candidateHash = computeProblemSpecHash(grounded);
  const changed = [
    context.spec.problemKind !== grounded.problemKind ? 'problemKind' : undefined,
    canonicalPart(context.spec.testCaseMode) !== canonicalPart(grounded.testCaseMode)
      ? 'testCaseMode'
      : undefined,
    canonicalPart(context.spec.inputFields.map(field => ({
      id: field.id,
      type: field.type,
      encoding: field.encoding,
      dependsOn: field.dependsOn || [],
    }))) !== canonicalPart(grounded.inputFields.map(field => ({
      id: field.id,
      type: field.type,
      encoding: field.encoding,
      dependsOn: field.dependsOn || [],
    }))) ? 'stdinEncoding' : undefined,
    canonicalPart(context.spec.outputPolicy) !== canonicalPart(grounded.outputPolicy)
      ? 'outputPolicy'
      : undefined,
    canonicalPart(context.spec.subtasks) !== canonicalPart(grounded.subtasks)
      ? 'subtasks'
      : undefined,
    canonicalPart(referenceContract(context.spec)) !== canonicalPart(referenceContract(grounded))
      ? 'references'
      : undefined,
    candidateHash !== context.specHash ? 'specHash' : undefined,
  ].filter(Boolean);
  if (changed.length > 0) {
    throw new TestdataPipelineError(
      '局部生成或修复试图改变 frozen ProblemSpec；必须回到 Spec 共识阶段。',
      'SPEC_PARSE_FAILED',
      'spec_consensus',
      'spec',
      'rerun-spec',
    );
  }
  return candidateHash;
}

export function createTestdataPipelineContext(
  input: CreateTestdataPipelineContextInput,
): TestdataPipelineContext {
  const schemaValidated = validateProblemSpecV1(input.spec, input.specValidation);
  const grounded = validateProblemSpecEvidence(schemaValidated, input.statement);
  const statement = deepFreeze(cloneJsonValue(input.statement));
  const spec = deepFreeze(cloneJsonValue(grounded));
  const risk = deepFreeze(cloneJsonValue(input.risk));
  const roleIdentities = deepFreeze(cloneJsonValue(input.roleIdentities));

  return Object.freeze({
    runId: input.runId,
    promptVersion: input.promptVersion,
    statement,
    spec,
    specHash: computeProblemSpecHash(spec),
    risk,
    roleIdentities,
  });
}
