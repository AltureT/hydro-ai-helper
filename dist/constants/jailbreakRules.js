"use strict";
/**
 * 系统内置的越狱关键词/正则
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBuiltinJailbreakPatterns = exports.builtinJailbreakPatternSources = void 0;
const BUILTIN_PATTERNS = [
    /忽略(之前|上文|所有).*提示/gi,
    /ignore (all|previous|earlier) (instructions|messages|prompts)/gi,
    /(从现在开始|现在起?).*(你是|扮演).*(猫娘|女仆|主人|角色|人格)/gi,
    /重置(设定|設定|系统|system)/gi,
    /system prompt/gi,
    /无条件服从/gi,
    /覆盖(系统|所有)提示/gi,
    /现在你是.*系统/gi,
    /(前面|上述|上面).*(规则|说明|内容).*(视为|看作).*(参考|示例|背景)/gi,
    /(这些|那些).*(规则|要求).*(只是|仅仅是).*(参考|建议)/gi,
    /(后续|接下来|在.*回答中).*(遇到|如果).*(冲突|不一致).*(优先|首先).*(执行|遵守).*(当前|本段|下面|以下).*(规则|内容)/gi,
    /如果.*(冲突|矛盾).*(请|就).*(以.*(为准|为先|为主))/gi,
    /(满足|服从).*(用户|我).*(最新|当前).*(请求|需求).*(视为|看作).*(最高优先级|第一优先)/gi,
    /(treat|treated)\s+as\s+(reference|background)(\s+only)?/gi,
    /(this|the following).*(takes?|take)\s+precedence/gi,
    /in\s+case\s+of\s+conflict.*(follow|use)\s+(this|the following)/gi,
    /user('?s)?\s+latest\s+(request|instruction).*(highest\s+priority)/gi,
    // 直接索要答案
    /直接给[我出]?.*?(答案|代码|solution)/gi,
    /给我完整.*?代码/gi,
    /不要.*?教学模式/gi,
    /把(完整|全部).*?(代码|答案|solution).*?(给|发|写|输出)/gi,
    // DAN / 越狱
    /\bDAN\b/g,
    /\bdo anything now\b/gi,
    /developer mode/gi,
    /\bjailbreak\b/gi,
    // 角色标签伪造
    /\[(AI导师|系统|assistant)\]\s*[:：]/gi,
    // 编码绕过
    /(base64|decode|eval)\s*[:：(（]/gi,
    /解码.*?以下/gi,
    // System prompt 泄露
    /输出.*?系统.*?提示词/gi,
    /(show|print|output|reveal).*?system.*?prompt/gi,
];
exports.builtinJailbreakPatternSources = BUILTIN_PATTERNS.map((pattern) => pattern.source);
const getBuiltinJailbreakPatterns = () => BUILTIN_PATTERNS.map((pattern) => new RegExp(pattern.source, pattern.flags));
exports.getBuiltinJailbreakPatterns = getBuiltinJailbreakPatterns;
//# sourceMappingURL=jailbreakRules.js.map