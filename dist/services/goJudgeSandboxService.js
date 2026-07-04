"use strict";
/**
 * go-judge 客户端：通过 Hydro 配置的沙箱执行 AI 生成的 Python 程序。
 *
 * 这里只传内存文件与标准输入输出，不在 Hydro Web 进程中执行任何 AI 代码。
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GoJudgeSandboxRunner = exports.SANDBOX_TOTAL_BUDGET_MS = exports.SANDBOX_CHUNK_SIZE = void 0;
exports.getTestdataGenerationMode = getTestdataGenerationMode;
const axios_1 = __importDefault(require("axios"));
const CPU_LIMIT_NS = 5000000000;
const CLOCK_LIMIT_NS = 10000000000;
const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
const STDOUT_LIMIT_BYTES = 1024 * 1024;
const STDERR_LIMIT_BYTES = 64 * 1024;
/**
 * 单请求内所有 cmd 在沙箱内并发执行；实测 2 核机上并发度过高会抢占内存与 RAM 盘，
 * 故大批量按块串行：每块最多 4 条，块间等待上一块返回后再发下一块。
 */
exports.SANDBOX_CHUNK_SIZE = 4;
/** 沙箱执行总时长预算（毫秒），由 materialize 层在各阶段间累计校验。 */
exports.SANDBOX_TOTAL_BUDGET_MS = 300000;
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
    async runPython(code, stdin = '', signal) {
        const [result] = await this.runPythonBatch(code, [stdin], signal);
        return result;
    }
    /**
     * 严格版：任一条未 Accepted 即抛出可读中文错误（保留原有报错文案，向后兼容）。
     * 基于宽容版实现，报错取该条 stderr / error / exitStatus。
     */
    async runPythonBatch(code, inputs, signal) {
        const details = await this.runPythonBatchDetailed(code, inputs, { signal });
        return details.map((detail, index) => {
            if (!detail.accepted) {
                const info = detail.stderr || detail.error || `exitStatus=${detail.exitStatus ?? 'unknown'}`;
                throw new Error(`第 ${index + 1} 个沙箱任务执行失败（${detail.status || 'Unknown'}）：${info.slice(0, 1000)}`);
            }
            return { stdout: detail.stdout, stderr: detail.stderr };
        });
    }
    /**
     * 宽容 + 分块批量执行：不因单条失败抛错，仅在 HTTP/协议层错误时抛。
     * 按 SANDBOX_CHUNK_SIZE 分块、块间串行；块请求 timeout = chunkSize × clockLimit + 15s。
     */
    async runPythonBatchDetailed(code, inputs, opts = {}) {
        if (inputs.length === 0)
            return [];
        const cpuSeconds = opts.cpuSeconds ?? 5;
        const cpuLimit = cpuSeconds * 1000000000;
        const clockLimit = cpuSeconds * 2 * 1000000000;
        const clockLimitMs = cpuSeconds * 2 * 1000;
        const chunkTimeout = exports.SANDBOX_CHUNK_SIZE * clockLimitMs + 15000;
        const details = [];
        for (let offset = 0; offset < inputs.length; offset += exports.SANDBOX_CHUNK_SIZE) {
            const chunk = inputs.slice(offset, offset + exports.SANDBOX_CHUNK_SIZE);
            const response = await this.http.post(`${this.host}/run`, { cmd: chunk.map(input => buildPythonCommand(code, input, { cpuLimit, clockLimit })) }, { timeout: chunkTimeout, signal: opts.signal, maxContentLength: 4 * 1024 * 1024, proxy: false });
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