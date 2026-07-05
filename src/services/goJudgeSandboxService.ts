/**
 * go-judge 客户端：通过 Hydro 配置的沙箱执行 AI 生成的 Python 程序。
 *
 * 这里只传内存文件与标准输入输出，不在 Hydro Web 进程中执行任何 AI 代码。
 */

import axios, { AxiosRequestConfig } from 'axios';

export type TestdataGenerationMode = 'auto' | 'sandbox' | 'direct';

export interface PythonRunResult {
  stdout: string;
  stderr: string;
}

/** 宽容批量执行的单条结果：不因单条失败抛错，由调用方按 status 分类处理。 */
export interface PythonRunDetail {
  status: string;        // go-judge 原文，如 'Accepted' | 'Time Limit Exceeded' | ...
  accepted: boolean;     // status==='Accepted' && exitStatus===0
  timedOut: boolean;     // status==='Time Limit Exceeded'
  exitStatus?: number;
  stdout: string;
  stderr: string;
  error?: string;        // go-judge error 字段或 fileError 拼接
}

export interface PythonBatchOptions {
  cpuSeconds?: number;        // 默认 5；clockLimit 恒为 cpu×2
  signal?: AbortSignal;
}

export interface TestdataSandboxRunner {
  isAvailable(signal?: AbortSignal): Promise<boolean>;
  runPython(code: string, stdin?: string, signal?: AbortSignal): Promise<PythonRunResult>;
  runPythonBatch(code: string, inputs: string[], signal?: AbortSignal): Promise<PythonRunResult[]>;
  runPythonBatchDetailed(code: string, inputs: string[], opts?: PythonBatchOptions): Promise<PythonRunDetail[]>;
}

interface GoJudgeResult {
  status?: string;
  exitStatus?: number;
  error?: string;
  files?: Record<string, string>;
  fileError?: Array<{ name?: string; type?: string; message?: string }>;
}

interface HttpClient {
  get<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<{ data: T }>;
  post<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<{ data: T }>;
}

const CPU_LIMIT_NS = 5_000_000_000;
const CLOCK_LIMIT_NS = 10_000_000_000;
const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
const STDOUT_LIMIT_BYTES = 1024 * 1024;
const STDERR_LIMIT_BYTES = 64 * 1024;

/**
 * 单请求内所有 cmd 在沙箱内并发执行；实测 2 核机上并发度过高会抢占内存与 RAM 盘，
 * 故大批量按块串行：每块最多 4 条，块间等待上一块返回后再发下一块。
 */
export const SANDBOX_CHUNK_SIZE = 4;
/** 沙箱执行总时长预算（毫秒），由 materialize 层在各阶段间累计校验。 */
export const SANDBOX_TOTAL_BUDGET_MS = 300_000;

function normalizeHost(host: string): string {
  const value = (host || '').trim() || 'http://localhost:5050/';
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Hydro 沙箱地址无效：${value}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Hydro 沙箱地址仅支持 HTTP/HTTPS：${value}`);
  }
  return parsed.toString().replace(/\/+$/, '');
}

function buildPythonCommand(
  code: string,
  stdin: string,
  limits: { cpuLimit?: number; clockLimit?: number } = {},
) {
  return {
    args: ['/usr/bin/python3', 'main.py'],
    env: ['PATH=/usr/bin:/bin', 'PYTHONIOENCODING=utf-8', 'PYTHONDONTWRITEBYTECODE=1'],
    files: [
      { content: stdin },
      { name: 'stdout', max: STDOUT_LIMIT_BYTES },
      { name: 'stderr', max: STDERR_LIMIT_BYTES },
    ],
    cpuLimit: limits.cpuLimit ?? CPU_LIMIT_NS,
    clockLimit: limits.clockLimit ?? CLOCK_LIMIT_NS,
    memoryLimit: MEMORY_LIMIT_BYTES,
    stackLimit: 64 * 1024 * 1024,
    procLimit: 16,
    copyIn: {
      'main.py': { content: code },
    },
    copyOut: ['stdout', 'stderr'],
    copyOutMax: STDOUT_LIMIT_BYTES,
  };
}

function unwrapResults(data: unknown): GoJudgeResult[] {
  if (Array.isArray(data)) return data as GoJudgeResult[];
  if (data && typeof data === 'object' && Array.isArray((data as { results?: unknown }).results)) {
    return (data as { results: GoJudgeResult[] }).results;
  }
  throw new Error('Hydro 沙箱返回了无法识别的响应格式');
}

/** 截断保留尾部：Python traceback 的关键错误行在最后一行。 */
function truncateTail(text: string, max: number): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
}

/** 截断保留头部：用于摘录出错任务的输入内容。 */
function truncateHead(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 把 go-judge 原始结果映射为宽容明细，按 status 分类而不抛异常。 */
function toRunDetail(result: GoJudgeResult): PythonRunDetail {
  const status = result.status || '';
  const stdout = result.files?.stdout || '';
  const stderr = result.files?.stderr || '';
  const fileError = (result.fileError || [])
    .map(item => [item.name, item.type, item.message].filter(Boolean).join(': '))
    .join('; ');
  return {
    status,
    accepted: status === 'Accepted' && result.exitStatus === 0,
    timedOut: status === 'Time Limit Exceeded',
    exitStatus: result.exitStatus,
    stdout,
    stderr,
    error: result.error || fileError || undefined,
  };
}

export class GoJudgeSandboxRunner implements TestdataSandboxRunner {
  private readonly host: string;

  constructor(host: string, private readonly http: HttpClient = axios) {
    this.host = normalizeHost(host);
  }

  async isAvailable(signal?: AbortSignal): Promise<boolean> {
    try {
      await this.http.get(`${this.host}/version`, { timeout: 3000, signal, proxy: false });
      return true;
    } catch {
      return false;
    }
  }

  async runPython(code: string, stdin = '', signal?: AbortSignal): Promise<PythonRunResult> {
    const [result] = await this.runPythonBatch(code, [stdin], signal);
    return result;
  }

  /**
   * 严格版：任一条未 Accepted 即抛出可读中文错误（保留原有报错文案，向后兼容）。
   * 基于宽容版实现，报错取该条 stderr / error / exitStatus。
   */
  async runPythonBatch(code: string, inputs: string[], signal?: AbortSignal): Promise<PythonRunResult[]> {
    const details = await this.runPythonBatchDetailed(code, inputs, { signal });
    return details.map((detail, index) => {
      if (!detail.accepted) {
        const info = detail.stderr || detail.error || `exitStatus=${detail.exitStatus ?? 'unknown'}`;
        throw new Error(
          `第 ${index + 1} 个沙箱任务执行失败（${detail.status || 'Unknown'}）：${truncateTail(info, 1000)}\n`
          + `该任务的输入内容：${truncateHead(inputs[index], 300) || '（空）'}`,
        );
      }
      return { stdout: detail.stdout, stderr: detail.stderr };
    });
  }

  /**
   * 宽容 + 分块批量执行：不因单条失败抛错，仅在 HTTP/协议层错误时抛。
   * 按 SANDBOX_CHUNK_SIZE 分块、块间串行；块请求 timeout = chunkSize × clockLimit + 15s。
   */
  async runPythonBatchDetailed(
    code: string,
    inputs: string[],
    opts: PythonBatchOptions = {},
  ): Promise<PythonRunDetail[]> {
    if (inputs.length === 0) return [];
    const cpuSeconds = opts.cpuSeconds ?? 5;
    const cpuLimit = cpuSeconds * 1_000_000_000;
    const clockLimit = cpuSeconds * 2 * 1_000_000_000;
    const clockLimitMs = cpuSeconds * 2 * 1000;
    const chunkTimeout = SANDBOX_CHUNK_SIZE * clockLimitMs + 15_000;

    const details: PythonRunDetail[] = [];
    for (let offset = 0; offset < inputs.length; offset += SANDBOX_CHUNK_SIZE) {
      const chunk = inputs.slice(offset, offset + SANDBOX_CHUNK_SIZE);
      const response = await this.http.post(
        `${this.host}/run`,
        { cmd: chunk.map(input => buildPythonCommand(code, input, { cpuLimit, clockLimit })) },
        { timeout: chunkTimeout, signal: opts.signal, maxContentLength: 4 * 1024 * 1024, proxy: false },
      );
      const results = unwrapResults(response.data);
      if (results.length !== chunk.length) {
        throw new Error(`Hydro 沙箱返回 ${results.length} 个结果，期望 ${chunk.length} 个`);
      }
      for (const result of results) details.push(toRunDetail(result));
    }
    return details;
  }
}

export function getTestdataGenerationMode(raw = process.env.AI_HELPER_TESTDATA_GENERATION_MODE): TestdataGenerationMode {
  const value = (raw || 'auto').trim().toLowerCase();
  return value === 'sandbox' || value === 'direct' ? value : 'auto';
}
