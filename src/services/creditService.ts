/**
 * CreditService - 信誉系数（US4，FR-027–FR-035）
 *
 * - 系数由信誉事件推导（creditMath），读取时计算恢复，不依赖定时任务；
 * - 只有高置信度违规扣分：实时规则按“基础分 × 2^(k−1)”翻倍（k = 窗口内第几次），单次有上限；
 * - 复核为误判时撤销对应扣分，从下一次请求起生效；
 * - 系统管理员可手动重置（须填原因，写审计）。
 * 信誉按用户跨域计算：在任一域的违规都会影响该用户在所有域的当日次数。
 */

import type { Collection, Db } from 'mongodb';
import { PRIV } from 'hydrooj';
import type { AIConfigModel } from '../models/aiConfig';
import {
  CREDIT_CATEGORIES,
  normalizeQuotaConfig,
  type CreditCategory,
  type CreditConfig,
} from '../models/configSections';
import { CREDIT_LOOKBACK_DAYS, type CreditEvent, type CreditEventModel } from '../models/creditEvent';
import type { ObjectIdType } from '../utils/mongo';
import { computeCredit, DAY_MS, realtimeDeduction, type CreditState } from './creditMath';
import type { AuditService } from './auditService';
import { GroupServiceError } from './hydroGroupService';

export const CREDIT_RESET_MAX_USERS = 500;
export const CREDIT_REASON_MAX = 200;
/** 学生端与管理端展示的近期扣分条数 */
const RECENT_LIMIT = 10;

export interface CreditSafetyLogInfo {
  _id: ObjectIdType;
  domainId?: string;
  problemId?: string;
  reviewStatus?: string;
  studentAppealedAt?: Date;
}

/** 读取安全记录的复核与申诉状态（学生端“申诉”入口是否可用） */
export interface CreditSafetyLogSource {
  findForUser(ids: ObjectIdType[], userId: number): Promise<CreditSafetyLogInfo[]>;
}

export interface CreditSummary extends CreditState {
  /** m < 1 */
  reduced: boolean;
}

export interface CreditEventView {
  id: string;
  type: 'deduction' | 'reset';
  source: CreditEvent['source'];
  category?: CreditCategory;
  deduction?: number;
  sequence?: number;
  at: string;
  domainId?: string;
  safetyLogId?: string;
  revokedAt?: string;
  revokedBy?: number;
  revokeReason?: string;
  actorUid?: number;
  reason?: string;
}

export interface StudentCreditStatus {
  m: number;
  reduced: boolean;
  recoveryAt: string | null;
  recentViolations: Array<{
    category: CreditCategory;
    at: string;
    source: CreditEvent['source'];
    domainId?: string;
    safetyEventId?: string;
    /** 安全记录待复核且未申诉过 */
    appealable: boolean;
    appealed: boolean;
  }>;
}

export interface RealtimeDeductionInput {
  uid: number;
  category: CreditCategory;
  safetyLogId?: ObjectIdType;
  domainId?: string;
  conversationId?: ObjectIdType;
  at?: Date;
}

/** 学生端 AI 抽查处罚通知（quota-status 的 notices） */
export interface StudentReviewNotice {
  id: string;
  category: CreditCategory;
  at: string;
  domainId?: string;
  /** 违规所在的题目（学生端“查看那道题”） */
  problemId?: string;
  safetyEventId?: string;
  conversationId?: string;
  appealable: boolean;
  appealed: boolean;
}

interface UserDocLite { _id: number; uname: string; priv?: number }

function invalid(code: string, key: string, params: Array<string | number> = []): GroupServiceError {
  return new GroupServiceError(code, 400, key, params);
}

function isCreditCategory(value: unknown): value is CreditCategory {
  return typeof value === 'string' && (CREDIT_CATEGORIES as readonly string[]).includes(value);
}

export class CreditService {
  private users: Collection<UserDocLite>;

  constructor(
    db: Db,
    private readonly events: CreditEventModel,
    private readonly configModel: Pick<AIConfigModel, 'getConfig'>,
    private readonly audit: AuditService,
    private readonly safetyLogs?: CreditSafetyLogSource,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.users = db.collection<UserDocLite>('user');
  }

  private async creditConfig(): Promise<CreditConfig> {
    const cfg = await this.configModel.getConfig();
    return normalizeQuotaConfig(cfg?.quotaConfig).credit;
  }

  private lookbackStart(now: Date): Date {
    return new Date(now.getTime() - CREDIT_LOOKBACK_DAYS * DAY_MS);
  }

  private summarize(events: CreditEvent[], config: CreditConfig, now: Date): CreditSummary {
    const state = computeCredit(events, config, now);
    return { ...state, reduced: state.m < 1 };
  }

  /** 额度计算用的系数（QuotaService 的 getCreditMultiplier） */
  async getMultiplier(uid: number, now: Date = this.clock()): Promise<number> {
    const [config, events] = await Promise.all([this.creditConfig(), this.events.listSince(uid, this.lookbackStart(now))]);
    return computeCredit(events, config, now).m;
  }

  /** 一页用户的信誉（学生总览），一次 $in 查询 */
  async getSummaries(uids: number[], now: Date = this.clock()): Promise<Map<number, CreditSummary>> {
    const out = new Map<number, CreditSummary>();
    if (!uids.length) return out;
    const [config, byUser] = await Promise.all([this.creditConfig(), this.events.listSinceMany(uids, this.lookbackStart(now))]);
    for (const uid of uids) out.set(uid, this.summarize(byUser.get(uid) || [], config, now));
    return out;
  }

  /** 近 30 天有未撤销扣分、且当前系数仍低于 1 的用户（学生总览“信誉已降低”筛选） */
  async reducedUids(candidates?: number[], now: Date = this.clock()): Promise<number[]> {
    const since = this.lookbackStart(now);
    let uids = await this.events.uidsWithDeductionsSince(since);
    if (candidates) {
      const allowed = new Set(candidates);
      uids = uids.filter((uid) => allowed.has(uid));
    }
    const out: number[] = [];
    for (let i = 0; i < uids.length; i += 500) {
      const chunk = uids.slice(i, i + 500);
      const summaries = await this.getSummaries(chunk, now);
      for (const uid of chunk) if (summaries.get(uid)?.reduced) out.push(uid);
    }
    return out;
  }

  /** 管理端用户详情：当前系数与近期信誉记录（含已撤销与重置） */
  async detail(uid: number, now: Date = this.clock()): Promise<CreditSummary & { events: CreditEventView[] }> {
    const [config, events] = await Promise.all([this.creditConfig(), this.events.listSince(uid, this.lookbackStart(now))]);
    const summary = this.summarize(events, config, now);
    const views = events.slice().reverse().slice(0, RECENT_LIMIT).map((event): CreditEventView => ({
      id: String(event._id),
      type: event.type,
      source: event.source,
      ...(event.category ? { category: event.category } : {}),
      ...(event.deduction !== undefined ? { deduction: event.deduction } : {}),
      ...(event.sequence !== undefined ? { sequence: event.sequence } : {}),
      at: event.at.toISOString(),
      ...(event.domainId ? { domainId: event.domainId } : {}),
      ...(event.safetyLogId ? { safetyLogId: String(event.safetyLogId) } : {}),
      ...(event.revokedAt ? { revokedAt: event.revokedAt.toISOString(), revokedBy: event.revokedBy, revokeReason: event.revokeReason } : {}),
      ...(event.actorUid !== undefined ? { actorUid: event.actorUid } : {}),
      ...(event.reason ? { reason: event.reason } : {}),
    }));
    return { ...summary, events: views };
  }

  /** 学生端：降额原因（违规类别和时间）、预计恢复时间、申诉入口；不含规则细节（FR-034） */
  async studentStatus(uid: number, now: Date = this.clock()): Promise<StudentCreditStatus> {
    const [config, events] = await Promise.all([this.creditConfig(), this.events.listSince(uid, this.lookbackStart(now))]);
    const summary = this.summarize(events, config, now);
    // 重置之前的扣分已不影响系数，不再列出
    const lastReset = events.reduce<number>((latest, event) => (event.type === 'reset' ? Math.max(latest, event.at.getTime()) : latest), 0);
    const deductions = events
      .filter((event) => event.type === 'deduction' && !event.revokedAt && event.at.getTime() > lastReset && isCreditCategory(event.category))
      .reverse()
      .slice(0, summary.reduced ? RECENT_LIMIT : 0);
    const logIds = deductions.map((event) => event.safetyLogId).filter((id): id is ObjectIdType => !!id);
    const logs = logIds.length && this.safetyLogs ? await this.safetyLogs.findForUser(logIds, uid) : [];
    const byId = new Map(logs.map((log) => [String(log._id), log]));
    return {
      m: summary.m,
      reduced: summary.reduced,
      recoveryAt: summary.recoveryAt ? summary.recoveryAt.toISOString() : null,
      recentViolations: deductions.map((event) => {
        const log = event.safetyLogId ? byId.get(String(event.safetyLogId)) : undefined;
        const pending = !!log && (!log.reviewStatus || log.reviewStatus === 'pending');
        return {
          category: event.category as CreditCategory,
          at: event.at.toISOString(),
          source: event.source,
          ...(event.domainId ? { domainId: event.domainId } : {}),
          ...(event.safetyLogId ? { safetyEventId: String(event.safetyLogId) } : {}),
          appealable: pending && !log?.studentAppealedAt,
          appealed: !!log?.studentAppealedAt,
        };
      }),
    };
  }

  /**
   * 实时规则的高置信度违规扣分（FR-029）。k = 窗口内（含本次）实时规则扣分次数。
   * 返回本次扣分；配置为 0 分时不记录。
   */
  async recordRealtimeDeduction(input: RealtimeDeductionInput): Promise<{ deduction: number; sequence: number } | null> {
    const at = input.at || this.clock();
    const config = await this.creditConfig();
    const weight = config.weights[input.category] ?? 0;
    if (weight <= 0) return null;
    const windowStart = new Date(at.getTime() - config.escalationWindowMinutes * 60 * 1000);
    const recent = await this.events.listSince(input.uid, windowStart);
    const sequence = recent.filter((event) => event.type === 'deduction' && event.source === 'realtime' && !event.revokedAt).length + 1;
    const deduction = realtimeDeduction(weight, sequence, config.maxDeduction);
    if (deduction <= 0) return null;
    await this.events.insert({
      uid: input.uid,
      at,
      type: 'deduction',
      source: 'realtime',
      category: input.category,
      deduction,
      sequence,
      ...(input.safetyLogId ? { safetyLogId: input.safetyLogId } : {}),
      ...(input.domainId ? { domainId: input.domainId } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    });
    return { deduction, sequence };
  }

  /**
   * AI 抽查自动处罚（FR-044）：只用类别基础分，不翻倍、不计入翻倍次数。配置为 0 分时不记录。
   */
  async recordReviewDeduction(input: RealtimeDeductionInput): Promise<{ deduction: number } | null> {
    const at = input.at || this.clock();
    const config = await this.creditConfig();
    const deduction = Math.min(config.weights[input.category] ?? 0, config.maxDeduction);
    if (!(deduction > 0)) return null;
    await this.events.insert({
      uid: input.uid,
      at,
      type: 'deduction',
      source: 'ai_review',
      category: input.category,
      deduction,
      ...(input.safetyLogId ? { safetyLogId: input.safetyLogId } : {}),
      ...(input.domainId ? { domainId: input.domainId } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    });
    return { deduction };
  }

  /** 学生尚未确认的 AI 抽查处罚通知（FR-046），最近 30 天 */
  async reviewNotices(uid: number, now: Date = this.clock()): Promise<StudentReviewNotice[]> {
    const events = await this.events.pendingReviewNotices(uid, this.lookbackStart(now));
    const logIds = events.map((event) => event.safetyLogId).filter((id): id is ObjectIdType => !!id);
    const logs = logIds.length && this.safetyLogs ? await this.safetyLogs.findForUser(logIds, uid) : [];
    const logById = new Map(logs.map((log) => [String(log._id), log]));
    return events.map((event) => {
      const log = event.safetyLogId ? logById.get(String(event.safetyLogId)) : undefined;
      const pending = !!log && (!log.reviewStatus || log.reviewStatus === 'pending');
      return {
        id: String(event._id),
        category: event.category as CreditCategory,
        at: event.at.toISOString(),
        ...(event.domainId ? { domainId: event.domainId } : {}),
        ...(log?.problemId ? { problemId: log.problemId } : {}),
        ...(event.safetyLogId ? { safetyEventId: String(event.safetyLogId) } : {}),
        ...(event.conversationId ? { conversationId: String(event.conversationId) } : {}),
        appealable: pending && !log?.studentAppealedAt,
        appealed: !!log?.studentAppealedAt,
      };
    });
  }

  async ackReviewNotice(id: ObjectIdType, uid: number): Promise<boolean> {
    return this.events.ackReviewNotice(id, uid, this.clock());
  }

  /**
   * 安全记录被复核为误判：撤销对应扣分（FR-031），写审计（FR-059“影响扣分的复核结论”）。
   * 返回被撤销的扣分条数。
   */
  async revokeBySafetyLog(safetyLogId: ObjectIdType, reviewerUid: number, domainId?: string): Promise<number> {
    const revoked = await this.events.revokeBySafetyLog(safetyLogId, reviewerUid, 'false_positive', this.clock());
    if (!revoked.length) return 0;
    const uid = revoked[0].uid;
    const user = await this.users.findOne({ _id: uid }, { projection: { _id: 1, uname: 1 } });
    await this.audit.record({
      actorUid: reviewerUid,
      action: 'credit.revoke',
      ...(domainId || revoked[0].domainId ? { domainId: domainId || revoked[0].domainId } : {}),
      target: { type: 'user', id: String(uid), label: user?.uname || `#${uid}` },
      detail: {
        uids: [uid],
        safetyLogId: String(safetyLogId),
        category: revoked[0].category,
        deduction: revoked.reduce((sum, event) => sum + (event.deduction || 0), 0),
        reason: 'false_positive',
      },
    });
    return revoked.length;
  }

  /** 系统管理员手动重置信誉（FR-032）：系数回到 1.0，写审计 */
  async reset(uidsRaw: unknown, reasonRaw: unknown, actorUid: number): Promise<{ reset: number[]; missing: number[] }> {
    const uids = this.requireUids(uidsRaw);
    const reason = typeof reasonRaw === 'string' ? reasonRaw.trim() : '';
    if (!reason) throw invalid('REASON_REQUIRED', 'ai_helper_credit_reason_required');
    if ([...reason].length > CREDIT_REASON_MAX) throw invalid('REASON_TOO_LONG', 'ai_helper_credit_reason_too_long', [CREDIT_REASON_MAX]);

    const docs = await this.users
      .find({ _id: { $in: uids, $gt: 1 }, priv: { $bitsAllSet: Number(PRIV.PRIV_USER_PROFILE) } }, { projection: { _id: 1, uname: 1 } })
      .toArray();
    const names = new Map(docs.map((doc) => [doc._id, doc.uname]));
    const targets = uids.filter((uid) => names.has(uid));
    const missing = uids.filter((uid) => !names.has(uid));
    if (!targets.length) return { reset: [], missing };

    const now = this.clock();
    const before = await this.getSummaries(targets, now);
    await this.events.insertMany(targets.map((uid) => ({ uid, at: now, type: 'reset' as const, source: 'manual' as const, actorUid, reason })));
    const label = targets.slice(0, 5).map((uid) => names.get(uid) || `#${uid}`).join(', ') + (targets.length > 5 ? ` +${targets.length - 5}` : '');
    await this.audit.record({
      actorUid,
      action: 'credit.reset',
      target: { type: 'user', id: targets.length === 1 ? String(targets[0]) : `batch:${targets.length}`, label },
      detail: {
        uids: targets,
        reason,
        before: targets.map((uid) => ({ uid, m: before.get(uid)?.m ?? 1 })).filter((item) => item.m < 1),
      },
    });
    return { reset: targets, missing };
  }

  private requireUids(raw: unknown): number[] {
    if (!Array.isArray(raw) || !raw.length) throw invalid('INVALID_UIDS', 'ai_helper_group_uids_invalid');
    const out: number[] = [];
    for (const item of raw) {
      const uid = typeof item === 'string' && /^\d+$/.test(item) ? Number(item) : item;
      if (typeof uid !== 'number' || !Number.isSafeInteger(uid) || uid <= 1) throw invalid('INVALID_UIDS', 'ai_helper_group_uids_invalid');
      if (!out.includes(uid)) out.push(uid);
    }
    if (out.length > CREDIT_RESET_MAX_USERS) throw invalid('TOO_MANY_USERS', 'ai_helper_group_too_many_users', [CREDIT_RESET_MAX_USERS]);
    return out;
  }
}
