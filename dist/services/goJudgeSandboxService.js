"use strict";
/**
 * go-judge 客户端：通过 Hydro 配置的沙箱执行 AI 生成的 Python / C++ 程序。
 *
 * 这里只传内存文件与标准输入输出，不在 Hydro Web 进程中执行任何 AI 代码。
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GoJudgeSandboxRunner = exports.DISCRIMINATION_BUDGET_MS = exports.SANDBOX_TOTAL_BUDGET_MS = exports.SANDBOX_RESPONSE_LIMIT_BYTES = exports.SANDBOX_CHUNK_SIZE = void 0;
exports.getTestdataGenerationMode = getTestdataGenerationMode;
const axios_1 = __importDefault(require("axios"));
const textTruncate_1 = require("../lib/textTruncate");
const CPU_LIMIT_NS = 5000000000;
const CLOCK_LIMIT_NS = 10000000000;
const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
const STDOUT_LIMIT_BYTES = 1024 * 1024;
const STDERR_LIMIT_BYTES = 64 * 1024;
const CPP_COMPILE_CPU_LIMIT_NS = 30000000000;
const CPP_COMPILE_CLOCK_LIMIT_NS = 60000000000;
const CPP_COMPILE_MEMORY_LIMIT_BYTES = 1024 * 1024 * 1024;
const CPP_COMPILE_PROC_LIMIT = 64;
const CPP_COMPILE_TIMEOUT_MS = 75000;
const SANDBOX_BUDGET_ERROR = '沙箱执行总时长超出预算，请减少测试点数量后重试';
/**
 * 单请求内所有 cmd 在沙箱内并发执行；实测 2 核机上并发度过高会抢占内存与 RAM 盘，
 * 故大批量按块串行：每块最多 4 条，块间等待上一块返回后再发下一块。
 */
exports.SANDBOX_CHUNK_SIZE = 4;
/**
 * Axios 的响应上限必须覆盖整批 go-judge 结果，而不是单条 stdout。
 * stdout/stderr 会被 JSON 转义，最坏情况下体积接近原始内容的两倍；
 * 额外预留 1MB 给状态、fileError 与 JSON 结构开销。
 */
exports.SANDBOX_RESPONSE_LIMIT_BYTES = (exports.SANDBOX_CHUNK_SIZE * (STDOUT_LIMIT_BYTES + STDERR_LIMIT_BYTES) * 2) + 1024 * 1024;
/** 沙箱执行总时长预算（毫秒），由 materialize 层在各阶段间累计校验。 */
exports.SANDBOX_TOTAL_BUDGET_MS = 300000;
/** 区分度验证独立预算，不占用正确性验证的总时长预算。 */
exports.DISCRIMINATION_BUDGET_MS = 180000;
function normalizeHost(host) {
    const value = (host || '').trim() || 'http://localhost:5050/';
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        throw new Error(`Hydro 沙箱地址无效：${value}`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error(`Hydro 沙箱地址仅支持 HTTP/HTTPS：${value}`);
    }
    return parsed.toString().replace(/\/+$/, '');
}
function buildPythonCommand(code, stdin, limits = {}) {
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
function buildCppCompileCommand(source, extraFiles = {}) {
    const extraCopyIn = Object.fromEntries(Object.entries(extraFiles).map(([name, content]) => [name, { content }]));
    return {
        args: ['/usr/bin/g++', '-O2', '-std=c++17', '-o', 'prog', 'prog.cc'],
        env: ['PATH=/usr/bin:/bin'],
        files: [
            { content: '' },
            { name: 'stdout', max: STDERR_LIMIT_BYTES },
            { name: 'stderr', max: STDERR_LIMIT_BYTES },
        ],
        cpuLimit: CPP_COMPILE_CPU_LIMIT_NS,
        clockLimit: CPP_COMPILE_CLOCK_LIMIT_NS,
        memoryLimit: CPP_COMPILE_MEMORY_LIMIT_BYTES,
        procLimit: CPP_COMPILE_PROC_LIMIT,
        copyIn: {
            ...extraCopyIn,
            'prog.cc': { content: source },
        },
        copyOut: ['stdout', 'stderr'],
        copyOutCached: ['prog'],
    };
}
function buildCompiledCommand(fileId, stdin, limits = {}) {
    return {
        args: ['prog'],
        env: ['PATH=/usr/bin:/bin'],
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
            prog: { fileId },
        },
        copyOut: ['stdout', 'stderr'],
        copyOutMax: STDOUT_LIMIT_BYTES,
    };
}
function unwrapResults(data) {
    if (Array.isArray(data))
        return data;
    if (data && typeof data === 'object' && Array.isArray(data.results)) {
        return data.results;
    }
    throw new Error('Hydro 沙箱返回了无法识别的响应格式');
}
/** 把 go-judge 原始结果映射为宽容明细，按 status 分类而不抛异常。 */
function toRunDetail(result) {
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
function summarizeSandboxError(err) {
    if (err instanceof Error)
        return (0, textTruncate_1.excerptTail)(err.message, 2000);
    return (0, textTruncate_1.excerptTail)(String(err), 2000);
}
class GoJudgeSandboxRunner {
    constructor(host, http = axios_1.default) {
        this.http = http;
        this.host = normalizeHost(host);
    }
    async isAvailable(signal) {
        try {
            await this.http.get(`${this.host}/version`, { timeout: 3000, signal, proxy: false });
            return true;
        }
        catch {
            return false;
        }
    }
    /**
     * 将 C++17 源码编译为 go-judge 缓存文件。编译器、协议或网络不可用均返回
     * ok:false，便于上层按降级铁律回到 Python-only；仅用户主动取消原样上抛。
     */
    async compileCpp(source, opts = {}) {
        const remainingBudgetMs = opts.deadlineAt === undefined
            ? Number.POSITIVE_INFINITY
            : opts.deadlineAt - Date.now();
        if (remainingBudgetMs <= 0)
            return { ok: false, error: SANDBOX_BUDGET_ERROR };
        try {
            const response = await this.http.post(`${this.host}/run`, { cmd: [buildCppCompileCommand(source, opts.extraFiles)] }, {
                timeout: Math.max(1, Math.min(CPP_COMPILE_TIMEOUT_MS, remainingBudgetMs)),
                signal: opts.signal,
                maxContentLength: exports.SANDBOX_RESPONSE_LIMIT_BYTES,
                proxy: false,
            });
            if (opts.deadlineAt !== undefined && Date.now() >= opts.deadlineAt) {
                return { ok: false, error: SANDBOX_BUDGET_ERROR };
            }
            const results = unwrapResults(response.data);
            if (results.length !== 1) {
                return {
                    ok: false,
                    error: `Hydro 沙箱返回 ${results.length} 个编译结果，期望 1 个`,
                };
            }
            const result = results[0];
            const detail = toRunDetail(result);
            if (!detail.accepted) {
                const info = detail.stderr
                    || detail.error
                    || `${detail.status || 'Unknown'}（exitStatus=${detail.exitStatus ?? 'unknown'}）`;
                return { ok: false, error: (0, textTruncate_1.excerptTail)(info, 2000) };
            }
            const fileId = result.fileIds?.prog;
            if (!fileId) {
                return { ok: false, error: 'Hydro 沙箱编译成功但未返回 prog 缓存文件' };
            }
            return { ok: true, fileId };
        }
        catch (err) {
            if (opts.signal?.aborted)
                throw err;
            if (opts.deadlineAt !== undefined && Date.now() >= opts.deadlineAt) {
                return { ok: false, error: SANDBOX_BUDGET_ERROR };
            }
            return { ok: false, error: summarizeSandboxError(err) };
        }
    }
    /** 删除 go-judge 缓存文件；清理失败不得遮蔽原流程结果。 */
    async deleteCachedFile(fileId) {
        if (!this.http.delete)
            return;
        try {
            await this.http.delete(`${this.host}/file/${encodeURIComponent(fileId)}`, { timeout: 3000, proxy: false });
        }
        catch {
            // best-effort：缓存会由 go-judge TTL 最终回收，不能让清理失败影响生成结果。
        }
    }
    async runPython(code, stdin = '', signal, deadlineAt) {
        const [result] = await this.runPythonBatch(code, [stdin], signal, deadlineAt);
        return result;
    }
    /**
     * 严格版：任一条未 Accepted 即抛出可读中文错误（保留原有报错文案，向后兼容）。
     * 基于宽容版实现，报错取该条 stderr / error / exitStatus。
     */
    async runPythonBatch(code, inputs, signal, deadlineAt) {
        const details = await this.runPythonBatchDetailed(code, inputs, { signal, deadlineAt });
        return details.map((detail, index) => {
            if (!detail.accepted) {
                const info = detail.stderr || detail.error || `exitStatus=${detail.exitStatus ?? 'unknown'}`;
                throw new Error(`第 ${index + 1} 个沙箱任务执行失败（${detail.status || 'Unknown'}）：${(0, textTruncate_1.excerptTail)(info, 1000)}\n`
                    + `该任务的输入内容：${(0, textTruncate_1.excerpt)(inputs[index] ?? '', 300) || '（空）'}`);
            }
            return { stdout: detail.stdout, stderr: detail.stderr };
        });
    }
    /**
     * 宽容 + 分块批量执行：不因单条失败抛错，仅在 HTTP/协议层错误时抛。
     * 按 SANDBOX_CHUNK_SIZE 分块、块间串行；块请求 timeout = chunkSize × clockLimit + 15s。
     */
    async runPythonBatchDetailed(code, inputs, opts = {}) {
        return this.runBatchDetailed(inputs, opts, (input, limits) => buildPythonCommand(code, input, limits));
    }
    /** 宽容执行已缓存的二进制，分块、限额与绝对截止时间语义和 Python 完全一致。 */
    async runCompiledBatchDetailed(fileId, inputs, opts = {}) {
        return this.runBatchDetailed(inputs, opts, (input, limits) => buildCompiledCommand(fileId, input, limits));
    }
    async runBatchDetailed(inputs, opts, buildCommand) {
        if (inputs.length === 0)
            return [];
        const cpuSeconds = opts.cpuSeconds ?? 5;
        const cpuLimit = cpuSeconds * 1000000000;
        const clockLimit = cpuSeconds * 2 * 1000000000;
        const clockLimitMs = cpuSeconds * 2 * 1000;
        const chunkTimeout = exports.SANDBOX_CHUNK_SIZE * clockLimitMs + 15000;
        const details = [];
        for (let offset = 0; offset < inputs.length; offset += exports.SANDBOX_CHUNK_SIZE) {
            const remainingBudgetMs = opts.deadlineAt === undefined
                ? Number.POSITIVE_INFINITY
                : opts.deadlineAt - Date.now();
            if (remainingBudgetMs <= 0)
                throw new Error(SANDBOX_BUDGET_ERROR);
            const chunk = inputs.slice(offset, offset + exports.SANDBOX_CHUNK_SIZE);
            let response;
            try {
                response = await this.http.post(`${this.host}/run`, { cmd: chunk.map(input => buildCommand(input, { cpuLimit, clockLimit })) }, {
                    timeout: Math.max(1, Math.min(chunkTimeout, remainingBudgetMs)),
                    signal: opts.signal,
                    maxContentLength: exports.SANDBOX_RESPONSE_LIMIT_BYTES,
                    proxy: false,
                });
            }
            catch (err) {
                if (opts.deadlineAt !== undefined && Date.now() >= opts.deadlineAt && !opts.signal?.aborted) {
                    throw new Error(SANDBOX_BUDGET_ERROR);
                }
                throw err;
            }
            if (opts.deadlineAt !== undefined && Date.now() >= opts.deadlineAt) {
                throw new Error(SANDBOX_BUDGET_ERROR);
            }
            const results = unwrapResults(response.data);
            if (results.length !== chunk.length) {
                throw new Error(`Hydro 沙箱返回 ${results.length} 个结果，期望 ${chunk.length} 个`);
            }
            for (const result of results)
                details.push(toRunDetail(result));
        }
        return details;
    }
}
exports.GoJudgeSandboxRunner = GoJudgeSandboxRunner;
function getTestdataGenerationMode(raw = process.env.AI_HELPER_TESTDATA_GENERATION_MODE) {
    const value = (raw || 'auto').trim().toLowerCase();
    return value === 'sandbox' || value === 'direct' ? value : 'auto';
}
//# sourceMappingURL=goJudgeSandboxService.js.map