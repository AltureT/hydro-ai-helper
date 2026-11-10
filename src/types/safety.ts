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

/**
 * 处置方式。`flagged`：AI 抽查标记待复核，未处罚；`ai_review_penalty`：AI 抽查自动处罚（只扣信誉，不设冷却）。
 */
export type SafetyAction = 'blocked' | 'cooldown_60s' | 'cooldown_5m' | 'flagged' | 'ai_review_penalty';

/** 实时规则只会产生的处置 */
export type RealtimeSafetyAction = Extract<SafetyAction, 'blocked' | 'cooldown_60s' | 'cooldown_5m'>;

/** AI 抽查的证据：匿名消息编号 + 短片段，以及是否通过核对（FR-043） */
export interface SafetyEvidence {
  ref: string;
  snippet: string;
  verified: boolean;
}

export type SafetyReviewStatus = 'pending' | 'confirmed' | 'false_positive';

export interface SafetyRuleDefinition {
  pattern: RegExp;
  category: Exclude<SafetyViolationCategory, 'obfuscated_injection' | 'off_topic'>;
  riskScore: number;
}
