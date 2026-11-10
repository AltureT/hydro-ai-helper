"use strict";
/**
 * 学生端次数状态（FR-019，plan R18）
 * GET /ai-helper/quota-status
 *
 * 返回当前用户今日的上限、已用、剩余、重置时间，以及是否被管理员关闭。次数按用户跨域合计。
 * credit：信誉系数是否降低、预计恢复时间、近期扣分的违规类别和时间及申诉入口（FR-034，不含规则细节）。
 * notices：尚未确认的 AI 抽查处罚通知（FR-046）；POST /ai-helper/quota-status/notices/:id/ack 确认。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.QuotaStatusHandlerPriv = exports.QuotaNoticeAckHandler = exports.QuotaStatusHandler = void 0;
const hydrooj_1 = require("hydrooj");
const csrfHelper_1 = require("../lib/csrfHelper");
const mongo_1 = require("../utils/mongo");
class QuotaStatusHandler extends hydrooj_1.Handler {
    async get() {
        try {
            const quotaService = this.ctx.get('quotaService');
            const uid = Number(this.user._id);
            const creditService = this.ctx.get('creditService');
            const [status, credit, notices] = await Promise.all([
                quotaService.status(uid),
                creditService ? creditService.studentStatus(uid).catch((err) => {
                    console.warn('[AI Helper] 读取信誉状态失败:', err instanceof Error ? err.message : 'unknown');
                    return null;
                }) : Promise.resolve(null),
                creditService && typeof creditService.reviewNotices === 'function'
                    ? creditService.reviewNotices(uid).catch((err) => {
                        console.warn('[AI Helper] 读取抽查通知失败:', err instanceof Error ? err.message : 'unknown');
                        return [];
                    })
                    : Promise.resolve([]),
            ]);
            this.response.body = { ...status, credit, notices };
            this.response.type = 'application/json';
        }
        catch (err) {
            console.error('[AI Helper] QuotaStatusHandler error:', err instanceof Error ? err.message : 'unknown');
            this.response.status = 500;
            this.response.body = { error: this.translate('ai_helper_quota_status_failed'), code: 'QUOTA_STATUS_FAILED' };
            this.response.type = 'application/json';
        }
    }
}
exports.QuotaStatusHandler = QuotaStatusHandler;
/** 学生确认 AI 抽查处罚通知（只能确认本人的） */
class QuotaNoticeAckHandler extends hydrooj_1.Handler {
    async post({ id }) {
        if ((0, csrfHelper_1.rejectIfCsrfInvalid)(this))
            return;
        const noticeId = String(id || '');
        const creditService = this.ctx.get('creditService');
        if (!mongo_1.ObjectId.isValid(noticeId) || !creditService) {
            this.response.status = 404;
            this.response.body = { error: this.translate('ai_helper_review_notice_not_found'), code: 'NOTICE_NOT_FOUND' };
            this.response.type = 'application/json';
            return;
        }
        try {
            const ok = await creditService.ackReviewNotice(new mongo_1.ObjectId(noticeId), Number(this.user._id));
            if (!ok) {
                this.response.status = 404;
                this.response.body = { error: this.translate('ai_helper_review_notice_not_found'), code: 'NOTICE_NOT_FOUND' };
            }
            else {
                this.response.body = { success: true };
            }
            this.response.type = 'application/json';
        }
        catch (err) {
            console.error('[AI Helper] QuotaNoticeAckHandler error:', err instanceof Error ? err.message : 'unknown');
            this.response.status = 500;
            this.response.body = { error: this.translate('ai_helper_review_notice_ack_failed'), code: 'NOTICE_ACK_FAILED' };
            this.response.type = 'application/json';
        }
    }
}
exports.QuotaNoticeAckHandler = QuotaNoticeAckHandler;
exports.QuotaStatusHandlerPriv = hydrooj_1.PRIV.PRIV_USER_PROFILE;
//# sourceMappingURL=quotaStatusHandler.js.map