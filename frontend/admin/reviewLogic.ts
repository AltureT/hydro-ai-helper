/**
 * AI 抽查标签页的纯逻辑：接口类型、设置表单校验（与服务端 applyAIReviewConfigPatch 一致）、显示用格式化。
 */

import type { JailbreakLogEntry } from './configTypes';

export interface AIReviewSettings {
  enabled: boolean;
  runAt: string;
  /** 0–1 */
  sampleRate: number;
  maxConversations: number;
  breakerWindow: number;
  breakerMinSample: number;
  breakerThreshold: number;
}

export interface ReviewRunView {
  id: string;
  trigger: 'schedule' | 'manual';
  scopeLabel?: string;
  requestedByName?: string;
  status: 'running' | 'completed' | 'failed' | 'skipped';
  candidateCount: number | null;
  processedCount: number;
  flaggedCount: number;
  penalizedCount: number;
  failedCount: number;
  tokens: { prompt: number; completion: number; total: number };
  estimatedCostUSD: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface ReviewFindingView {
  id: string;
  domainId?: string;
  domainName?: string;
  userId?: number;
  uname?: string;
  problemId?: string;
  problemTitle?: string;
  conversationId?: string;
  category?: JailbreakLogEntry['category'];
  confidence?: 'medium' | 'high';
  actionTaken?: JailbreakLogEntry['actionTaken'];
  evidence: Array<{ ref: string; snippet: string; verified: boolean }>;
  evidenceVerified: boolean;
  autoPenalized: boolean;
  reason?: string;
  reviewStatus: 'pending' | 'confirmed' | 'false_positive';
  studentAppealedAt?: string;
  reviewRunId?: string;
  createdAt: string;
}

export interface ReviewStatusResponse {
  config: AIReviewSettings;
  timezone: string;
  modelConfigured: boolean;
  state: {
    autoPenaltyEnabled: boolean;
    trippedAt?: string;
    trippedStats?: { window: number; sample: number; falsePositives: number; rate: number };
    disabledAt?: string;
    disabledByName?: string;
    resumedAt?: string;
    resumedByName?: string;
  };
  breaker: { window: number; sample: number; falsePositives: number; rate: number; minSample: number; threshold: number };
  nextRunAt: string | null;
  monthCost: { totalTokens: number; totalCost: number; runCount: number };
  runs: ReviewRunView[];
  findings: ReviewFindingView[];
}

export const REVIEW_API = {
  status: '/ai-helper/admin/review',
  run: '/ai-helper/admin/review/run',
  autoPenalty: '/ai-helper/admin/review/auto-penalty',
} as const;

export const MAX_REVIEW_NAMES = 50;

export interface ReviewSettingsForm {
  enabled: boolean;
  runAt: string;
  samplePercent: string;
  maxConversations: string;
}

export type ReviewSettingsError = 'runAt' | 'samplePercent' | 'maxConversations';

export function settingsToForm(settings: AIReviewSettings): ReviewSettingsForm {
  return {
    enabled: settings.enabled,
    runAt: settings.runAt,
    samplePercent: String(Math.round(settings.sampleRate * 1000) / 10),
    maxConversations: String(settings.maxConversations),
  };
}

/** 只校验并返回页面可编辑的四项；熔断参数沿用已保存的值 */
export function parseSettingsForm(form: ReviewSettingsForm):
  { patch: Pick<AIReviewSettings, 'enabled' | 'runAt' | 'sampleRate' | 'maxConversations'>; errors: ReviewSettingsError[] } {
  const errors: ReviewSettingsError[] = [];
  const runAt = form.runAt.trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(runAt)) errors.push('runAt');
  const percentText = form.samplePercent.trim().replace(/%$/, '');
  const percent = /^\d+(\.\d+)?$/.test(percentText) ? Number(percentText) : NaN;
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) errors.push('samplePercent');
  const maxText = form.maxConversations.trim();
  const max = /^\d+$/.test(maxText) ? Number(maxText) : NaN;
  if (!Number.isInteger(max) || max < 1 || max > 5000) errors.push('maxConversations');
  return {
    patch: {
      enabled: form.enabled,
      runAt,
      sampleRate: Math.round(percent * 10) / 1000,
      maxConversations: max,
    },
    errors,
  };
}

export function sameSettings(patch: ReturnType<typeof parseSettingsForm>['patch'], saved: AIReviewSettings): boolean {
  return patch.enabled === saved.enabled
    && patch.runAt === saved.runAt
    && Math.abs(patch.sampleRate - saved.sampleRate) < 1e-9
    && patch.maxConversations === saved.maxConversations;
}

/** 名单：换行、逗号、顿号、空白分隔；去重 */
export function parseNameList(text: string): string[] {
  return [...new Set(text.split(/[\s,，、]+/).map((name) => name.trim()).filter(Boolean))];
}

export function formatPercent(rate: number): string {
  return `${Math.round(rate * 1000) / 10}%`;
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

export function formatUSD(value: number): string {
  return `$${value < 1 ? value.toFixed(3) : value.toFixed(2)}`;
}

export type RunTone = 'ok' | 'error' | 'muted' | 'info';

export function runTone(run: Pick<ReviewRunView, 'status'>): RunTone {
  switch (run.status) {
    case 'completed': return 'ok';
    case 'failed': return 'error';
    case 'skipped': return 'muted';
    default: return 'info';
  }
}

/** 运行状态文案键：失败或跳过时带原因 */
export function runStatusKey(run: Pick<ReviewRunView, 'status' | 'error'>): string {
  if (run.status === 'skipped' && run.error === 'model_unavailable') return 'ai_helper_review_run_status_model_unavailable';
  if (run.status === 'failed' && run.error === 'model_failed') return 'ai_helper_review_run_status_model_failed';
  return `ai_helper_review_run_status_${run.status}`;
}

/** 处置标记：已自动处罚 / 未处罚；待复核时追加“待复核” */
export function findingActionKey(finding: Pick<ReviewFindingView, 'autoPenalized' | 'reviewStatus'>): string {
  const pending = finding.reviewStatus === 'pending';
  if (finding.autoPenalized && finding.reviewStatus === 'false_positive') return 'ai_helper_review_penalty_revoked';
  if (finding.autoPenalized) return pending ? 'ai_helper_review_auto_penalized_pending' : 'ai_helper_review_auto_penalized';
  return pending ? 'ai_helper_review_flagged_pending' : 'ai_helper_review_flagged';
}

/** 最近发现按复核状态更新（复核后无需整页刷新） */
export function markFindingReviewed(
  findings: ReviewFindingView[],
  id: string,
  reviewStatus: 'confirmed' | 'false_positive',
): ReviewFindingView[] {
  return findings.map((finding) => (finding.id === id ? { ...finding, reviewStatus } : finding));
}
