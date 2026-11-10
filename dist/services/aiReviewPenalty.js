"use strict";
/**
 * AI 抽查的处罚条件与熔断（plan R15，FR-044、FR-047）。纯函数。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.REALTIME_MATCH_WINDOW_MS = void 0;
exports.decideAutoPenalty = decideAutoPenalty;
exports.touchesRealtimeDeduction = touchesRealtimeDeduction;
exports.evaluateBreaker = evaluateBreaker;
/** FR-044：全部条件满足才自动处罚；返回未满足的条件，便于测试和排查 */
function decideAutoPenalty(input) {
    const blockers = [];
    if (!input.autoPenaltyEnabled)
        blockers.push('auto_penalty_disabled');
    if (input.confidence !== 'high')
        blockers.push('not_high_confidence');
    if (!input.evidenceVerified)
        blockers.push('evidence_unverified');
    if (input.conversationAlreadyPenalized)
        blockers.push('conversation_already_penalized');
    if (input.userPenalizedToday)
        blockers.push('user_penalized_today');
    if (input.touchesRealtimeDeduction)
        blockers.push('realtime_deducted');
    return { penalize: blockers.length === 0, blockers };
}
/** 实时规则扣分与对应学生消息的时间差上限：扣分写在保存学生消息之前，二者相隔通常不到 1 秒 */
exports.REALTIME_MATCH_WINDOW_MS = 60 * 1000;
/**
 * 证据涉及的学生消息是否已被实时规则扣过分。
 * - 偏题第 2 次起的固定回复（`topicGuardBypassedLLM`）之前的那条学生消息已扣分；
 * - 或者该会话有一条实时扣分，时间与该消息相差不超过 60 秒。
 */
function touchesRealtimeDeduction(evidenceMessages, realtimeDeductionTimes) {
    return evidenceMessages.some((message) => message.followedByFixedReply
        || realtimeDeductionTimes.some((at) => Math.abs(at.getTime() - message.timestamp.getTime()) <= exports.REALTIME_MATCH_WINDOW_MS));
}
/**
 * 熔断判断（FR-047）：取最近 breakerWindow 条已复核的自动处罚，样本数 ≥ breakerMinSample
 * 且误判比例 ≥ breakerThreshold 时触发。
 */
function evaluateBreaker(reviewed, config) {
    const sample = reviewed.slice(0, config.breakerWindow);
    const falsePositives = sample.filter((item) => item.reviewStatus === 'false_positive').length;
    const rate = sample.length ? falsePositives / sample.length : 0;
    return {
        window: config.breakerWindow,
        sample: sample.length,
        falsePositives,
        rate: Math.round(rate * 10000) / 10000,
        trip: sample.length >= config.breakerMinSample && sample.length > 0 && rate >= config.breakerThreshold,
    };
}
//# sourceMappingURL=aiReviewPenalty.js.map