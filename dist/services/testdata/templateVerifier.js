"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TemplateVerificationError = void 0;
exports.verifySelectedTemplates = verifySelectedTemplates;
const goJudgeSandboxService_1 = require("../goJudgeSandboxService");
class TemplateVerificationError extends Error {
    constructor(language, kind, check, caseIndex) {
        super(`模板 ${language} 验证${kind}失败`);
        this.language = language;
        this.kind = kind;
        this.check = check;
        this.caseIndex = caseIndex;
        this.name = 'TemplateVerificationError';
    }
}
exports.TemplateVerificationError = TemplateVerificationError;
function comparableFileContent(content) {
    return content
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n')
        .map(line => line.trimEnd())
        .join('\n')
        .trimEnd();
}
function isCancellation(error) {
    const candidate = error;
    return !!candidate && (candidate.name === 'AbortError' || candidate.name === 'CanceledError'
        || candidate.code === 'ERR_CANCELED' || candidate.category === 'aborted');
}
function fail(language, kind, check, caseIndex) {
    throw new TemplateVerificationError(language, kind, { ...check, failureKind: kind }, caseIndex);
}
function assertPresentSource(input, language) {
    const solution = input.solutions[language];
    const template = input.templates[language];
    if (!solution?.trim() || !template?.trim()) {
        fail(language, 'compile', { compiled: false, executed: false, total: input.cases.length, passed: 0 });
    }
    return { solution, template };
}
function throwExecutionError(input, language, check, error) {
    if (input.signal?.aborted)
        throw input.signal.reason ?? error;
    if (isCancellation(error))
        throw error;
    if ((0, goJudgeSandboxService_1.isSandboxBudgetExceededError)(error))
        fail(language, 'budget', check);
    fail(language, 'runtime', check);
}
function throwIfCancelledOrExpired(input, language, check) {
    if (input.signal?.aborted) {
        throw input.signal.reason ?? Object.assign(new Error('canceled'), { name: 'AbortError' });
    }
    const deadlineAt = input.deadlineAtProvider?.() ?? input.deadlineAt;
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
        fail(language, 'budget', check);
    }
}
async function deleteCachedFile(runner, fileId) {
    try {
        await runner.deleteCachedFile?.(fileId);
    }
    catch {
        // Cache deletion is best-effort and must not hide cancellation or verification failures.
    }
}
async function runLanguage(input, language) {
    const { solution, template } = assertPresentSource(input, language);
    const inputs = input.cases.map(testcase => testcase.input);
    const options = {
        signal: input.signal,
        deadlineAt: input.deadlineAtProvider?.() ?? input.deadlineAt,
    };
    const baseCheck = {
        compiled: language === 'py', executed: false, total: inputs.length, passed: 0,
    };
    if (language === 'py') {
        try {
            return await input.runner.runPythonBatchDetailed(`${solution}\n${template}`, inputs, options);
        }
        catch (error) {
            return throwExecutionError(input, language, baseCheck, error);
        }
    }
    if (language === 'cc') {
        if (!input.runner.compileCpp || !input.runner.runCompiledBatchDetailed) {
            fail(language, 'compile', baseCheck);
        }
        let compiled;
        try {
            compiled = await input.runner.compileCpp(template, {
                extraFiles: { 'foo.cc': solution }, ...options,
            });
        }
        catch (error) {
            return throwExecutionError(input, language, baseCheck, error);
        }
        if (!compiled.ok)
            fail(language, 'compile', baseCheck);
        try {
            return await input.runner.runCompiledBatchDetailed(compiled.fileId, inputs, options);
        }
        catch (error) {
            return throwExecutionError(input, language, { ...baseCheck, compiled: true }, error);
        }
        finally {
            await deleteCachedFile(input.runner, compiled.fileId);
        }
    }
    if (!input.runner.compileJava || !input.runner.runJavaBatchDetailed) {
        fail(language, 'compile', baseCheck);
    }
    let compiled;
    try {
        compiled = await input.runner.compileJava(template, solution, options);
    }
    catch (error) {
        return throwExecutionError(input, language, baseCheck, error);
    }
    if (!compiled.ok)
        fail(language, 'compile', baseCheck);
    try {
        return await input.runner.runJavaBatchDetailed(compiled.fileId, inputs, options);
    }
    catch (error) {
        return throwExecutionError(input, language, { ...baseCheck, compiled: true }, error);
    }
    finally {
        await deleteCachedFile(input.runner, compiled.fileId);
    }
}
async function adjudicate(input, language, results) {
    const check = {
        compiled: true,
        executed: results.length === input.cases.length,
        total: input.cases.length,
        passed: 0,
    };
    if (!check.executed)
        fail(language, 'runtime', check);
    const badExecution = results.findIndex(result => !result.accepted);
    if (badExecution !== -1)
        fail(language, 'runtime', check, badExecution);
    if (!input.adjudicator.customChecker) {
        throwIfCancelledOrExpired(input, language, check);
        const mismatch = results.findIndex((result, index) => (comparableFileContent(result.stdout) !== comparableFileContent(input.cases[index].answer)));
        check.passed = mismatch === -1 ? check.total : mismatch;
        if (mismatch !== -1)
            fail(language, 'mismatch', check, mismatch);
        return check;
    }
    let verdicts;
    try {
        throwIfCancelledOrExpired(input, language, check);
        verdicts = await input.adjudicator.adjudicate(results.map((result, index) => ({
            input: input.cases[index].input,
            output: result.stdout,
            answer: input.cases[index].answer,
        })), {
            signal: input.signal,
            deadlineAt: input.deadlineAtProvider?.() ?? input.deadlineAt,
        });
        throwIfCancelledOrExpired(input, language, check);
    }
    catch (error) {
        if (input.signal?.aborted)
            throw input.signal.reason ?? error;
        if (isCancellation(error))
            throw error;
        if (error instanceof TemplateVerificationError)
            throw error;
        if ((0, goJudgeSandboxService_1.isSandboxBudgetExceededError)(error))
            fail(language, 'budget', check);
        return checkerInfraResult(input, language, check);
    }
    if (verdicts.length !== check.total)
        return checkerInfraResult(input, language, check);
    const infraIndex = verdicts.findIndex(verdict => (verdict === 'infra-error' || (verdict !== 'accept' && verdict !== 'reject')));
    if (infraIndex !== -1)
        return checkerInfraResult(input, language, check, infraIndex);
    const rejected = verdicts.findIndex(verdict => verdict !== 'accept');
    check.passed = rejected === -1 ? check.total : rejected;
    if (rejected !== -1)
        fail(language, 'mismatch', check, rejected);
    return check;
}
function checkerInfraResult(input, language, check, caseIndex) {
    const failed = { ...check, failureKind: 'checker-infra' };
    if (input.allowCheckerInfraResult)
        return failed;
    fail(language, 'checker-infra', failed, caseIndex);
}
async function verifySelectedTemplates(input) {
    const checks = {};
    for (const language of input.languages) {
        const results = await runLanguage(input, language);
        throwIfCancelledOrExpired(input, language, {
            compiled: true,
            executed: results.length === input.cases.length,
            total: input.cases.length,
            passed: 0,
        });
        checks[language] = await adjudicate(input, language, results);
    }
    return checks;
}
//# sourceMappingURL=templateVerifier.js.map