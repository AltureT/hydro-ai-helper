"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyRateLimit = applyRateLimit;
/**
 * Apply rate limiting via HydroOJ's built-in limitRate (opcount model).
 * Returns true if the request was BLOCKED (handler should return immediately).
 * Returns false if the request is allowed to proceed.
 */
async function applyRateLimit(handler, options) {
    const { op, periodSecs, maxOps, key, failOpen = false, errorMessage = 'ai_helper_err_rate_limited', } = options;
    try {
        if (key) {
            await handler.limitRate(op, periodSecs, maxOps, key);
        }
        else {
            await handler.limitRate(op, periodSecs, maxOps);
        }
        return false;
    }
    catch (err) {
        // HydroOJ throws an error with name 'OpcountExceededError' or
        // an error whose constructor name matches when opcount is exceeded.
        // The error may also be identified by its status code (429) or code property.
        const e = err;
        if (e?.name === 'OpcountExceededError'
            || e?.constructor?.name === 'OpcountExceededError'
            || e?.code === 'OpcountExceededError'
            || (e?.status === 429)) {
            handler.response.status = 429;
            handler.response.body = {
                error: handler.translate(errorMessage),
                code: 'RATE_LIMIT_EXCEEDED',
                category: 'rate_limit',
                retryable: true,
            };
            handler.response.type = 'application/json';
            return true;
        }
        // Unexpected error (e.g., DB failure)
        if (failOpen) {
            console.warn(`[RateLimit] ${op}: DB error, fail-open`, err);
            return false;
        }
        // fail-closed: re-throw so the handler's outer catch returns 503
        throw err;
    }
}
//# sourceMappingURL=rateLimitHelper.js.map