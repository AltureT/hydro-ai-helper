"use strict";
/**
 * AI 抽查的候选会话（plan R15，FR-041）
 *
 * 过去 24 小时内：
 *   1. 规则中置信度命中所在的会话；
 *   2. 有过偏题计数的用户的会话；
 *   3. 当日或前一日用量达到其有效额度 80% 的用户的会话；
 *   4. 其余会话按比例随机抽样。
 * 按会话去重，前三类优先；超过上限时先截断随机样本，再截断前三类。
 * 数据来源通过接口注入，便于测试。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MANUAL_USER_LOOKBACK_DAYS = exports.HIGH_USAGE_RATIO = void 0;
exports.selectCandidates = selectCandidates;
exports.selectManualCandidates = selectManualCandidates;
exports.HIGH_USAGE_RATIO = 0.8;
class CandidateList {
    constructor(max) {
        this.max = max;
        this.items = [];
        this.seen = new Set();
    }
    get full() {
        return this.items.length >= this.max;
    }
    get ids() {
        return [...this.seen];
    }
    add(conversations, reason) {
        for (const conversation of conversations) {
            if (this.full)
                return;
            const key = String(conversation.conversationId);
            if (this.seen.has(key))
                continue;
            this.seen.add(key);
            this.items.push({ ...conversation, reason });
        }
    }
}
/** 每日批次与“立即抽查一次”的候选 */
async function selectCandidates(sources, options) {
    const max = Math.max(0, Math.floor(options.max));
    const list = new CandidateList(max);
    if (!max)
        return list.items;
    const [medium, offTopicUids, highUsageUids] = await Promise.all([
        sources.mediumConfidenceConversations(options.since),
        sources.offTopicUsers(options.since),
        sources.highUsageUsers(exports.HIGH_USAGE_RATIO),
    ]);
    list.add(medium, 'medium_confidence');
    if (!list.full && offTopicUids.length) {
        list.add(await sources.conversationsOfUsers(offTopicUids, options.since, max), 'off_topic');
    }
    if (!list.full && highUsageUids.length) {
        list.add(await sources.conversationsOfUsers(highUsageUids, options.since, max), 'high_usage');
    }
    const rate = Math.min(1, Math.max(0, options.sampleRate));
    if (!list.full && rate > 0) {
        const total = await sources.countConversations(options.since);
        const sampleSize = Math.min(max - list.items.length, Math.round(total * rate));
        if (sampleSize > 0) {
            list.add(await sources.sampleConversations(options.since, sampleSize, list.ids), 'sample');
        }
    }
    return list.items;
}
/** 手动指定学生或会话：学生取最近 7 天的会话 */
exports.MANUAL_USER_LOOKBACK_DAYS = 7;
async function selectManualCandidates(sources, scope, now, max) {
    const list = new CandidateList(Math.max(0, Math.floor(max)));
    if (scope.conversationIds?.length) {
        list.add(await sources.conversationsByIds(scope.conversationIds), 'manual');
    }
    if (!list.full && scope.uids?.length) {
        const since = new Date(now.getTime() - exports.MANUAL_USER_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
        list.add(await sources.conversationsOfUsers(scope.uids, since, max), 'manual');
    }
    return list.items;
}
//# sourceMappingURL=aiReviewCandidates.js.map