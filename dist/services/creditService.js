"use strict";
/**
 * CreditService - 信誉系数（US4，FR-027–FR-035）
 *
 * - 系数由信誉事件推导（creditMath），读取时计算恢复，不依赖定时任务；
 * - 只有高置信度违规扣分：实时规则按“基础分 × 2^(k−1)”翻倍（k = 窗口内第几次），单次有上限；
 * - 复核为误判时撤销对应扣分，从下一次请求起生效；
 * - 系统管理员可手动重置（须填原因，写审计）。
 * 信誉按用户跨域计算：在任一域的违规都会影响该用户在所有域的当日次数。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreditService = exports.CREDIT_REASON_MAX = exports.CREDIT_RESET_MAX_USERS = void 0;
const hydrooj_1 = require("hydrooj");
const configSections_1 = require("../models/configSections");
const creditEvent_1 = require("../models/creditEvent");
const creditMath_1 = require("./creditMath");
const hydroGroupService_1 = require("./hydroGroupService");
exports.CREDIT_RESET_MAX_USERS = 500;
exports.CREDIT_REASON_MAX = 200;
/** 学生端与管理端展示的近期扣分条数 */
const RECENT_LIMIT = 10;
function invalid(code, key, params = []) {
    return new hydroGroupService_1.GroupServiceError(code, 400, key, params);
}
function isCreditCategory(value) {
    return typeof value === 'string' && configSections_1.CREDIT_CATEGORIES.includes(value);
}
class CreditService {
    constructor(db, events, configModel, audit, safetyLogs, clock = () => new Date()) {
        this.events = events;
        this.configModel = configModel;
        this.audit = audit;
        this.safetyLogs = safetyLogs;
        this.clock = clock;
        this.users = db.collection('user');
    }
    async creditConfig() {
        const cfg = await this.configModel.getConfig();
        return (0, configSections_1.normalizeQuotaConfig)(cfg?.quotaConfig).credit;
    }
    lookbackStart(now) {
        return new Date(now.getTime() - creditEvent_1.CREDIT_LOOKBACK_DAYS * creditMath_1.DAY_MS);
    }
    summarize(events, config, now) {
        const state = (0, creditMath_1.computeCredit)(events, config, now);
        return { ...state, reduced: state.m < 1 };
    }
    /** 额度计算用的系数（QuotaService 的 getCreditMultiplier） */
    async getMultiplier(uid, now = this.clock()) {
        const [config, events] = await Promise.all([this.creditConfig(), this.events.listSince(uid, this.lookbackStart(now))]);
        return (0, creditMath_1.computeCredit)(events, config, now).m;
    }
    /** 一页用户的信誉（学生总览），一次 $in 查询 */
    async getSummaries(uids, now = this.clock()) {
        const out = new Map();
        if (!uids.length)
            return out;
        const [config, byUser] = await Promise.all([this.creditConfig(), this.events.listSinceMany(uids, this.lookbackStart(now))]);
        for (const uid of uids)
            out.set(uid, this.summarize(byUser.get(uid) || [], config, now));
        return out;
    }
    /** 近 30 天有未撤销扣分、且当前系数仍低于 1 的用户（学生总览“信誉已降低”筛选） */
    async reducedUids(candidates, now = this.clock()) {
        const since = this.lookbackStart(now);
        let uids = await this.events.uidsWithDeductionsSince(since);
        if (candidates) {
            const allowed = new Set(candidates);
            uids = uids.filter((uid) => allowed.has(uid));
        }
        const out = [];
        for (let i = 0; i < uids.length; i += 500) {
            const chunk = uids.slice(i, i + 500);
            const summaries = await this.getSummaries(chunk, now);
            for (const uid of chunk)
                if (summaries.get(uid)?.reduced)
                    out.push(uid);
        }
        return out;
    }
    /** 管理端用户详情：当前系数与近期信誉记录（含已撤销与重置） */
    async detail(uid, now = this.clock()) {
        const [config, events] = await Promise.all([this.creditConfig(), this.events.listSince(uid, this.lookbackStart(now))]);
        const summary = this.summarize(events, config, now);
        const views = events.slice().reverse().slice(0, RECENT_LIMIT).map((event) => ({
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
    async studentStatus(uid, now = this.clock()) {
        const [config, events] = await Promise.all([this.creditConfig(), this.events.listSince(uid, this.lookbackStart(now))]);
        const summary = this.summarize(events, config, now);
        // 重置之前的扣分已不影响系数，不再列出
        const lastReset = events.reduce((latest, event) => (event.type === 'reset' ? Math.max(latest, event.at.getTime()) : latest), 0);
        const deductions = events
            .filter((event) => event.type === 'deduction' && !event.revokedAt && event.at.getTime() > lastReset && isCreditCategory(event.category))
            .reverse()
            .slice(0, summary.reduced ? RECENT_LIMIT : 0);
        const logIds = deductions.map((event) => event.safetyLogId).filter((id) => !!id);
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
                    category: event.category,
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
    async recordRealtimeDeduction(input) {
        const at = input.at || this.clock();
        const config = await this.creditConfig();
        const weight = config.weights[input.category] ?? 0;
        if (weight <= 0)
            return null;
        const windowStart = new Date(at.getTime() - config.escalationWindowMinutes * 60 * 1000);
        const recent = await this.events.listSince(input.uid, windowStart);
        const sequence = recent.filter((event) => event.type === 'deduction' && event.source === 'realtime' && !event.revokedAt).length + 1;
        const deduction = (0, creditMath_1.realtimeDeduction)(weight, sequence, config.maxDeduction);
        if (deduction <= 0)
            return null;
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
     * 安全记录被复核为误判：撤销对应扣分（FR-031），写审计（FR-059“影响扣分的复核结论”）。
     * 返回被撤销的扣分条数。
     */
    async revokeBySafetyLog(safetyLogId, reviewerUid, domainId) {
        const revoked = await this.events.revokeBySafetyLog(safetyLogId, reviewerUid, 'false_positive', this.clock());
        if (!revoked.length)
            return 0;
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
    async reset(uidsRaw, reasonRaw, actorUid) {
        const uids = this.requireUids(uidsRaw);
        const reason = typeof reasonRaw === 'string' ? reasonRaw.trim() : '';
        if (!reason)
            throw invalid('REASON_REQUIRED', 'ai_helper_credit_reason_required');
        if ([...reason].length > exports.CREDIT_REASON_MAX)
            throw invalid('REASON_TOO_LONG', 'ai_helper_credit_reason_too_long', [exports.CREDIT_REASON_MAX]);
        const docs = await this.users
            .find({ _id: { $in: uids, $gt: 1 }, priv: { $bitsAllSet: Number(hydrooj_1.PRIV.PRIV_USER_PROFILE) } }, { projection: { _id: 1, uname: 1 } })
            .toArray();
        const names = new Map(docs.map((doc) => [doc._id, doc.uname]));
        const targets = uids.filter((uid) => names.has(uid));
        const missing = uids.filter((uid) => !names.has(uid));
        if (!targets.length)
            return { reset: [], missing };
        const now = this.clock();
        const before = await this.getSummaries(targets, now);
        await this.events.insertMany(targets.map((uid) => ({ uid, at: now, type: 'reset', source: 'manual', actorUid, reason })));
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
    requireUids(raw) {
        if (!Array.isArray(raw) || !raw.length)
            throw invalid('INVALID_UIDS', 'ai_helper_group_uids_invalid');
        const out = [];
        for (const item of raw) {
            const uid = typeof item === 'string' && /^\d+$/.test(item) ? Number(item) : item;
            if (typeof uid !== 'number' || !Number.isSafeInteger(uid) || uid <= 1)
                throw invalid('INVALID_UIDS', 'ai_helper_group_uids_invalid');
            if (!out.includes(uid))
                out.push(uid);
        }
        if (out.length > exports.CREDIT_RESET_MAX_USERS)
            throw invalid('TOO_MANY_USERS', 'ai_helper_group_too_many_users', [exports.CREDIT_RESET_MAX_USERS]);
        return out;
    }
}
exports.CreditService = CreditService;
//# sourceMappingURL=creditService.js.map