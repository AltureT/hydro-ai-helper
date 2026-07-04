/**
 * BatchSummaryService - 批量生成学生 AI 学习总结
 *
 * 并发调度 AI 为每位学生生成个性化学习总结，支持 SSE 进度事件
 */

import type { Db } from 'mongodb';
import { BatchSummaryJobModel, BatchSummaryJob } from '../models/batchSummaryJob';
import { StudentSummaryModel, StudentSummary, ProblemSnapshot } from '../models/studentSummary';
import { StudentHistoryRecord, ErrorDistribution } from '../models/studentHistory';
import { SubmissionSampler, RawSubmission, SampleResult } from './submissionSampler';
import { extractAiErrorMetadata } from './openaiClient';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ProblemInfo {
  pid: string;
  title: string;
  content: string;
}

export interface SSEEvent {
  type: 'progress' | 'student_done' | 'student_failed' | 'job_done' | 'job_stopped';
  [key: string]: unknown;
}

// ─── HydroOJ record status mapping ───────────────────────────────────────────

const STATUS_MAP: Record<number, string> = {
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

// Adaptive-concurrency floor — never drop below this many parallel AI calls
const MIN_CONCURRENCY = 2;

// ─── Prompt builders ──────────────────────────────────────────────────────────

function buildSystemPrompt(locale: string, contestTitle: string, domainId: string): string {
  if (locale === 'zh') {
    return `你是一位充满热情、深谙教育心理学（特别是"成长型思维"）的资深编程教师。你的任务是根据学生在 OJ 平台上本次作业的提交数据和历史表现，写一份学生自己会认真读完的学习总结：先逐题讲清完成情况，再给一段让他有动力继续学的整体评价。

当前环境:
- 输出语言：中文，直接对学生说话（称"你"）
- 平台名称：HydroOJ
- 作业名称：${contestTitle}
- 提交链接格式：[提交 #rXXXX] — 前端会自动解析为 /d/${domainId}/record/XXXX 的可点击链接

【输出结构】固定三部分，除表格外的文字总计不超过 250 字：

一、逐题回顾 — 用 Markdown 表格逐题呈现，一题一行，必须覆盖本次作业的每一道题：
| 题目 | 完成情况 | 点评与建议 |
|---|---|---|
- "完成情况"固定用以下写法之一：✅ 一次通过 / ✅ N 次尝试后通过 / 🔶 尝试 N 次未通过 / ⬜ 未提交
- "点评与建议"限一句话，按情况写：
  - 已通过：肯定过程中的具体行为（如关键的一次调试改动，可引用 [提交 #rXXXX]）；若代码有明显优化空间（更简洁的写法、更低的复杂度、更清晰的命名），顺带半句点出方向，不写代码。
  - 未通过：指出最接近的一次尝试离通过只差哪个知识点，语气是"差一步"而不是"失败"。
  - 未提交：不指责，一句话降低门槛邀请尝试（如"和你已通过的某题思路相通"）。

二、整体评价 — 2~4 句自然段：结合提交行为（尝试次数、调试韧性、时间投入、历史进步）给出以正面鼓励为主的总评；表扬必须落在具体行为和策略上，不空喊"你真棒"，不与其他同学比较。

三、下一步 — 最后单独一行，以 "💡 下一步：" 开头，给一条具体、微小、可执行的建议（如复习某个知识点、重做某道题、画个流程图）。

【核心教育理念】
1. 过程胜于结果：赞美学生的努力、策略调整和坚持，而不是聪明或天赋。
2. 错误是学习的数据：将 Bug 视为探索过程中的必然，而非失败。
3. 真实且具体：每句表扬都要能对应到具体的提交数据；严禁编造数据中不存在的提交、分数或行为。

【情境触发策略（根据学生数据动态调整侧重点）】
请分析传入的学生数据，识别其属于以下哪种典型情境，并据此决定整体评价的侧重点：
- 情境 A [经历大量调试后最终 AC]：重点表扬"死磕到底"的韧性，还原他的调试路径。
- 情境 B [全部/大部分一次性 AC，用时极短]：简单肯定基础扎实，把重心放在"点评与建议"列的进阶方向上（如优化复杂度），避免其停留在舒适区。
- 情境 C [多次失败后放弃（未 AC）]：提供情感支持，肯定前期思考，指出卡住的核心概念，降低难度期望，鼓励下次再战。
- 情境 D [历史数据对比有明显进步]：结合"历史背景"用数据点出纵向成长（如"WA 占比明显下降"）。
（注意：学生可能同时符合多个情境，请综合判断。）`;
  }

  return `You are a passionate, senior programming teacher deeply versed in educational psychology, particularly "Growth Mindset". Your task is to write a learning summary the student will actually read: first a per-problem review, then an encouraging overall evaluation, based on their submissions for this homework and historical data on an Online Judge (OJ) platform.

Current environment:
- Output language: English, speaking directly to the student ("you")
- Platform: HydroOJ
- Homework title: ${contestTitle}
- Submission link format: [Submission #rXXXX] — frontend will auto-parse into /d/${domainId}/record/XXXX clickable links

[Output Structure] Exactly three parts; prose outside the table must not exceed 150 words:

1. Per-problem review — a Markdown table, one row per problem, covering EVERY problem in this homework:
| Problem | Result | Comment & Suggestion |
|---|---|---|
- "Result" must be one of: ✅ First-try AC / ✅ AC after N attempts / 🔶 N attempts, not passed / ⬜ Not attempted
- "Comment & Suggestion" is one sentence:
  - Passed: praise a specific behavior (e.g. the key debugging change, cite [Submission #rXXXX]); if the code has clear room for improvement (simpler style, lower complexity, better naming), add half a sentence pointing the direction — no code.
  - Not passed: name the single concept that separated their closest attempt from passing; frame it as "one step away", never as failure.
  - Not attempted: no blame; one low-barrier invitation to try (e.g. "shares its approach with a problem you already solved").

2. Overall evaluation — 2-4 natural sentences: combine submission behavior (attempt counts, debugging resilience, time invested, historical progress) into a mostly positive evaluation; praise specific behaviors and strategies, no generic fluff, no comparison with other students.

3. Next step — final line starting with "💡 Next step: ", one concrete, tiny, actionable suggestion.

[Core Educational Philosophy]
1. Process over Product: Praise effort, strategic adjustments, and persistence, not intelligence or talent.
2. Errors are Just Data: Frame bugs as necessary steps in exploration, not failures.
3. Authentic and Specific: Every claim must trace back to actual submission data; never invent submissions, scores, or behaviors.

[Situational Triggers (Adapt focus based on data)]
Analyze the student data and identify which scenario applies:
- Scenario A [Heavy debugging then AC]: Focus on praising grit, resilience, and problem-solving process.
- Scenario B [Most/All first-try AC, very fast]: Briefly acknowledge solid foundation, shift weight to the stretch goals in the Comment column.
- Scenario C [Multiple failures then gave up]: Strong emotional support, validate thinking, point out the stuck concept, encourage retry.
- Scenario D [Clear improvement from historical data]: Emphasize longitudinal growth using historical context.`;
}

const CONTENT_TOKEN_BUDGET = 2000;
const CHARS_PER_TOKEN = 3.5;

function truncateContent(content: string): string {
  const maxChars = Math.floor(CONTENT_TOKEN_BUDGET * CHARS_PER_TOKEN);
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + '\n[...truncated...]';
}

// ─── Helper functions ─────────────────────────────────────────────────────────

function classifyStudentScenario(snapshots: ProblemSnapshot[]): string {
  if (snapshots.length === 0) return 'C';
  const totalProblems = snapshots.length;
  const acProblems = snapshots.filter(
    (s) => s.allStatuses.some((st) => st.includes(':AC')),
  ).length;
  const totalSubmissions = snapshots.reduce((sum, s) => sum + s.submissionCount, 0);
  const avgAttempts = totalProblems > 0 ? totalSubmissions / totalProblems : 0;
  const gaveUp = snapshots.filter(
    (s) => s.submissionCount > 0 && s.submissionCount <= 2
      && !s.allStatuses.some((st) => st.includes(':AC')),
  ).length;
  if (acProblems === totalProblems && avgAttempts <= 1.5) return 'B';
  if (gaveUp >= totalProblems * 0.5) return 'C';
  if (acProblems > 0 && avgAttempts >= 4) return 'A';
  return 'A';
}

function extractActionableAdvice(text: string): string {
  const primary = text.match(/💡\s*(?:下一步[：:]\s*|Next step[：:]\s*)(.+)/i);
  if (primary) return primary[1].trim();
  const fallback1 = text.match(/💡\s*(.+)/);
  if (fallback1) return fallback1[1].trim();
  return text.slice(-200).trim();
}

function computeStudentStats(snapshots: ProblemSnapshot[]): {
  errorDistribution: ErrorDistribution;
  avgAttemptsToAC: number;
  gaveUpCount: number;
  notAttemptedCount: number;
  totalProblems: number;
  solvedCount: number;
} {
  const dist: ErrorDistribution = { CE: 0, RE: 0, WA: 0, TLE: 0, MLE: 0, AC: 0 };
  let acAttempts = 0;
  let acCount = 0;
  let gaveUp = 0;
  let notAttempted = 0;

  for (const snap of snapshots) {
    if (snap.submissionCount === 0) {
      notAttempted++;
      continue;
    }
    const hasAC = snap.allStatuses.some((st) => st.includes(':AC'));
    if (hasAC) {
      acCount++;
      acAttempts += snap.submissionCount;
    } else if (snap.submissionCount <= 2) {
      gaveUp++;
    }
    for (const st of snap.allStatuses) {
      const parts = st.split(':');
      const status = parts[parts.length - 1];
      if (status in dist) (dist as any)[status]++;
    }
  }

  return {
    errorDistribution: dist,
    avgAttemptsToAC: acCount > 0 ? Math.round((acAttempts / acCount) * 10) / 10 : 0,
    gaveUpCount: gaveUp,
    notAttemptedCount: notAttempted,
    totalProblems: snapshots.length,
    solvedCount: acCount,
  };
}

function buildHistoricalContext(records: StudentHistoryRecord[]): string | null {
  if (records.length === 0) return null;
  const latest = records[0];
  const oldest = records[records.length - 1];
  const latestTotal = Object.values(latest.errorDistribution).reduce((a, b) => a + b, 0) || 1;
  const oldestTotal = Object.values(oldest.errorDistribution).reduce((a, b) => a + b, 0) || 1;
  const ceShift = `CE: ${Math.round((oldest.errorDistribution.CE / oldestTotal) * 100)}%→${Math.round((latest.errorDistribution.CE / latestTotal) * 100)}%`;
  const waShift = `WA: ${Math.round((oldest.errorDistribution.WA / oldestTotal) * 100)}%→${Math.round((latest.errorDistribution.WA / latestTotal) * 100)}%`;
  const solvedTrend = records.slice().reverse().map((r) => `${r.solvedCount}/${r.totalProblems}`).join(' → ');
  const gaveUpTrend = records.slice().reverse().map((r) => r.gaveUpCount);
  const resilienceTrend = gaveUpTrend.length >= 2
    ? gaveUpTrend[gaveUpTrend.length - 1] < gaveUpTrend[0] ? 'improving' : gaveUpTrend[gaveUpTrend.length - 1] === gaveUpTrend[0] ? 'stable' : 'declining'
    : 'unknown';
  const recentStruggle = records.slice(0, 2).every((r) => r.totalProblems > 0 && r.solvedCount / r.totalProblems < 0.3);

  const ctx = {
    assignments_tracked: records.length,
    error_shift: `${ceShift}, ${waShift}`,
    resilience_trend: resilienceTrend,
    solved_rate_trend: solvedTrend,
    last_advice: latest.actionableAdvice || '',
    continuous_struggle: recentStruggle,
  };
  let json = JSON.stringify(ctx, null, 0);
  if (json.length > 500) {
    ctx.last_advice = ctx.last_advice.slice(0, 50) + '...';
    json = JSON.stringify(ctx, null, 0);
  }
  return json;
}

function buildUserPrompt(
  problems: ProblemInfo[],
  sampleResults: Map<string, SampleResult>,
): string {
  const parts: string[] = [];

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
        parts.push(
          `#### [提交 #r${sub.recordId}] 里程碑: ${sub.milestone} | 状态: ${sub.status} | 时间: ${sub.timestamp.toISOString()}`,
        );
        parts.push('```\n' + sub.code + '\n```');
      }
    }
  }

  return parts.join('\n\n');
}

// ─── BatchSummaryService ──────────────────────────────────────────────────────

export class BatchSummaryService {
  private db: Db;
  private jobModel: BatchSummaryJobModel;
  private summaryModel: StudentSummaryModel;
  private aiClient: any;
  private tokenUsageModel: any;
  private historyModel: any;
  private sampler: SubmissionSampler;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private featureStatsModel: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private errorReporter: any;

  constructor(
    db: Db,
    jobModel: BatchSummaryJobModel,
    summaryModel: StudentSummaryModel,
    aiClient: any,
    tokenUsageModel: any,
    historyModel?: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    featureStatsModel?: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    errorReporter?: any,
  ) {
    this.db = db;
    this.jobModel = jobModel;
    this.summaryModel = summaryModel;
    this.aiClient = aiClient;
    this.tokenUsageModel = tokenUsageModel;
    this.historyModel = historyModel || null;
    this.featureStatsModel = featureStatsModel || null;
    this.errorReporter = errorReporter || null;
    this.sampler = new SubmissionSampler();
  }

  /**
   * Execute batch summary generation.
   * @param pendingOnly - if true, only process students with 'pending' status (for continue after stop)
   */
  async execute(
    job: BatchSummaryJob,
    problems: ProblemInfo[],
    onEvent: (event: SSEEvent) => void,
    pendingOnly = false,
    userNameMap?: Map<number, string>,
  ): Promise<void> {
    // Step 1: Mark job as running
    this.featureStatsModel?.recordAttempt('batch_summary').catch(() => { /* best-effort */ });
    await this.jobModel.updateStatus(job._id, 'running');

    // Step 2: Fetch summaries to process
    const summaries = pendingOnly
      ? await this.summaryModel.findPendingByJob(job._id)
      : await this.summaryModel.findAllByJob(job._id);
    const total = summaries.length;
    let concurrency = job.config?.concurrency ?? 10;

    let completedCount = 0;
    let failedCount = 0;
    let totalTokens = 0;

    // Build system prompt once (invariant across all students in this job)
    const systemPrompt = buildSystemPrompt(job.config.locale, job.contestTitle, job.domainId);

    // Step 3: Process in rounds of `concurrency`
    let cursor = 0;
    while (cursor < summaries.length) {
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

      const batch = summaries.slice(cursor, cursor + concurrency);
      cursor += batch.length;

      const results = await Promise.allSettled(
        batch.map((summary) => this.processStudent(job, summary, problems, systemPrompt, onEvent, userNameMap)),
      );

      let roundFailed = 0;
      for (const result of results) {
        if (result.status === 'fulfilled') {
          completedCount++;
          totalTokens += result.value ?? 0;
        } else {
          failedCount++;
          roundFailed++;
        }
      }

      // Adaptive back-off: when most of a round fails (typically the AI
      // endpoint timing out under load), halve the concurrency instead of
      // keeping ten parallel calls hammering an endpoint that is already
      // struggling — fewer in-flight requests give each remaining call a
      // better shot at finishing inside its timeout budget.
      if (roundFailed * 2 > batch.length && concurrency > MIN_CONCURRENCY) {
        concurrency = Math.max(MIN_CONCURRENCY, Math.floor(concurrency / 2));
        console.warn(
          `[BatchSummaryService] ${roundFailed}/${batch.length} failed in one round — reducing concurrency to ${concurrency}`,
        );
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
    // Health signal: only count the run as a success when at most half the
    // students failed. The previous "at least one summary" rule marked a run
    // with 1/50 completions healthy, so an AI outage that failed nearly every
    // student never surfaced in per-feature health.
    if (completedCount > 0 && completedCount >= failedCount) {
      this.featureStatsModel?.recordSuccess('batch_summary').catch(() => { /* best-effort */ });
    }

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
  private async processStudent(
    job: BatchSummaryJob,
    summary: StudentSummary,
    problems: ProblemInfo[],
    systemPrompt: string,
    onEvent: (event: SSEEvent) => void,
    userNameMap?: Map<number, string>,
  ): Promise<number> {
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
      const recordsByPid = new Map<string, any[]>();
      for (const r of allRecords) {
        const pid = String(r.pid);
        if (!recordsByPid.has(pid)) recordsByPid.set(pid, []);
        recordsByPid.get(pid)!.push(r);
      }

      // c. Sample per problem
      const sampleResults = new Map<string, SampleResult>();
      const problemSnapshots: ProblemSnapshot[] = [];

      for (const problem of problems) {
        const rawRecords = recordsByPid.get(problem.pid) ?? [];
        const rawSubmissions: RawSubmission[] = rawRecords.map((r: any) => ({
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

      // d. Classify scenario and build user prompt
      const scenario = classifyStudentScenario(problemSnapshots);

      // d3. Fetch historical context
      let historyContext: string | null = null;
      if (this.historyModel) {
        try {
          const historyRecords = await this.historyModel.findRecent(job.domainId, summary.userId, 3);
          historyContext = buildHistoricalContext(historyRecords);
        } catch (err) {
          console.warn('[BatchSummaryService] Failed to fetch history:', err);
        }
      }

      // d4. Build user prompt with scenario + history
      const studentName = userNameMap?.get(summary.userId) || `User #${summary.userId}`;
      let userPrompt = `# 学生：${studentName}\n\n`;
      userPrompt += buildUserPrompt(problems, sampleResults);
      userPrompt += `\n\n---\n系统预判：该学生属于【情境 ${scenario}】，请据此调整侧重点。`;
      if (historyContext) {
        userPrompt += `\n\n历史背景:\n该学生在本课程的近期表现摘要如下，请参考以提供纵向对比和鼓励：\n${historyContext}\n\n特别注意：\n- 如果上次建议（last_advice）与本次表现有关联，请明确提及\n- 如果错误类型在升级（如从 CE 转向 WA/TLE），这是认知进步的信号\n- 如果发现连续多次受挫（continuous_struggle=true），降低难度期望，提供情感支持`;
      }

      // e. Call AI
      const response = await this.aiClient.chat(
        [{ role: 'user', content: userPrompt }],
        systemPrompt,
      );

      const summaryText: string = response.content;
      const promptTokens: number = response.usage?.prompt_tokens ?? 0;
      const completionTokens: number = response.usage?.completion_tokens ?? 0;

      // f. Save summary
      await this.summaryModel.completeSummary(
        summary._id,
        summaryText,
        problemSnapshots,
        { prompt: promptTokens, completion: completionTokens },
      );

      // g. Token counts are already persisted on the summary via completeSummary
      // above. Batch jobs are admin background tasks, not per-student chats, so
      // they are intentionally NOT written to TokenUsageModel (whose recordUsage
      // is keyed by conversationId/messageId for per-student budget tracking).
      // A previous `tokenUsageModel.record(...)` call here was a no-op that threw
      // "record is not a function" on every student (~870×) — removed.

      // g2. Save historical context record (fire-and-forget, non-blocking)
      if (this.historyModel) {
        const stats = computeStudentStats(problemSnapshots);
        const advice = extractActionableAdvice(summaryText);
        this.historyModel.create({
          domainId: job.domainId,
          userId: summary.userId,
          contestId: job.contestId,
          contestTitle: job.contestTitle,
          jobId: job._id,
          ...stats,
          actionableAdvice: advice,
          createdAt: new Date(),
          }).catch((histErr: any) => {
            console.warn('[BatchSummaryService] Failed to save history record:', histErr);
          });
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
    } catch (err: any) {
      const errorMessage = err?.message ?? String(err);

      await this.summaryModel.markFailed(summary._id, errorMessage);
      await this.jobModel.incrementFailed(job._id);

      onEvent({
        type: 'student_failed',
        userId: summary.userId,
        error: errorMessage,
      });

      console.error(`[BatchSummaryService] Failed for userId=${summary.userId}:`, err);

      // Telemetry: per-student failures previously only reached Mongo + SSE, so
      // a batch where every student timed out looked healthy on the platform.
      // The reporter dedupes by stack fingerprint, so N students failing the
      // same way become one entry with count=N — no flood risk.
      try {
        this.errorReporter?.capture(
          'background_job', 'batch_summary',
          errorMessage,
          undefined,
          err instanceof Error ? err.stack : undefined,
          // AI 失败时附带各端点尝试详情（HTTP 状态/服务商消息），
          // 否则错误面板只有 "All models failed" 一句话无从定位
          { jobId: String(job._id), domainId: job.domainId, ...extractAiErrorMetadata(err) },
        );
      } catch { /* best-effort */ }

      // Re-throw so Promise.allSettled registers as 'rejected'
      throw err;
    }
  }
}
