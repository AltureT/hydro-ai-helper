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
    '【完整公开题面证据（仅用于实现 frozen Spec 的题意与计算语义）】',
    '- Frozen ProblemSpec 仍是唯一结构契约。',
    '- 不得用题面重新定义 problemKind、testCaseMode、stdin encoding、outputPolicy、subtasks 或任何约束/不变量引用。',
    '- 若题面文字与 Frozen ProblemSpec 冲突，必须报告冲突，不得改写或重新解释 Spec。',
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
