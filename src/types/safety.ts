export type SafetyViolationCategory =
  | 'answer_seeking'
  | 'prompt_injection'
  | 'prompt_exfiltration'
  | 'obfuscated_injection';

export type SafetyConfidence = 'medium' | 'high';

export type SafetyDetectionSource =
  | 'plain'
  | 'compacted'
  | 'base64'
  | 'hex'
  | 'conversation'
  | 'custom';

export type SafetyAction = 'blocked' | 'cooldown_60s' | 'cooldown_5m';

export type SafetyReviewStatus = 'pending' | 'confirmed' | 'false_positive';

export interface SafetyRuleDefinition {
  pattern: RegExp;
  category: Exclude<SafetyViolationCategory, 'obfuscated_injection'>;
  riskScore: number;
}
