/**
 * AI 抽查管理接口（US7，系统管理员）
 *
 * - GET  /ai-helper/admin/review               抽查状态：设置、自动处罚与熔断、运行记录、下次运行、本月成本、最近发现
 * - POST /ai-helper/admin/review/run           手动触发：全量候选，或指定学生（用户名）/会话
 * - POST /ai-helper/admin/review/auto-penalty  停用或恢复自动处罚（熔断后只能由此恢复）
 * 抽查设置本身通过现有的 PUT /ai-helper/admin/config（aiReviewConfig）保存。
 */

import { Handler, PRIV } from 'hydrooj';
import { rejectIfCsrfInvalid } from '../lib/csrfHelper';
import { GroupServiceError } from '../services/hydroGroupService';
import type { AIReviewService } from '../services/aiReviewService';
import type { AIReviewScheduler } from '../services/aiReviewScheduler';
import type { AuditService } from '../services/auditService';
import type { ReviewRunModel } from '../models/reviewRun';
import type { JailbreakLog, JailbreakLogModel } from '../models/jailbreakLog';
import type { AIConfigModel } from '../models/aiConfig';
import { normalizeAIReviewConfig, normalizeQuotaConfig } from '../models/configSections';
import { dateKey, nextResetAt, startOfDay } from '../utils/timezone';
import { rejectIfNotSystemAdmin, respondGroupError } from './groupAdminHandler';
import { runAtMinutes } from '../services/aiReviewScheduler';
import { ObjectId, type ObjectIdType } from '../utils/mongo';
import { translateWithParams } from '../utils/i18nHelper';

export const MAX_MANUAL_REVIEW_USERS = 50;
export const MAX_MANUAL_REVIEW_CONVERSATIONS = 50;
const FINDINGS_LIMIT = 20;
const RUNS_LIMIT = 20;

function json(handler: Handler, status: number, body: Record<string, unknown>): void {
  if (status !== 200) handler.response.status = status;
  handler.response.body = body;
  handler.response.type = 'application/json';
}

function body(handler: Handler): Record<string, unknown> {
  const raw = handler.request.body;
  return raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
}

function actor(handler: Handler): number {
  return Number(handler.user?._id);
}

function invalid(code: string, key: string, params: Array<string | number> = []): GroupServiceError {
  return new GroupServiceError(code, 400, key, params);
}

function stringList(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,，、]+/) : [];
  return [...new Set(list.map((item) => String(item ?? '').trim()).filter(Boolean))];
}

function scopeLabelOf(names: string[], conversationCount: number): string | undefined {
  const parts: string[] = [];
  if (names.length) parts.push(names.slice(0, 3).join('、') + (names.length > 3 ? ` +${names.length - 3}` : ''));
  if (conversationCount) parts.push(`${conversationCount} conversation${conversationCount > 1 ? 's' : ''}`);
  return parts.length ? parts.join(' · ') : undefined;
}

function formatFinding(
  log: JailbreakLog,
  names: { users: Map<number, string>; domains: Map<string, string> },
  titles: Map<string, string>,
) {
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

export class ReviewAdminHandler extends Handler {
  async get() {
    if (rejectIfNotSystemAdmin(this)) return;
    try {
      const runs = this.ctx.get('reviewRunModel') as ReviewRunModel;
      const service = this.ctx.get('aiReviewService') as AIReviewService;
      const safetyLogs = this.ctx.get('jailbreakLogModel') as JailbreakLogModel;
      const configModel = this.ctx.get('aiConfigModel') as AIConfigModel;

      const cfg = await configModel.getConfig();
      const review = normalizeAIReviewConfig(cfg?.aiReviewConfig);
      const timezone = normalizeQuotaConfig(cfg?.quotaConfig).timezone;
      const now = new Date();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

      const [state, runList, findings, monthCost, todayRun] = await Promise.all([
        runs.getState(),
        runs.list(RUNS_LIMIT),
        safetyLogs.listAIReviewFindings(FINDINGS_LIMIT),
        runs.costBetween(monthStart, new Date(now.getTime() + 1)),
        runs.get(`daily:${dateKey(timezone, now)}`),
      ]);
      const breaker = await service.breakerStats(state);

      const uids = new Set<number>();
      for (const run of runList) if (run.requestedBy !== undefined) uids.add(run.requestedBy);
      for (const log of findings) if (log.userId !== undefined) uids.add(log.userId);
      if (state.disabledBy !== undefined) uids.add(state.disabledBy);
      if (state.resumedBy !== undefined) uids.add(state.resumedBy);
      const domainIds = [...new Set(findings.map((log) => log.domainId).filter((id): id is string => !!id))];
      const conversationIds = findings.map((log) => log.conversationId).filter((id): id is ObjectIdType => !!id);
      const [names, titles] = await Promise.all([
        service.nameMaps([...uids], domainIds),
        service.problemTitles(conversationIds),
      ]);

      let nextRunAt: string | null = null;
      if (review.enabled) {
        const minutes = runAtMinutes(review.runAt);
        const todayAt = new Date(startOfDay(timezone, now).getTime() + minutes * 60 * 1000);
        nextRunAt = (todayRun ? new Date(nextResetAt(timezone, now).getTime() + minutes * 60 * 1000) : todayAt).toISOString();
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
    } catch (err) {
      respondGroupError(this, err, 'ai_helper_review_load_failed', 'REVIEW_LOAD_FAILED');
    }
  }
}

export class ReviewRunHandler extends Handler {
  async post() {
    if (rejectIfCsrfInvalid(this)) return;
    if (rejectIfNotSystemAdmin(this)) return;
    try {
      const b = body(this);
      const service = this.ctx.get('aiReviewService') as AIReviewService;
      const scheduler = this.ctx.get('aiReviewScheduler') as AIReviewScheduler;
      const audit = this.ctx.get('auditService') as AuditService;

      const unames = stringList(b.unames);
      const conversationIds = stringList(b.conversationIds);
      if (unames.length > MAX_MANUAL_REVIEW_USERS) throw invalid('TOO_MANY_USERS', 'ai_helper_review_err_too_many_users', [MAX_MANUAL_REVIEW_USERS]);
      if (conversationIds.length > MAX_MANUAL_REVIEW_CONVERSATIONS) {
        throw invalid('TOO_MANY_CONVERSATIONS', 'ai_helper_review_err_too_many_conversations', [MAX_MANUAL_REVIEW_CONVERSATIONS]);
      }
      if (conversationIds.some((id) => !ObjectId.isValid(id))) throw invalid('INVALID_CONVERSATION', 'ai_helper_review_err_invalid_conversation');

      let uids: number[] = [];
      let names: string[] = [];
      if (unames.length) {
        const resolved = await service.resolveUnames(unames);
        if (resolved.missing.length) {
          json(this, 400, {
            error: translateWithParams(this, 'ai_helper_review_err_users_not_found', resolved.missing.slice(0, 10).join('、')),
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
    } catch (err) {
      respondGroupError(this, err, 'ai_helper_review_run_failed', 'REVIEW_RUN_FAILED');
    }
  }
}

export class ReviewAutoPenaltyHandler extends Handler {
  async post() {
    if (rejectIfCsrfInvalid(this)) return;
    if (rejectIfNotSystemAdmin(this)) return;
    try {
      const b = body(this);
      if (typeof b.enabled !== 'boolean') throw invalid('INVALID_ENABLED', 'ai_helper_review_err_enabled');
      const service = this.ctx.get('aiReviewService') as AIReviewService;
      const state = await service.setAutoPenalty(b.enabled, actor(this));
      json(this, 200, { success: true, autoPenaltyEnabled: state.autoPenaltyEnabled });
    } catch (err) {
      respondGroupError(this, err, 'ai_helper_review_auto_penalty_failed', 'REVIEW_AUTO_PENALTY_FAILED');
    }
  }
}

export const ReviewAdminHandlerPriv = PRIV.PRIV_EDIT_SYSTEM;
