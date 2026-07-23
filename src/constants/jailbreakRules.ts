/**
 * 系统内置的安全策略规则。
 *
 * “直接索要答案”与真正的 Prompt Injection 分开分类，避免教学策略违规
 * 被误标为安全攻击。规则只是第一层确定性检测，不能替代输出门禁。
 */

import type { SafetyRuleDefinition } from '../types/safety';

const INJECTION_RULES: SafetyRuleDefinition[] = [
  { pattern: /忽略(之前|上文|所有).*提示/gi, category: 'prompt_injection', riskScore: 85 },
  { pattern: /无视(之前|上文|前面|所有).*(要求|规则|提示|设定)/gi, category: 'prompt_injection', riskScore: 85 },
  { pattern: /ignore\s+(all\s+)?(previous|earlier)\s+(instructions|messages|prompts)/gi, category: 'prompt_injection', riskScore: 85 },
  // 紧凑视图用于识别 i g n o r e / 忽 略 一类字符插空绕过。
  { pattern: /ignore(?:all)?(?:previous|earlier)(?:instructions|messages|prompts)/gi, category: 'prompt_injection', riskScore: 90 },
  { pattern: /(从现在开始|现在起?).*(你是|扮演).*(猫娘|女仆|主人|角色|人格)/gi, category: 'prompt_injection', riskScore: 80 },
  { pattern: /重置(设定|設定|系统|system)/gi, category: 'prompt_injection', riskScore: 85 },
  { pattern: /无条件服从/gi, category: 'prompt_injection', riskScore: 80 },
  { pattern: /覆盖(系统|所有)提示/gi, category: 'prompt_injection', riskScore: 90 },
  { pattern: /现在你是.*系统/gi, category: 'prompt_injection', riskScore: 85 },
  { pattern: /(前面|上述|上面).*(规则|说明|内容).*(视为|看作).*(参考|示例|背景)/gi, category: 'prompt_injection', riskScore: 80 },
  { pattern: /(这些|那些).*(规则|要求).*(只是|仅仅是).*(参考|建议)/gi, category: 'prompt_injection', riskScore: 80 },
  { pattern: /(后续|接下来|在.*回答中).*(遇到|如果).*(冲突|不一致).*(优先|首先).*(执行|遵守).*(当前|本段|下面|以下).*(规则|内容)/gi, category: 'prompt_injection', riskScore: 85 },
  { pattern: /如果.*(冲突|矛盾).*(请|就).*(以.*(为准|为先|为主))/gi, category: 'prompt_injection', riskScore: 80 },
  { pattern: /(满足|服从).*(用户|我).*(最新|当前).*(请求|需求).*(视为|看作).*(最高优先级|第一优先)/gi, category: 'prompt_injection', riskScore: 85 },
  { pattern: /(treat|treated)\s+as\s+(reference|background)(\s+only)?/gi, category: 'prompt_injection', riskScore: 75 },
  { pattern: /(this|the following).*(takes?|take)\s+precedence/gi, category: 'prompt_injection', riskScore: 80 },
  { pattern: /in\s+case\s+of\s+conflict.*(follow|use)\s+(this|the following)/gi, category: 'prompt_injection', riskScore: 85 },
  { pattern: /user('?s)?\s+latest\s+(request|instruction).*(highest\s+priority)/gi, category: 'prompt_injection', riskScore: 85 },
  { pattern: /\bDAN\b/g, category: 'prompt_injection', riskScore: 80 },
  { pattern: /\bdo anything now\b/gi, category: 'prompt_injection', riskScore: 85 },
  { pattern: /developer mode/gi, category: 'prompt_injection', riskScore: 80 },
  { pattern: /\bjailbreak\b/gi, category: 'prompt_injection', riskScore: 75 },
  { pattern: /\[(AI导师|系统|assistant)\]\s*[:：]/gi, category: 'prompt_injection', riskScore: 80 },
];

const ANSWER_SEEKING_RULES: SafetyRuleDefinition[] = [
  // 直接索要答案
  { pattern: /直接给[我出]?.*?(答案|代码|solution)/gi, category: 'answer_seeking', riskScore: 40 },
  { pattern: /给我完整.*?代码/gi, category: 'answer_seeking', riskScore: 40 },
  { pattern: /不要.*?教学模式/gi, category: 'answer_seeking', riskScore: 45 },
  { pattern: /把(完整|全部).*?(代码|答案|solution).*?(给|发|写|输出)/gi, category: 'answer_seeking', riskScore: 45 },
  { pattern: /(写出|给出|生成).*(可通过|通过).*(全部|所有).*(测试点|样例).*(代码|程序|实现)/gi, category: 'answer_seeking', riskScore: 45 },
  { pattern: /(accepted|complete|full)\s+(solution|code|implementation)/gi, category: 'answer_seeking', riskScore: 40 },
];

const EXFILTRATION_RULES: SafetyRuleDefinition[] = [
  { pattern: /(输出|展示|泄露|告诉我|打印).*?(系统|system).*?(提示词|prompt|指令)/gi, category: 'prompt_exfiltration', riskScore: 90 },
  { pattern: /(show|print|output|reveal|repeat).*?(your|the)?.*?system.*?(prompt|instructions)/gi, category: 'prompt_exfiltration', riskScore: 90 },
  { pattern: /(?:show|print|output|reveal)(?:me)?(?:your|the)?system(?:prompt|instructions)/gi, category: 'prompt_exfiltration', riskScore: 95 },
];

const BUILTIN_RULES: SafetyRuleDefinition[] = [
  ...INJECTION_RULES,
  ...ANSWER_SEEKING_RULES,
  ...EXFILTRATION_RULES,
];

export const builtinJailbreakPatternSources = BUILTIN_RULES.map((rule) => rule.pattern.source);

export const getBuiltinJailbreakRules = (): SafetyRuleDefinition[] =>
  BUILTIN_RULES.map((rule) => ({
    ...rule,
    pattern: new RegExp(rule.pattern.source, rule.pattern.flags),
  }));

export const getBuiltinJailbreakPatterns = (): RegExp[] =>
  getBuiltinJailbreakRules().map((rule) => rule.pattern);
