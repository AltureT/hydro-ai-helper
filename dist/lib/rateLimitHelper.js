"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyRateLimit = applyRateLimit;
/**
 * Apply rate limiting via HydroOJ's built-in limitRate (opcount model).
 * Returns true if the request was BLOCKED (handler should return immediately).
 * Returns false if the request is allowed to proceed.
 */
async function applyRateLimit(handler, options) {
    const { op, periodSecs, maxOps, key, failOpen = false, errorMessage = '请求太频繁，请稍后再试', } = options;
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
        if (err?.name === 'OpcountExceededError'
            || err?.constructor?.name === 'OpcountExceededError'
            || err?.code === 'OpcountExceededError'
            || (err?.status === 429)) {
            handler.response.status = 429;
            handler.response.body = {
                error: errorMessage,
                code: 'RATE_LIMIT_EXCEEDED',
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