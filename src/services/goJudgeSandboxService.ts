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

export interface TestdataSandboxRunner {
  isAvailable(signal?: AbortSignal): Promise<boolean>;
  runPython(code: string, stdin?: string, signal?: AbortSignal): Promise<PythonRunResult>;
  runPythonBatch(code: string, inputs: string[], signal?: AbortSignal): Promise<PythonRunResult[]>;
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

function buildPythonCommand(code: string, stdin: string) {
  return {
    args: ['/usr/bin/python3', 'main.py'],
    env: ['PATH=/usr/bin:/bin', 'PYTHONIOENCODING=utf-8', 'PYTHONDONTWRITEBYTECODE=1'],
    files: [
      { content: stdin },
      { name: 'stdout', max: STDOUT_LIMIT_BYTES },
      { name: 'stderr', max: STDERR_LIMIT_BYTES },
    ],
    cpuLimit: CPU_LIMIT_NS,
    clockLimit: CLOCK_LIMIT_NS,
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

function assertAccepted(result: GoJudgeResult, index: number): PythonRunResult {
  const stdout = result.files?.stdout || '';
  const stderr = result.files?.stderr || '';
  if (result.status !== 'Accepted' || result.exitStatus !== 0) {
    const fileError = (result.fileError || [])
      .map(item => [item.name, item.type, item.message].filter(Boolean).join(': '))
      .join('; ');
    const detail = stderr || result.error || fileError || `exitStatus=${result.exitStatus ?? 'unknown'}`;
    throw new Error(`第 ${index + 1} 个沙箱任务执行失败（${result.status || 'Unknown'}）：${detail.slice(0, 1000)}`);
  }
  return { stdout, stderr };
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

  async runPythonBatch(code: string, inputs: string[], signal?: AbortSignal): Promise<PythonRunResult[]> {
    if (inputs.length === 0) return [];
    const response = await this.http.post(
      `${this.host}/run`,
      { cmd: inputs.map(input => buildPythonCommand(code, input)) },
      { timeout: 90_000, signal, maxContentLength: 4 * 1024 * 1024, proxy: false },
    );
    const results = unwrapResults(response.data);
    if (results.length !== inputs.length) {
      throw new Error(`Hydro 沙箱返回 ${results.length} 个结果，期望 ${inputs.length} 个`);
    }
    return results.map(assertAccepted);
  }
}

export function getTestdataGenerationMode(raw = process.env.AI_HELPER_TESTDATA_GENERATION_MODE): TestdataGenerationMode {
  const value = (raw || 'auto').trim().toLowerCase();
  return value === 'sandbox' || value === 'direct' ? value : 'auto';
}
