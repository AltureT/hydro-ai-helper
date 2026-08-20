import {
  canonicalProblemSpec,
  type TestdataPipelineContext,
} from './pipelineContext';

export function buildFrozenProblemSpecBlock(context: TestdataPipelineContext): string {
  return [
    '【FROZEN_PROBLEM_SPEC（唯一机器题意契约，不得修改或重新解释）】',
    `specHash: ${context.specHash}`,
    canonicalProblemSpec(context.spec),
  ].join('\n');
}

export function buildFrozenStatementEvidenceBlock(context: TestdataPipelineContext): string {
  return [
    '【题面证据（仅用于实现 frozen spec；若文字与 Spec 冲突，必须报告而不得改写 Spec）】',
    context.statement.normalizedMarkdown,
  ].join('\n');
}

export function buildFrozenInputEncodingBlock(context: TestdataPipelineContext): string {
  const mode = context.spec.testCaseMode.kind === 'counted'
    ? `counted; countField=${context.spec.testCaseMode.countField}`
    : 'single';
  return [
    '【冻结 stdin encoding】',
    `testCaseMode: ${mode}`,
    ...context.spec.inputFields.map(field => (
      `${field.id} (${field.type}): ${field.encoding}`
      + (field.dependsOn?.length ? `; dependsOn=${field.dependsOn.join(',')}` : '')
    )),
  ].join('\n');
}
