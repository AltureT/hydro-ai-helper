"use strict";
/**
 * 输出安全后处理服务
 * 轻量级 AI 回复清洗，不依赖 LLM 二次调用
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.OutputSafetyService = void 0;
// 常见跑题关键词词典（游戏名、动漫名等热门内容）
const OFF_TOPIC_KEYWORDS = [
    // 游戏
    '原神', '崩坏', '王者荣耀', '英雄联盟', 'LOL', '我的世界', 'Minecraft',
    '绝地求生', 'PUBG', '使命召唤', '堡垒之夜', 'Fortnite', '明日方舟',
    '光遇', '蛋仔派对', '和平精英', '第五人格', '阴阳师', '梦幻西游',
    '穿越火线', 'CSGO', 'CS2', 'Dota', '星穹铁道', '鸣潮', '绝区零',
    // 动漫/影视
    '海贼王', '火影忍者', '进击的巨人', '鬼灭之刃', '咒术回战',
    '间谍过家家', '龙珠', '名侦探柯南', '死神', '银魂',
    '刀剑神域', '一拳超人', '全职猎人', '东京喰种', '约会大作战',
    // 社交/娱乐
    '抖音', 'TikTok', 'B站', '快手', '微博', '小红书',
    // 网络用语/角色扮演
    '猫娘', '女仆', 'AI女友', '恋爱'
];
const CODE_BLOCK_REGEX = /```([\w+#.-]*)[^\n]*\n?([\s\S]*?)```/g;
const CODE_LINE_PATTERN = /^\s*(?:def\s|class\s|for\s*\(?|while\s*\(?|if\s*\(?|elif\s|else\s*[:{]|try\s*[:{]|except\b|return\b|print\s*\(|input\s*\(|import\s|from\s|raise\s|with\s|yield\b|assert\b|break\b|continue\b|pass\b|#include\b|using\s+namespace\b|(?:int|long|double|float|char|bool|string|void|auto|vector|map|set|queue|stack)\s+[A-Za-z_]\w*|public\s+static\s+void\s+main|System\.out\.|Scanner\s+|std::|cin\s*>>|cout\s*<<|[A-Za-z_]\w*\s*=\s*[^=])/;
const CODE_LEAK_THRESHOLD = 5;
class OutputSafetyService {
    sanitize(aiResponse, options) {
        const { problemTitle, problemContent } = options;
        // 构建白名单：题目标题和内容中出现的关键词不需要过滤
        const whitelist = new Set();
        const whitelistSource = [problemTitle, problemContent].filter(Boolean).join(' ');
        let rewritten = false;
        let result = aiResponse;
        for (const keyword of OFF_TOPIC_KEYWORDS) {
            if (whitelistSource.includes(keyword)) {
                whitelist.add(keyword);
                continue;
            }
            // 检测 AI 回复中是否包含跑题关键词
            if (result.includes(keyword)) {
                result = result.split(keyword).join(options.offTopicReplacement || '该话题');
                rewritten = true;
            }
        }
        // 如果是 clarify 回复且被改写、且完全无编程关键词，替换为安全模板
        if (options.questionType === 'clarify' && rewritten) {
            const hasProgrammingContent = /(?:代码|函数|变量|循环|数组|列表|算法|排序|递归|栈|队列|二叉树|图|dp|dfs|bfs|print|if|for|while|def|class|return|import|int|str|float|input|output)/i.test(result);
            if (!hasProgrammingContent) {
                result = '这个内容与编程学习无关，我无法解释。请选中 AI 回复中与代码或算法相关的部分来追问。';
                rewritten = true;
                return { content: result, rewritten, replacementKey: 'ai_helper_err_clarify_off_topic' };
            }
        }
        // 代码泄露检测：所有问题类型均执行，optimize 也不能返回可直接提交的完整实现。
        const codeLeakResult = this.detectCodeLeak(result, options.codeTruncatedComment, options.solutionBlockedMessage);
        if (codeLeakResult.detected) {
            result = codeLeakResult.content;
            rewritten = true;
        }
        return { content: result, rewritten, codeLeakDetected: codeLeakResult.detected };
    }
    detectCodeLeak(content, truncatedComment, solutionBlockedMessage) {
        let detected = false;
        const replacement = solutionBlockedMessage
            || truncatedComment
            || '完整实现已隐藏。请贴出你当前的代码或说明卡住的步骤，我会给你下一条提示。';
        const result = content.replace(CODE_BLOCK_REGEX, (match, language, codeContent) => {
            const lines = codeContent.split('\n');
            const realCodeLines = this.getCodeLines(lines);
            if (realCodeLines.length > CODE_LEAK_THRESHOLD || this.looksLikeCompleteSolution(codeContent)) {
                detected = true;
                const label = language ? ` (${language})` : '';
                return `> ${replacement}${label}`;
            }
            return match;
        });
        // 检查未使用 Markdown 围栏的可运行代码。若已构成完整解答，整体替换，
        // 避免只删部分行后仍泄露关键填空或算法实现。
        const withoutFencedBlocks = content.replace(CODE_BLOCK_REGEX, '');
        const unfencedCodeLines = this.getCodeLines(withoutFencedBlocks.split('\n'));
        if (unfencedCodeLines.length > CODE_LEAK_THRESHOLD || this.looksLikeCompleteSolution(withoutFencedBlocks)) {
            return { content: replacement, detected: true };
        }
        return { content: result, detected };
    }
    getCodeLines(lines) {
        return lines.filter((line) => {
            const trimmed = line.trim();
            if (!trimmed)
                return false;
            if (trimmed.startsWith('//'))
                return false;
            if (trimmed.startsWith('#') && !trimmed.startsWith('#include'))
                return false;
            return CODE_LINE_PATTERN.test(line);
        });
    }
    looksLikeCompleteSolution(content) {
        const hasEntryPoint = /(?:\bdef\s+solve\s*\(|\bint\s+main\s*\(|public\s+static\s+void\s+main\s*\()/i.test(content);
        const hasInput = /(?:\binput\s*\(|\bcin\s*>>|\bScanner\s*\(|\.next(?:Int|Long|Line)?\s*\()/i.test(content);
        const hasOutput = /(?:\bprint\s*\(|\bcout\s*<<|System\.out\.(?:print|println)\s*\()/i.test(content);
        return hasEntryPoint && hasInput && hasOutput;
    }
}
exports.OutputSafetyService = OutputSafetyService;
//# sourceMappingURL=outputSafetyService.js.map