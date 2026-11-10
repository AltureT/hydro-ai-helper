/**
 * AI 定期抽查（US7，plan R9、R10、R15）
 *
 * 一个批次：熔断检查 → 选出候选（存入批次文档，可断点续跑）→ 逐个会话调用审核模型（并发 2）
 * → 解析与证据核对 → 违规且置信度为中或高时写安全记录（来源 ai_review）→ 满足 FR-044 时自动扣信誉。
 * 审核模型不可用时整批跳过；连续 3 次调用失败时中止，不产生后续处罚（FR-048）。
 * token 与费用只累计在批次文档中，不写入 ai_token_usage，因此不计入任何学生（FR-049）。
 */

import type { Collection, Db } from 'mongodb';
import { ObjectId, type ObjectIdType } from '../utils/mongo';
import { normalizeAIReviewConfig, normalizeQuotaConfig, type AIReviewConfig, type CreditCategory } from '../models/configSections';
import type { AIConfigModel } from '../models/aiConfig';
import type { MessageModel } from '../models/message';
import type { JailbreakLogModel } from '../models/jailbreakLog';
import type { CreditEventModel } from '../models/creditEvent';
import type { QuotaUsageModel } from '../models/quotaUsage';
import {
  ReviewRunModel,
  type ReviewCandidate,
  type ReviewRunProgress,
  type ReviewRunScope,
  type ReviewRunStatus,
  type ReviewState,
} from '../models/reviewRun';
import type { ChatCallOptions, ChatMessage, TokenUsage } from './openaiClient';
import type { AuditService } from './auditService';
import type { CreditService } from './creditService';
import type { QuotaService } from './quotaService';
import { GroupServiceError } from './hydroGroupService';
import {
  buildReviewTranscript,
  buildReviewUserPrompt,
  parseReviewResult,
  REVIEW_SYSTEM_PROMPT,
  verifyEvidence,
  type ReviewSourceMessage,
} from './aiReviewEvidence';
import {
  selectCandidates,
  selectManualCandidates,
  type CandidateConversation,
  type CandidateSources,
} from './aiReviewCandidates';
import { decideAutoPenalty, evaluateBreaker, touchesRealtimeDeduction } from './aiReviewPenalty';
import { dateKey, previousDateKey, startOfDay } from '../utils/timezone';

export const REVIEW_CONCURRENCY = 2;
export const REVIEW_MAX_CONSECUTIVE_MODEL_FAILURES = 3;
export const REVIEW_MAX_COMPLETION_TOKENS = 800;
export const REVIEW_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export interface ReviewModelClient {
  chat(messages: ChatMessage[], systemPrompt: string, options?: ChatCallOptions): Promise<{
    content: string;
    usage?: TokenUsage;
    usedModel: { modelName: string };
  }>;
}

export interface ConversationLite {
  _id: ObjectIdType;
  domainId: string;
  userId: number;
  problemId?: string;
  messageCount?: number;
  endTime?: Date;
  metadata?: { problemTitle?: string };
}

export interface AIReviewDeps {
  db: Db;
  runs: ReviewRunModel;
  messages: Pick<MessageModel, 'findByConversationId'>;
  safetyLogs: Pick<JailbreakLogModel,
    'create' | 'downgradeAutoPenalty' | 'conversationsWithConfidenceSince' | 'usersWithPenaltyEventsSince'
    | 'hasAutoPenaltyForConversation' | 'hasAutoPenaltyForUserSince' | 'recentReviewedAutoPenalties'>;
  creditEvents: Pick<CreditEventModel, 'listRealtimeForConversation'>;
  credit: Pick<CreditService, 'recordReviewDeduction'>;
  configModel: Pick<AIConfigModel, 'getConfig'>;
  audit: Pick<AuditService, 'record'>;
  quotaUsage?: Pick<QuotaUsageModel, 'usersWithUsage'>;
  quota?: Pick<QuotaService, 'explainMany'>;
  createClient: () => Promise<ReviewModelClient>;
  estimateCost: (modelName: string, promptTokens: number, completionTokens: number) => number;
  clock?: () => Date;
  /** 测试注入 */
  candidateSources?: CandidateSources;
}

interface ConversationOutcome extends ReviewRunProgress {
  modelFailure?: boolean;
}

export class AIReviewService {
  private readonly clock: () => Date;
  private readonly conversations: Collection<ConversationLite>;
  private readonly candidateSources: CandidateSources;

  constructor(private readonly deps: AIReviewDeps) {
    this.clock = deps.clock || (() => new Date());
    this.conversations = deps.db.collection<ConversationLite>('ai_conversations');
    this.candidateSources = deps.candidateSources || this.mongoCandidateSources();
  }

  private async configs(): Promise<{ review: AIReviewConfig; timezone: string; weights: Record<CreditCategory, number> }> {
    const cfg = await this.deps.configModel.getConfig();
    const quota = normalizeQuotaConfig(cfg?.quotaConfig);
    return { review: normalizeAIReviewConfig(cfg?.aiReviewConfig), timezone: quota.timezone, weights: quota.credit.weights };
  }

  // ─── 批次 ───────────────────────────────────────────────

  /** 每日批次：当天已有批次（其他进程负责）时返回 null */
  async startDaily(owner: string): Promise<string | null> {
    const { timezone } = await this.configs();
    const now = this.clock();
    const date = dateKey(timezone, now);
    const id = `daily:${date}`;
    const created = await this.deps.runs.tryCreate({ id, trigger: 'schedule', owner, now, date });
    return created ? id : null;
  }

  /** 手动触发（FR-040）：有批次正在运行时拒绝，避免同一会话被并发处罚 */
  async startManual(owner: string, actorUid: number, scope?: ReviewRunScope, scopeLabel?: string): Promise<string> {
    const now = this.clock();
    if (await this.deps.runs.hasActiveRun(now)) {
      throw new GroupServiceError('REVIEW_RUNNING', 409, 'ai_helper_review_err_running');
    }
    const id = `manual:${new ObjectId().toHexString()}`;
    await this.deps.runs.tryCreate({
      id, trigger: 'manual', owner, now, requestedBy: actorUid,
      ...(scope ? { scope } : {}),
      ...(scopeLabel ? { scopeLabel } : {}),
    });
    return id;
  }

  /**
   * 执行（或续跑）一个批次。`active()` 返回 false 表示租约已丢失，立即停止且不再写结果。
   */
  async execute(runId: string, owner: string, active: () => boolean = () => true): Promise<ReviewRunStatus | null> {
    const run = await this.deps.runs.get(runId);
    if (!run || run.status !== 'running' || run.leaseOwner !== owner) return null;
    const { review } = await this.configs();

    try {
      await this.checkBreaker();
    } catch (err) {
      console.warn('[AIReview] 熔断检查失败:', err instanceof Error ? err.message : err);
    }

    let candidates = run.candidates;
    if (!candidates) {
      const now = this.clock();
      candidates = run.scope && (run.scope.uids?.length || run.scope.conversationIds?.length)
        ? await selectManualCandidates(this.candidateSources, run.scope, now, review.maxConversations)
        : await selectCandidates(this.candidateSources, {
          since: new Date(now.getTime() - REVIEW_LOOKBACK_MS),
          sampleRate: review.sampleRate,
          max: review.maxConversations,
        });
      if (!active() || !(await this.deps.runs.setCandidates(runId, owner, candidates))) return null;
    }

    const processed = new Set(run.processedIds);
    const pending = candidates.filter((candidate) => !processed.has(String(candidate.conversationId)));
    if (!pending.length) {
      await this.deps.runs.finish(runId, owner, 'completed', this.clock());
      return 'completed';
    }

    let client: ReviewModelClient;
    try {
      client = await this.deps.createClient();
    } catch (err) {
      console.warn('[AIReview] 审核模型不可用，本次跳过:', err instanceof Error ? err.message : err);
      await this.deps.runs.finish(runId, owner, 'skipped', this.clock(), 'model_unavailable');
      return 'skipped';
    }

    let consecutiveFailures = 0;
    let aborted = false;
    let leaseLost = false;
    // 同一学生的会话由同一个 worker 依次处理：“当天只处罚一次”的检查不会因并发而失效（FR-044）
    const byUser = new Map<number, ReviewCandidate[]>();
    for (const candidate of pending) {
      const list = byUser.get(candidate.userId);
      if (list) list.push(candidate);
      else byUser.set(candidate.userId, [candidate]);
    }
    const groups = [...byUser.values()];
    let cursor = 0;
    const worker = async () => {
      while (!aborted && !leaseLost && cursor < groups.length) {
        const group = groups[cursor++];
        for (const candidate of group) {
          if (aborted || leaseLost) return;
          if (!active()) { leaseLost = true; return; }
          const outcome = await this.reviewConversation(runId, candidate, client).catch((err): ConversationOutcome => {
            console.error('[AIReview] 处理会话失败:', err instanceof Error ? err.message : err);
            return { failed: 1 };
          });
          if (outcome.modelFailure) {
            consecutiveFailures += 1;
            if (consecutiveFailures >= REVIEW_MAX_CONSECUTIVE_MODEL_FAILURES) aborted = true;
          } else {
            consecutiveFailures = 0;
          }
          if (!active()) { leaseLost = true; return; }
          const recorded = await this.deps.runs.markProcessed(runId, owner, String(candidate.conversationId), outcome);
          if (!recorded) {
            const latest = await this.deps.runs.get(runId);
            if (!latest || latest.status !== 'running' || latest.leaseOwner !== owner) { leaseLost = true; return; }
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(REVIEW_CONCURRENCY, groups.length) }, worker));

    if (leaseLost) return null;
    const status: ReviewRunStatus = aborted ? 'failed' : 'completed';
    await this.deps.runs.finish(runId, owner, status, this.clock(), aborted ? 'model_failed' : undefined);
    return status;
  }

  // ─── 单个会话 ───────────────────────────────────────────

  private async reviewConversation(runId: string, candidate: ReviewCandidate, client: ReviewModelClient): Promise<ConversationOutcome> {
    const conversation = await this.conversations.findOne({ _id: candidate.conversationId });
    if (!conversation) return {};
    const stored = await this.deps.messages.findByConversationId(conversation._id);
    const messages: ReviewSourceMessage[] = stored.map((message) => ({
      id: String(message._id),
      role: message.role === 'student' ? 'student' : 'ai',
      content: message.content || '',
      ...(message.role === 'student' && message.metadata?.codeContent ? { code: message.metadata.codeContent } : {}),
      timestamp: message.timestamp,
    }));
    const transcript = buildReviewTranscript(messages, conversation.metadata?.problemTitle);
    if (!transcript.studentMessageCount) return {};

    let content: string;
    let usage: TokenUsage | undefined;
    let modelName = '';
    try {
      const response = await client.chat(
        [{ role: 'user', content: buildReviewUserPrompt(transcript) }],
        REVIEW_SYSTEM_PROMPT,
        { temperature: 0, maxTokens: REVIEW_MAX_COMPLETION_TOKENS, contentMode: 'raw' },
      );
      content = response.content;
      usage = response.usage;
      modelName = response.usedModel?.modelName || '';
    } catch (err) {
      console.warn('[AIReview] 审核模型调用失败:', err instanceof Error ? err.message : err);
      return { failed: 1, modelFailure: true };
    }

    const tokens = usage
      ? { prompt: usage.promptTokens, completion: usage.completionTokens, total: usage.totalTokens }
      : undefined;
    const costUSD = usage ? this.deps.estimateCost(modelName, usage.promptTokens, usage.completionTokens) : 0;
    const base: ConversationOutcome = { ...(tokens ? { tokens } : {}), costUSD };

    const parsed = parseReviewResult(content);
    if (!parsed.ok) return { ...base, failed: 1 };
    const result = parsed.result;
    // 低置信度不进入复核列表（验收场景 4）
    if (!result.violation || !result.category || result.confidence === 'low') return base;

    const check = verifyEvidence(result.evidence, transcript.refs);
    const now = this.clock();
    const { timezone } = await this.configs();
    const state = await this.deps.runs.getState();

    const evidenceMessageIds = new Set(check.items
      .filter((item) => item.ok)
      .map((item) => transcript.refs.get(item.ref)?.messageId)
      .filter((id): id is string => !!id));
    const evidenceMessages = stored
      .map((message, index) => ({ message, next: stored[index + 1] }))
      .filter(({ message }) => evidenceMessageIds.has(String(message._id)))
      .map(({ message, next }) => ({
        timestamp: message.timestamp,
        followedByFixedReply: !!next && next.role === 'ai' && !!next.metadata?.topicGuardBypassedLLM,
      }));

    const [conversationAlreadyPenalized, userPenalizedToday, realtimeEvents] = await Promise.all([
      this.deps.safetyLogs.hasAutoPenaltyForConversation(conversation._id),
      this.deps.safetyLogs.hasAutoPenaltyForUserSince(conversation.userId, startOfDay(timezone, now)),
      this.deps.creditEvents.listRealtimeForConversation(conversation.userId, conversation._id),
    ]);
    const decision = decideAutoPenalty({
      autoPenaltyEnabled: state.autoPenaltyEnabled,
      confidence: result.confidence,
      evidenceVerified: check.verified,
      conversationAlreadyPenalized,
      userPenalizedToday,
      touchesRealtimeDeduction: touchesRealtimeDeduction(evidenceMessages, realtimeEvents.map((event) => event.at)),
    });

    const firstQuote = check.items[0]?.quote || result.reason || result.category;
    const logId = await this.deps.safetyLogs.create({
      domainId: conversation.domainId,
      userId: conversation.userId,
      ...(conversation.problemId ? { problemId: conversation.problemId } : {}),
      conversationId: conversation._id,
      matchedPattern: 'ai_review',
      matchedText: firstQuote,
      category: result.category,
      confidence: result.confidence,
      detectionSource: 'ai_review',
      actionTaken: decision.penalize ? 'ai_review_penalty' : 'flagged',
      createdAt: now,
      reviewRunId: runId,
      evidence: check.items.map((item) => ({ ref: item.ref, snippet: item.quote, verified: item.ok })),
      evidenceVerified: check.verified,
      autoPenalized: decision.penalize,
      ...(result.reason ? { reviewReason: result.reason } : {}),
    });

    let penalized = 0;
    if (decision.penalize) {
      try {
        const deducted = await this.deps.credit.recordReviewDeduction({
          uid: conversation.userId,
          category: result.category as CreditCategory,
          safetyLogId: logId,
          domainId: conversation.domainId,
          conversationId: conversation._id,
          at: now,
        });
        if (deducted) penalized = 1;
        else await this.deps.safetyLogs.downgradeAutoPenalty(logId);
      } catch (err) {
        console.error('[AIReview] 写入信誉扣分失败:', err instanceof Error ? err.message : err);
        await this.deps.safetyLogs.downgradeAutoPenalty(logId).catch(() => undefined);
      }
    }
    return { ...base, flagged: 1, penalized };
  }

  // ─── 熔断 ───────────────────────────────────────────────

  /** 当前误判统计（只看最近一次恢复之后产生的自动处罚） */
  async breakerStats(state?: ReviewState) {
    const [{ review }, current] = await Promise.all([this.configs(), state ? Promise.resolve(state) : this.deps.runs.getState()]);
    const reviewed = await this.deps.safetyLogs.recentReviewedAutoPenalties(review.breakerWindow, current.resumedAt);
    return { ...evaluateBreaker(reviewed, review), minSample: review.breakerMinSample, threshold: review.breakerThreshold };
  }

  /**
   * 熔断检查（FR-047）：每批开始前、每次复核 AI 抽查记录后调用。触发时写审计，返回是否本次触发。
   */
  async checkBreaker(): Promise<boolean> {
    const state = await this.deps.runs.getState();
    if (!state.autoPenaltyEnabled) return false;
    const stats = await this.breakerStats(state);
    if (!stats.trip) return false;
    const { window, sample, falsePositives, rate } = stats;
    const tripped = await this.deps.runs.trip({ window, sample, falsePositives, rate }, this.clock());
    if (tripped) {
      await this.deps.audit.record({
        action: 'review.breaker_trip',
        target: { type: 'review', id: 'auto_penalty' },
        detail: { window, sample, falsePositives, rate, threshold: stats.threshold },
      }).catch((err) => console.error('[AIReview] 写熔断审计失败:', err instanceof Error ? err.message : err));
    }
    return tripped;
  }

  /** 管理员停用或恢复自动处罚（只能由系统管理员恢复，FR-047） */
  async setAutoPenalty(enabled: boolean, actorUid: number): Promise<ReviewState> {
    const before = await this.deps.runs.getState();
    const state = await this.deps.runs.setAutoPenalty(enabled, actorUid, this.clock());
    if (before.autoPenaltyEnabled !== enabled) {
      await this.deps.audit.record({
        actorUid,
        action: enabled ? 'review.auto_penalty_resume' : 'review.auto_penalty_disable',
        target: { type: 'review', id: 'auto_penalty' },
        detail: before.trippedStats ? { trippedStats: before.trippedStats } : {},
      });
    }
    return state;
  }

  // ─── 管理页查询 ─────────────────────────────────────────

  async nameMaps(uids: number[], domainIds: string[]): Promise<{ users: Map<number, string>; domains: Map<string, string> }> {
    const users = this.deps.db.collection<{ _id: number; uname: string }>('user');
    const domains = this.deps.db.collection<{ _id: string; name?: string }>('domain');
    const [userDocs, domainDocs] = await Promise.all([
      uids.length ? users.find({ _id: { $in: uids } }, { projection: { _id: 1, uname: 1 } }).toArray() : Promise.resolve([]),
      domainIds.length ? domains.find({ _id: { $in: domainIds } }, { projection: { _id: 1, name: 1 } }).toArray() : Promise.resolve([]),
    ]);
    return {
      users: new Map(userDocs.map((doc) => [doc._id, doc.uname])),
      domains: new Map(domainDocs.map((doc) => [doc._id, doc.name || doc._id])),
    };
  }

  async problemTitles(conversationIds: ObjectIdType[]): Promise<Map<string, string>> {
    if (!conversationIds.length) return new Map();
    const docs = await this.conversations
      .find({ _id: { $in: conversationIds } }, { projection: { _id: 1, metadata: 1 } })
      .toArray();
    return new Map(docs
      .filter((doc) => doc.metadata?.problemTitle)
      .map((doc) => [String(doc._id), doc.metadata?.problemTitle as string]));
  }

  /** 按用户名找学生（不区分大小写，排除游客与内置账号） */
  async resolveUnames(unames: string[]): Promise<{ users: Array<{ uid: number; uname: string }>; missing: string[] }> {
    if (!unames.length) return { users: [], missing: [] };
    const docs = await this.deps.db.collection<{ _id: number; uname: string; unameLower?: string }>('user')
      .find({ unameLower: { $in: unames.map((name) => name.toLowerCase()) }, _id: { $gt: 1 } }, { projection: { _id: 1, uname: 1, unameLower: 1 } })
      .toArray();
    const found = new Set(docs.map((doc) => doc.unameLower || doc.uname.toLowerCase()));
    return {
      users: docs.map((doc) => ({ uid: doc._id, uname: doc.uname })),
      missing: unames.filter((name) => !found.has(name.toLowerCase())),
    };
  }

  // ─── 候选来源（Mongo） ─────────────────────────────────

  private mongoCandidateSources(): CandidateSources {
    const toCandidate = (doc: ConversationLite): CandidateConversation => ({
      conversationId: doc._id, domainId: doc.domainId, userId: doc.userId,
    });
    const projection = { _id: 1, domainId: 1, userId: 1 };
    const active = (since: Date) => ({ endTime: { $gte: since }, messageCount: { $gte: 1 } });
    return {
      mediumConfidenceConversations: async (since) => {
        const hits = await this.deps.safetyLogs.conversationsWithConfidenceSince('medium', since);
        if (!hits.length) return [];
        const ids = [...new Map(hits.map((hit) => [String(hit.conversationId), hit.conversationId])).values()];
        const docs = await this.conversations.find({ _id: { $in: ids } }, { projection }).toArray();
        return docs.map(toCandidate);
      },
      offTopicUsers: (since) => this.deps.safetyLogs.usersWithPenaltyEventsSince('off_topic', since),
      highUsageUsers: async (ratio) => {
        if (!this.deps.quotaUsage || !this.deps.quota) return [];
        const { timezone } = await this.configs();
        const now = this.clock();
        const [today, yesterday] = await Promise.all([
          this.deps.quotaUsage.usersWithUsage(dateKey(timezone, now), 1, 5000),
          this.deps.quotaUsage.usersWithUsage(previousDateKey(timezone, now), 1, 5000),
        ]);
        const used = new Map<number, number>();
        for (const row of [...today, ...yesterday]) used.set(row.uid, Math.max(used.get(row.uid) || 0, row.used));
        const uids = [...used.keys()];
        const out: number[] = [];
        for (let i = 0; i < uids.length; i += 200) {
          const explained = await this.deps.quota.explainMany(uids.slice(i, i + 200));
          for (const [uid, quota] of explained) {
            if (quota.limit !== null && quota.limit > 0 && (used.get(uid) || 0) >= quota.limit * ratio) out.push(uid);
          }
        }
        return out;
      },
      conversationsOfUsers: async (uids, since, limit) => {
        if (!uids.length) return [];
        const docs = await this.conversations
          .find({ userId: { $in: uids }, ...active(since) }, { projection })
          .sort({ endTime: -1 })
          .limit(limit)
          .toArray();
        return docs.map(toCandidate);
      },
      countConversations: (since) => this.conversations.countDocuments(active(since)),
      sampleConversations: async (since, size, excludeIds) => {
        const exclude = excludeIds.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
        const docs = await this.conversations.aggregate<ConversationLite>([
          { $match: { ...active(since), ...(exclude.length ? { _id: { $nin: exclude } } : {}) } },
          { $sample: { size } },
          { $project: projection },
        ]).toArray();
        return docs.map(toCandidate);
      },
      conversationsByIds: async (ids) => {
        const objectIds = ids.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
        if (!objectIds.length) return [];
        const docs = await this.conversations.find({ _id: { $in: objectIds } }, { projection }).toArray();
        return docs.map(toCandidate);
      },
    };
  }
}
