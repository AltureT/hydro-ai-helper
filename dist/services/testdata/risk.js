"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTestdataReliabilityMode = getTestdataReliabilityMode;
exports.getTestdataDirectFallbackEnabled = getTestdataDirectFallbackEnabled;
exports.assessTestdataRisk = assessTestdataRisk;
const CUSTOM_CHECKER_SIGNAL = {
    code: 'CUSTOM_CHECKER', weight: 3, messageKey: 'ai_helper_testdata_risk_custom_checker',
};
const RISK_PATTERNS = {
    multipleValidOutput: /\b(?:multiple|many|any)\s+(?:valid|correct)\s+(?:outputs?|answers?)\b|(?:多个答案|答案不唯一|任意(?:合法|正确)(?:答案|输出))/i,
    floatingPoint: /\b(?:floating(?:\s|-)?point|absolute\s+(?:or\s+)?relative\s+error|precision)\b|(?:浮点|精度|误差)/i,
    statefulOperations: /\b(?:ADD|DEL|DELETE|ROLLBACK|UNDO|DYNAMIC\s+(?:UPDATE|MODIFICATION)|MODIFY)\b|(?:添加|删除|撤销|回滚|动态(?:修改|操作))/i,
    subtasks: /\bsubtasks?\b|(?:子任务|部分分)/i,
    graphOrTree: /\b(?:graph|tree|vertices|edges|adjacency)\b|(?:图|树|节点|边|邻接)/i,
    complexStructure: /\b(?:nested|matrix|multidimensional|linked\s+list|struct(?:ure)?)\b|(?:嵌套|矩阵|二维|多维|链表|结构体)/i,
    countedCases: /\b(?:first\s+line\s+(?:contains|has)\s+T(?:\s+(?:test\s+)?cases?)?|T\s+test\s+cases?)\b|(?:第一行.*(?:T|t).*?(?:组|测试)|(?:多组|T\s*组)测试)/i,
    parseableSample: /(?:^|\n)\s*(?:#{1,6}\s*)?(?:input|输入)(?:\s*(?:sample|样例|example|\d+))?\s*\n?\s*```[^\n]*\n[\s\S]*?\n```[\s\S]{0,400}?(?:^|\n)\s*(?:#{1,6}\s*)?(?:output|输出)(?:\s*(?:sample|样例|example|\d+))?\s*\n?\s*```[^\n]*\n[\s\S]*?\n```/i,
};
function signal(code, weight, messageKey) {
    return { code, weight, messageKey };
}
function tierForScore(score) {
    if (score >= 6)
        return 'high';
    if (score >= 3)
        return 'medium';
    return 'low';
}
function getTestdataReliabilityMode(raw = process.env.AI_HELPER_TESTDATA_RELIABILITY_MODE) {
    const value = String(raw || 'observe').trim().toLowerCase();
    return value === 'legacy' || value === 'enforce' ? value : 'observe';
}
function getTestdataDirectFallbackEnabled(raw = process.env.AI_HELPER_TESTDATA_ALLOW_DIRECT_FALLBACK) {
    return String(raw || '').trim().toLowerCase() === 'true';
}
function assessTestdataRisk(input) {
    const statement = String(input.statement || '');
    const reasons = [];
    const addIf = (condition, risk) => {
        if (condition)
            reasons.push(risk);
    };
    addIf(!!input.hasCustomChecker, CUSTOM_CHECKER_SIGNAL);
    addIf(RISK_PATTERNS.multipleValidOutput.test(statement), signal('MULTIPLE_VALID_OUTPUT', 3, 'ai_helper_testdata_risk_multiple_valid_output'));
    addIf(RISK_PATTERNS.floatingPoint.test(statement), signal('FLOATING_POINT', 3, 'ai_helper_testdata_risk_floating_point'));
    addIf(RISK_PATTERNS.statefulOperations.test(statement), signal('STATEFUL_OPERATIONS', 2, 'ai_helper_testdata_risk_stateful_operations'));
    addIf(RISK_PATTERNS.subtasks.test(statement), signal('SUBTASKS', 2, 'ai_helper_testdata_risk_subtasks'));
    addIf(RISK_PATTERNS.graphOrTree.test(statement), signal('GRAPH_OR_TREE', 2, 'ai_helper_testdata_risk_graph_or_tree'));
    addIf(RISK_PATTERNS.complexStructure.test(statement), signal('COMPLEX_STRUCTURE', 2, 'ai_helper_testdata_risk_complex_structure'));
    addIf(statement.length > 16000, signal('STATEMENT_TOO_LONG', 2, 'ai_helper_testdata_risk_statement_too_long'));
    addIf(RISK_PATTERNS.countedCases.test(statement), signal('COUNTED_TEST_CASES', 1, 'ai_helper_testdata_risk_counted_test_cases'));
    addIf(!RISK_PATTERNS.parseableSample.test(statement), signal('NO_PARSEABLE_SAMPLES', 1, 'ai_helper_testdata_risk_no_parseable_samples'));
    addIf(!!input.specConflict, signal('SPEC_CONFLICT', 3, 'ai_helper_testdata_risk_spec_conflict'));
    addIf(!!input.statementTruncated, signal('STATEMENT_TRUNCATED', 3, 'ai_helper_testdata_risk_statement_truncated'));
    if (input.unsupportedCustomChecker) {
        reasons.push(signal('UNSUPPORTED_CUSTOM_CHECKER', 0, 'ai_helper_testdata_risk_unsupported_custom_checker'));
    }
    const score = reasons.reduce((total, item) => total + item.weight, 0);
    // A truncated statement is semantically incomplete: its missing constraints
    // cannot be made safe by a direct-output confirmation.
    const tier = input.unsupportedCustomChecker || input.statementTruncated
        ? 'blocked'
        : tierForScore(score);
    const allowsDirectFallback = tier === 'low'
        ? input.directFallbackEnabled
        : tier === 'medium'
            ? input.directFallbackEnabled && input.confirmDirectFallback === true
            : false;
    const requiresSandbox = !allowsDirectFallback;
    const requiresSpecConsensus = !!input.specConflict || tier === 'high' || tier === 'blocked';
    const requiresIndependentModels = tier === 'high' || tier === 'blocked';
    return {
        tier,
        score,
        reasons: reasons.map(({ code, weight, messageKey }) => ({ code, weight, messageKey })),
        requiresSandbox,
        requiresSpecConsensus,
        requiresIndependentModels,
        allowsDirectFallback,
        ...(input.reliabilityMode === 'observe' ? { wouldBlock: !allowsDirectFallback } : {}),
    };
}
//# sourceMappingURL=risk.js.map