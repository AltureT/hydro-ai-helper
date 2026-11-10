export type SafetyViolationCategory =
  | 'answer_seeking'
  | 'prompt_injection'
  | 'prompt_exfiltration'
  | 'obfuscated_injection'
  | 'off_topic';

export const SAFETY_VIOLATION_CATEGORIES: readonly SafetyViolationCategory[] = [
  'answer_seeking', 'prompt_injection', 'prompt_exfiltration', 'obfuscated_injection', 'off_topic',
] as const;

/** 规则风险分 ≥ 70 为高置信度（FR-028a） */
export const HIGH_CONFIDENCE_RISK_SCORE = 70;

export type SafetyConfidence = 'medium' | 'high';

export type SafetyDetectionSource =
  | 'plain'
  | 'compacted'
  | 'base64'
  | 'hex'
  | 'conversation'
  | 'custom'
  | 'topic_guard'
  | 'ai_review';

export type SafetyAction = 'blocked' | 'cooldown_60s' | 'cooldown_5m';

export type SafetyReviewStatus = 'pending' | 'confirmed' | 'false_positive';

export interface SafetyRuleDefinition {
  pattern: RegExp;
  category: Exclude<SafetyViolationCategory, 'obfuscated_injection' | 'off_topic'>;
  riskScore: number;
}
