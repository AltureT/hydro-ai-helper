/**
 * TeachingSummaryHandler - 教学总结 API 处理器
 *
 * 提供竞赛教学分析总结的生成、查询、列表和反馈功能
 */

import { Handler, PRIV, db } from 'hydrooj';
import { ObjectId, ObjectIdType } from '../utils/mongo';
import { getDomainId } from '../utils/domainHelper';
import { createOpenAIClientFromConfig } from '../services/openaiClient';
import { TeachingSummaryModel } from '../models/teachingSummary';
import { TeachingAnalysisService } from '../services/teachingAnalysisService';
import { TeachingSuggestionService } from '../services/teachingSuggestionService';
import { isFillInBlankProblem } from '../services/analyzers/codeSelectionService';

export const TeachingSummaryHandlerPriv = PRIV.PRIV_READ_RECORD_CODE;

// ─── Helper: resolve contestId to ObjectId ───────────────────────────────────

function parseContestId(raw: string): ObjectIdType | null {
  try {
    return new ObjectId(raw);
  } catch {
    return null;
  }
}

// ─── TeachingSummaryHandler ───────────────────────────────────────────────────

/**
 * TeachingSummaryHandler - 获取或生成竞赛教学总结
 * GET  /ai-helper/teaching-summary/:contestId  — 查询已有总结
 * POST /ai-helper/teaching-summary/:contestId  — 触发生成
 */
export class TeachingSummaryHandler extends Handler {
  async get() {
    try {
      const domainId = getDomainId(this);
      const contestId = this.request.params.contestId as string;

      const contestObjId = parseContestId(contestId);
      if (!contestObjId) {
        this.response.status = 400;
        this.response.body = { error: { code: 'INVALID_CONTEST_ID', message: 'Invalid contestId format' } };
        this.response.type = 'application/json';
        return;
      }

      const model: TeachingSummaryModel = this.ctx.get('teachingSummaryModel');
      const summary = await model.findByContest(domainId, contestObjId);

      if (!summary) {
        this.response.status = 404;
        this.response.body = { error: { code: 'NOT_FOUND', message: 'Teaching summary not found' } };
        this.response.type = 'application/json';
        return;
      }

      this.response.body = { summary };
      this.response.type = 'application/json';
    } catch (err) {
      console.error('[TeachingSummaryHandler.get] error:', err);
      this.response.status = 500;
      this.response.body = { error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'Internal error' } };
      this.response.type = 'application/json';
    }
  }

  async post() {
    try {
      const domainId = getDomainId(this);
      const contestId = this.request.params.contestId as string;
      const { teachingFocus, regenerate } = this.request.body as {
        teachingFocus?: string;
        regenerate?: boolean;
      };

      const contestObjId = parseContestId(contestId);
      if (!contestObjId) {
        this.response.status = 400;
        this.response.body = { error: { code: 'INVALID_CONTEST_ID', message: 'Invalid contestId format' } };
        this.response.type = 'application/json';
        return;
      }

      const model: TeachingSummaryModel = this.ctx.get('teachingSummaryModel');

      // Check for existing summary
      const existing = await model.findByContest(domainId, contestObjId);
      if (existing && !regenerate) {
        this.response.body = { summary: existing, exists: true };
        this.response.type = 'application/json';
        return;
      }

      // Delete old summary if regenerating
      if (existing && regenerate) {
        await model.deleteById(existing._id);
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

      // Get attendees
      const statusColl = db.collection('document.status');
      const tsdocs = await statusColl
        .find({ domainId, docType: 30, docId: contestObjId }, { projection: { uid: 1 } })
        .toArray();
      const studentUids: number[] = tsdocs.map((s: any) => Number(s.uid)).filter((uid: number) => uid > 0);

      if (studentUids.length === 0) {
        this.response.status = 400;
        this.response.body = { error: { code: 'NO_STUDENTS', message: 'No students found for this contest' } };
        this.response.type = 'application/json';
        return;
      }

      // Create summary record
      const summaryId = await model.create({
        domainId,
        contestId: contestObjId,
        contestTitle: String(tdoc.title || contestId),
        contestContent: String(tdoc.content || ''),
        teachingFocus,
        createdBy: this.user._id,
        dataSnapshotAt: new Date(),
      });

      const newSummary = await model.findById(summaryId);

      // Fire-and-forget async generation
      this.generateAsync(
        model,
        domainId,
        summaryId,
        contestObjId,
        tdoc,
        studentUids,
        teachingFocus,
      ).catch((err) => {
        console.error('[TeachingSummaryHandler] generateAsync unhandled error:', err);
      });

      this.response.body = { summary: newSummary, started: true };
      this.response.type = 'application/json';
    } catch (err) {
      console.error('[TeachingSummaryHandler.post] error:', err);
      this.response.status = 500;
      this.response.body = { error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'Internal error' } };
      this.response.type = 'application/json';
    }
  }

  private async generateAsync(
    model: TeachingSummaryModel,
    domainId: string,
    summaryId: any,
    contestObjId: ObjectIdType,
    tdoc: any,
    studentUids: number[],
    teachingFocus?: string,
  ): Promise<void> {
    const startTime = Date.now();

    try {
      await model.updateStatus(summaryId, 'generating');

      // Build pid list from contest
      const pids: number[] = ((tdoc.pids || []) as unknown[])
        .map((p: unknown) => parseInt(String(p).replace(/^P/i, ''), 10))
        .filter((n: number) => !isNaN(n));

      // Fetch problem docs early — needed for both analyzer titles and LLM context
      const documentColl = db.collection('document');
      const problemDocs = await documentColl
        .find({ domainId, docType: 10, docId: { $in: pids } })
        .toArray();

      const pidTitles = new Map<number, string>();
      const problemContexts = problemDocs.map((doc: any) => {
        const pid = doc.docId as number;
        const title = (doc.title || String(doc.docId)) as string;
        pidTitles.set(pid, title);
        return { pid, title, content: (doc.content || '') as string };
      });

      // Layer 1: Analysis (with problem titles for human-readable findings)
      const analysisService = new TeachingAnalysisService(this.ctx.db);
      const analysisResult = await analysisService.analyze({
        domainId,
        contestId: contestObjId,
        pids,
        studentUids,
        pidTitles,
        contestStartTime: tdoc.beginAt ? new Date(tdoc.beginAt) : undefined,
        contestEndTime: tdoc.endAt ? new Date(tdoc.endAt) : undefined,
      });

      // Prepare fill-in candidates with problem content for template detection
      const fillInCandidatesForPrompt = analysisResult.fillInCandidates.map(c => {
        const problemDoc = problemDocs.find((d: any) => d.docId === c.pid);
        const problemContent = (problemDoc?.content || '') as string;
        return {
          pid: c.pid,
          title: c.title,
          lang: c.lang,
          code: c.code,
          isFillInProblem: isFillInBlankProblem(problemContent),
        };
      });

      // Layer 2: AI suggestions
      const aiClient = await createOpenAIClientFromConfig(this.ctx);
      const suggestionService = new TeachingSuggestionService(aiClient);

      const overallResult = await suggestionService.generateOverallSuggestion({
        contestTitle: String(tdoc.title || ''),
        contestContent: String(tdoc.content || ''),
        teachingFocus,
        stats: analysisResult.stats,
        findings: analysisResult.findings,
        problemContexts,
        fillInCandidates: fillInCandidatesForPrompt,
      });

      let totalPromptTokens = overallResult.tokenUsage.promptTokens;
      let totalCompletionTokens = overallResult.tokenUsage.completionTokens;

      // Deep dives for findings that need them
      const deepDiveResults: Record<string, string> = {};
      const problemDocMap = new Map(problemDocs.map((doc: any) => [doc.docId as number, doc]));

      const deepDiveFindings = analysisResult.findings.filter(f => f.needsDeepDive);

      // Batch-fetch code samples for all deep-dive findings (avoids N+1 queries)
      if (deepDiveFindings.length > 0) {
        const allSampleUids = new Set<number>();
        const allSamplePids = new Set<number>();
        for (const f of deepDiveFindings) {
          for (const uid of f.evidence.affectedStudents.slice(0, 5)) allSampleUids.add(uid);
          for (const pid of f.evidence.affectedProblems) allSamplePids.add(pid);
        }
        const allSampleRecords = allSampleUids.size > 0 && allSamplePids.size > 0
          ? await this.ctx.db.collection('record').find({
              domainId,
              pid: { $in: Array.from(allSamplePids) },
              uid: { $in: Array.from(allSampleUids) },
              code: { $exists: true, $ne: '' },
            }).project({ pid: 1, uid: 1, code: 1 }).limit(50).toArray()
          : [];

        // Index by pid:uid for O(1) lookup
        const samplesByPidUid = new Map<string, string>();
        for (const r of allSampleRecords) {
          const key = `${r.pid}:${r.uid}`;
          if (!samplesByPidUid.has(key)) {
            samplesByPidUid.set(key, String((r as any).code).slice(0, 500));
          }
        }

        // Attach samples to findings
        for (const finding of deepDiveFindings) {
          const codes: string[] = [];
          for (const uid of finding.evidence.affectedStudents.slice(0, 5)) {
            for (const pid of finding.evidence.affectedProblems) {
              const code = samplesByPidUid.get(`${pid}:${uid}`);
              if (code) { codes.push(code); break; }
            }
            if (codes.length >= 3) break;
          }
          if (codes.length > 0) {
            finding.evidence.samples = { code: codes };
          }
        }
      }

      for (const finding of deepDiveFindings) {
        const problemContent = finding.evidence.affectedProblems
          .map(pid => {
            const doc = problemDocMap.get(pid);
            return doc ? `### ${doc.title || doc.docId}\n${doc.content || ''}` : '';
          })
          .filter(Boolean)
          .join('\n\n');

        const deepDiveResult = await suggestionService.generateDeepDive(finding, problemContent);
        deepDiveResults[finding.id] = deepDiveResult.text;
        totalPromptTokens += deepDiveResult.tokenUsage.promptTokens;
        totalCompletionTokens += deepDiveResult.tokenUsage.completionTokens;
      }

      // Save completed results
      await model.saveResults(summaryId, {
        stats: analysisResult.stats,
        findings: analysisResult.findings,
        overallSuggestion: overallResult.text,
        deepDiveResults,
        tokenUsage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens },
        generationTimeMs: Date.now() - startTime,
      });

      console.log('[TeachingSummaryHandler] generateAsync completed for summaryId=%s', summaryId);
    } catch (err) {
      console.error('[TeachingSummaryHandler] generateAsync failed for summaryId=%s:', summaryId, err);
      try {
        await model.updateStatus(summaryId, 'failed');
      } catch (updateErr) {
        console.error('[TeachingSummaryHandler] Failed to set status=failed:', updateErr);
      }
    }
  }
}

// ─── TeachingReviewHandler ────────────────────────────────────────────────────

/**
 * TeachingReviewHandler - 分页查看域内所有教学总结
 * GET /ai-helper/teaching-review
 */
export class TeachingReviewHandler extends Handler {
  async get() {
    try {
      const domainId = getDomainId(this);
      const rawPage = this.request.query?.page;
      const rawLimit = this.request.query?.limit;

      const page = Math.max(1, parseInt(String(rawPage || '1'), 10));
      const limit = Math.min(50, Math.max(1, parseInt(String(rawLimit || '20'), 10)));

      const model: TeachingSummaryModel = this.ctx.get('teachingSummaryModel');
      const summaries = await model.findByDomain(domainId, page, limit);

      this.response.body = { summaries, page, limit };
      this.response.type = 'application/json';
    } catch (err) {
      console.error('[TeachingReviewHandler.get] error:', err);
      this.response.status = 500;
      this.response.body = { error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'Internal error' } };
      this.response.type = 'application/json';
    }
  }
}

// ─── TeachingSummaryFeedbackHandler ──────────────────────────────────────────

/**
 * TeachingSummaryFeedbackHandler - 提交对教学总结的反馈
 * POST /ai-helper/teaching-summary/:summaryId/feedback
 */
export class TeachingSummaryFeedbackHandler extends Handler {
  async post() {
    try {
      const summaryId = this.request.params.summaryId as string;
      const { rating, comment } = this.request.body as {
        rating?: string;
        comment?: string;
      };

      if (rating !== 'up' && rating !== 'down') {
        this.response.status = 400;
        this.response.body = { error: { code: 'INVALID_RATING', message: "rating must be 'up' or 'down'" } };
        this.response.type = 'application/json';
        return;
      }

      const model: TeachingSummaryModel = this.ctx.get('teachingSummaryModel');
      const existing = await model.findById(summaryId);
      if (!existing) {
        this.response.status = 404;
        this.response.body = { error: { code: 'NOT_FOUND', message: 'Teaching summary not found' } };
        this.response.type = 'application/json';
        return;
      }

      await model.saveFeedback(existing._id, rating, comment);

      this.response.body = { ok: true };
      this.response.type = 'application/json';
    } catch (err) {
      console.error('[TeachingSummaryFeedbackHandler.post] error:', err);
      this.response.status = 500;
      this.response.body = { error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'Internal error' } };
      this.response.type = 'application/json';
    }
  }
}
