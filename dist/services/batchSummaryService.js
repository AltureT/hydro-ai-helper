"use strict";
/**
 * BatchSummaryService - 批量生成学生 AI 学习总结
 *
 * 并发调度 AI 为每位学生生成个性化学习总结，支持 SSE 进度事件
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BatchSummaryService = void 0;
const submissionSampler_1 = require("./submissionSampler");
// ─── HydroOJ record status mapping ───────────────────────────────────────────
const STATUS_MAP = {
    1: 'AC',
    2: 'WA',
    3: 'TLE',
    4: 'MLE',
    5: 'OLE',
    6: 'RE',
    7: 'CE',
    8: 'SE',
    9: 'IGN',
    10: 'Pending',
    11: 'Compiling',
    12: 'Judging',
};
// ─── Prompt builders ──────────────────────────────────────────────────────────
function buildSystemPrompt(locale, contestTitle, domainId) {
    const lang = locale === 'zh' ? '中文' : 'English';
    return `你是 HydroOJ 平台上的资深编程导师。你的任务是根据学生的作业或比赛提交记录，生成一份个性化的学习总结，供学生复盘和教师查阅。

## 当前环境
- 输出语言：${lang}
- 平台名称：HydroOJ
- 作业名称：${contestTitle}
- 提交链接格式：[提交 #rXXXX] — 前端会自动解析为 /d/${domainId}/record/XXXX 的可点击链接

## 原则
1. 教育为先，绝不代笔
2. 强制引用格式 [提交 #rXXXX]
3. 洞察全局错误模式
4. 肯定努力与调试过程
5. 因材施教
6. 语气与篇幅：200-800字`;
}
const CONTENT_TOKEN_BUDGET = 2000;
const CHARS_PER_TOKEN = 3.5;
function truncateContent(content) {
    const maxChars = Math.floor(CONTENT_TOKEN_BUDGET * CHARS_PER_TOKEN);
    if (content.length <= maxChars)
        return content;
    return content.slice(0, maxChars) + '\n[...truncated...]';
}
function buildUserPrompt(problems, sampleResults) {
    const parts = [];
    for (const problem of problems) {
        const result = sampleResults.get(problem.pid);
        parts.push(`## 题目：${problem.title}`);
        parts.push(`### 题目描述\n${truncateContent(problem.content)}`);
        if (!result || result.submissionCount === 0) {
            parts.push('### 提交记录\n（无提交）');
            continue;
        }
        parts.push(`### 提交时间线（共 ${result.submissionCount} 次提交）`);
        if (result.allStatuses.length > 0) {
            parts.push(result.allStatuses.join('\n'));
        }
        if (result.sampledSubmissions.length > 0) {
            parts.push('\n### 代码样本');
            for (const sub of result.sampledSubmissions) {
                parts.push(`#### [提交 #r${sub.recordId}] 里程碑: ${sub.milestone} | 状态: ${sub.status} | 时间: ${sub.timestamp.toISOString()}`);
                parts.push('```\n' + sub.code + '\n```');
            }
        }
    }
    return parts.join('\n\n');
}
// ─── BatchSummaryService ──────────────────────────────────────────────────────
class BatchSummaryService {
    constructor(db, jobModel, summaryModel, aiClient, tokenUsageModel) {
        this.db = db;
        this.jobModel = jobModel;
        this.summaryModel = summaryModel;
        this.aiClient = aiClient;
        this.tokenUsageModel = tokenUsageModel;
        this.sampler = new submissionSampler_1.SubmissionSampler();
    }
    /**
     * Execute batch summary generation.
     * @param pendingOnly - if true, only process students with 'pending' status (for continue after stop)
     */
    async execute(job, problems, onEvent, pendingOnly = false) {
        // Step 1: Mark job as running
        await this.jobModel.updateStatus(job._id, 'running');
        // Step 2: Fetch summaries to process
        const summaries = pendingOnly
            ? await this.summaryModel.findPendingByJob(job._id)
            : await this.summaryModel.findAllByJob(job._id);
        const total = summaries.length;
        const concurrency = job.config?.concurrency ?? 10;
        let completedCount = 0;
        let failedCount = 0;
        let totalTokens = 0;
        // Step 3: Process in batches of `concurrency`
        for (let i = 0; i < summaries.length; i += concurrency) {
            // Check if job was stopped between batches
            const currentJob = await this.jobModel.findById(job._id);
            if (currentJob?.status === 'stopped') {
                // Reset any students stuck in 'generating' back to 'pending'
                await this.summaryModel.resetGeneratingToPending(job._id);
                onEvent({
                    type: 'job_stopped',
                    completed: completedCount,
                    failed: failedCount,
                });
                return;
            }
            const batch = summaries.slice(i, i + concurrency);
            const results = await Promise.allSettled(batch.map((summary) => this.processStudent(job, summary, problems, onEvent)));
            for (const result of results) {
                if (result.status === 'fulfilled') {
                    completedCount++;
                    totalTokens += result.value ?? 0;
                }
                else {
                    failedCount++;
                }
            }
            // Emit progress after each batch
            onEvent({
                type: 'progress',
                completed: completedCount,
                total,
                failed: failedCount,
            });
        }
        // Step 4: Finalize job status
        const finalStatus = completedCount > 0 || failedCount === 0 ? 'completed' : 'failed';
        await this.jobModel.updateStatus(job._id, finalStatus);
        onEvent({
            type: 'job_done',
            completed: completedCount,
            failed: failedCount,
            totalTokens,
        });
    }
    /**
     * Process a single student's summary.
     * Returns total tokens used on success; throws on failure.
     */
    async processStudent(job, summary, problems, onEvent) {
        try {
            // a. Mark as generating
            await this.summaryModel.markGenerating(summary._id);
            // b. Fetch all submissions for this student in one query
            // HydroOJ record.pid is number — convert string pids to numbers for query
            const numericPids = problems.map((p) => Number(p.pid)).filter((n) => !Number.isNaN(n));
            const allRecords = await this.db
                .collection('record')
                .find({
                domainId: job.domainId,
                uid: summary.userId,
                pid: { $in: numericPids },
            })
                .sort({ judgeAt: 1 })
                .toArray();
            // Group records by pid
            const recordsByPid = new Map();
            for (const r of allRecords) {
                const pid = String(r.pid);
                if (!recordsByPid.has(pid))
                    recordsByPid.set(pid, []);
                recordsByPid.get(pid).push(r);
            }
            // c. Sample per problem
            const sampleResults = new Map();
            const problemSnapshots = [];
            for (const problem of problems) {
                const rawRecords = recordsByPid.get(problem.pid) ?? [];
                const rawSubmissions = rawRecords.map((r) => ({
                    recordId: r._id,
                    code: r.code ?? '',
                    status: STATUS_MAP[r.status] ?? String(r.status),
                    score: r.score ?? 0,
                    lang: r.lang ?? 'cpp',
                    timestamp: r.judgeAt ?? new Date(),
                    runtime: r.time ?? 0,
                    memory: r.memory ?? 0,
                }));
                const lang = rawSubmissions[0]?.lang ?? 'cpp';
                const sampleResult = this.sampler.sample(rawSubmissions, lang);
                sampleResults.set(problem.pid, sampleResult);
                problemSnapshots.push({
                    pid: problem.pid,
                    title: problem.title,
                    submissionCount: sampleResult.submissionCount,
                    sampledSubmissions: sampleResult.sampledSubmissions,
                    allStatuses: sampleResult.allStatuses,
                });
            }
            // d. Build prompts
            const systemPrompt = buildSystemPrompt(job.config.locale, job.contestTitle, job.domainId);
            const userPrompt = buildUserPrompt(problems, sampleResults);
            // e. Call AI
            const response = await this.aiClient.chat([{ role: 'user', content: userPrompt }], systemPrompt);
            const summaryText = response.content;
            const promptTokens = response.usage?.prompt_tokens ?? 0;
            const completionTokens = response.usage?.completion_tokens ?? 0;
            // f. Save summary
            await this.summaryModel.completeSummary(summary._id, summaryText, problemSnapshots, { prompt: promptTokens, completion: completionTokens });
            // g. Record token usage
            try {
                await this.tokenUsageModel.record({
                    domainId: job.domainId,
                    jobId: job._id,
                    userId: summary.userId,
                    promptTokens,
                    completionTokens,
                });
            }
            catch (tokenErr) {
                console.warn('[BatchSummaryService] Failed to record token usage:', tokenErr);
            }
            await this.jobModel.incrementCompleted(job._id);
            // h. Emit student_done event
            onEvent({
                type: 'student_done',
                userId: summary.userId,
                status: 'completed',
                summary: summaryText,
            });
            return promptTokens + completionTokens;
        }
        catch (err) {
            const errorMessage = err?.message ?? String(err);
            await this.summaryModel.markFailed(summary._id, errorMessage);
            await this.jobModel.incrementFailed(job._id);
            onEvent({
                type: 'student_failed',
                userId: summary.userId,
                error: errorMessage,
            });
            console.error(`[BatchSummaryService] Failed for userId=${summary.userId}:`, err);
            // Re-throw so Promise.allSettled registers as 'rejected'
            throw err;
        }
    }
}
exports.BatchSummaryService = BatchSummaryService;
//# sourceMappingURL=batchSummaryService.js.map