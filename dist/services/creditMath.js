"use strict";
/**
 * 信誉系数计算（纯函数，plan R8）
 *
 * 差距 gap = 1 − m。按时间顺序处理事件：
 *   - 每条事件前先恢复：gap ← max(0, gap − 每日恢复量 × Δt 天)
 *   - 扣分：gap ← min(1 − 下限, gap + 扣分)
 *   - 重置：gap ← 0
 * 当前系数 m = 1 − max(0, gap − 每日恢复量 × (now − 最后事件) 天)。
 * 已撤销的扣分不参与计算，所以撤销后从下一次读取起按剩余记录重新计算（FR-031）。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DAY_MS = void 0;
exports.computeCredit = computeCredit;
exports.realtimeDeduction = realtimeDeduction;
exports.DAY_MS = 24 * 60 * 60 * 1000;
function round4(value) {
    return Math.round(value * 10000) / 10000;
}
function computeCredit(events, params, now) {
    const maxGap = Math.max(0, 1 - Math.min(1, Math.max(0, params.floor)));
    const rate = Math.max(0, params.recoveryPerDay);
    const sorted = events
        .filter((event) => !event.revokedAt && event.at.getTime() <= now.getTime())
        // 同一时刻的扣分先于重置处理：重置清除它之前（含同时）的扣分
        .sort((a, b) => a.at.getTime() - b.at.getTime() || (a.type === b.type ? 0 : a.type === 'reset' ? 1 : -1));
    let gap = 0;
    let last = null;
    for (const event of sorted) {
        if (last)
            gap = Math.max(0, gap - rate * ((event.at.getTime() - last.getTime()) / exports.DAY_MS));
        if (event.type === 'reset')
            gap = 0;
        else
            gap = Math.min(maxGap, gap + Math.max(0, event.deduction || 0));
        last = event.at;
    }
    if (last)
        gap = Math.max(0, gap - rate * ((now.getTime() - last.getTime()) / exports.DAY_MS));
    gap = round4(gap);
    const recoveryAt = gap > 0 && rate > 0 ? new Date(now.getTime() + Math.ceil((gap / rate) * exports.DAY_MS)) : null;
    return { m: round4(1 - gap), gap, recoveryAt };
}
/** 实时规则的扣分：类别基础分 × 2^(k−1)，单次最多 maxDeduction（FR-029） */
function realtimeDeduction(weight, k, maxDeduction) {
    const times = Math.max(1, Math.floor(k));
    return round4(Math.min(Math.max(0, maxDeduction), Math.max(0, weight) * 2 ** (times - 1)));
}
//# sourceMappingURL=creditMath.js.map