"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FeedbackHandlerPriv = exports.FeedbackHandler = void 0;
const hydrooj_1 = require("hydrooj");
const csrfHelper_1 = require("../lib/csrfHelper");
const i18nHelper_1 = require("../utils/i18nHelper");
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
                this.response.body = { error: this.translate('ai_helper_feedback_invalid_type'), code: 'INVALID_TYPE' };
                this.response.type = 'application/json';
                return;
            }
            if (!subject || typeof subject !== 'string' || subject.trim().length === 0) {
                this.response.status = 400;
                this.response.body = { error: this.translate('ai_helper_feedback_subject_required'), code: 'SUBJECT_REQUIRED' };
                this.response.type = 'application/json';
                return;
            }
            if (subject.length > MAX_SUBJECT_LENGTH) {
                this.response.status = 400;
                this.response.body = { error: (0, i18nHelper_1.translateWithParams)(this, 'ai_helper_feedback_subject_too_long', MAX_SUBJECT_LENGTH), code: 'SUBJECT_TOO_LONG' };
                this.response.type = 'application/json';
                return;
            }
            const bodyText = typeof feedbackBody === 'string' ? feedbackBody : '';
            if (bodyText.length > MAX_BODY_LENGTH) {
                this.response.status = 400;
                this.response.body = { error: (0, i18nHelper_1.translateWithParams)(this, 'ai_helper_feedback_body_too_long', MAX_BODY_LENGTH), code: 'BODY_TOO_LONG' };
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
                this.response.body = { success: true, message: this.translate('ai_helper_feedback_success') };
            }
            else {
                this.response.status = 502;
                this.response.body = { success: false, error: this.translate('ai_helper_feedback_submit_failed'), code: 'FEEDBACK_SUBMIT_FAILED' };
            }
            this.response.type = 'application/json';
        }
        catch (err) {
            console.error('[FeedbackHandler] Error:', err);
            this.response.status = 500;
            this.response.body = { error: this.translate('ai_helper_feedback_failed'), code: 'FEEDBACK_FAILED' };
            this.response.type = 'application/json';
        }
    }
}
exports.FeedbackHandler = FeedbackHandler;
exports.FeedbackHandlerPriv = hydrooj_1.PRIV.PRIV_EDIT_SYSTEM;
//# sourceMappingURL=feedbackHandler.js.map