"use strict";
/**
 * QuotaService - 每日 AI 次数（US2、US3）
 *
 * 解析有效额度 → 预占 → 确认 / 退还，并提供学生端状态与管理端的额度来源说明（explain）。
 * 额度组、个人覆盖、信誉系数通过 QuotaPolicySources 接入。
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
    memberships(uid) {
        return this.sources.getGroupMemberships ? this.sources.getGroupMemberships(uid) : Promise.resolve([]);
    }
    multiplier(uid, now) {
        return this.sources.getCreditMultiplier ? this.sources.getCreditMultiplier(uid, now) : Promise.resolve(1);
    }
    build(override, groups, m, quotaConfig, now) {
        const defaultLimit = (0, quotaPolicy_1.defaultLimitFromConfig)(quotaConfig.dailyMessageLimit);
        const result = (0, quotaPolicy_1.explainBase)(override, groups, defaultLimit, now);
        return {
            limit: (0, quotaPolicy_1.effective)(result.base, m, quotaConfig.guaranteeCount),
            base: result.base,
            source: result.source,
            capped: result.capped,
            disabled: result.base === 0,
            defaultLimit,
            guaranteeCount: quotaConfig.guaranteeCount,
            m,
            override: override ? { ...override, active: (0, quotaPolicy_1.isOverrideActive)(override, now) } : null,
            groups: groups.map((group) => ({
                ...group,
                applied: group.id === result.grantGroupId || group.id === result.capGroupId,
            })),
        };
    }
    /** 解析用户当前的有效额度；传入已读取的配置可省去一次查询 */
    async resolve(uid, config) {
        const cfg = config === undefined ? await this.configModel.getConfig() : config;
        const quotaConfig = (0, configSections_1.normalizeQuotaConfig)(cfg?.quotaConfig);
        const now = this.clock();
        const [override, groups, m] = await Promise.all([
            this.sources.getOverride ? this.sources.getOverride(uid, now) : Promise.resolve(null),
            this.memberships(uid),
            this.multiplier(uid, now),
        ]);
        const explained = this.build(override, groups, m, quotaConfig, now);
        return {
            limit: explained.limit,
            base: explained.base,
            source: explained.source,
            capped: explained.capped,
            m,
            quotaConfig,
            timeoutSeconds: cfg?.timeoutSeconds || 30,
        };
    }
    /** 管理端：一个用户的有效额度、来源与今日用量（FR-026） */
    async explain(uid) {
        const result = await this.explainMany([uid]);
        return result.get(uid);
    }
    /** 管理端批量版本（学生总览一页最多 50 人）：覆盖与用量各一次批量查询 */
    async explainMany(uids) {
        const out = new Map();
        if (!uids.length)
            return out;
        const cfg = await this.configModel.getConfig();
        const quotaConfig = (0, configSections_1.normalizeQuotaConfig)(cfg?.quotaConfig);
        const now = this.clock();
        const tz = quotaConfig.timezone;
        const date = (0, timezone_1.dateKey)(tz, now);
        const resetAt = (0, timezone_1.nextResetAt)(tz, now).toISOString();
        const overridesPromise = this.sources.getOverrides
            ? this.sources.getOverrides(uids, now)
            : Promise.all(uids.map(async (uid) => [uid, this.sources.getOverride ? await this.sources.getOverride(uid, now) : null]))
                .then((pairs) => new Map(pairs.filter((pair) => !!pair[1])));
        const multipliersPromise = this.sources.getCreditMultipliers
            ? this.sources.getCreditMultipliers(uids, now)
            : Promise.all(uids.map(async (uid) => [uid, await this.multiplier(uid, now)])).then((pairs) => new Map(pairs));
        const [overrides, usage, perUser, multipliers] = await Promise.all([
            overridesPromise,
            this.usage.getMany(uids, date),
            Promise.all(uids.map(async (uid) => ({ uid, groups: await this.memberships(uid) }))),
            multipliersPromise,
        ]);
        for (const { uid, groups } of perUser) {
            const m = multipliers.get(uid) ?? 1;
            const explained = this.build(overrides.get(uid) || null, groups, m, quotaConfig, now);
            const used = usage.get(uid)?.used ?? 0;
            out.set(uid, {
                ...explained,
                used,
                remaining: explained.limit === null ? null : Math.max(0, explained.limit - used),
                resetAt,
                timezone: tz,
            });
        }
        return out;
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
            base: resolved.base,
            disabled: resolved.base === 0,
            timezone: tz,
        };
    }
}
exports.QuotaService = QuotaService;
//# sourceMappingURL=quotaService.js.map