import {
  compareTestdataBenchmarkReports,
  createTestdataBenchmarkAggregateSnapshot,
  evaluateTestdataBenchmarkPlan,
  formatTestdataBenchmarkComparison,
  formatTestdataBenchmarkSummary,
  parseTestdataBenchmarkReport,
  summarizeTestdataBenchmark,
  type TestdataBenchmarkReport,
  type TestdataBenchmarkResult,
} from '../../benchmarks/testdataBenchmark';
import {
  TESTDATA_HARD_BENCHMARK_CASES,
  selectTestdataBenchmarkCases,
} from '../../benchmarks/testdataBenchmarkCases';
import {
  main,
  parseTestdataBenchmarkCliArgs,
} from '../../benchmarks/testdataBenchmarkCli';
import type { GenerationPlan, PlannedFile } from '../../services/testdataGenService';

function solveTrustedProbe(caseId: string, input: string): string {
  if (caseId === 'xor-subarrays-less-than-k') {
    const values = input.trim().split(/\s+/).map(Number);
    const n = values[0];
    const k = values[1];
    const array = values.slice(2, 2 + n);
    let answer = 0;
    for (let left = 0; left < n; left++) {
      let xor = 0;
      for (let right = left; right < n; right++) {
        xor ^= array[right];
        if (xor < k) answer++;
      }
    }
    return `${answer}\n`;
  }
  const lines = input.trim().split('\n');
  const [n, q] = lines[0].trim().split(/\s+/).map(Number);
  if (caseId === 'dynamic-connectivity-offline') {
    const edges = new Set<string>();
    const edgeKey = (u: number, v: number) => u < v ? `${u},${v}` : `${v},${u}`;
    const output: string[] = [];
    for (let i = 0; i < q; i++) {
      const [op, uRaw, vRaw] = lines[i + 1].trim().split(/\s+/);
      const u = Number(uRaw);
      const v = Number(vRaw);
      if (op === 'ADD') edges.add(edgeKey(u, v));
      else if (op === 'DEL') edges.delete(edgeKey(u, v));
      else {
        const graph = Array.from({ length: n + 1 }, () => [] as number[]);
        for (const edge of edges) {
          const [a, b] = edge.split(',').map(Number);
          graph[a].push(b);
          graph[b].push(a);
        }
        const seen = new Set([u]);
        const stack = [u];
        while (stack.length > 0) {
          const current = stack.pop() as number;
          for (const next of graph[current]) {
            if (seen.has(next)) continue;
            seen.add(next);
            stack.push(next);
          }
        }
        output.push(seen.has(v) ? 'Yes' : 'No');
      }
    }
    return `${output.join('\n')}\n`;
  }
  if (caseId === 'range-flip-longest-ones') {
    const bits = lines[1].trim().split('').map(Number);
    const output: string[] = [];
    for (let i = 0; i < q; i++) {
      const [op, leftRaw, rightRaw] = lines[i + 2].trim().split(/\s+/);
      const left = Number(leftRaw) - 1;
      const right = Number(rightRaw) - 1;
      if (op === 'FLIP') {
        for (let index = left; index <= right; index++) bits[index] ^= 1;
      } else {
        let current = 0;
        let best = 0;
        for (let index = left; index <= right; index++) {
          current = bits[index] ? current + 1 : 0;
          best = Math.max(best, current);
        }
        output.push(String(best));
      }
    }
    return `${output.join('\n')}\n`;
  }
  throw new Error(`missing trusted solver for ${caseId}`);
}

function validPlan(): GenerationPlan {
  const files: PlannedFile[] = [];
  for (let i = 1; i <= 8; i++) {
    files.push(
      { name: `${i}.in`, content: `${i}\n`, kind: 'case-in', origin: 'executed' },
      { name: `${i}.out`, content: `${i}\n`, kind: 'case-out', origin: 'executed' },
    );
  }
  files.push(
    { name: 'std.py', content: 'print(input())\n', kind: 'std', origin: 'executed' },
    { name: 'generator.py', content: 'print(1)\n', kind: 'generator', origin: 'executed' },
    { name: 'brute.py', content: 'print(input())\n', kind: 'brute', origin: 'executed' },
    { name: 'validator.py', content: 'pass\n', kind: 'validator', origin: 'executed' },
  );
  return {
    problemType: 'traditional',
    files,
    caseCount: 8,
    verification: {
      mode: 'sandbox',
      oracleKind: 'ai-solution',
      sampleCheck: { total: 1, passed: 1 },
      validator: { ran: true, casesChecked: 69 },
      stressCheck: {
        generated: 60,
        uniqueInputs: 60,
        duplicateInputs: 0,
        compared: 60,
        agreed: 60,
      },
    },
  };
}

function runnerForProbeOutputs(outputs: string[]) {
  return {
    isAvailable: jest.fn().mockResolvedValue(true),
    runPython: jest.fn(),
    runPythonBatch: jest.fn(),
    runPythonBatchDetailed: jest.fn().mockResolvedValue(outputs.map(stdout => ({
      status: 'Accepted',
      accepted: true,
      timedOut: false,
      exitStatus: 0,
      stdout,
      stderr: '',
    }))),
  };
}

describe('测试数据难题基准集', () => {
  it('题目 ID 唯一，隐藏探针不会原样出现在题面中', () => {
    const ids = TESTDATA_HARD_BENCHMARK_CASES.map(item => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([
      'xor-subarrays-less-than-k',
      'dynamic-connectivity-offline',
      'range-flip-longest-ones',
    ]));
    for (const item of TESTDATA_HARD_BENCHMARK_CASES) {
      expect(item.hiddenProbes.length).toBeGreaterThanOrEqual(3);
      for (const probe of item.hiddenProbes) {
        expect(item.statementMarkdown).not.toContain(probe.input.trim());
        expect(solveTrustedProbe(item.id, probe.input)).toBe(probe.output);
      }
    }
  });

  it('支持选择部分题目并拒绝未知 ID', () => {
    expect(selectTestdataBenchmarkCases(['range-flip-longest-ones']).map(item => item.id))
      .toEqual(['range-flip-longest-ones']);
    expect(() => selectTestdataBenchmarkCases(['missing-case'])).toThrow(/未知基准题目/);
  });
});

describe('evaluateTestdataBenchmarkPlan', () => {
  const benchmarkCase = TESTDATA_HARD_BENCHMARK_CASES[0];

  it('同时通过机器质量闸门和隐藏正确性探针', async () => {
    const runner = runnerForProbeOutputs(benchmarkCase.hiddenProbes.map(probe => probe.output));
    const result = await evaluateTestdataBenchmarkPlan(benchmarkCase, validPlan(), runner);
    expect(result.qualityGateFailures).toEqual([]);
    expect(result.probes.every(probe => probe.passed)).toBe(true);
    expect(runner.runPythonBatchDetailed).toHaveBeenCalledWith(
      expect.stringContaining('print(input())'),
      benchmarkCase.hiddenProbes.map(probe => probe.input),
      expect.objectContaining({ cpuSeconds: 5, deadlineAt: expect.any(Number) }),
    );
  });

  it('ORACLE 与内部 BRUTE 即使自洽，隐藏探针错误仍判失败', async () => {
    const outputs = benchmarkCase.hiddenProbes.map((probe, index) =>
      index === 1 ? '999\n' : probe.output);
    const result = await evaluateTestdataBenchmarkPlan(
      benchmarkCase,
      validPlan(),
      runnerForProbeOutputs(outputs),
    );
    expect(result.qualityGateFailures.join('\n')).toContain('隐藏正确性探针失败');
    expect(result.probes[1]).toMatchObject({ passed: false, actual: '999\n' });
  });

  it('拒绝 ai-only 关键文件和重复正式输入', async () => {
    const plan = validPlan();
    const firstInput = plan.files.find(file => file.name === '1.in') as PlannedFile;
    firstInput.origin = 'ai-only';
    for (const file of plan.files.filter(item => item.kind === 'case-in')) file.content = 'same\n';
    const result = await evaluateTestdataBenchmarkPlan(
      benchmarkCase,
      plan,
      runnerForProbeOutputs(benchmarkCase.hiddenProbes.map(probe => probe.output)),
    );
    expect(result.qualityGateFailures.join('\n')).toContain('正式测试点多样性不足');
    expect(result.qualityGateFailures.join('\n')).toContain('未经执行的关键文件');
  });
});

describe('测试数据基准 CLI 与汇总', () => {
  it('解析题目、输出与通过率参数，并默认要求 100% 通过', () => {
    expect(parseTestdataBenchmarkCliArgs([])).toMatchObject({ minPassRate: 1, caseIds: [] });
    expect(parseTestdataBenchmarkCliArgs([
      '--confirm-cost',
      '--case=a,b',
      '--case', 'c',
      '--output=report.json',
      '--min-pass-rate', '0.67',
    ])).toEqual({
      list: false,
      help: false,
      confirmCost: true,
      caseIds: ['a', 'b', 'c'],
      output: 'report.json',
      minPassRate: 0.67,
    });
    expect(() => parseTestdataBenchmarkCliArgs(['--min-pass-rate=2'])).toThrow(/0 到 1/);
    expect(parseTestdataBenchmarkCliArgs(['--compare-reports=old.json,new.json']).compareReports)
      .toEqual(['old.json', 'new.json']);
    expect(() => parseTestdataBenchmarkCliArgs(['--compare-reports=only-one.json']))
      .toThrow(/old\.json,new\.json/);
  });

  it('未显式确认费用时拒绝运行，--list 不需要模型配置', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(main([])).resolves.toBe(2);
      await expect(main(['--list'])).resolves.toBe(0);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('--confirm-cost'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('xor-subarrays-less-than-k'));
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('按隐藏探针与失败阶段汇总结果', () => {
    const results: TestdataBenchmarkResult[] = [
      {
        id: 'pass', title: 'p', tags: [], passed: true, durationMs: 1000,
        tokenUsage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
        qualityGateFailures: [], probes: [{ name: 'h', passed: true, status: 'Accepted', expected: '1', actual: '1' }],
      },
      {
        id: 'hidden', title: 'h', tags: [], passed: false, durationMs: 2000,
        qualityGateFailures: ['隐藏正确性探针失败：边界'], probes: [],
      },
      {
        id: 'parse', title: 'x', tags: [], passed: false, durationMs: 3000,
        failureStage: 'solution_blueprint', error: 'bad', qualityGateFailures: [], probes: [],
      },
    ];
    expect(summarizeTestdataBenchmark(results)).toEqual({
      total: 3,
      passed: 1,
      failed: 2,
      passRate: 1 / 3,
      durationMs: 6000,
      totalTokens: 3,
      failureStages: { hidden_probe: 1, solution_blueprint: 1 },
    });
    expect(formatTestdataBenchmarkSummary(results)).toContain('1/3 passed (33.3%)');
  });

  it('聚合快照不包含错误正文、代码或隐藏探针输入输出', () => {
    const result: TestdataBenchmarkResult = {
      id: 'hard', title: '题目', tags: ['x'], passed: false, durationMs: 1234,
      failureStage: 'hidden_probe', error: 'SECRET_ERROR_WITH_CODE',
      tokenUsage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      qualityGateFailures: ['SECRET_GATE_DETAIL'],
      probes: [{
        name: '边界', passed: false, status: 'Accepted',
        expected: 'SECRET_EXPECTED', actual: 'SECRET_ACTUAL',
      }],
    };
    const report: TestdataBenchmarkReport = {
      schemaVersion: 1,
      runId: 'run-1',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:01:00.000Z',
      pluginVersion: '3.0.4',
      revision: 'abc123',
      models: ['model-a'],
      summary: summarizeTestdataBenchmark([result]),
      results: [result],
    };
    const snapshot = createTestdataBenchmarkAggregateSnapshot(report);
    expect(snapshot.cases[0]).toEqual({
      id: 'hard', passed: false, durationMs: 1234, totalTokens: 30,
      failureStage: 'hidden_probe', qualityGateFailureCount: 1,
      hiddenProbesPassed: 0, hiddenProbesTotal: 1,
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('SECRET_ERROR_WITH_CODE');
    expect(serialized).not.toContain('SECRET_GATE_DETAIL');
    expect(serialized).not.toContain('SECRET_EXPECTED');
    expect(serialized).not.toContain('SECRET_ACTUAL');
  });

  it('比较两份历史报告并标出改善、回退和失败阶段变化', () => {
    const makeResult = (
      id: string,
      passed: boolean,
      durationMs: number,
      failureStage?: string,
    ): TestdataBenchmarkResult => ({
      id, title: id, tags: [], passed, durationMs, failureStage,
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: durationMs / 10 },
      qualityGateFailures: [], probes: [],
    });
    const baselineResults = [
      makeResult('a', true, 1000),
      makeResult('b', false, 2000, 'solution_blueprint'),
    ];
    const currentResults = [
      makeResult('a', false, 1500, 'hidden_probe'),
      makeResult('b', true, 1800),
    ];
    const makeReport = (
      runId: string,
      results: TestdataBenchmarkResult[],
    ): TestdataBenchmarkReport => ({
      schemaVersion: 1,
      runId,
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:01:00.000Z',
      pluginVersion: '3.0.4',
      models: ['model-a'],
      summary: summarizeTestdataBenchmark(results),
      results,
    });
    const comparison = compareTestdataBenchmarkReports(
      makeReport('old', baselineResults),
      makeReport('new', currentResults),
    );
    expect(comparison).toMatchObject({
      baselineRunId: 'old', currentRunId: 'new', passRateDelta: 0,
      regressions: 1, improvements: 1,
      failureStageDeltas: { hidden_probe: 1, solution_blueprint: -1 },
    });
    expect(comparison.cases).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'a', change: 'regressed' }),
      expect.objectContaining({ id: 'b', change: 'improved' }),
    ]));
    expect(formatTestdataBenchmarkComparison(comparison)).toContain('REGRESSED  a');
  });

  it('拒绝未知版本或缺少关键字段的历史报告', () => {
    expect(() => parseTestdataBenchmarkReport({ schemaVersion: 2 })).toThrow(/不支持/);
    expect(() => parseTestdataBenchmarkReport({ schemaVersion: 1, runId: 'x' }))
      .toThrow(/运行时间/);
  });
});
