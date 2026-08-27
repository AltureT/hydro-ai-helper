import {
  isSandboxBudgetExceededError,
  PythonRunDetail,
  TestdataSandboxRunner,
} from '../goJudgeSandboxService';

export type TemplateVerificationLanguage = 'py' | 'java' | 'cc';
export type TemplateVerificationFailureKind =
  | 'compile' | 'runtime' | 'budget' | 'mismatch' | 'checker-infra';

export interface TemplateVerificationCheck {
  compiled: boolean;
  executed: boolean;
  total: number;
  passed: number;
  failureKind?: TemplateVerificationFailureKind;
}

export type TemplateChecks =
  Partial<Record<TemplateVerificationLanguage, TemplateVerificationCheck>>;
export type TemplateAdjudicationVerdict = 'accept' | 'reject' | 'infra-error';

export interface TemplateOutputAdjudicator {
  readonly customChecker: boolean;
  adjudicate(
    cases: Array<{ input: string; output: string; answer: string }>,
    controls?: { signal?: AbortSignal; deadlineAt?: number },
  ):
    Promise<TemplateAdjudicationVerdict[]>;
}

export class TemplateVerificationError extends Error {
  constructor(
    readonly language: TemplateVerificationLanguage,
    readonly kind: TemplateVerificationFailureKind,
    readonly check: TemplateVerificationCheck,
    readonly caseIndex?: number,
  ) {
    super(`模板 ${language} 验证${kind}失败`);
    this.name = 'TemplateVerificationError';
  }
}

type VerificationInput = {
  languages: TemplateVerificationLanguage[];
  solutions: Partial<Record<TemplateVerificationLanguage, string>>;
  templates: Partial<Record<TemplateVerificationLanguage, string>>;
  cases: Array<{ input: string; answer: string }>;
  runner: TestdataSandboxRunner;
  adjudicator: TemplateOutputAdjudicator;
  signal?: AbortSignal;
  deadlineAt?: number;
  deadlineAtProvider?: () => number | undefined;
  allowCheckerInfraResult: boolean;
};

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
  const candidate = error as { name?: string; code?: string; category?: string } | null;
  return !!candidate && (
    candidate.name === 'AbortError' || candidate.name === 'CanceledError'
    || candidate.code === 'ERR_CANCELED' || candidate.category === 'aborted'
  );
}

function fail(
  language: TemplateVerificationLanguage,
  kind: TemplateVerificationFailureKind,
  check: TemplateVerificationCheck,
  caseIndex?: number,
): never {
  throw new TemplateVerificationError(language, kind, { ...check, failureKind: kind }, caseIndex);
}

function assertPresentSource(
  input: VerificationInput,
  language: TemplateVerificationLanguage,
): { solution: string; template: string } {
  const solution = input.solutions[language];
  const template = input.templates[language];
  if (!solution?.trim() || !template?.trim()) {
    fail(language, 'compile', { compiled: false, executed: false, total: input.cases.length, passed: 0 });
  }
  return { solution, template };
}

function throwExecutionError(
  input: VerificationInput,
  language: TemplateVerificationLanguage,
  check: TemplateVerificationCheck,
  error: unknown,
): never {
  if (input.signal?.aborted) throw input.signal.reason ?? error;
  if (isCancellation(error)) throw error;
  if (isSandboxBudgetExceededError(error)) fail(language, 'budget', check);
  fail(language, 'runtime', check);
}

function throwIfCancelledOrExpired(
  input: VerificationInput,
  language: TemplateVerificationLanguage,
  check: TemplateVerificationCheck,
): void {
  if (input.signal?.aborted) {
    throw input.signal.reason ?? Object.assign(new Error('canceled'), { name: 'AbortError' });
  }
  const deadlineAt = earliestVerifierDeadline(input);
  if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
    fail(language, 'budget', check);
  }
}

function earliestVerifierDeadline(input: VerificationInput): number | undefined {
  const hardDeadlineAt = input.deadlineAt;
  const correctnessDeadlineAt = input.deadlineAtProvider?.();
  if (hardDeadlineAt === undefined) return correctnessDeadlineAt;
  if (correctnessDeadlineAt === undefined) return hardDeadlineAt;
  return Math.min(hardDeadlineAt, correctnessDeadlineAt);
}

async function deleteCachedFile(runner: TestdataSandboxRunner, fileId: string): Promise<void> {
  try {
    await runner.deleteCachedFile?.(fileId);
  } catch {
    // Cache deletion is best-effort and must not hide cancellation or verification failures.
  }
}

async function runLanguage(input: VerificationInput, language: TemplateVerificationLanguage): Promise<PythonRunDetail[]> {
  const { solution, template } = assertPresentSource(input, language);
  const inputs = input.cases.map(testcase => testcase.input);
  const options = {
    signal: input.signal,
    deadlineAt: earliestVerifierDeadline(input),
  };
  const baseCheck: TemplateVerificationCheck = {
    compiled: language === 'py', executed: false, total: inputs.length, passed: 0,
  };

  if (language === 'py') {
    try {
      return await input.runner.runPythonBatchDetailed(`${solution}\n${template}`, inputs, options);
    } catch (error) {
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
    } catch (error) {
      return throwExecutionError(input, language, baseCheck, error);
    }
    if (!compiled.ok) fail(language, 'compile', baseCheck);
    try {
      return await input.runner.runCompiledBatchDetailed(compiled.fileId, inputs, options);
    } catch (error) {
      return throwExecutionError(input, language, { ...baseCheck, compiled: true }, error);
    } finally {
      await deleteCachedFile(input.runner, compiled.fileId);
    }
  }

  if (!input.runner.compileJava || !input.runner.runJavaBatchDetailed) {
    fail(language, 'compile', baseCheck);
  }
  let compiled;
  try {
    compiled = await input.runner.compileJava(template, solution, options);
  } catch (error) {
    return throwExecutionError(input, language, baseCheck, error);
  }
  if (!compiled.ok) fail(language, 'compile', baseCheck);
  try {
    return await input.runner.runJavaBatchDetailed(compiled.fileId, inputs, options);
  } catch (error) {
    return throwExecutionError(input, language, { ...baseCheck, compiled: true }, error);
  } finally {
    await deleteCachedFile(input.runner, compiled.fileId);
  }
}

async function adjudicate(
  input: VerificationInput,
  language: TemplateVerificationLanguage,
  results: PythonRunDetail[],
): Promise<TemplateVerificationCheck> {
  const check: TemplateVerificationCheck = {
    compiled: true,
    executed: results.length === input.cases.length,
    total: input.cases.length,
    passed: 0,
  };
  if (!check.executed) fail(language, 'runtime', check);

  const badExecution = results.findIndex(result => !result.accepted);
  if (badExecution !== -1) fail(language, 'runtime', check, badExecution);

  if (!input.adjudicator.customChecker) {
    throwIfCancelledOrExpired(input, language, check);
    const matches = results.map((result, index) => (
      comparableFileContent(result.stdout) === comparableFileContent(input.cases[index].answer)
    ));
    const mismatch = matches.findIndex(match => !match);
    check.passed = matches.filter(Boolean).length;
    if (mismatch !== -1) fail(language, 'mismatch', check, mismatch);
    return check;
  }

  let verdicts: TemplateAdjudicationVerdict[];
  try {
    throwIfCancelledOrExpired(input, language, check);
    verdicts = await input.adjudicator.adjudicate(results.map((result, index) => ({
      input: input.cases[index].input,
      output: result.stdout,
      answer: input.cases[index].answer,
    })), {
      signal: input.signal,
      deadlineAt: input.deadlineAt,
    });
    throwIfCancelledOrExpired(input, language, check);
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason ?? error;
    if (isCancellation(error)) throw error;
    if (error instanceof TemplateVerificationError) throw error;
    if (isSandboxBudgetExceededError(error)) fail(language, 'budget', check);
    return checkerInfraResult(input, language, check);
  }
  check.passed = verdicts.filter(verdict => verdict === 'accept').length;
  if (verdicts.length !== check.total) return checkerInfraResult(input, language, check);
  const infraIndex = verdicts.findIndex(verdict => (
    verdict === 'infra-error' || (verdict !== 'accept' && verdict !== 'reject')
  ));
  if (infraIndex !== -1) return checkerInfraResult(input, language, check, infraIndex);
  const rejected = verdicts.findIndex(verdict => verdict !== 'accept');
  if (rejected !== -1) fail(language, 'mismatch', check, rejected);
  return check;
}

function checkerInfraResult(
  input: VerificationInput,
  language: TemplateVerificationLanguage,
  check: TemplateVerificationCheck,
  caseIndex?: number,
): TemplateVerificationCheck {
  const failed = { ...check, failureKind: 'checker-infra' as const };
  if (input.allowCheckerInfraResult) return failed;
  fail(language, 'checker-infra', failed, caseIndex);
}

export async function verifySelectedTemplates(input: VerificationInput): Promise<TemplateChecks> {
  const checks: TemplateChecks = {};
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
