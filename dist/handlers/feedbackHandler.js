"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FeedbackHandlerPriv = exports.FeedbackHandler = void 0;
const hydrooj_1 = require("hydrooj");
const csrfHelper_1 = require("../lib/csrfHelper");
const VALID_TYPES = new Set(['bug', 'feature', 'other']);
const MAX_SUBJECT_LENGTH = 200;
const MAX_BODY_LENGTH = 2000;
class FeedbackHandler extends hydrooj_1.Handler {
    async post() {
        try {
            if ((0, csrfHelper_1.rejectIfCsrfInvalid)(this))
                return;
            const { type, subject, body: feedbackBody, contactEmail } = this.request.body;
            if (!type || !VALID_TYPES.has(type)) {
                this.response.status = 400;
                this.response.body = { error: '反馈类型必须为 bug、feature 或 other' };
                this.response.type = 'application/json';
                return;
            }
            if (!subject || typeof subject !== 'string' || subject.trim().length === 0) {
                this.response.status = 400;
                this.response.body = { error: '请填写反馈主题' };
                this.response.type = 'application/json';
                return;
            }
            if (subject.length > MAX_SUBJECT_LENGTH) {
                this.response.status = 400;
                this.response.body = { error: `主题不能超过 ${MAX_SUBJECT_LENGTH} 字符` };
                this.response.type = 'application/json';
                return;
            }
            const bodyText = typeof feedbackBody === 'string' ? feedbackBody : '';
            if (bodyText.length > MAX_BODY_LENGTH) {
                this.response.status = 400;
                this.response.body = { error: `描述不能超过 ${MAX_BODY_LENGTH} 字符` };
                this.response.type = 'application/json';
                return;
            }
            // Sanitize: strip control characters
            // eslint-disable-next-line no-control-regex
            const sanitize = (s) => s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim();
            const payload = {
                type: type,
                subject: sanitize(subject),
                body: sanitize(bodyText),
                contact_email: contactEmail ? sanitize(contactEmail).slice(0, 200) : undefined,
            };
            const telemetryService = this.ctx.get('telemetryService');
            const success = await telemetryService.reportFeedback(payload);
            if (success) {
                this.response.body = { success: true, message: '反馈已提交，感谢您的意见！' };
            }
            else {
                this.response.status = 502;
                this.response.body = { success: false, error: '反馈提交失败，请稍后再试' };
            }
            this.response.type = 'application/json';
        }
        catch (err) {
            console.error('[FeedbackHandler] Error:', err);
            this.response.status = 500;
            this.response.body = { error: '提交反馈失败' };
            this.response.type = 'application/json';
        }
    }
}
exports.FeedbackHandler = FeedbackHandler;
exports.FeedbackHandlerPriv = hydrooj_1.PRIV.PRIV_EDIT_SYSTEM;
//# sourceMappingURL=feedbackHandler.js.map