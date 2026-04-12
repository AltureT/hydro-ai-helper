"use strict";
/**
 * TeachingSummaryHandler - 教学总结 API 处理器
 *
 * 提供竞赛教学分析总结的生成、查询、列表和反馈功能
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TeachingSummaryFeedbackHandler = exports.TeachingReviewHandler = exports.TeachingSummaryHandler = exports.TeachingSummaryHandlerPriv = void 0;
const hydrooj_1 = require("hydrooj");
const mongo_1 = require("../utils/mongo");
const domainHelper_1 = require("../utils/domainHelper");
const openaiClient_1 = require("../services/openaiClient");
const teachingAnalysisService_1 = require("../services/teachingAnalysisService");
const teachingSuggestionService_1 = require("../services/teachingSuggestionService");
const codeSelectionService_1 = require("../services/analyzers/codeSelectionService");
exports.TeachingSummaryHandlerPriv = hydrooj_1.PRIV.PRIV_READ_RECORD_CODE;
// ─── Helper: resolve contestId to ObjectId ───────────────────────────────────
function parseContestId(raw) {
    try {
        return new mongo_1.ObjectId(raw);
    }
    catch {
        return null;
    }
}
// ─── TeachingSummaryHandler ───────────────────────────────────────────────────
/**
 * TeachingSummaryHandler - 获取或生成竞赛教学总结
 * GET  /ai-helper/teaching-summary/:contestId  — 查询已有总结
 * POST /ai-helper/teaching-summary/:contestId  — 触发生成
 */
class TeachingSummaryHandler extends hydrooj_1.Handler {
    async get() {
        try {
            const domainId = (0, domainHelper_1.getDomainId)(this);
            const contestId = this.request.params.contestId;
            const contestObjId = parseContestId(contestId);
            if (!contestObjId) {
                this.response.status = 400;
                this.response.body = { error: { code: 'INVALID_CONTEST_ID', message: 'Invalid contestId format' } };
                this.response.type = 'application/json';
                return;
            }
            const model = this.ctx.get('teachingSummaryModel');
            const summary = await model.findByContest(domainId, contestObjId);
            if (!summary) {
                this.response.status = 404;
                this.response.body = { error: { code: 'NOT_FOUND', message: 'Teaching summary not found' } };
                this.response.type = 'application/json';
                return;
            }
            this.response.body = { summary };
            this.response.type = 'application/json';
        }
        catch (err) {
            console.error('[TeachingSummaryHandler.get] error:', err);
            this.response.status = 500;
            this.response.body = { error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'Internal error' } };
            this.response.type = 'application/json';
        }
    }
    async post() {
        try {
            const domainId = (0, domainHelper_1.getDomainId)(this);
            const contestId = this.request.params.contestId;
            const { teachingFocus, regenerate } = this.request.body;
            const contestObjId = parseContestId(contestId);
            if (!contestObjId) {
                this.response.status = 400;
                this.response.body = { error: { code: 'INVALID_CONTEST_ID', message: 'Invalid contestId format' } };
                this.response.type = 'application/json';
                return;
            }
            const model = this.ctx.get('teachingSummaryModel');
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
            const documentColl = hydrooj_1.db.collection('document');
            const tdoc = await documentColl.findOne({ domainId, docType: 30, docId: contestObjId });
            if (!tdoc) {
                this.response.status = 404;
                this.response.body = { error: { code: 'CONTEST_NOT_FOUND', message: 'Contest not found' } };
                this.response.type = 'application/json';
                return;
            }
            // Get attendees
            const statusColl = hydrooj_1.db.collection('document.status');
            const tsdocs = await statusColl
                .find({ domainId, docType: 30, docId: contestObjId }, { projection: { uid: 1 } })
                .toArray();
            const studentUids = tsdocs.map((s) => Number(s.uid)).filter((uid) => uid > 0);
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
            this.generateAsync(model, domainId, summaryId, contestObjId, tdoc, studentUids, teachingFocus).catch((err) => {
                console.error('[TeachingSummaryHandler] generateAsync unhandled error:', err);
            });
            this.response.body = { summary: newSummary, started: true };
            this.response.type = 'application/json';
        }
        catch (err) {
            console.error('[TeachingSummaryHandler.post] error:', err);
            this.response.status = 500;
            this.response.body = { error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'Internal error' } };
            this.response.type = 'application/json';
        }
    }
    async generateAsync(model, domainId, summaryId, contestObjId, tdoc, studentUids, teachingFocus) {
        const startTime = Date.now();
        try {
            await model.updateStatus(summaryId, 'generating');
            // Build pid list from contest
            const pids = (tdoc.pids || [])
                .map((p) => parseInt(String(p).replace(/^P/i, ''), 10))
                .filter((n) => !isNaN(n));
            // Fetch problem docs early — needed for both analyzer titles and LLM context
            const documentColl = hydrooj_1.db.collection('document');
            const problemDocs = await documentColl
                .find({ domainId, docType: 10, docId: { $in: pids } })
                .toArray();
            const pidTitles = new Map();
            const problemContexts = problemDocs.map((doc) => {
                const pid = doc.docId;
                const title = (doc.title || String(doc.docId));
                pidTitles.set(pid, title);
                return { pid, title, content: (doc.content || '') };
            });
            // Layer 1: Analysis (with problem titles for human-readable findings)
            const analysisService = new teachingAnalysisService_1.TeachingAnalysisService(this.ctx.db);
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
                const problemDoc = problemDocs.find((d) => d.docId === c.pid);
                const problemContent = (problemDoc?.content || '');
                return {
                    pid: c.pid,
                    title: c.title,
                    lang: c.lang,
                    code: c.code,
                    isFillInProblem: (0, codeSelectionService_1.isFillInBlankProblem)(problemContent),
                };
            });
            // Layer 2: AI suggestions
            const aiClient = await (0, openaiClient_1.createOpenAIClientFromConfig)(this.ctx);
            const suggestionService = new teachingSuggestionService_1.TeachingSuggestionService(aiClient);
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
            const deepDiveResults = {};
            // Reuse problemDocs from overall suggestion fetch (avoid N+1 queries)
            const problemDocMap = new Map(problemDocs.map((doc) => [doc.docId, doc]));
            for (const finding of analysisResult.findings) {
                if (!finding.needsDeepDive)
                    continue;
                const affectedPids = finding.evidence.affectedProblems;
                const problemContent = affectedPids
                    .map(pid => {
                    const doc = problemDocMap.get(pid);
                    return doc ? `### ${doc.title || doc.docId}\n${doc.content || ''}` : '';
                })
                    .filter(Boolean)
                    .join('\n\n');
                // Collect code samples from records for affected students
                const sampleUids = finding.evidence.affectedStudents.slice(0, 5);
                if (sampleUids.length > 0 && affectedPids.length > 0) {
                    const recordDocs = await this.ctx.db.collection('record').find({
                        domainId,
                        pid: { $in: affectedPids },
                        uid: { $in: sampleUids },
                    }).limit(5).toArray();
                    if (recordDocs.length > 0) {
                        finding.evidence.samples = {
                            code: recordDocs
                                .filter((r) => r.code)
                                .map((r) => String(r.code).slice(0, 500)),
                        };
                    }
                }
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
        }
        catch (err) {
            console.error('[TeachingSummaryHandler] generateAsync failed for summaryId=%s:', summaryId, err);
            try {
                await model.updateStatus(summaryId, 'failed');
            }
            catch (updateErr) {
                console.error('[TeachingSummaryHandler] Failed to set status=failed:', updateErr);
            }
        }
    }
}
exports.TeachingSummaryHandler = TeachingSummaryHandler;
// ─── TeachingReviewHandler ────────────────────────────────────────────────────
/**
 * TeachingReviewHandler - 分页查看域内所有教学总结
 * GET /ai-helper/teaching-review
 */
class TeachingReviewHandler extends hydrooj_1.Handler {
    async get() {
        try {
            const domainId = (0, domainHelper_1.getDomainId)(this);
            const rawPage = this.request.query?.page;
            const rawLimit = this.request.query?.limit;
            const page = Math.max(1, parseInt(String(rawPage || '1'), 10));
            const limit = Math.min(50, Math.max(1, parseInt(String(rawLimit || '20'), 10)));
            const model = this.ctx.get('teachingSummaryModel');
            const summaries = await model.findByDomain(domainId, page, limit);
            this.response.body = { summaries, page, limit };
            this.response.type = 'application/json';
        }
        catch (err) {
            console.error('[TeachingReviewHandler.get] error:', err);
            this.response.status = 500;
            this.response.body = { error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'Internal error' } };
            this.response.type = 'application/json';
        }
    }
}
exports.TeachingReviewHandler = TeachingReviewHandler;
// ─── TeachingSummaryFeedbackHandler ──────────────────────────────────────────
/**
 * TeachingSummaryFeedbackHandler - 提交对教学总结的反馈
 * POST /ai-helper/teaching-summary/:summaryId/feedback
 */
class TeachingSummaryFeedbackHandler extends hydrooj_1.Handler {
    async post() {
        try {
            const summaryId = this.request.params.summaryId;
            const { rating, comment } = this.request.body;
            if (rating !== 'up' && rating !== 'down') {
                this.response.status = 400;
                this.response.body = { error: { code: 'INVALID_RATING', message: "rating must be 'up' or 'down'" } };
                this.response.type = 'application/json';
                return;
            }
            const model = this.ctx.get('teachingSummaryModel');
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
        }
        catch (err) {
            console.error('[TeachingSummaryFeedbackHandler.post] error:', err);
            this.response.status = 500;
            this.response.body = { error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'Internal error' } };
            this.response.type = 'application/json';
        }
    }
}
exports.TeachingSummaryFeedbackHandler = TeachingSummaryFeedbackHandler;
//# sourceMappingURL=teachingSummaryHandler.js.map