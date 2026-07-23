import type { MultiModelClient, TokenUsage } from '../services/openaiClient';
import type { TestdataSandboxRunner } from '../services/goJudgeSandboxService';
import {
  TestdataGenService,
  extractTestdataErrorMetadata,
  isCancellation,
  type GenerationPlan,
  type TestdataGenerationProgress,
} from '../services/testdataGenService';
import type { TestdataBenchmarkCase } from './testdataBenchmarkCases';

const HIDDEN_PROBE_BUDGET_MS = 120_000;

export interface TestdataBenchmarkProbeResult {
  name: string;
  passed: boolean;
  status: string;
  expected: string;
  actual: string;
  error?: string;
}

export interface TestdataBenchmarkResult {
  id: string;
  title: string;
  tags: string[];
  passed: boolean;
  durationMs: number;
  usedModel?: string;
  tokenUsage?: TokenUsage;
  failureStage?: string;
  error?: string;
  qualityGateFailures: string[];
  probes: TestdataBenchmarkProbeResult[];
  verification?: GenerationPlan['verification'];
}

export interface TestdataBenchmarkSummary {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  durationMs: number;
  totalTokens: number;
  failureStages: Record<string, number>;
}

export interface TestdataBenchmarkReport {
  schemaVersion: 1;
  runId: string;
  startedAt: string;
  completedAt: string;
  pluginVersion: string;
  revision?: string;
  models: string[];
  summary: TestdataBenchmarkSummary;
  results: TestdataBenchmarkResult[];
}

export interface TestdataBenchmarkCaseComparison {
  id: string;
  change: 'improved' | 'regressed' | 'unchanged-pass' | 'unchanged-fail' | 'added' | 'removed';
  baselinePassed?: boolean;
  currentPassed?: boolean;
  durationDeltaMs?: number;
  tokenDelta?: number;
}

export interface TestdataBenchmarkComparison {
  baselineRunId: string;
  currentRunId: string;
  passRateDelta: number;
  durationDeltaMs: number;
  tokenDelta: number;
  regressions: number;
  improvements: number;
  failureStageDeltas: Record<string, number>;
  cases: TestdataBenchmarkCaseComparison[];
}

/** 可用于未来遥测趋势的最小聚合快照；不含题面、代码、探针输入输出或错误正文。 */
export interface TestdataBenchmarkAggregateSnapshot {
  schemaVersion: 1;
  runId: string;
  completedAt: string;
  pluginVersion: string;
  revision?: string;
  models: string[];
  summary: TestdataBenchmarkSummary;
  cases: Array<{
    id: string;
    passed: boolean;
    durationMs: number;
    totalTokens: number;
    failureStage?: string;
    qualityGateFailureCount: number;
    hiddenProbesPassed: number;
    hiddenProbesTotal: number;
  }>;
}

export interface RunTestdataBenchmarkOptions {
  signal?: AbortSignal;
  onCaseStart?: (benchmarkCase: TestdataBenchmarkCase, index: number, total: number) => void;
  onProgress?: (benchmarkCase: TestdataBenchmarkCase, event: TestdataGenerationProgress) => void;
  onCaseComplete?: (result: TestdataBenchmarkResult, index: number, total: number) => void;
}

function comparableOutput(value: string): string {
  return value.replace(/\r\n?/g, '\n').trimEnd();
}

function collectQualityGateFailures(
  benchmarkCase: TestdataBenchmarkCase,
  plan: GenerationPlan,
): string[] {
  const failures: string[] = [];
  if (plan.problemType !== 'traditional') failures.push('模型把传统题误判为函数题');
  if (plan.caseCount !== benchmarkCase.options.caseCount) {
    failures.push(`正式测试点数量为 ${plan.caseCount}，期望 ${benchmarkCase.options.caseCount}`);
  }
  const verification = plan.verification;
  if (verification?.mode !== 'sandbox') failures.push('未经过沙箱验证');
  if (!verification?.sampleCheck
    || verification.sampleCheck.total < 1
    || verification.sampleCheck.passed !== verification.sampleCheck.total) {
    failures.push('题面样例未全部通过');
  }
  if (!verification?.validator?.ran) failures.push('VALIDATOR 未实际执行');
  const stress = verification?.stressCheck;
  if (!stress
    || stress.skippedReason
    || stress.compared !== stress.generated
    || stress.agreed !== stress.compared) {
    failures.push('独立小数据压力对拍未全部一致');
  }
  if (stress && stress.uniqueInputs < Math.ceil(stress.generated * 0.8)) {
    failures.push(`压力数据唯一输入不足：${stress.uniqueInputs}/${stress.generated}`);
  }
  const caseInputs = plan.files.filter(file => file.kind === 'case-in');
  const uniqueFormalInputs = new Set(caseInputs.map(file => comparableOutput(file.content))).size;
  if (caseInputs.length > 1 && uniqueFormalInputs < Math.ceil(caseInputs.length * 0.75)) {
    failures.push(`正式测试点多样性不足：${uniqueFormalInputs}/${caseInputs.length}`);
  }
  const machineCheckedKinds = new Set(['case-in', 'case-out', 'std', 'generator', 'brute', 'validator']);
  const aiOnlyMachineFiles = plan.files.filter(file =>
    machineCheckedKinds.has(file.kind) && file.origin === 'ai-only');
  if (aiOnlyMachineFiles.length > 0) {
    failures.push(`存在未经执行的关键文件：${aiOnlyMachineFiles.map(file => file.name).join('、')}`);
  }
  return failures;
}

export async function evaluateTestdataBenchmarkPlan(
  benchmarkCase: TestdataBenchmarkCase,
  plan: GenerationPlan,
  runner: TestdataSandboxRunner,
  signal?: AbortSignal,
): Promise<{ qualityGateFailures: string[]; probes: TestdataBenchmarkProbeResult[] }> {
  const qualityGateFailures = collectQualityGateFailures(benchmarkCase, plan);
  const std = plan.files.find(file => file.name === 'std.py' && file.kind === 'std');
  if (!std) {
    qualityGateFailures.push('生成计划缺少可执行 std.py');
    return { qualityGateFailures, probes: [] };
  }
  const inputs = benchmarkCase.hiddenProbes.map(probe => probe.input);
  let details;
  try {
    details = await runner.runPythonBatchDetailed(std.content, inputs, {
      cpuSeconds: 5,
      deadlineAt: Date.now() + HIDDEN_PROBE_BUDGET_MS,
      signal,
    });
  } catch (err) {
    if (isCancellation(err)) throw err;
    qualityGateFailures.push(`隐藏探针执行失败：${err instanceof Error ? err.message : String(err)}`);
    return { qualityGateFailures, probes: [] };
  }
  if (details.length !== inputs.length) {
    qualityGateFailures.push(`隐藏探针返回 ${details.length} 个结果，期望 ${inputs.length} 个`);
  }
  const probes = benchmarkCase.hiddenProbes.map((probe, index): TestdataBenchmarkProbeResult => {
    const detail = details[index];
    const actual = detail?.stdout || '';
    const passed = !!detail?.accepted
      && comparableOutput(actual) === comparableOutput(probe.output);
    return {
      name: probe.name,
      passed,
      status: detail?.status || 'Missing Result',
      expected: probe.output,
      actual,
      ...(!detail?.accepted && (detail?.stderr || detail?.error)
        ? { error: detail.stderr || detail.error }
        : {}),
    };
  });
  const failedProbes = probes.filter(probe => !probe.passed);
  if (failedProbes.length > 0) {
    qualityGateFailures.push(`隐藏正确性探针失败：${failedProbes.map(probe => probe.name).join('、')}`);
  }
  return { qualityGateFailures, probes };
}

export async function runTestdataBenchmarkCase(
  benchmarkCase: TestdataBenchmarkCase,
  aiClient: MultiModelClient,
  runner: TestdataSandboxRunner,
  onProgress?: (event: TestdataGenerationProgress) => void,
  signal?: AbortSignal,
): Promise<TestdataBenchmarkResult> {
  const startedAt = Date.now();
  try {
    const service = new TestdataGenService(aiClient, {
      sandboxRunner: runner,
      mode: 'sandbox',
    });
    const plan = await service.generate({
      problemTitle: benchmarkCase.title,
      statementMarkdown: benchmarkCase.statementMarkdown,
      options: { ...benchmarkCase.options, languages: [...benchmarkCase.options.languages] },
      onProgress,
      signal,
    });
    const evaluated = await evaluateTestdataBenchmarkPlan(benchmarkCase, plan, runner, signal);
    return {
      id: benchmarkCase.id,
      title: benchmarkCase.title,
      tags: [...benchmarkCase.tags],
      passed: evaluated.qualityGateFailures.length === 0,
      durationMs: Date.now() - startedAt,
      usedModel: plan.usedModel,
      tokenUsage: plan.tokenUsage,
      qualityGateFailures: evaluated.qualityGateFailures,
      probes: evaluated.probes,
      verification: plan.verification,
    };
  } catch (err) {
    if (isCancellation(err)) throw err;
    const metadata = extractTestdataErrorMetadata(err);
    return {
      id: benchmarkCase.id,
      title: benchmarkCase.title,
      tags: [...benchmarkCase.tags],
      passed: false,
      durationMs: Date.now() - startedAt,
      failureStage: typeof metadata?.failureStage === 'string'
        ? metadata.failureStage
        : 'unclassified',
      error: err instanceof Error ? err.message : String(err),
      qualityGateFailures: [],
      probes: [],
    };
  }
}

export async function runTestdataBenchmark(
  cases: readonly TestdataBenchmarkCase[],
  aiClient: MultiModelClient,
  runner: TestdataSandboxRunner,
  options: RunTestdataBenchmarkOptions = {},
): Promise<TestdataBenchmarkResult[]> {
  const results: TestdataBenchmarkResult[] = [];
  for (let index = 0; index < cases.length; index++) {
    const benchmarkCase = cases[index];
    options.onCaseStart?.(benchmarkCase, index, cases.length);
    const result = await runTestdataBenchmarkCase(
      benchmarkCase,
      aiClient,
      runner,
      event => options.onProgress?.(benchmarkCase, event),
      options.signal,
    );
    results.push(result);
    options.onCaseComplete?.(result, index, cases.length);
  }
  return results;
}

export function summarizeTestdataBenchmark(
  results: readonly TestdataBenchmarkResult[],
): TestdataBenchmarkSummary {
  const passed = results.filter(result => result.passed).length;
  const failureStages: Record<string, number> = {};
  for (const result of results) {
    if (result.passed) continue;
    const stage = result.failureStage
      || (result.qualityGateFailures.some(item => item.includes('隐藏正确性探针'))
        ? 'hidden_probe'
        : 'quality_gate');
    failureStages[stage] = (failureStages[stage] || 0) + 1;
  }
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    passRate: results.length > 0 ? passed / results.length : 0,
    durationMs: results.reduce((sum, result) => sum + result.durationMs, 0),
    totalTokens: results.reduce((sum, result) => sum + (result.tokenUsage?.totalTokens || 0), 0),
    failureStages,
  };
}

export function formatTestdataBenchmarkSummary(
  results: readonly TestdataBenchmarkResult[],
): string {
  const summary = summarizeTestdataBenchmark(results);
  const lines = results.map(result => {
    const seconds = (result.durationMs / 1000).toFixed(1);
    const reason = result.passed
      ? `hidden ${result.probes.filter(probe => probe.passed).length}/${result.probes.length}`
      : result.error || result.qualityGateFailures.join('；') || result.failureStage || 'unknown';
    return `${result.passed ? 'PASS' : 'FAIL'}  ${result.id}  ${seconds}s  ${reason}`;
  });
  lines.push(
    '',
    `Summary: ${summary.passed}/${summary.total} passed (${(summary.passRate * 100).toFixed(1)}%)`,
    `Duration: ${(summary.durationMs / 1000).toFixed(1)}s, tokens: ${summary.totalTokens}`,
  );
  if (Object.keys(summary.failureStages).length > 0) {
    lines.push(`Failure stages: ${Object.entries(summary.failureStages).map(([key, value]) => `${key}=${value}`).join(', ')}`);
  }
  return lines.join('\n');
}

export function createTestdataBenchmarkAggregateSnapshot(
  report: TestdataBenchmarkReport,
): TestdataBenchmarkAggregateSnapshot {
  return {
    schemaVersion: 1,
    runId: report.runId,
    completedAt: report.completedAt,
    pluginVersion: report.pluginVersion,
    ...(report.revision ? { revision: report.revision } : {}),
    models: [...report.models],
    summary: { ...report.summary, failureStages: { ...report.summary.failureStages } },
    cases: report.results.map(result => ({
      id: result.id,
      passed: result.passed,
      durationMs: result.durationMs,
      totalTokens: result.tokenUsage?.totalTokens || 0,
      ...(result.failureStage ? { failureStage: result.failureStage } : {}),
      qualityGateFailureCount: result.qualityGateFailures.length,
      hiddenProbesPassed: result.probes.filter(probe => probe.passed).length,
      hiddenProbesTotal: result.probes.length,
    })),
  };
}

export function parseTestdataBenchmarkReport(value: unknown): TestdataBenchmarkReport {
  if (!value || typeof value !== 'object') throw new Error('基准报告不是对象');
  const report = value as Partial<TestdataBenchmarkReport>;
  if (report.schemaVersion !== 1) throw new Error(`不支持的基准报告版本：${String(report.schemaVersion)}`);
  if (typeof report.runId !== 'string' || !report.runId) throw new Error('基准报告缺少 runId');
  if (typeof report.startedAt !== 'string' || typeof report.completedAt !== 'string') {
    throw new Error('基准报告缺少运行时间');
  }
  if (typeof report.pluginVersion !== 'string' || !Array.isArray(report.models)) {
    throw new Error('基准报告缺少插件版本或模型链');
  }
  if (!report.summary || typeof report.summary.passRate !== 'number' || !Array.isArray(report.results)) {
    throw new Error('基准报告缺少汇总或题目结果');
  }
  for (const result of report.results) {
    if (!result || typeof result.id !== 'string' || typeof result.passed !== 'boolean') {
      throw new Error('基准报告包含非法题目结果');
    }
  }
  return report as TestdataBenchmarkReport;
}

export function compareTestdataBenchmarkReports(
  baseline: TestdataBenchmarkReport,
  current: TestdataBenchmarkReport,
): TestdataBenchmarkComparison {
  const baselineById = new Map(baseline.results.map(result => [result.id, result]));
  const currentById = new Map(current.results.map(result => [result.id, result]));
  const ids = [...new Set([...baselineById.keys(), ...currentById.keys()])].sort();
  const cases: TestdataBenchmarkCaseComparison[] = ids.map(id => {
    const before = baselineById.get(id);
    const after = currentById.get(id);
    if (!before) return { id, change: 'added', currentPassed: after?.passed };
    if (!after) return { id, change: 'removed', baselinePassed: before.passed };
    const change = !before.passed && after.passed ? 'improved'
      : before.passed && !after.passed ? 'regressed'
        : after.passed ? 'unchanged-pass' : 'unchanged-fail';
    return {
      id,
      change,
      baselinePassed: before.passed,
      currentPassed: after.passed,
      durationDeltaMs: after.durationMs - before.durationMs,
      tokenDelta: (after.tokenUsage?.totalTokens || 0) - (before.tokenUsage?.totalTokens || 0),
    };
  });
  const stages = new Set([
    ...Object.keys(baseline.summary.failureStages),
    ...Object.keys(current.summary.failureStages),
  ]);
  const failureStageDeltas: Record<string, number> = {};
  for (const stage of [...stages].sort()) {
    const delta = (current.summary.failureStages[stage] || 0)
      - (baseline.summary.failureStages[stage] || 0);
    if (delta !== 0) failureStageDeltas[stage] = delta;
  }
  return {
    baselineRunId: baseline.runId,
    currentRunId: current.runId,
    passRateDelta: current.summary.passRate - baseline.summary.passRate,
    durationDeltaMs: current.summary.durationMs - baseline.summary.durationMs,
    tokenDelta: current.summary.totalTokens - baseline.summary.totalTokens,
    regressions: cases.filter(item => item.change === 'regressed').length,
    improvements: cases.filter(item => item.change === 'improved').length,
    failureStageDeltas,
    cases,
  };
}

function signed(value: number, suffix = ''): string {
  return `${value >= 0 ? '+' : ''}${value}${suffix}`;
}

export function formatTestdataBenchmarkComparison(
  comparison: TestdataBenchmarkComparison,
): string {
  const lines = [
    `Compare: ${comparison.baselineRunId} -> ${comparison.currentRunId}`,
    `Pass rate: ${signed(Number((comparison.passRateDelta * 100).toFixed(1)), 'pp')}`,
    `Duration: ${signed(Number((comparison.durationDeltaMs / 1000).toFixed(1)), 's')}`,
    `Tokens: ${signed(comparison.tokenDelta)}`,
    `Cases: improvements=${comparison.improvements}, regressions=${comparison.regressions}`,
  ];
  for (const item of comparison.cases.filter(entry =>
    entry.change === 'improved' || entry.change === 'regressed' || entry.change === 'added' || entry.change === 'removed')) {
    lines.push(`${item.change.toUpperCase()}  ${item.id}`);
  }
  if (Object.keys(comparison.failureStageDeltas).length > 0) {
    lines.push(`Failure stage delta: ${Object.entries(comparison.failureStageDeltas)
      .map(([stage, delta]) => `${stage}=${signed(delta)}`).join(', ')}`);
  }
  return lines.join('\n');
}
