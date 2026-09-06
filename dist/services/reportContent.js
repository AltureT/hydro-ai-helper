"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reportContent = reportContent;
/** Remove the provider's leading reasoning wrapper, preserving report code/text. */
function reportContent(content) {
    let result = content;
    while (/^\s*<think>/i.test(result)) {
        const end = result.search(/<\/think>/i);
        if (end < 0)
            throw new Error('Model returned an incomplete reasoning block without a report');
        result = result.slice(end + '</think>'.length).trimStart();
    }
    if (!result.trim())
        throw new Error('Model returned an empty report');
    return result;
}
//# sourceMappingURL=reportContent.js.map