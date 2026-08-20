import { TestdataPipelineError } from './failures';
import type { ProblemSpecV1 } from './problemSpec';

export const VALIDATOR_PROBE_CONSTRUCTION_KINDS = [
  'integer-below-min',
  'integer-above-max',
  'array-length-mismatch',
  'duplicate-element',
  'permutation-duplicate-or-missing',
  'illegal-string-character',
  'graph-self-loop',
  'graph-duplicate-edge',
  'graph-disconnected',
  'tree-missing-edge',
  'tree-cycle',
  'dag-cycle',
  'add-existing-object',
  'delete-missing-object',
  'operation-argument-out-of-range',
  'subtask-upper-bound',
] as const;

export type ValidatorProbeConstructionKind =
  typeof VALIDATOR_PROBE_CONSTRUCTION_KINDS[number];

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

export interface ValidatorProbeRecipe {
  targetId: string;
  constructionKind: ValidatorProbeConstructionKind;
  fieldId?: string;
  operationName?: string;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('object');
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some(key => !allowedSet.has(key))) throw new TypeError('unknown field');
  if (required.some(key => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new TypeError('missing field');
  }
}

function uniqueKnownIds(value: unknown, knownIds: ReadonlySet<string>): string[] {
  if (!Array.isArray(value)) throw new TypeError('array');
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || seen.has(item) || !knownIds.has(item)) {
      throw new TypeError('known unique id');
    }
    seen.add(item);
    ids.push(item);
  }
  return ids.sort();
}

function coverageFailure(
  requiredConstraintIds: readonly string[],
  requiredInvariantIds: readonly string[],
  declaredConstraintIds: readonly unknown[],
  declaredInvariantIds: readonly unknown[],
): TestdataPipelineError {
  return new TestdataPipelineError(
    'VALIDATOR Manifest 缺失、非法或未覆盖全部必需目标。',
    'VALIDATOR_CONSTRAINT_COVERAGE_MISSING',
    'independent_verifier_parse',
    'coverage',
    'repair-artifact',
    {
      expectedCount: requiredConstraintIds.length + requiredInvariantIds.length,
      actualCount: declaredConstraintIds.length + declaredInvariantIds.length,
    },
  );
}

export function requiredValidatorTargetIds(spec: ProblemSpecV1): {
  constraintIds: string[];
  invariantIds: string[];
} {
  return {
    constraintIds: spec.constraints
      .filter(constraint => constraint.machineCheckable === true)
      .map(constraint => constraint.id)
      .sort(),
    invariantIds: spec.invariants
      .filter(invariant => invariant.machineCheckable === true)
      .map(invariant => invariant.id)
      .sort(),
  };
}

export function parseAndValidateValidatorManifest(
  raw: string,
  spec: ProblemSpecV1,
): ValidatorManifestValidation {
  const { constraintIds: requiredConstraintIds, invariantIds: requiredInvariantIds }
    = requiredValidatorTargetIds(spec);
  let parsed: unknown;
  let declaredConstraintIds: unknown[] = [];
  let declaredInvariantIds: unknown[] = [];

  try {
    parsed = JSON.parse(raw);
    const manifest = asObject(parsed);
    exactKeys(manifest, ['constraintIds', 'invariantIds']);
    declaredConstraintIds = Array.isArray(manifest.constraintIds) ? manifest.constraintIds : [];
    declaredInvariantIds = Array.isArray(manifest.invariantIds) ? manifest.invariantIds : [];
    const constraintIds = uniqueKnownIds(
      manifest.constraintIds,
      new Set(requiredConstraintIds),
    );
    const invariantIds = uniqueKnownIds(
      manifest.invariantIds,
      new Set(requiredInvariantIds),
    );
    const missingConstraintIds = requiredConstraintIds.filter(id => !constraintIds.includes(id));
    const missingInvariantIds = requiredInvariantIds.filter(id => !invariantIds.includes(id));
    if (missingConstraintIds.length || missingInvariantIds.length) {
      throw coverageFailure(
        requiredConstraintIds,
        requiredInvariantIds,
        declaredConstraintIds,
        declaredInvariantIds,
      );
    }
    return {
      manifest: { constraintIds, invariantIds },
      requiredConstraintIds,
      requiredInvariantIds,
      missingConstraintIds,
      missingInvariantIds,
    };
  } catch (error) {
    if (error instanceof TestdataPipelineError) throw error;
    const manifest = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
    return (() => {
      throw coverageFailure(
        requiredConstraintIds,
        requiredInvariantIds,
        Array.isArray(manifest.constraintIds) ? manifest.constraintIds : [],
        Array.isArray(manifest.invariantIds) ? manifest.invariantIds : [],
      );
    })();
  }
}

export function parseAndValidateValidatorProbeRecipes(
  raw: string,
  spec: ProblemSpecV1,
): ValidatorProbeRecipe[] {
  const requiredTargets = requiredValidatorTargetIds(spec);
  const knownTargetIds = new Set([
    ...requiredTargets.constraintIds,
    ...requiredTargets.invariantIds,
  ]);
  const knownFieldIds = new Set(spec.inputFields.map(field => field.id));
  const knownOperationNames = new Set((spec.operations || []).map(operation => operation.name));
  let declaredRecipes: unknown[] = [];

  try {
    const root = asObject(JSON.parse(raw));
    exactKeys(root, ['recipes']);
    if (!Array.isArray(root.recipes)) throw new TypeError('recipes');
    declaredRecipes = root.recipes;
    if (root.recipes.length > 64) throw new TypeError('recipes');

    const canonicalRecipes = new Set<string>();
    const recipes = root.recipes.map(value => {
      const recipe = asObject(value);
      exactKeys(
        recipe,
        ['targetId', 'constructionKind', 'fieldId', 'operationName'],
        ['targetId', 'constructionKind'],
      );
      if (typeof recipe.targetId !== 'string' || recipe.targetId.length === 0
        || !knownTargetIds.has(recipe.targetId)) {
        throw new TypeError('targetId');
      }
      if (typeof recipe.constructionKind !== 'string'
        || !VALIDATOR_PROBE_CONSTRUCTION_KINDS.includes(
          recipe.constructionKind as ValidatorProbeConstructionKind,
        )) {
        throw new TypeError('constructionKind');
      }
      const fieldId = recipe.fieldId;
      let normalizedFieldId: string | undefined;
      if (fieldId !== undefined) {
        if (typeof fieldId !== 'string' || !knownFieldIds.has(fieldId)) {
          throw new TypeError('fieldId');
        }
        normalizedFieldId = fieldId;
      }
      const operationName = recipe.operationName;
      let normalizedOperationName: string | undefined;
      if (operationName !== undefined) {
        if (typeof operationName !== 'string' || !knownOperationNames.has(operationName)) {
          throw new TypeError('operationName');
        }
        normalizedOperationName = operationName;
      }

      const normalized: ValidatorProbeRecipe = {
        targetId: recipe.targetId,
        constructionKind: recipe.constructionKind as ValidatorProbeConstructionKind,
        ...(normalizedFieldId === undefined ? {} : { fieldId: normalizedFieldId }),
        ...(normalizedOperationName === undefined ? {} : { operationName: normalizedOperationName }),
      };
      const canonical = JSON.stringify({
        targetId: normalized.targetId,
        constructionKind: normalized.constructionKind,
        fieldId: normalized.fieldId,
        operationName: normalized.operationName,
      });
      if (canonicalRecipes.has(canonical)) throw new TypeError('duplicate recipe');
      canonicalRecipes.add(canonical);
      return normalized;
    });

    return recipes.map(recipe => ({ ...recipe }));
  } catch (error) {
    if (error instanceof TestdataPipelineError) throw error;
    throw coverageFailure(
      requiredTargets.constraintIds,
      requiredTargets.invariantIds,
      declaredRecipes,
      [],
    );
  }
}
