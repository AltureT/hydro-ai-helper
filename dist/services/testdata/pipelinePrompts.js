"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildFrozenProblemSpecBlock = buildFrozenProblemSpecBlock;
exports.buildFrozenStatementEvidenceBlock = buildFrozenStatementEvidenceBlock;
exports.buildFrozenInputEncodingBlock = buildFrozenInputEncodingBlock;
const pipelineContext_1 = require("./pipelineContext");
function buildFrozenProblemSpecBlock(context) {
    return [
        '【FROZEN_PROBLEM_SPEC（唯一机器题意契约，不得修改或重新解释）】',
        `specHash: ${context.specHash}`,
        (0, pipelineContext_1.canonicalProblemSpec)(context.spec),
    ].join('\n');
}
function buildFrozenStatementEvidenceBlock(context) {
    return [
        '【题面证据（仅用于实现 frozen spec；若文字与 Spec 冲突，必须报告而不得改写 Spec）】',
        context.statement.normalizedMarkdown,
    ].join('\n');
}
function buildFrozenInputEncodingBlock(context) {
    const mode = context.spec.testCaseMode.kind === 'counted'
        ? `counted; countField=${context.spec.testCaseMode.countField}`
        : 'single';
    return [
        '【冻结 stdin encoding】',
        `testCaseMode: ${mode}`,
        ...context.spec.inputFields.map(field => (`${field.id} (${field.type}): ${field.encoding}`
            + (field.dependsOn?.length ? `; dependsOn=${field.dependsOn.join(',')}` : ''))),
    ].join('\n');
}
//# sourceMappingURL=pipelinePrompts.js.map