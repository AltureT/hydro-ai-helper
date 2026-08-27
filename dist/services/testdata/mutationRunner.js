"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MUTATION_CONCURRENCY_MAX = exports.MUTATION_CONCURRENCY_MIN = exports.MUTATION_CONCURRENCY_DEFAULT = exports.MUTATION_SCORE_THRESHOLD = exports.MUTATION_BUDGET_MS = void 0;
exports.getMutationConcurrency = getMutationConcurrency;
exports.evaluateMutationCandidates = evaluateMutationCandidates;
const goJudgeSandboxService_1 = require("../goJudgeSandboxService");
exports.MUTATION_BUDGET_MS = 120000;
exports.MUTATION_SCORE_THRESHOLD = 0.8;
exports.MUTATION_CONCURRENCY_DEFAULT = 2;
exports.MUTATION_CONCURRENCY_MIN = 1;
exports.MUTATION_CONCURRENCY_MAX = 4;
function getMutationConcurrency(raw = process.env.AI_HELPER_TESTDATA_MUTATION_CONCURRENCY) {
    if (!raw || !/^\d+$/.test(raw))
        return exports.MUTATION_CONCURRENCY_DEFAULT;
    const concurrency = Number(raw);
    return Number.isSafeInteger(concurrency)
        && concurrency >= exports.MUTATION_CONCURRENCY_MIN
        && concurrency <= exports.MUTATION_CONCURRENCY_MAX
        ? concurrency
        : exports.MUTATION_CONCURRENCY_DEFAULT;
}
const EXPLICIT_KILLED_STATUSES = new Set([
    'Wrong Answer',
    'Runtime Error',
    'Memory Limit Exceeded',
    'Output Limit Exceeded',
    'Time Limit Exceeded',
]);
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
    const value = error;
    return !!value && (value.name === 'AbortError'
        || value.name === 'CanceledError'
        || value.code === 'ERR_CANCELED'
        || value.category === 'aborted');
}
function throwIfCancelled(signal, error) {
    if (signal?.aborted) {
        throw signal.reason ?? Object.assign(new Error('canceled'), { name: 'AbortError' });
    }
    if (isCancellation(error))
        throw error;
}
function classifyExecutionDetails(details, expectedLength) {
    if (details.length !== expectedLength)
        return 'infra';
    for (const item of details) {
        if (!item || typeof item.status !== 'string')
            return 'infra';
        if (item.timedOut)
            return 'timeout';
        if (EXPLICIT_KILLED_STATUSES.has(item.status))
            return 'killed';
        if (item.status === 'Accepted' && item.accepted && (item.exitStatus ?? 0) === 0)
            continue;
        if (item.status === 'Accepted' && Number.isInteger(item.exitStatus) && item.exitStatus !== 0) {
            return 'killed';
        }
        return 'infra';
    }
    return 'accepted';
}
async function judgeAcceptedOutputs(input) {
    if (input.customChecker) {
        if (!input.judgeWithChecker)
            return 'checker-infra';
        try {
            const verdicts = await input.judgeWithChecker(input.cases.map((formalCase, index) => ({
                input: formalCase.input,
                output: input.details[index]?.stdout || '',
                answer: formalCase.answer,
            })), { signal: input.signal, deadlineAt: input.deadlineAt });
            if (verdicts.length !== input.cases.length || verdicts.some(item => item === 'infra-error')) {
                return 'checker-infra';
            }
            return verdicts.some(item => item === 'reject') ? 'killed' : 'survived';
        }
        catch (error) {
            throwIfCancelled(input.signal, error);
            return (0, goJudgeSandboxService_1.isSandboxBudgetExceededError)(error) || Date.now() >= input.deadlineAt
                ? 'budget-exhausted'
                : 'checker-infra';
        }
    }
    const differs = input.details.some((item, index) => (comparableFileContent(item.stdout)
        !== comparableFileContent(input.cases[index]?.answer || '')));
    return differs ? 'killed' : 'survived';
}
async function runAcceptedCandidate(input) {
    let details;
    try {
        details = await input.run();
    }
    catch (error) {
        throwIfCancelled(input.signal, error);
        return (0, goJudgeSandboxService_1.isSandboxBudgetExceededError)(error) || Date.now() >= input.deadlineAt
            ? 'budget-exhausted'
            : 'sandbox-infra';
    }
    const execution = classifyExecutionDetails(details, input.cases.length);
    if (execution === 'infra')
        return 'sandbox-infra';
    if (execution === 'timeout')
        return 'timeout-pending';
    if (execution === 'killed')
        return 'killed';
    return judgeAcceptedOutputs({ ...input, details });
}
async function evaluateCandidate(input) {
    throwIfCancelled(input.signal);
    if (Date.now() >= input.deadlineAt)
        return 'budget-exhausted';
    const inputs = input.cases.map(item => item.input);
    if (input.candidate.language === 'python') {
        return runAcceptedCandidate({
            ...input,
            run: () => input.runner.runPythonBatchDetailed(input.candidate.source, inputs, { signal: input.signal, deadlineAt: input.deadlineAt }),
        });
    }
    if (!input.runner.compileCpp || !input.runner.runCompiledBatchDetailed) {
        return 'sandbox-infra';
    }
    let fileId;
    try {
        let compiled;
        try {
            compiled = await input.runner.compileCpp(input.candidate.source, {
                signal: input.signal,
                deadlineAt: input.deadlineAt,
            });
        }
        catch (error) {
            throwIfCancelled(input.signal, error);
            return (0, goJudgeSandboxService_1.isSandboxBudgetExceededError)(error) || Date.now() >= input.deadlineAt
                ? 'budget-exhausted'
                : 'sandbox-infra';
        }
        if (compiled.ok === false)
            return compiled.kind === 'compile' ? 'non-viable' : 'sandbox-infra';
        fileId = compiled.fileId;
        return await runAcceptedCandidate({
            ...input,
            run: () => input.runner.runCompiledBatchDetailed(fileId, inputs, {
                signal: input.signal,
                deadlineAt: input.deadlineAt,
            }),
        });
    }
    finally {
        if (fileId) {
            try {
                await input.runner.deleteCachedFile?.(fileId);
            }
            catch {
                // Compiled files have a sandbox TTL; cleanup failure cannot replace evidence.
            }
        }
    }
}
function emptySummary(mode, candidates, skippedReason) {
    return {
        mode,
        status: 'skipped',
        generated: candidates.filter(item => item.origin === 'generated').length,
        historical: candidates.filter(item => item.origin === 'historical').length,
        viable: 0,
        killed: 0,
        survived: 0,
        operators: [],
        skippedReason,
    };
}
async function evaluateMutationCandidates(input) {
    throwIfCancelled(input.signal);
    if (input.candidates.length === 0)
        return emptySummary(input.mode, input.candidates, 'no-candidates');
    const deadlineAt = Math.min(input.correctnessDeadlineAt, Date.now() + exports.MUTATION_BUDGET_MS);
    if (Date.now() >= deadlineAt)
        return emptySummary(input.mode, input.candidates, 'budget-exhausted');
    const operatorSummaries = new Map();
    const concurrency = getMutationConcurrency();
    let viable = 0;
    let killed = 0;
    let partialReason;
    candidateWindows: for (let windowStart = 0; windowStart < input.candidates.length; windowStart += concurrency) {
        throwIfCancelled(input.signal);
        if (Date.now() >= deadlineAt) {
            partialReason = 'budget-exhausted';
            break;
        }
        const window = input.candidates.slice(windowStart, windowStart + concurrency);
        const initialOutcomes = await Promise.all(window.map(candidate => evaluateCandidate({
            ...input,
            candidate,
            deadlineAt,
        })));
        for (let index = 0; index < window.length; index++) {
            const candidate = window[index];
            let outcome = initialOutcomes[index];
            if (outcome === 'timeout-pending') {
                throwIfCancelled(input.signal);
                outcome = Date.now() >= deadlineAt
                    ? 'budget-exhausted'
                    : await evaluateCandidate({ ...input, candidate, deadlineAt });
                if (outcome === 'timeout-pending')
                    outcome = 'killed';
            }
            if (outcome === 'non-viable')
                continue;
            if (outcome === 'checker-infra') {
                partialReason = partialReason || 'checker-infra';
                continue;
            }
            if (outcome === 'sandbox-infra') {
                partialReason = partialReason || 'sandbox-infra';
                continue;
            }
            if (outcome === 'budget-exhausted') {
                partialReason = 'budget-exhausted';
                break candidateWindows;
            }
            viable++;
            if (outcome === 'killed')
                killed++;
            const aggregate = operatorSummaries.get(candidate.operatorId) || {
                id: candidate.operatorId,
                viable: 0,
                killed: 0,
            };
            aggregate.viable++;
            if (outcome === 'killed')
                aggregate.killed++;
            operatorSummaries.set(candidate.operatorId, aggregate);
        }
    }
    if (viable === 0 && !partialReason) {
        return emptySummary(input.mode, input.candidates, 'no-viable-candidates');
    }
    const summary = {
        mode: input.mode,
        status: partialReason ? 'partial' : 'completed',
        generated: input.candidates.filter(item => item.origin === 'generated').length,
        historical: input.candidates.filter(item => item.origin === 'historical').length,
        viable,
        killed,
        survived: viable - killed,
        ...(viable > 0 ? { score: killed / viable } : {}),
        operators: [...operatorSummaries.values()],
        ...(partialReason ? { skippedReason: partialReason } : {}),
    };
    return summary;
}
//# sourceMappingURL=mutationRunner.js.map