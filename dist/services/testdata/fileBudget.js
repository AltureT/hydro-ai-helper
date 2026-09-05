"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GENERATOR_REPLAY_DATA_FILENAME = exports.TESTDATA_PLAN_MAX_BYTES = exports.TESTDATA_INPUT_MAX_BYTES = exports.TESTDATA_CODE_FILE_MAX_BYTES = void 0;
exports.testdataFileByteLimit = testdataFileByteLimit;
exports.assertTestdataPlanBudget = assertTestdataPlanBudget;
const failures_1 = require("./failures");
exports.TESTDATA_CODE_FILE_MAX_BYTES = 256 * 1024;
exports.TESTDATA_INPUT_MAX_BYTES = 4 * 1024 * 1024;
exports.TESTDATA_PLAN_MAX_BYTES = 8 * 1024 * 1024;
exports.GENERATOR_REPLAY_DATA_FILENAME = 'generator-data.b64';
/** The larger allowance is for data, never for model-generated executable code. */
function testdataFileByteLimit(name) {
    return name.endsWith('.in') || name === exports.GENERATOR_REPLAY_DATA_FILENAME
        ? exports.TESTDATA_INPUT_MAX_BYTES : exports.TESTDATA_CODE_FILE_MAX_BYTES;
}
function assertTestdataPlanBudget(plan) {
    let total = 0;
    for (const file of plan.files) {
        const content = file.content.replace(/\r\n?/g, '\n');
        const bytes = Buffer.byteLength(content, 'utf8') + (content.endsWith('\n') ? 0 : 1);
        const maxBytes = testdataFileByteLimit(file.name);
        if (bytes > maxBytes) {
            throw new failures_1.TestdataPipelineError('生成文件超过对应类型的大小上限', 'GENERATOR_OUTPUT_TOO_LARGE', 'generator', 'generator', 'manual-review', { actualBytes: bytes, maxBytes });
        }
        total += bytes;
    }
    // Leave headroom under MongoDB's document limit for job/checkpoint metadata.
    if (total > exports.TESTDATA_PLAN_MAX_BYTES || Buffer.byteLength(JSON.stringify(plan), 'utf8') > 12 * 1024 * 1024) {
        throw new failures_1.TestdataPipelineError('生成计划超过总量或序列化大小上限，未缩减测试覆盖', 'GENERATOR_OUTPUT_TOO_LARGE', 'generator', 'generator', 'manual-review', { actualBytes: total, maxBytes: exports.TESTDATA_PLAN_MAX_BYTES });
    }
}
//# sourceMappingURL=fileBudget.js.map