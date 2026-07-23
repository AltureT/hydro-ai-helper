import { execFileSync } from 'child_process';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import packageJson from '../../package.json';
import type { ResolvedModelConfig } from '../services/openaiClient';
import {
  compareTestdataBenchmarkReports,
  createTestdataBenchmarkAggregateSnapshot,
  formatTestdataBenchmarkComparison,
  formatTestdataBenchmarkSummary,
  parseTestdataBenchmarkReport,
  runTestdataBenchmark,
  summarizeTestdataBenchmark,
  type TestdataBenchmarkReport,
} from './testdataBenchmark';
import {
  TESTDATA_HARD_BENCHMARK_CASES,
  selectTestdataBenchmarkCases,
} from './testdataBenchmarkCases';

interface CliOptions {
  list: boolean;
  help: boolean;
  confirmCost: boolean;
  caseIds: string[];
  output?: string;
  aggregateOutput?: string;
  compare?: string;
  compareReports?: [string, string];
  minPassRate: number;
}

function usage(): string {
  return `真实模型测试数据难题基准

用法：
  npm run benchmark:testdata -- --list
  npm run benchmark:testdata -- --confirm-cost [--case=id1,id2] [--output=report.json] [--aggregate-output=safe.json] [--compare=old.json]
  npm run benchmark:testdata -- --compare-reports=old.json,new.json

必需环境变量（--list 除外）：
  TESTDATA_BENCHMARK_API_BASE       OpenAI 兼容 API base，例如 https://api.openai.com/v1
  TESTDATA_BENCHMARK_API_KEY        API key
  TESTDATA_BENCHMARK_MODELS         模型链，逗号分隔；也可用 TESTDATA_BENCHMARK_MODEL 指定单模型
  TESTDATA_BENCHMARK_SANDBOX_HOST   go-judge 地址，例如 http://127.0.0.1:5050

可选环境变量：
  TESTDATA_BENCHMARK_TIMEOUT_SECONDS  单次模型调用超时，默认 600
  TESTDATA_BENCHMARK_REVISION         报告版本标识；默认读取当前 Git commit

安全说明：必须显式传 --confirm-cost 才会调用模型；题目串行执行，避免挤兑沙箱。`;
}

function readValue(argv: string[], index: number, name: string): { value: string; consumed: number } {
  const current = argv[index];
  const prefix = `${name}=`;
  if (current.startsWith(prefix)) return { value: current.slice(prefix.length), consumed: 0 };
  const next = argv[index + 1];
  if (!next || next.startsWith('--')) throw new Error(`${name} 缺少参数`);
  return { value: next, consumed: 1 };
}

export function parseTestdataBenchmarkCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    list: false,
    help: false,
    confirmCost: false,
    caseIds: [],
    minPassRate: 1,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--list') options.list = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--confirm-cost') options.confirmCost = true;
    else if (arg === '--case' || arg.startsWith('--case=')) {
      const parsed = readValue(argv, i, '--case');
      options.caseIds.push(...parsed.value.split(',').map(value => value.trim()).filter(Boolean));
      i += parsed.consumed;
    } else if (arg === '--output' || arg.startsWith('--output=')) {
      const parsed = readValue(argv, i, '--output');
      options.output = parsed.value;
      i += parsed.consumed;
    } else if (arg === '--aggregate-output' || arg.startsWith('--aggregate-output=')) {
      const parsed = readValue(argv, i, '--aggregate-output');
      options.aggregateOutput = parsed.value;
      i += parsed.consumed;
    } else if (arg === '--compare' || arg.startsWith('--compare=')) {
      const parsed = readValue(argv, i, '--compare');
      options.compare = parsed.value;
      i += parsed.consumed;
    } else if (arg === '--compare-reports' || arg.startsWith('--compare-reports=')) {
      const parsed = readValue(argv, i, '--compare-reports');
      const paths = parsed.value.split(',').map(value => value.trim()).filter(Boolean);
      if (paths.length !== 2) throw new Error('--compare-reports 必须提供 old.json,new.json');
      options.compareReports = [paths[0], paths[1]];
      i += parsed.consumed;
    } else if (arg === '--min-pass-rate' || arg.startsWith('--min-pass-rate=')) {
      const parsed = readValue(argv, i, '--min-pass-rate');
      options.minPassRate = Number(parsed.value);
      i += parsed.consumed;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  if (!Number.isFinite(options.minPassRate)
    || options.minPassRate < 0
    || options.minPassRate > 1) {
    throw new Error('--min-pass-rate 必须是 0 到 1 之间的数字');
  }
  options.caseIds = [...new Set(options.caseIds)];
  return options;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

function buildModels(): ResolvedModelConfig[] {
  const apiBaseUrl = requiredEnv('TESTDATA_BENCHMARK_API_BASE');
  const apiKey = requiredEnv('TESTDATA_BENCHMARK_API_KEY');
  const modelValue = process.env.TESTDATA_BENCHMARK_MODELS?.trim()
    || process.env.TESTDATA_BENCHMARK_MODEL?.trim()
    || '';
  const modelNames = modelValue.split(',').map(value => value.trim()).filter(Boolean);
  if (modelNames.length === 0) {
    throw new Error('缺少环境变量 TESTDATA_BENCHMARK_MODELS 或 TESTDATA_BENCHMARK_MODEL');
  }
  const timeoutSeconds = Number(process.env.TESTDATA_BENCHMARK_TIMEOUT_SECONDS || 600);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 1800) {
    throw new Error('TESTDATA_BENCHMARK_TIMEOUT_SECONDS 必须在 10 到 1800 之间');
  }
  return modelNames.map((modelName, index) => ({
    endpointId: `benchmark-${index + 1}`,
    endpointName: 'benchmark',
    apiBaseUrl,
    apiKey,
    modelName,
    timeoutSeconds,
  }));
}

async function writeJsonReport(output: string, payload: unknown): Promise<string> {
  const resolved = path.resolve(output);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return resolved;
}

async function readJsonReport(input: string): Promise<TestdataBenchmarkReport> {
  const resolved = path.resolve(input);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolved, 'utf8'));
  } catch (err) {
    throw new Error(`无法读取基准报告 ${resolved}：${err instanceof Error ? err.message : String(err)}`);
  }
  return parseTestdataBenchmarkReport(parsed);
}

function getPluginVersion(): string {
  return String(packageJson.version || process.env.npm_package_version || 'unknown');
}

function getRevision(): string | undefined {
  const provided = process.env.TESTDATA_BENCHMARK_REVISION?.trim();
  if (provided) return provided.slice(0, 80);
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let options: CliOptions;
  try {
    options = parseTestdataBenchmarkCliArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(usage());
    return 2;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (options.list) {
    for (const item of TESTDATA_HARD_BENCHMARK_CASES) {
      console.log(`${item.id}\t${item.title}\t${item.tags.join(',')}`);
    }
    return 0;
  }
  if (options.compareReports) {
    try {
      const [baseline, current] = await Promise.all(options.compareReports.map(readJsonReport));
      const comparison = compareTestdataBenchmarkReports(baseline, current);
      console.log(formatTestdataBenchmarkComparison(comparison));
      return comparison.regressions > 0 || comparison.passRateDelta < 0 ? 1 : 0;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 2;
    }
  }
  if (!options.confirmCost) {
    console.error('未执行：真实基准会产生模型调用费用，请显式传入 --confirm-cost。');
    return 2;
  }

  try {
    const cases = selectTestdataBenchmarkCases(options.caseIds);
    const models = buildModels();
    const sandboxHost = requiredEnv('TESTDATA_BENCHMARK_SANDBOX_HOST');
    const [{ MultiModelClient }, { GoJudgeSandboxRunner }] = await Promise.all([
      import('../services/openaiClient'),
      import('../services/goJudgeSandboxService'),
    ]);
    const runner = new GoJudgeSandboxRunner(sandboxHost);
    if (!await runner.isAvailable()) {
      throw new Error(`go-judge 不可用：${sandboxHost}`);
    }
    const client = new MultiModelClient(models);
    const startedAt = new Date().toISOString();
    const lastStage = new Map<string, string>();
    const results = await runTestdataBenchmark(cases, client, runner, {
      onCaseStart: (item, index, total) => {
        console.log(`[${index + 1}/${total}] START ${item.id} ${item.title}`);
      },
      onProgress: (item, event) => {
        const key = `${event.attempt}:${event.stage}`;
        if (lastStage.get(item.id) === key) return;
        lastStage.set(item.id, key);
        console.log(`[${item.id}] ${event.percent}% ${event.stage} attempt=${event.attempt}`);
      },
      onCaseComplete: (result) => {
        console.log(`[${result.id}] ${result.passed ? 'PASS' : 'FAIL'} ${(result.durationMs / 1000).toFixed(1)}s`);
      },
    });
    const summary = summarizeTestdataBenchmark(results);
    const completedAt = new Date().toISOString();
    const revision = getRevision();
    const report: TestdataBenchmarkReport = {
      schemaVersion: 1,
      runId: `${completedAt.replace(/[:.]/g, '-')}-${models.map(model => model.modelName).join('+').slice(0, 80)}`,
      startedAt,
      completedAt,
      pluginVersion: getPluginVersion(),
      ...(revision ? { revision } : {}),
      models: models.map(model => model.modelName),
      summary,
      results,
    };
    console.log('');
    console.log(formatTestdataBenchmarkSummary(results));
    if (options.output) {
      const reportPath = await writeJsonReport(options.output, report);
      console.log(`Report: ${reportPath}`);
    }
    if (options.aggregateOutput) {
      const aggregatePath = await writeJsonReport(
        options.aggregateOutput,
        createTestdataBenchmarkAggregateSnapshot(report),
      );
      console.log(`Aggregate report: ${aggregatePath}`);
    }
    let regressed = false;
    if (options.compare) {
      const baseline = await readJsonReport(options.compare);
      const comparison = compareTestdataBenchmarkReports(baseline, report);
      console.log('');
      console.log(formatTestdataBenchmarkComparison(comparison));
      regressed = comparison.regressions > 0 || comparison.passRateDelta < 0;
    }
    return summary.passRate >= options.minPassRate && !regressed ? 0 : 1;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }).catch(err => {
    console.error(err);
    process.exitCode = 2;
  });
}
