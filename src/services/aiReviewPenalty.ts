/**
 * AI 抽查的处罚条件与熔断（plan R15，FR-044、FR-047）。纯函数。
 */

import type { ReviewBreakerStats } from '../models/reviewRun';
import type { SafetyReviewStatus } from '../types/safety';
import type { ReviewConfidence } from './aiReviewEvidence';

export type PenaltyBlocker =
  | 'auto_penalty_disabled'
  | 'not_high_confidence'
  | 'evidence_unverified'
  | 'conversation_already_penalized'
  | 'user_penalized_today'
  | 'realtime_deducted';

export interface PenaltyInput {
  autoPenaltyEnabled: boolean;
  confidence: ReviewConfidence;
  evidenceVerified: boolean;
  conversationAlreadyPenalized: boolean;
  userPenalizedToday: boolean;
  /** 证据涉及的学生消息已被实时规则扣过分 */
  touchesRealtimeDeduction: boolean;
}

/** FR-044：全部条件满足才自动处罚；返回未满足的条件，便于测试和排查 */
export function decideAutoPenalty(input: PenaltyInput): { penalize: boolean; blockers: PenaltyBlocker[] } {
  const blockers: PenaltyBlocker[] = [];
  if (!input.autoPenaltyEnabled) blockers.push('auto_penalty_disabled');
  if (input.confidence !== 'high') blockers.push('not_high_confidence');
  if (!input.evidenceVerified) blockers.push('evidence_unverified');
  if (input.conversationAlreadyPenalized) blockers.push('conversation_already_penalized');
  if (input.userPenalizedToday) blockers.push('user_penalized_today');
  if (input.touchesRealtimeDeduction) blockers.push('realtime_deducted');
  return { penalize: blockers.length === 0, blockers };
}

/** 实时规则扣分与对应学生消息的时间差上限：扣分写在保存学生消息之前，二者相隔通常不到 1 秒 */
export const REALTIME_MATCH_WINDOW_MS = 60 * 1000;

/**
 * 证据涉及的学生消息是否已被实时规则扣过分。
 * - 偏题第 2 次起的固定回复（`topicGuardBypassedLLM`）之前的那条学生消息已扣分；
 * - 或者该会话有一条实时扣分，时间与该消息相差不超过 60 秒。
 */
export function touchesRealtimeDeduction(
  evidenceMessages: Array<{ timestamp: Date; followedByFixedReply: boolean }>,
  realtimeDeductionTimes: Date[]
): boolean {
  return evidenceMessages.some((message) => message.followedByFixedReply
    || realtimeDeductionTimes.some((at) => Math.abs(at.getTime() - message.timestamp.getTime()) <= REALTIME_MATCH_WINDOW_MS));
}

export interface BreakerConfig {
  breakerWindow: number;
  breakerMinSample: number;
  breakerThreshold: number;
}

/**
 * 熔断判断（FR-047）：取最近 breakerWindow 条已复核的自动处罚，样本数 ≥ breakerMinSample
 * 且误判比例 ≥ breakerThreshold 时触发。
 */
export function evaluateBreaker(
  reviewed: Array<{ reviewStatus?: SafetyReviewStatus }>,
  config: BreakerConfig
): ReviewBreakerStats & { trip: boolean } {
  const sample = reviewed.slice(0, config.breakerWindow);
  const falsePositives = sample.filter((item) => item.reviewStatus === 'false_positive').length;
  const rate = sample.length ? falsePositives / sample.length : 0;
  return {
    window: config.breakerWindow,
    sample: sample.length,
    falsePositives,
    rate: Math.round(rate * 10000) / 10000,
    trip: sample.length >= config.breakerMinSample && sample.length > 0 && rate >= config.breakerThreshold,
  };
}
