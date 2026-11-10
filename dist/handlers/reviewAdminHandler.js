"use strict";
/**
 * AI 抽查管理接口（US7，系统管理员）
 *
 * - GET  /ai-helper/admin/review               抽查状态：设置、自动处罚与熔断、运行记录、下次运行、本月成本、最近发现
 * - POST /ai-helper/admin/review/run           手动触发：全量候选，或指定学生（用户名）/会话
 * - POST /ai-helper/admin/review/auto-penalty  停用或恢复自动处罚（熔断后只能由此恢复）
 * 抽查设置本身通过现有的 PUT /ai-helper/admin/config（aiReviewConfig）保存。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReviewAdminHandlerPriv = exports.ReviewAutoPenaltyHandler = exports.ReviewRunHandler = exports.ReviewAdminHandler = exports.MAX_MANUAL_REVIEW_CONVERSATIONS = exports.MAX_MANUAL_REVIEW_USERS = void 0;
const hydrooj_1 = require("hydrooj");
const csrfHelper_1 = require("../lib/csrfHelper");
const hydroGroupService_1 = require("../services/hydroGroupService");
const configSections_1 = require("../models/configSections");
const timezone_1 = require("../utils/timezone");
const groupAdminHandler_1 = require("./groupAdminHandler");
const aiReviewScheduler_1 = require("../services/aiReviewScheduler");
const mongo_1 = require("../utils/mongo");
const i18nHelper_1 = require("../utils/i18nHelper");
exports.MAX_MANUAL_REVIEW_USERS = 50;
exports.MAX_MANUAL_REVIEW_CONVERSATIONS = 50;
const FINDINGS_LIMIT = 20;
const RUNS_LIMIT = 20;
function json(handler, status, body) {
    if (status !== 200)
        handler.response.status = status;
    handler.response.body = body;
    handler.response.type = 'application/json';
}
function body(handler) {
    const raw = handler.request.body;
    return raw && typeof raw === 'object' ? raw : {};
}
function actor(handler) {
    return Number(handler.user?._id);
}
function invalid(code, key, params = []) {
    return new hydroGroupService_1.GroupServiceError(code, 400, key, params);
}
function stringList(raw) {
    const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,，、]+/) : [];
    return [...new Set(list.map((item) => String(item ?? '').trim()).filter(Boolean))];
}
function scopeLabelOf(names, conversationCount) {
    const parts = [];
    if (names.length)
        parts.push(names.slice(0, 3).join('、') + (names.length > 3 ? ` +${names.length - 3}` : ''));
    if (conversationCount)
        parts.push(`${conversationCount} conversation${conversationCount > 1 ? 's' : ''}`);
    return parts.length ? parts.join(' · ') : undefined;
}
function formatFinding(log, names, titles) {
    const conversationId = log.conversationId ? String(log.conversationId) : undefined;
    return {
        id: String(log._id),
        domainId: log.domainId,
        domainName: log.domainId ? names.domains.get(log.domainId) || log.domainId : undefined,
        userId: log.userId,
        uname: log.userId !== undefined ? names.users.get(log.userId) : undefined,
        problemId: log.problemId,
        problemTitle: conversationId ? titles.get(conversationId) : undefined,
        conversationId,
        category: log.category,
        confidence: log.confidence,
        actionTaken: log.actionTaken,
        evidence: log.evidence || [],
        evidenceVerified: !!log.evidenceVerified,
        autoPenalized: !!log.autoPenalized,
        reason: log.reviewReason,
        reviewStatus: log.reviewStatus || 'pending',
        studentAppealedAt: log.studentAppealedAt?.toISOString(),
        reviewRunId: log.reviewRunId,
        createdAt: log.createdAt.toISOString(),
    };
}
class ReviewAdminHandler extends hydrooj_1.Handler {
    async get() {
        if ((0, groupAdminHandler_1.rejectIfNotSystemAdmin)(this))
            return;
        try {
            const runs = this.ctx.get('reviewRunModel');
            const service = this.ctx.get('aiReviewService');
            const safetyLogs = this.ctx.get('jailbreakLogModel');
            const configModel = this.ctx.get('aiConfigModel');
            const cfg = await configModel.getConfig();
            const review = (0, configSections_1.normalizeAIReviewConfig)(cfg?.aiReviewConfig);
            const timezone = (0, configSections_1.normalizeQuotaConfig)(cfg?.quotaConfig).timezone;
            const now = new Date();
            const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
            const [state, runList, findings, monthCost, todayRun] = await Promise.all([
                runs.getState(),
                runs.list(RUNS_LIMIT),
                safetyLogs.listAIReviewFindings(FINDINGS_LIMIT),
                runs.costBetween(monthStart, new Date(now.getTime() + 1)),
                runs.get(`daily:${(0, timezone_1.dateKey)(timezone, now)}`),
            ]);
            const breaker = await service.breakerStats(state);
            const uids = new Set();
            for (const run of runList)
                if (run.requestedBy !== undefined)
                    uids.add(run.requestedBy);
            for (const log of findings)
                if (log.userId !== undefined)
                    uids.add(log.userId);
            if (state.disabledBy !== undefined)
                uids.add(state.disabledBy);
            if (state.resumedBy !== undefined)
                uids.add(state.resumedBy);
            const domainIds = [...new Set(findings.map((log) => log.domainId).filter((id) => !!id))];
            const conversationIds = findings.map((log) => log.conversationId).filter((id) => !!id);
            const [names, titles] = await Promise.all([
                service.nameMaps([...uids], domainIds),
                service.problemTitles(conversationIds),
            ]);
            let nextRunAt = null;
            if (review.enabled) {
                const minutes = (0, aiReviewScheduler_1.runAtMinutes)(review.runAt);
                const todayAt = new Date((0, timezone_1.startOfDay)(timezone, now).getTime() + minutes * 60 * 1000);
                nextRunAt = (todayRun ? new Date((0, timezone_1.nextResetAt)(timezone, now).getTime() + minutes * 60 * 1000) : todayAt).toISOString();
            }
            json(this, 200, {
                config: review,
                timezone,
                modelConfigured: !!cfg?.scenarioModels?.aiReview?.length,
                state: {
                    autoPenaltyEnabled: state.autoPenaltyEnabled,
                    ...(state.trippedAt ? { trippedAt: state.trippedAt.toISOString(), trippedStats: state.trippedStats } : {}),
                    ...(state.disabledAt ? {
                        disabledAt: state.disabledAt.toISOString(),
                        disabledByName: state.disabledBy !== undefined ? names.users.get(state.disabledBy) : undefined,
                    } : {}),
                    ...(state.resumedAt ? {
                        resumedAt: state.resumedAt.toISOString(),
                        resumedByName: state.resumedBy !== undefined ? names.users.get(state.resumedBy) : undefined,
                    } : {}),
                },
                breaker: {
                    window: breaker.window,
                    sample: breaker.sample,
                    falsePositives: breaker.falsePositives,
                    rate: breaker.rate,
                    minSample: breaker.minSample,
                    threshold: breaker.threshold,
                },
                nextRunAt,
                monthCost: {
                    totalTokens: monthCost.totalTokens,
                    totalCost: Math.round(monthCost.totalCost * 10000) / 10000,
                    runCount: monthCost.runCount,
                },
                runs: runList.map((run) => ({
                    id: run._id,
                    trigger: run.trigger,
                    scopeLabel: run.scopeLabel,
                    requestedByName: run.requestedBy !== undefined ? names.users.get(run.requestedBy) : undefined,
                    status: run.status,
                    candidateCount: run.candidateCount,
                    processedCount: run.processedCount,
                    flaggedCount: run.flaggedCount,
                    penalizedCount: run.penalizedCount,
                    failedCount: run.failedCount,
                    tokens: run.tokens,
                    estimatedCostUSD: Math.round(run.estimatedCostUSD * 10000) / 10000,
                    startedAt: run.startedAt.toISOString(),
                    ...(run.finishedAt ? { finishedAt: run.finishedAt.toISOString() } : {}),
                    ...(run.error ? { error: run.error } : {}),
                })),
                findings: findings.map((log) => formatFinding(log, names, titles)),
            });
        }
        catch (err) {
            (0, groupAdminHandler_1.respondGroupError)(this, err, 'ai_helper_review_load_failed', 'REVIEW_LOAD_FAILED');
        }
    }
}
exports.ReviewAdminHandler = ReviewAdminHandler;
class ReviewRunHandler extends hydrooj_1.Handler {
    async post() {
        if ((0, csrfHelper_1.rejectIfCsrfInvalid)(this))
            return;
        if ((0, groupAdminHandler_1.rejectIfNotSystemAdmin)(this))
            return;
        try {
            const b = body(this);
            const service = this.ctx.get('aiReviewService');
            const scheduler = this.ctx.get('aiReviewScheduler');
            const audit = this.ctx.get('auditService');
            const unames = stringList(b.unames);
            const conversationIds = stringList(b.conversationIds);
            if (unames.length > exports.MAX_MANUAL_REVIEW_USERS)
                throw invalid('TOO_MANY_USERS', 'ai_helper_review_err_too_many_users', [exports.MAX_MANUAL_REVIEW_USERS]);
            if (conversationIds.length > exports.MAX_MANUAL_REVIEW_CONVERSATIONS) {
                throw invalid('TOO_MANY_CONVERSATIONS', 'ai_helper_review_err_too_many_conversations', [exports.MAX_MANUAL_REVIEW_CONVERSATIONS]);
            }
            if (conversationIds.some((id) => !mongo_1.ObjectId.isValid(id)))
                throw invalid('INVALID_CONVERSATION', 'ai_helper_review_err_invalid_conversation');
            let uids = [];
            let names = [];
            if (unames.length) {
                const resolved = await service.resolveUnames(unames);
                if (resolved.missing.length) {
                    json(this, 400, {
                        error: (0, i18nHelper_1.translateWithParams)(this, 'ai_helper_review_err_users_not_found', resolved.missing.slice(0, 10).join('、')),
                        code: 'USERS_NOT_FOUND',
                        missing: resolved.missing,
                    });
                    return;
                }
                uids = resolved.users.map((user) => user.uid);
                names = resolved.users.map((user) => user.uname);
            }
            const scope = uids.length || conversationIds.length
                ? { ...(uids.length ? { uids } : {}), ...(conversationIds.length ? { conversationIds } : {}) }
                : undefined;
            const runId = await service.startManual(scheduler.owner, actor(this), scope, scopeLabelOf(names, conversationIds.length));
            await audit.record({
                actorUid: actor(this),
                action: 'review.run',
                target: { type: 'review', id: runId, ...(names.length ? { label: names.slice(0, 10).join('、') } : {}) },
                detail: { runId, ...(uids.length ? { uids } : {}), ...(conversationIds.length ? { conversationCount: conversationIds.length } : {}) },
            }).catch((err) => console.error('[AI Helper] 写抽查审计失败:', err instanceof Error ? err.message : err));
            scheduler.runInBackground(runId);
            json(this, 200, { success: true, runId });
        }
        catch (err) {
            (0, groupAdminHandler_1.respondGroupError)(this, err, 'ai_helper_review_run_failed', 'REVIEW_RUN_FAILED');
        }
    }
}
exports.ReviewRunHandler = ReviewRunHandler;
class ReviewAutoPenaltyHandler extends hydrooj_1.Handler {
    async post() {
        if ((0, csrfHelper_1.rejectIfCsrfInvalid)(this))
            return;
        if ((0, groupAdminHandler_1.rejectIfNotSystemAdmin)(this))
            return;
        try {
            const b = body(this);
            if (typeof b.enabled !== 'boolean')
                throw invalid('INVALID_ENABLED', 'ai_helper_review_err_enabled');
            const service = this.ctx.get('aiReviewService');
            const state = await service.setAutoPenalty(b.enabled, actor(this));
            json(this, 200, { success: true, autoPenaltyEnabled: state.autoPenaltyEnabled });
        }
        catch (err) {
            (0, groupAdminHandler_1.respondGroupError)(this, err, 'ai_helper_review_auto_penalty_failed', 'REVIEW_AUTO_PENALTY_FAILED');
        }
    }
}
exports.ReviewAutoPenaltyHandler = ReviewAutoPenaltyHandler;
exports.ReviewAdminHandlerPriv = hydrooj_1.PRIV.PRIV_EDIT_SYSTEM;
//# sourceMappingURL=reviewAdminHandler.js.map