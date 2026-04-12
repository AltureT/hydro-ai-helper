/**
 * Batch Summary Handlers - 批量生成学生 AI 学习总结 API
 *
 * 提供竞赛批量摘要的生成、查看、重试、发布、导出、编辑、停止和继续功能
 */

import { Handler, PRIV, db } from 'hydrooj';
import type { ServerResponse } from 'http';
import { ObjectId } from '../utils/mongo';
import { getDomainId } from '../utils/domainHelper';
import { createSSEWriter } from '../lib/sseHelper';
import { createMultiModelClientFromConfig } from '../services/openaiClient';
import { BatchSummaryJobModel } from '../models/batchSummaryJob';
import { StudentSummaryModel } from '../models/studentSummary';
import { BatchSummaryService, ProblemInfo } from '../services/batchSummaryService';

// ─── CSV helper ───────────────────────────────────────────────────────────────

function escapeCsv(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * BatchSummaryGenerateHandler - 触发批量生成任务
 * POST /ai-helper/batch-summaries/generate
 */
export class BatchSummaryGenerateHandler extends Handler {
  async post() {
    try {
      const domainId = getDomainId(this);
      const { contestId, mode, confirmRegenerate } = this.request.body as {
        contestId?: string;
        mode?: 'new_only' | 'regenerate';
        confirmRegenerate?: boolean;
      };

      if (!contestId) {
        this.response.status = 400;
        this.response.body = { error: { code: 'MISSING_CONTEST_ID', message: 'contestId is required' } };
        this.response.type = 'application/json';
        return;
      }

      const jobModel: BatchSummaryJobModel = this.ctx.get('batchSummaryJobModel');
      const summaryModel: StudentSummaryModel = this.ctx.get('studentSummaryModel');

      let contestObjId;
      try {
        contestObjId = new ObjectId(contestId);
      } catch {
        this.response.status = 400;
        this.response.body = { error: { code: 'INVALID_CONTEST_ID', message: 'Invalid contestId format' } };
        this.response.type = 'application/json';
        return;
      }

      // Fetch contest document
      const documentColl = db.collection('document');
      const tdoc = await documentColl.findOne({ domainId, docType: 30, docId: contestObjId });
      if (!tdoc) {
        this.response.status = 404;
        this.response.body = { error: { code: 'CONTEST_NOT_FOUND', message: 'Contest not found' } };
        this.response.type = 'application/json';
        return;
      }

      // Get all current attendees
      const statusColl = db.collection('document.status');
      const tsdocs = await statusColl
        .find({ domainId, docType: 30, docId: contestObjId }, { projection: { uid: 1 } })
        .toArray();
      const allAttendees: number[] = tsdocs.map((s: any) => Number(s.uid)).filter((uid: number) => uid > 0);

      // Check for existing active job
      const existingJob = await jobModel.findActiveJob(domainId, contestObjId);

      // Determine effective mode
      const effectiveMode = mode || (existingJob ? 'new_only' : 'regenerate');

      let job: any;
      let newStudentIds: number[];
      let previousCompleted = 0;
      let previousFailed = 0;

      if (effectiveMode === 'new_only' && existingJob) {
        // --- Supplementary generation: append new students to existing job ---
        const existingUserIds = await summaryModel.findUserIdsByJob(existingJob._id);
        const existingSet = new Set(existingUserIds);
        newStudentIds = allAttendees.filter((uid) => !existingSet.has(uid));

        if (newStudentIds.length === 0) {
          this.response.body = { noNewStudents: true };
          this.response.type = 'application/json';
          return;
        }

        // Insert new summary records (safe against concurrent inserts)
        await summaryModel.createBatchSafe(existingJob._id, domainId, contestObjId, newStudentIds);

        // Track previous counts for SSE progress offset
        previousCompleted = existingJob.completedCount;
        previousFailed = existingJob.failedCount;

        // Atomically update totalStudents and reset job to running
        const newTotal = existingUserIds.length + newStudentIds.length;
        await jobModel.prepareForSupplementary(existingJob._id, newTotal);

        // Construct updated job object in-memory (avoid extra DB roundtrip)
        job = { ...existingJob, totalStudents: newTotal, status: 'running' as const, completedAt: null };
      } else {
        // --- Full regeneration ---
        if (existingJob) {
          if (!confirmRegenerate) {
            const hasEdited = await summaryModel.hasEditedSummaries(existingJob._id);
            if (hasEdited) {
              this.response.body = { needConfirm: true };
              this.response.type = 'application/json';
              return;
            }
          }
          await jobModel.archive(existingJob._id);
        }

        newStudentIds = allAttendees;

        const jobId = await jobModel.create({
          domainId,
          contestId: contestObjId,
          contestTitle: String(tdoc.title || contestId),
          createdBy: this.user._id,
          totalStudents: allAttendees.length,
          config: { concurrency: 10, locale: 'zh' },
        });

        if (allAttendees.length > 0) {
          await summaryModel.createBatch(jobId, domainId, contestObjId, allAttendees);
        }

        job = await jobModel.findById(jobId);
        if (!job) {
          this.response.status = 500;
          this.response.body = { error: { code: 'JOB_CREATE_FAILED', message: 'Failed to create job' } };
          this.response.type = 'application/json';
          return;
        }
      }

      // Fetch user names (only for students being processed in this run)
      const userColl = db.collection('user');
      const userDocs = await userColl
        .find({ _id: { $in: newStudentIds } }, { projection: { _id: 1, uname: 1 } })
        .toArray();
      const userNameMap = new Map<number, string>();
      for (const u of userDocs) {
        userNameMap.set(u._id, u.uname || `User #${u._id}`);
      }

      // Fetch problem info
      const pids: string[] = (tdoc.pids || []).map((p: unknown) => String(p));
      const numericPids = pids.map(p => parseInt(p.replace(/^P/i, ''), 10)).filter(n => !isNaN(n));
      const problemDocs = await documentColl
        .find({ domainId, docType: 10, docId: { $in: numericPids } })
        .toArray();
      const problems: ProblemInfo[] = problemDocs.map((doc: any) => ({
        pid: String(doc.docId),
        title: doc.title || `Problem ${doc.docId}`,
        content: doc.content || '',
      }));

      // Setup SSE
      const koaCtx = (this as any).context;
      const rawRes: ServerResponse | undefined = koaCtx?.res;
      if (!rawRes) {
        this.response.status = 500;
        this.response.body = { error: { code: 'SSE_UNAVAILABLE', message: 'Raw response not available' } };
        this.response.type = 'application/json';
        return;
      }
      koaCtx.respond = false;
      if ('compress' in koaCtx) koaCtx.compress = false;
      koaCtx.req?.socket?.setNoDelay?.(true);
      koaCtx.req?.socket?.setTimeout?.(0);

      const sse = createSSEWriter(rawRes);
      sse.writeEvent('job_started', {
        jobId: String(job._id),
        totalStudents: job.totalStudents,
        newStudents: newStudentIds.length,
        previousCompleted,
        previousFailed,
      });

      // Create AI client
      let aiClient;
      try {
        aiClient = await createMultiModelClientFromConfig(this.ctx);
      } catch (clientErr) {
        console.error('[BatchSummaryGenerateHandler] Failed to create AI client:', clientErr);
        sse.writeEvent('error', { error: clientErr instanceof Error ? clientErr.message : 'AI service not configured' });
        sse.end();
        return;
      }
      const tokenUsageModel = this.ctx.get('tokenUsageModel') || null;
      const historyModel = this.ctx.get('studentHistoryModel') || null;
      const service = new BatchSummaryService(
        this.ctx.db,
        jobModel,
        summaryModel,
        aiClient,
        tokenUsageModel,
        historyModel,
      );

      const pendingOnly = effectiveMode === 'new_only';

      service.execute(job, problems, (event) => {
        if (!sse.closed) {
          const uid = Number(event.userId);
          if (uid && userNameMap.has(uid)) {
            (event as any).userName = userNameMap.get(uid);
          }
          sse.writeEvent(event.type, event);
        }
      }, pendingOnly, userNameMap).then(() => {
        if (!sse.closed) sse.end();
      }).catch((err) => {
        console.error('[BatchSummaryGenerateHandler] execute error:', err);
        if (!sse.closed) {
          sse.writeEvent('error', { message: err instanceof Error ? err.message : 'Unknown error' });
          sse.end();
        }
      });

    } catch (err) {
      console.error('[BatchSummaryGenerateHandler] error:', err);
      this.response.status = 500;
      this.response.body = {
        error: {
          code: 'INTERNAL_ERROR',
          message: err instanceof Error ? err.message : 'Internal server error',
        },
      };
      this.response.type = 'application/json';
    }
  }
}

/**
 * BatchSummaryResultHandler - 查询任务结果
 * GET /ai-helper/batch-summaries/:jobId/result
 */
export class BatchSummaryResultHandler extends Handler {
  async get() {
    try {
      const jobId = this.request.params.jobId;
      const jobModel: BatchSummaryJobModel = this.ctx.get('batchSummaryJobModel');
      const summaryModel: StudentSummaryModel = this.ctx.get('studentSummaryModel');

      const job = await jobModel.findById(jobId);
      if (!job) {
        this.response.status = 404;
        this.response.body = { error: { code: 'JOB_NOT_FOUND', message: 'Job not found' } };
        this.response.type = 'application/json';
        return;
      }

      const isTeacher = this.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM);

      let summaries;
      if (isTeacher) {
        summaries = await summaryModel.findAllByJob(job._id);
      } else {
        const mySummary = await summaryModel.findPublishedForStudent(
          job.domainId,
          job.contestId,
          this.user._id,
        );
        summaries = mySummary ? [mySummary] : [];
      }

      this.response.body = { job, summaries };
      this.response.type = 'application/json';
    } catch (err) {
      console.error('[BatchSummaryResultHandler] error:', err);
      this.response.status = 500;
      this.response.body = { error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'Internal error' } };
      this.response.type = 'application/json';
    }
  }
}

/**
 * BatchSummaryRetryHandler - 重试失败的摘要生成
 * POST /ai-helper/batch-summaries/:jobId/retry/:userId
 */
export class BatchSummaryRetryHandler extends Handler {
  async post() {
    try {
      const { jobId, userId } = this.request.params;
      const jobModel: BatchSummaryJobModel = this.ctx.get('batchSummaryJobModel');
      const summaryModel: StudentSummaryModel = this.ctx.get('studentSummaryModel');

      const job = await jobModel.findById(jobId);
      if (!job) {
        this.response.status = 404;
        this.response.body = { error: { code: 'JOB_NOT_FOUND', message: 'Job not found' } };
        this.response.type = 'application/json';
        return;
      }

      const summary = await summaryModel.findByJobAndUser(job._id, parseInt(userId, 10));
      if (!summary) {
        this.response.status = 404;
        this.response.body = { error: { code: 'SUMMARY_NOT_FOUND', message: 'Summary not found' } };
        this.response.type = 'application/json';
        return;
      }

      await summaryModel.resetToPending(summary._id);

      this.response.body = { ok: true };
      this.response.type = 'application/json';
    } catch (err) {
      console.error('[BatchSummaryRetryHandler] error:', err);
      this.response.status = 500;
      this.response.body = { error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'Internal error' } };
      this.response.type = 'application/json';
    }
  }
}

/**
 * BatchSummaryRetryFailedHandler - 批量重置所有失败的学生为待处理
 * POST /ai-helper/batch-summaries/:jobId/retry-failed
 */
export class BatchSummaryRetryFailedHandler extends Handler {
  async post() {
    try {
      const { jobId } = this.request.params;
      const jobModel: BatchSummaryJobModel = this.ctx.get('batchSummaryJobModel');
      const summaryModel: StudentSummaryModel = this.ctx.get('studentSummaryModel');

      const job = await jobModel.findById(jobId);
      if (!job) {
        this.response.status = 404;
        this.response.body = { error: { code: 'JOB_NOT_FOUND', message: 'Job not found' } };
        this.response.type = 'application/json';
        return;
      }

      const count = await summaryModel.resetFailedToPending(job._id);

      this.response.body = { ok: true, reset: count };
      this.response.type = 'application/json';
    } catch (err) {
      console.error('[BatchSummaryRetryFailedHandler] error:', err);
      this.response.status = 500;
      this.response.body = { error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'Internal error' } };
      this.response.type = 'application/json';
    }
  }
}

/**
 * BatchSummaryPublishHandler - 发布摘要
 * POST /ai-helper/batch-summaries/:jobId/publish
 */
export class BatchSummaryPublishHandler extends Handler {
  async post() {
    try {
      const { jobId } = this.request.params;
      const { userId } = this.request.body as { userId?: string };

      const jobModel: BatchSummaryJobModel = this.ctx.get('batchSummaryJobModel');
      const summaryModel: StudentSummaryModel = this.ctx.get('studentSummaryModel');

      const job = await jobModel.findById(jobId);
      if (!job) {
        this.response.status = 404;
        this.response.body = { error: { code: 'JOB_NOT_FOUND', message: 'Job not found' } };
        this.response.type = 'application/json';
        return;
      }

      let published: number;
      if (userId) {
        const summary = await summaryModel.findByJobAndUser(job._id, parseInt(userId, 10));
        if (!summary) {
          this.response.status = 404;
          this.response.body = { error: { code: 'SUMMARY_NOT_FOUND', message: 'Summary not found' } };
          this.response.type = 'application/json';
          return;
        }
        await summaryModel.publishOne(summary._id);
        published = 1;
      } else {
        published = await summaryModel.publishAll(job._id);
      }

      this.response.body = { published };
      this.response.type = 'application/json';
    } catch (err) {
      console.error('[BatchSummaryPublishHandler] error:', err);
      this.response.status = 500;
      this.response.body = { error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'Internal error' } };
      this.response.type = 'application/json';
    }
  }
}

/**
 * BatchSummaryExportHandler - 导出摘要 CSV
 * GET /ai-helper/batch-summaries/:jobId/export
 */
export class BatchSummaryExportHandler extends Handler {
  async get() {
    try {
      const { jobId } = this.request.params;

      const jobModel: BatchSummaryJobModel = this.ctx.get('batchSummaryJobModel');
      const summaryModel: StudentSummaryModel = this.ctx.get('studentSummaryModel');

      const job = await jobModel.findById(jobId);
      if (!job) {
        this.response.status = 404;
        this.response.body = { error: { code: 'JOB_NOT_FOUND', message: 'Job not found' } };
        this.response.type = 'application/json';
        return;
      }

      const summaries = await summaryModel.findAllByJob(job._id);

      // Build CSV
      const header = ['userId', 'status', 'publishStatus', 'summary', 'promptTokens', 'completionTokens', 'createdAt'];
      const rows = summaries.map(s => [
        escapeCsv(String(s.userId)),
        escapeCsv(s.status),
        escapeCsv(s.publishStatus),
        escapeCsv(s.summary || ''),
        escapeCsv(String(s.tokenUsage?.prompt ?? 0)),
        escapeCsv(String(s.tokenUsage?.completion ?? 0)),
        escapeCsv(s.createdAt.toISOString()),
      ]);

      const csv = [header.join(','), ...rows.map(r => r.join(','))].join('\n');

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `batch_summaries_${jobId}_${timestamp}.csv`;

      this.response.status = 200;
      this.response.type = 'text/csv';
      this.response.addHeader('Content-Disposition', `attachment; filename="${filename}"`);
      this.response.body = csv;
    } catch (err) {
      console.error('[BatchSummaryExportHandler] error:', err);
      this.response.status = 500;
      this.response.body = { error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'Internal error' } };
      this.response.type = 'application/json';
    }
  }
}

/**
 * BatchSummaryEditHandler - 编辑摘要内容
 * POST /ai-helper/batch-summaries/:jobId/edit/:userId
 */
export class BatchSummaryEditHandler extends Handler {
  async post() {
    try {
      const { jobId, userId } = this.request.params;
      const { summary } = this.request.body as { summary?: string };

      if (summary === undefined) {
        this.response.status = 400;
        this.response.body = { error: { code: 'MISSING_SUMMARY', message: 'summary is required' } };
        this.response.type = 'application/json';
        return;
      }

      const jobModel: BatchSummaryJobModel = this.ctx.get('batchSummaryJobModel');
      const summaryModel: StudentSummaryModel = this.ctx.get('studentSummaryModel');

      const job = await jobModel.findById(jobId);
      if (!job) {
        this.response.status = 404;
        this.response.body = { error: { code: 'JOB_NOT_FOUND', message: 'Job not found' } };
        this.response.type = 'application/json';
        return;
      }

      const summaryDoc = await summaryModel.findByJobAndUser(job._id, parseInt(userId, 10));
      if (!summaryDoc) {
        this.response.status = 404;
        this.response.body = { error: { code: 'SUMMARY_NOT_FOUND', message: 'Summary not found' } };
        this.response.type = 'application/json';
        return;
      }

      await summaryModel.editSummary(summaryDoc._id, summary);

      this.response.body = { ok: true };
      this.response.type = 'application/json';
    } catch (err) {
      console.error('[BatchSummaryEditHandler] error:', err);
      this.response.status = 500;
      this.response.body = { error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'Internal error' } };
      this.response.type = 'application/json';
    }
  }
}

/**
 * BatchSummaryLatestHandler - 查询指定竞赛的最新任务及摘要
 * GET /ai-helper/batch-summaries/latest?contestId=xxx
 */
export class BatchSummaryLatestHandler extends Handler {
  async get() {
    try {
      const domainId = getDomainId(this);
      const contestId = this.request.query?.contestId as string;

      if (!contestId) {
        this.response.body = { job: null, summaries: [] };
        this.response.type = 'application/json';
        return;
      }

      let contestObjId;
      try {
        contestObjId = new ObjectId(contestId);
      } catch {
        this.response.body = { job: null, summaries: [] };
        this.response.type = 'application/json';
        return;
      }

      const jobModel: BatchSummaryJobModel = this.ctx.get('batchSummaryJobModel');
      const summaryModel: StudentSummaryModel = this.ctx.get('studentSummaryModel');

      const job = await jobModel.findActiveJob(domainId, contestObjId);
      if (!job) {
        this.response.body = { job: null, summaries: [] };
        this.response.type = 'application/json';
        return;
      }

      // Query current attendee count for new-student detection
      const statusColl = db.collection('document.status');
      const attendeeCount = await statusColl.countDocuments({
        domainId,
        docType: 30,
        docId: contestObjId,
      });

      // Fetch user names
      const summaries = await summaryModel.findAllByJob(job._id);
      const uids = summaries.map((s) => s.userId).filter((uid) => uid > 0);
      const userColl = db.collection('user');
      const userDocs = await userColl
        .find({ _id: { $in: uids } }, { projection: { _id: 1, uname: 1 } })
        .toArray();
      const userNameMap = new Map<number, string>();
      for (const u of userDocs) {
        userNameMap.set(u._id, u.uname || `User #${u._id}`);
      }

      const enriched = summaries.map((s) => ({
        userId: s.userId,
        userName: userNameMap.get(s.userId) || `User #${s.userId}`,
        status: s.status,
        publishStatus: s.publishStatus,
        summary: s.summary,
        error: s.error,
      }));

      this.response.body = {
        job: {
          _id: job._id,
          status: job.status,
          totalStudents: job.totalStudents,
          completedCount: job.completedCount,
          failedCount: job.failedCount,
          contestTitle: job.contestTitle,
        },
        summaries: enriched,
        currentAttendeeCount: attendeeCount,
      };
      this.response.type = 'application/json';
    } catch (err) {
      console.error('[BatchSummaryLatestHandler] error:', err);
      this.response.status = 500;
      this.response.body = { error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'Internal error' } };
      this.response.type = 'application/json';
    }
  }
}

/**
 * BatchSummaryStopHandler - 停止正在进行的批量生成
 * POST /ai-helper/batch-summaries/:jobId/stop
 */
export class BatchSummaryStopHandler extends Handler {
  async post() {
    try {
      const { jobId } = this.request.params;
      const jobModel: BatchSummaryJobModel = this.ctx.get('batchSummaryJobModel');
      const summaryModel: StudentSummaryModel = this.ctx.get('studentSummaryModel');

      const job = await jobModel.findById(jobId);
      if (!job) {
        this.response.status = 404;
        this.response.body = { error: { code: 'JOB_NOT_FOUND', message: 'Job not found' } };
        this.response.type = 'application/json';
        return;
      }

      // Mark job as stopped — the service loop checks this between batches
      await jobModel.updateStatus(job._id, 'stopped');
      // Reset any students stuck in 'generating' back to 'pending'
      await summaryModel.resetGeneratingToPending(job._id);

      this.response.body = { ok: true };
      this.response.type = 'application/json';
    } catch (err) {
      console.error('[BatchSummaryStopHandler] error:', err);
      this.response.status = 500;
      this.response.body = { error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'Internal error' } };
      this.response.type = 'application/json';
    }
  }
}

/**
 * BatchSummaryContinueHandler - 继续生成剩余的待定学生摘要
 * POST /ai-helper/batch-summaries/:jobId/continue
 */
export class BatchSummaryContinueHandler extends Handler {
  async post() {
    try {
      const { jobId } = this.request.params;
      const domainId = getDomainId(this);
      const jobModel: BatchSummaryJobModel = this.ctx.get('batchSummaryJobModel');
      const summaryModel: StudentSummaryModel = this.ctx.get('studentSummaryModel');

      const job = await jobModel.findById(jobId);
      if (!job) {
        this.response.status = 404;
        this.response.body = { error: { code: 'JOB_NOT_FOUND', message: 'Job not found' } };
        this.response.type = 'application/json';
        return;
      }

      // Fetch problem info (same as generate handler)
      const documentColl = db.collection('document');
      const tdoc = await documentColl.findOne({ domainId, docType: 30, docId: job.contestId });
      if (!tdoc) {
        this.response.status = 404;
        this.response.body = { error: { code: 'CONTEST_NOT_FOUND', message: 'Contest not found' } };
        this.response.type = 'application/json';
        return;
      }

      const pids: string[] = (tdoc.pids || []).map((p: unknown) => String(p));
      const numericPids = pids.map((p) => parseInt(p.replace(/^P/i, ''), 10)).filter((n) => !isNaN(n));
      const problemDocs = await documentColl
        .find({ domainId, docType: 10, docId: { $in: numericPids } })
        .toArray();
      const problems: ProblemInfo[] = problemDocs.map((doc: any) => ({
        pid: String(doc.docId),
        title: doc.title || `Problem ${doc.docId}`,
        content: doc.content || '',
      }));

      // Fetch user names for SSE enrichment
      const pendingSummaries = await summaryModel.findPendingByJob(job._id);
      const uids = pendingSummaries.map((s) => s.userId).filter((uid) => uid > 0);
      const userColl = db.collection('user');
      const userDocs = await userColl
        .find({ _id: { $in: uids } }, { projection: { _id: 1, uname: 1 } })
        .toArray();
      const userNameMap = new Map<number, string>();
      for (const u of userDocs) {
        userNameMap.set(u._id, u.uname || `User #${u._id}`);
      }

      // Setup SSE
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const koaCtx = (this as any).context;
      const rawRes: ServerResponse | undefined = koaCtx?.res;
      if (!rawRes) {
        this.response.status = 500;
        this.response.body = { error: { code: 'SSE_UNAVAILABLE', message: 'Raw response not available' } };
        this.response.type = 'application/json';
        return;
      }
      koaCtx.respond = false;
      if ('compress' in koaCtx) koaCtx.compress = false;
      koaCtx.req?.socket?.setNoDelay?.(true);
      koaCtx.req?.socket?.setTimeout?.(0);

      const sse = createSSEWriter(rawRes);
      sse.writeEvent('job_started', {
        jobId: String(job._id),
        totalStudents: pendingSummaries.length,
      });

      // Create AI client
      let aiClient;
      try {
        aiClient = await createMultiModelClientFromConfig(this.ctx);
      } catch (clientErr) {
        console.error('[BatchSummaryContinueHandler] Failed to create AI client:', clientErr);
        sse.writeEvent('error', { error: clientErr instanceof Error ? clientErr.message : 'AI service not configured' });
        sse.end();
        return;
      }
      const tokenUsageModel = this.ctx.get('tokenUsageModel') || null;
      const historyModel = this.ctx.get('studentHistoryModel') || null;
      const service = new BatchSummaryService(
        this.ctx.db,
        jobModel,
        summaryModel,
        aiClient,
        tokenUsageModel,
        historyModel,
      );

      service.execute(job, problems, (event) => {
        if (!sse.closed) {
          const uid = Number(event.userId);
          if (uid && userNameMap.has(uid)) {
            (event as any).userName = userNameMap.get(uid);
          }
          sse.writeEvent(event.type, event);
        }
      }, true, userNameMap).then(() => {
        if (!sse.closed) sse.end();
      }).catch((err) => {
        console.error('[BatchSummaryContinueHandler] execute error:', err);
        if (!sse.closed) {
          sse.writeEvent('error', { message: err instanceof Error ? err.message : 'Unknown error' });
          sse.end();
        }
      });

    } catch (err) {
      console.error('[BatchSummaryContinueHandler] error:', err);
      this.response.status = 500;
      this.response.body = {
        error: {
          code: 'INTERNAL_ERROR',
          message: err instanceof Error ? err.message : 'Internal server error',
        },
      };
      this.response.type = 'application/json';
    }
  }
}

/**
 * StudentSummaryHandler - 学生查看自己的已发布学习总结
 * GET /ai-helper/batch-summaries/my-summary?contestId=xxx
 * 仅返回当前登录用户的 published 总结，无需教师权限
 */
export class StudentSummaryHandler extends Handler {
  async get() {
    try {
      const domainId = getDomainId(this);
      const contestId = this.request.query?.contestId as string;
      const userId = this.user._id;

      if (!contestId || !userId) {
        this.response.body = { summary: null };
        this.response.type = 'application/json';
        return;
      }

      let contestObjId;
      try {
        contestObjId = new ObjectId(contestId);
      } catch {
        this.response.body = { summary: null };
        this.response.type = 'application/json';
        return;
      }

      const summaryModel: StudentSummaryModel = this.ctx.get('studentSummaryModel');
      const doc = await summaryModel.findPublishedForStudent(domainId, contestObjId, userId);

      if (!doc) {
        this.response.body = { summary: null };
        this.response.type = 'application/json';
        return;
      }

      this.response.body = {
        summary: {
          summary: doc.summary,
          contestId: String(doc.contestId),
          updatedAt: doc.updatedAt,
        },
      };
      this.response.type = 'application/json';
    } catch (err) {
      console.error('[StudentSummaryHandler] error:', err);
      this.response.status = 500;
      this.response.body = { error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'Internal error' } };
      this.response.type = 'application/json';
    }
  }
}
