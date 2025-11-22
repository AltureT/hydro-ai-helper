/**
 * 系统内置的越狱关键词/正则
 */

const BUILTIN_PATTERNS: RegExp[] = [
  /忽略(之前|上文|所有).*提示/gi,
  /ignore (all|previous|earlier) (instructions|messages|prompts)/gi,
  /(从现在开始|现在起?).*(你是|扮演).*(猫娘|女仆|主人|角色|人格)/gi,
  /重置(设定|設定|系统|system)/gi,
  /system prompt/gi,
  /无条件服从/gi,
  /覆盖(系统|所有)提示/gi,
  /现在你是.*系统/gi
];

export const builtinJailbreakPatternSources = BUILTIN_PATTERNS.map((pattern) => pattern.source);

export const getBuiltinJailbreakPatterns = (): RegExp[] =>
  BUILTIN_PATTERNS.map((pattern) => new RegExp(pattern.source, pattern.flags));
