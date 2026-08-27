import {
  isSandboxBudgetExceededError,
  type PythonRunDetail,
  type TestdataSandboxRunner,
} from '../goJudgeSandboxService';
import {
  type MutationCandidate,
  type MutationGateMode,
  type MutationOperatorId,
} from './mutation';

export const MUTATION_BUDGET_MS = 120_000;
export const MUTATION_SCORE_THRESHOLD = 0.8;
export const MUTATION_CONCURRENCY_DEFAULT = 2;
export const MUTATION_CONCURRENCY_MIN = 1;
export const MUTATION_CONCURRENCY_MAX = 4;

export function getMutationConcurrency(
  raw = process.env.AI_HELPER_TESTDATA_MUTATION_CONCURRENCY,
): number {
  if (!raw || !/^\d+$/.test(raw)) return MUTATION_CONCURRENCY_DEFAULT;
  const concurrency = Number(raw);
  return Number.isSafeInteger(concurrency)
    && concurrency >= MUTATION_CONCURRENCY_MIN
    && concurrency <= MUTATION_CONCURRENCY_MAX
    ? concurrency
    : MUTATION_CONCURRENCY_DEFAULT;
}

export type MutationSkipReason =
  | 'gate-off'
  | 'sandbox-unavailable'
  | 'unsupported-source'
  | 'no-candidates'
  | 'no-viable-candidates'
  | 'checker-infra'
  | 'sandbox-infra'
  | 'budget-exhausted';

export interface MutationFormalCase {
  input: string;
  answer: string;
}

export interface MutationOperatorSummary {
  id: MutationOperatorId;
  viable: number;
  killed: number;
}

export interface MutationVerificationSummary {
  mode: MutationGateMode;
  status: 'completed' | 'partial' | 'skipped';
  generated: number;
  historical: number;
  viable: number;
  killed: number;
  survived: number;
  score?: number;
  operators: MutationOperatorSummary[];
  skippedReason?: MutationSkipReason;
}

export type MutationCheckerJudge = (
  cases: Array<{ input: string; output: string; answer: string }>,
  opts: { signal?: AbortSignal; deadlineAt: number },
) => Promise<Array<'accept' | 'reject' | 'infra-error'>>;

type CandidateOutcome = 'killed' | 'survived' | 'non-viable' | 'checker-infra'
  | 'sandbox-infra' | 'budget-exhausted' | 'timeout-pending';

const EXPLICIT_KILLED_STATUSES = new Set([
  'Wrong Answer',
  'Runtime Error',
  'Memory Limit Exceeded',
  'Output Limit Exceeded',
  'Time Limit Exceeded',
]);

function comparableFileContent(content: string): string {
  return content
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .trimEnd();
}

function isCancellation(error: unknown): boolean {
  const value = error as { name?: unknown; code?: unknown; category?: unknown } | null;
  return !!value && (
    value.name === 'AbortError'
    || value.name === 'CanceledError'
    || value.code === 'ERR_CANCELED'
    || value.category === 'aborted'
  );
}

function throwIfCancelled(signal: AbortSignal | undefined, error?: unknown): void {
  if (signal?.aborted) {
    throw signal.reason ?? Object.assign(new Error('canceled'), { name: 'AbortError' });
  }
  if (isCancellation(error)) throw error;
}

function classifyExecutionDetails(
  details: readonly (PythonRunDetail | undefined)[],
  expectedLength: number,
): 'accepted' | 'killed' | 'timeout' | 'infra' {
  if (details.length !== expectedLength) return 'infra';
  for (const item of details) {
    if (!item || typeof item.status !== 'string') return 'infra';
    if (item.timedOut) return 'timeout';
    if (EXPLICIT_KILLED_STATUSES.has(item.status)) return 'killed';
    if (item.status === 'Accepted' && item.accepted && (item.exitStatus ?? 0) === 0) continue;
    if (item.status === 'Accepted' && Number.isInteger(item.exitStatus) && item.exitStatus !== 0) {
      return 'killed';
    }
    return 'infra';
  }
  return 'accepted';
}

async function judgeAcceptedOutputs(input: {
  details: readonly PythonRunDetail[];
  cases: readonly MutationFormalCase[];
  customChecker: boolean;
  judgeWithChecker?: MutationCheckerJudge;
  signal?: AbortSignal;
  deadlineAt: number;
}): Promise<CandidateOutcome> {
  if (input.customChecker) {
    if (!input.judgeWithChecker) return 'checker-infra';
    try {
      const verdicts = await input.judgeWithChecker(
        input.cases.map((formalCase, index) => ({
          input: formalCase.input,
          output: input.details[index]?.stdout || '',
          answer: formalCase.answer,
        })),
        { signal: input.signal, deadlineAt: input.deadlineAt },
      );
      if (verdicts.length !== input.cases.length || verdicts.some(item => item === 'infra-error')) {
        return 'checker-infra';
      }
      return verdicts.some(item => item === 'reject') ? 'killed' : 'survived';
    } catch (error) {
      throwIfCancelled(input.signal, error);
      return isSandboxBudgetExceededError(error) || Date.now() >= input.deadlineAt
        ? 'budget-exhausted'
        : 'checker-infra';
    }
  }

  const differs = input.details.some((item, index) => (
    comparableFileContent(item.stdout)
      !== comparableFileContent(input.cases[index]?.answer || '')
  ));
  return differs ? 'killed' : 'survived';
}

async function runAcceptedCandidate(input: {
  run: () => Promise<PythonRunDetail[]>;
  cases: readonly MutationFormalCase[];
  customChecker: boolean;
  judgeWithChecker?: MutationCheckerJudge;
  signal?: AbortSignal;
  deadlineAt: number;
}): Promise<CandidateOutcome> {
  let details: PythonRunDetail[];
  try {
    details = await input.run();
  } catch (error) {
    throwIfCancelled(input.signal, error);
    return isSandboxBudgetExceededError(error) || Date.now() >= input.deadlineAt
      ? 'budget-exhausted'
      : 'sandbox-infra';
  }
  const execution = classifyExecutionDetails(details, input.cases.length);
  if (execution === 'infra') return 'sandbox-infra';
  if (execution === 'timeout') return 'timeout-pending';
  if (execution === 'killed') return 'killed';
  return judgeAcceptedOutputs({ ...input, details });
}

async function evaluateCandidate(input: {
  candidate: MutationCandidate;
  cases: readonly MutationFormalCase[];
  runner: TestdataSandboxRunner;
  customChecker: boolean;
  judgeWithChecker?: MutationCheckerJudge;
  signal?: AbortSignal;
  deadlineAt: number;
}): Promise<CandidateOutcome> {
  throwIfCancelled(input.signal);
  if (Date.now() >= input.deadlineAt) return 'budget-exhausted';
  const inputs = input.cases.map(item => item.input);
  if (input.candidate.language === 'python') {
    return runAcceptedCandidate({
      ...input,
      run: () => input.runner.runPythonBatchDetailed(
        input.candidate.source,
        inputs,
        { signal: input.signal, deadlineAt: input.deadlineAt },
      ),
    });
  }

  if (!input.runner.compileCpp || !input.runner.runCompiledBatchDetailed) {
    return 'sandbox-infra';
  }
  let fileId: string | undefined;
  try {
    let compiled;
    try {
      compiled = await input.runner.compileCpp(input.candidate.source, {
        signal: input.signal,
        deadlineAt: input.deadlineAt,
      });
    } catch (error) {
      throwIfCancelled(input.signal, error);
      return isSandboxBudgetExceededError(error) || Date.now() >= input.deadlineAt
        ? 'budget-exhausted'
        : 'sandbox-infra';
    }
    if (compiled.ok === false) return compiled.kind === 'compile' ? 'non-viable' : 'sandbox-infra';
    fileId = compiled.fileId;
    return await runAcceptedCandidate({
      ...input,
      run: () => (input.runner.runCompiledBatchDetailed as NonNullable<
        TestdataSandboxRunner['runCompiledBatchDetailed']
      >)(fileId as string, inputs, {
        signal: input.signal,
        deadlineAt: input.deadlineAt,
      }),
    });
  } finally {
    if (fileId) {
      try {
        await input.runner.deleteCachedFile?.(fileId);
      } catch {
        // Compiled files have a sandbox TTL; cleanup failure cannot replace evidence.
      }
    }
  }
}

function emptySummary(
  mode: Exclude<MutationGateMode, 'off'>,
  candidates: readonly MutationCandidate[],
  skippedReason: MutationSkipReason,
): MutationVerificationSummary {
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

export async function evaluateMutationCandidates(input: {
  mode: Exclude<MutationGateMode, 'off'>;
  candidates: readonly MutationCandidate[];
  cases: readonly MutationFormalCase[];
  runner: TestdataSandboxRunner;
  customChecker: boolean;
  judgeWithChecker?: MutationCheckerJudge;
  signal?: AbortSignal;
  correctnessDeadlineAt: number;
}): Promise<MutationVerificationSummary> {
  throwIfCancelled(input.signal);
  if (input.candidates.length === 0) return emptySummary(input.mode, input.candidates, 'no-candidates');
  const deadlineAt = Math.min(input.correctnessDeadlineAt, Date.now() + MUTATION_BUDGET_MS);
  if (Date.now() >= deadlineAt) return emptySummary(input.mode, input.candidates, 'budget-exhausted');

  const operatorSummaries = new Map<MutationOperatorId, MutationOperatorSummary>();
  const concurrency = getMutationConcurrency();
  let viable = 0;
  let killed = 0;
  let partialReason: MutationSkipReason | undefined;
  candidateWindows: for (let windowStart = 0;
    windowStart < input.candidates.length;
    windowStart += concurrency) {
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
        if (outcome === 'timeout-pending') outcome = 'killed';
      }
      if (outcome === 'non-viable') continue;
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
      if (outcome === 'killed') killed++;
      const aggregate = operatorSummaries.get(candidate.operatorId) || {
        id: candidate.operatorId,
        viable: 0,
        killed: 0,
      };
      aggregate.viable++;
      if (outcome === 'killed') aggregate.killed++;
      operatorSummaries.set(candidate.operatorId, aggregate);
    }
  }

  if (viable === 0 && !partialReason) {
    return emptySummary(input.mode, input.candidates, 'no-viable-candidates');
  }
  const summary: MutationVerificationSummary = {
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
