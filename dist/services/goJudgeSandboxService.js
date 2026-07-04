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
exports.GoJudgeSandboxRunner = void 0;
exports.getTestdataGenerationMode = getTestdataGenerationMode;
const axios_1 = __importDefault(require("axios"));
const CPU_LIMIT_NS = 5000000000;
const CLOCK_LIMIT_NS = 10000000000;
const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
const STDOUT_LIMIT_BYTES = 1024 * 1024;
const STDERR_LIMIT_BYTES = 64 * 1024;
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
function buildPythonCommand(code, stdin) {
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
function unwrapResults(data) {
    if (Array.isArray(data))
        return data;
    if (data && typeof data === 'object' && Array.isArray(data.results)) {
        return data.results;
    }
    throw new Error('Hydro 沙箱返回了无法识别的响应格式');
}
function assertAccepted(result, index) {
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
    async runPythonBatch(code, inputs, signal) {
        if (inputs.length === 0)
            return [];
        const response = await this.http.post(`${this.host}/run`, { cmd: inputs.map(input => buildPythonCommand(code, input)) }, { timeout: 90000, signal, maxContentLength: 4 * 1024 * 1024, proxy: false });
        const results = unwrapResults(response.data);
        if (results.length !== inputs.length) {
            throw new Error(`Hydro 沙箱返回 ${results.length} 个结果，期望 ${inputs.length} 个`);
        }
        return results.map(assertAccepted);
    }
}
exports.GoJudgeSandboxRunner = GoJudgeSandboxRunner;
function getTestdataGenerationMode(raw = process.env.AI_HELPER_TESTDATA_GENERATION_MODE) {
    const value = (raw || 'auto').trim().toLowerCase();
    return value === 'sandbox' || value === 'direct' ? value : 'auto';
}
//# sourceMappingURL=goJudgeSandboxService.js.map