"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveProblemContent = resolveProblemContent;
exports.resolveProblemContents = resolveProblemContents;
/**
 * 题面读取兼容（HydroOJ 4.x / 5.x）
 *
 * Hydro 5 把题面迁到 `problem.statement` 集合，新建题目或保存题面时会把
 * `document.content` 写成空串；升级前未再编辑过的题目仍保留旧 `content`。
 * 因此只有 `content` 为空时才需要回退到 `ProblemModel.getStatements()`
 * （Hydro 5 才有该方法，Hydro 4 上保持原行为）。
 */
const hydrooj_1 = require("hydrooj");
/**
 * 返回 Hydro 4 形态的题面 `content`：已有值原样返回；否则读取 Hydro 5 的内联题面，
 * 单语言返回 Markdown 字符串，多语言返回 `{lang: content}` JSON 字符串，
 * 与旧版多语言题面格式一致。仅有文件（如 PDF）的题面没有文本，会被跳过。
 */
async function resolveProblemContent(pdoc, domainId) {
    const stored = pdoc.content;
    if (stored)
        return stored;
    const getStatements = hydrooj_1.ProblemModel?.getStatements;
    if (typeof getStatements !== 'function' || typeof pdoc.docId !== 'number')
        return stored ?? '';
    try {
        // 投影可能未包含 domainId，getStatements 需要它定位 problem.statement
        const entries = await getStatements.call(hydrooj_1.ProblemModel, { ...pdoc, domainId: pdoc.domainId || domainId });
        const byLang = new Map();
        for (const entry of entries || []) {
            if (typeof entry?.content !== 'string' || !entry.content.trim())
                continue;
            const lang = typeof entry.lang === 'string' && entry.lang ? entry.lang : 'default';
            if (!byLang.has(lang))
                byLang.set(lang, entry.content);
        }
        if (byLang.size === 0)
            return stored ?? '';
        if (byLang.size === 1)
            return byLang.values().next().value;
        return JSON.stringify(Object.fromEntries(byLang));
    }
    catch (err) {
        console.warn('[AI-Helper] 读取题面失败，按空题面处理:', err instanceof Error ? err.message : String(err));
        return stored ?? '';
    }
}
/** 批量版本：就地补全直接从 `document` 集合读出的题目文档的 `content`。 */
async function resolveProblemContents(docs, domainId) {
    await Promise.all(docs.map(async (doc) => {
        if (doc.content)
            return;
        const content = await resolveProblemContent(doc, domainId);
        if (content)
            doc.content = content;
    }));
    return docs;
}
//# sourceMappingURL=problemStatement.js.map