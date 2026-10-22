"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.REPORT_CHAT_OPTIONS = void 0;
exports.reportContent = reportContent;
const reportMarkdown_1 = require("../utils/reportMarkdown");
/** Remove provider metadata and normalize report headings before persistence. */
function reportContent(content) {
    const result = (0, reportMarkdown_1.normalizeReportMarkdown)(content);
    if (!result.trim())
        throw new Error('Model returned an empty report');
    return result;
}
// Reports need room for both reasoning and the final answer. Let the provider
// choose its model default instead of inheriting the 4096-token chat limit.
// Keep the configured endpoint timeout and the existing bounded retries.
exports.REPORT_CHAT_OPTIONS = { contentMode: 'report', maxTokens: null };
//# sourceMappingURL=reportContent.js.map