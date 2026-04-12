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

// ─── Prompt builders ──────────────────────────────────────────────────────────

function buildSystemPrompt(locale: string, contestTitle: string, domainId: string): string {
  if (locale === 'zh') {
    return `你是一位充满热情、深谙教育心理学（特别是"成长型思维"）的资深编程教师。你的任务是根据学生在 OJ 平台上的近期作业表现和历史数据，写一段个性化、有温度的学习总结。

当前环境:
- 输出语言：中文
- 平台名称：HydroOJ
- 作业名称：${contestTitle}
- 提交链接格式：[提交 #rXXXX] — 前端会自动解析为 /d/${domainId}/record/XXXX 的可点击链接

【核心教育理念】
1. 过程胜于结果：赞美学生的努力、策略调整和坚持，而不是聪明或天赋。
2. 错误是学习的数据：将 Bug 视为探索过程中的必然，而非失败。
3. 真实且具体：表扬必须基于具体的代码表现或行为数据，拒绝空泛的"你真棒"。

【写作风格与语气】
- 语气自然、对话感强：就像老师在课后把学生叫到身边，面对面、平等的交流。
- 拒绝生搬硬套的模板：不要使用生硬的标题（如"闪光点"、"解题历程"等），段落过渡要自然。
- 长度灵活：根据学生表现的丰富程度决定篇幅。简单情况 100 字即可，复杂调试过程可以展开（不超过 500 字）。
- 强制引用格式：引用学生提交时使用 [提交 #rXXXX] 格式。

【情境触发策略（根据学生数据动态调整侧重点）】
请分析传入的学生数据，识别其属于以下哪种典型情境，并据此决定侧重点：
- 情境 A [经历大量调试后最终 AC]：重点表扬"死磕到底"的韧性和解决问题的过程。
- 情境 B [全部/大部分一次性 AC，用时极短]：简单肯定基础扎实，重点给出进阶挑战（如优化复杂度），避免其停留在舒适区。
- 情境 C [多次失败后放弃（未 AC）]：提供情感支持，肯定前期思考，指出卡住的核心概念，降低难度期望，鼓励下次再战。
- 情境 D [历史数据对比有明显进步]：结合"历史背景"强调纵向成长。
（注意：学生可能同时符合多个情境，请综合判断。）

【硬性要求】
在总结的最后，你必须自然地融入一条"下一步建议"。这必须是一个具体、微小、可执行的建议（如复习某个知识点、画个流程图、挑战某类型的题）。用 "💡 下一步：" 标记这句话。`;
  }

  return `You are a passionate, senior programming teacher deeply versed in educational psychology, particularly "Growth Mindset". Your task is to write a personalized, warm learning summary based on a student's recent homework performance and historical data on an Online Judge (OJ) platform.

Current environment:
- Output language: English
- Platform: HydroOJ
- Homework title: ${contestTitle}
- Submission link format: [Submission #rXXXX] — frontend will auto-parse into /d/${domainId}/record/XXXX clickable links

[Core Educational Philosophy]
1. Process over Product: Praise effort, strategic adjustments, and persistence, not intelligence or talent.
2. Errors are Just Data: Frame bugs as necessary steps in exploration, not failures.
3. Authentic and Specific: All praise must be grounded in specific code behaviors or submission data. No generic fluff.

[Writing Style & Tone]
- Natural and Conversational: Write as if talking to the student face-to-face after class.
- No Rigid Templates: Do NOT use stiff headings. Let paragraphs flow naturally.
- Flexible Length: Simple one-shot AC ~ 100 words. Complex debugging journey up to 500 words.
- Mandatory citation: Reference submissions using [Submission #rXXXX] format.

[Situational Triggers (Adapt focus based on data)]
Analyze the student data and identify which scenario applies:
- Scenario A [Heavy debugging then AC]: Focus on praising grit, resilience, and problem-solving process.
- Scenario B [Most/All first-try AC, very fast]: Briefly acknowledge solid foundation, focus on stretch goals.
- Scenario C [Multiple failures then gave up]: Strong emotional support, validate thinking, point out the stuck concept, encourage retry.
- Scenario D [Clear improvement from historical data]: Emphasize longitudinal growth using historical context.

[Strict Requirement]
At the end of your summary, naturally integrate one "Actionable Next Step". Mark it with "💡 Next step: ".`;
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

  constructor(
    db: Db,
    jobModel: BatchSummaryJobModel,
    summaryModel: StudentSummaryModel,
    aiClient: any,
    tokenUsageModel: any,
    historyModel?: any,
  ) {
    this.db = db;
    this.jobModel = jobModel;
    this.summaryModel = summaryModel;
    this.aiClient = aiClient;
    this.tokenUsageModel = tokenUsageModel;
    this.historyModel = historyModel || null;
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
  ): Promise<void> {
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

      const results = await Promise.allSettled(
        batch.map((summary) => this.processStudent(job, summary, problems, onEvent)),
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          completedCount++;
          totalTokens += result.value ?? 0;
        } else {
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
  private async processStudent(
    job: BatchSummaryJob,
    summary: StudentSummary,
    problems: ProblemInfo[],
    onEvent: (event: SSEEvent) => void,
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

      // d. Build prompts
      const systemPrompt = buildSystemPrompt(job.config.locale, job.contestTitle, job.domainId);

      // d2. Classify scenario
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
      let userPrompt = buildUserPrompt(problems, sampleResults);
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

      // g. Record token usage
      try {
        await this.tokenUsageModel.record({
          domainId: job.domainId,
          jobId: job._id,
          userId: summary.userId,
          promptTokens,
          completionTokens,
        });
      } catch (tokenErr) {
        console.warn('[BatchSummaryService] Failed to record token usage:', tokenErr);
      }

      // g2. Save historical context record (non-blocking)
      if (this.historyModel) {
        try {
          const stats = computeStudentStats(problemSnapshots);
          const advice = extractActionableAdvice(summaryText);
          await this.historyModel.create({
            domainId: job.domainId,
            userId: summary.userId,
            contestId: job.contestId,
            contestTitle: job.contestTitle,
            jobId: job._id,
            ...stats,
            actionableAdvice: advice,
            createdAt: new Date(),
          });
        } catch (histErr) {
          console.warn('[BatchSummaryService] Failed to save history record:', histErr);
        }
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

      // Re-throw so Promise.allSettled registers as 'rejected'
      throw err;
    }
  }
}
