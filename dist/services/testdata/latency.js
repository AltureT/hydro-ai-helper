"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TESTDATA_MODEL_TIMEOUT_MAX_SECONDS = exports.TESTDATA_MODEL_TIMEOUT_MIN_SECONDS = exports.TESTDATA_MODEL_TIMEOUT_DEFAULT_MS = void 0;
exports.getTestdataModelTimeoutMs = getTestdataModelTimeoutMs;
exports.TESTDATA_MODEL_TIMEOUT_DEFAULT_MS = 300000;
exports.TESTDATA_MODEL_TIMEOUT_MIN_SECONDS = 30;
exports.TESTDATA_MODEL_TIMEOUT_MAX_SECONDS = 1800;
function getTestdataModelTimeoutMs(raw = process.env.AI_HELPER_TESTDATA_MODEL_TIMEOUT_SECONDS) {
    if (!raw || !/^\d+$/.test(raw))
        return exports.TESTDATA_MODEL_TIMEOUT_DEFAULT_MS;
    const seconds = Number(raw);
    if (!Number.isSafeInteger(seconds)
        || seconds < exports.TESTDATA_MODEL_TIMEOUT_MIN_SECONDS
        || seconds > exports.TESTDATA_MODEL_TIMEOUT_MAX_SECONDS) {
        return exports.TESTDATA_MODEL_TIMEOUT_DEFAULT_MS;
    }
    return seconds * 1000;
}
//# sourceMappingURL=latency.js.map