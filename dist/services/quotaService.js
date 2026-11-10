"use strict";
/**
 * QuotaService - 每日 AI 次数（US2）
 *
 * 解析有效额度 → 预占 → 确认 / 退还，并提供学生端状态。
 * 额度组、个人覆盖、信誉系数通过 QuotaPolicySources 接入（PR3 / PR4），本版本只有全局默认。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.QuotaService = void 0;
const crypto_1 = require("crypto");
const configSections_1 = require("../models/configSections");
const timezone_1 = require("../utils/timezone");
const quotaPolicy_1 = require("./quotaPolicy");
const MIN_RESERVATION_TTL_MS = 10 * 60 * 1000;
function snapshot(limit, used, resetAt) {
    return {
        limit,
        used,
        remaining: limit === null ? null : Math.max(0, limit - used),
        resetAt: resetAt.toISOString(),
    };
}
class QuotaService {
    constructor(usage, configModel, sources = {}, clock = () => new Date()) {
        this.usage = usage;
        this.configModel = configModel;
        this.sources = sources;
        this.clock = clock;
    }
    /** 解析用户当前的有效额度；传入已读取的配置可省去一次查询 */
    async resolve(uid, config) {
        const cfg = config === undefined ? await this.configModel.getConfig() : config;
        const quotaConfig = (0, configSections_1.normalizeQuotaConfig)(cfg?.quotaConfig);
        const now = this.clock();
        const [override, groups, m] = await Promise.all([
            this.sources.getOverride ? this.sources.getOverride(uid, now) : Promise.resolve(null),
            this.sources.getGroupLimits ? this.sources.getGroupLimits(uid) : Promise.resolve({ grants: [], caps: [] }),
            this.sources.getCreditMultiplier ? this.sources.getCreditMultiplier(uid, now) : Promise.resolve(1),
        ]);
        const { base, source, capped } = (0, quotaPolicy_1.resolveBase)(override, groups.grants, groups.caps, (0, quotaPolicy_1.defaultLimitFromConfig)(quotaConfig.dailyMessageLimit), now);
        return {
            limit: (0, quotaPolicy_1.effective)(base, m, quotaConfig.guaranteeCount),
            base,
            source,
            capped,
            m,
            quotaConfig,
            timeoutSeconds: cfg?.timeoutSeconds || 30,
        };
    }
    /** 请求开始时预占一次；被拒时不留下任何数据 */
    async reserve(uid, config) {
        const resolved = await this.resolve(uid, config);
        const now = this.clock();
        const tz = resolved.quotaConfig.timezone;
        const date = (0, timezone_1.dateKey)(tz, now);
        const resetAt = (0, timezone_1.nextResetAt)(tz, now);
        if (resolved.base === 0)
            return { ok: false, code: 'AI_DISABLED_BY_ADMIN' };
        if (resolved.limit === null) {
            return { ok: true, reservation: { uid, date, id: null, limit: null, resetAt, settled: false } };
        }
        const id = (0, crypto_1.randomUUID)();
        const ttlMs = Math.max(MIN_RESERVATION_TTL_MS, resolved.timeoutSeconds * 2 * 1000);
        const reserved = await this.usage.reserve(uid, date, resolved.limit, id, new Date(now.getTime() - ttlMs), now);
        if (!reserved) {
            const doc = await this.usage.get(uid, date);
            return { ok: false, code: 'QUOTA_EXHAUSTED', limit: resolved.limit, used: doc?.used ?? resolved.limit, resetAt };
        }
        return { ok: true, reservation: { uid, date, id, limit: resolved.limit, resetAt, settled: false } };
    }
    /** 成功拿到 AI 回复后确认计次（幂等），返回最新用量 */
    async confirm(reservation) {
        if (!reservation || reservation.settled)
            return null;
        reservation.settled = true;
        const now = this.clock();
        const used = reservation.id
            ? await this.usage.confirm(reservation.uid, reservation.date, reservation.id, now)
            : await this.usage.increment(reservation.uid, reservation.date, now);
        return snapshot(reservation.limit, used, reservation.resetAt);
    }
    /** 未确认的预占在请求结束时退还（幂等） */
    async release(reservation) {
        if (!reservation || reservation.settled)
            return;
        reservation.settled = true;
        if (reservation.id)
            await this.usage.release(reservation.uid, reservation.date, reservation.id);
    }
    /** 学生端状态：今日上限、已用、剩余、重置时间、是否被管理员关闭 */
    async status(uid) {
        const resolved = await this.resolve(uid);
        const now = this.clock();
        const tz = resolved.quotaConfig.timezone;
        const doc = await this.usage.get(uid, (0, timezone_1.dateKey)(tz, now));
        return {
            ...snapshot(resolved.limit, doc?.used ?? 0, (0, timezone_1.nextResetAt)(tz, now)),
            disabled: resolved.base === 0,
            timezone: tz,
        };
    }
}
exports.QuotaService = QuotaService;
//# sourceMappingURL=quotaService.js.map