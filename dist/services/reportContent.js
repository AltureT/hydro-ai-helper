"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reportContent = reportContent;
const reportMarkdown_1 = require("../utils/reportMarkdown");
/** Remove provider metadata and normalize report headings before persistence. */
function reportContent(content) {
    const result = (0, reportMarkdown_1.normalizeReportMarkdown)(content);
    if (!result.trim())
        throw new Error('Model returned an empty report');
    return result;
}
//# sourceMappingURL=reportContent.js.map