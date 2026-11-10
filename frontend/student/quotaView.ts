/**
 * 学生端每日次数的展示逻辑（不依赖 React / i18n，可单元测试）
 */

export interface QuotaSnapshotView {
  limit: number | null;
  used: number;
  remaining: number | null;
  resetAt: string;
}

export type CreditCategoryView = 'off_topic' | 'answer_seeking' | 'prompt_injection' | 'prompt_exfiltration' | 'obfuscated_injection';

export interface CreditViolationView {
  category: CreditCategoryView;
  at: string;
  source: 'realtime' | 'ai_review' | 'manual';
  domainId?: string;
  safetyEventId?: string;
  appealable: boolean;
  appealed: boolean;
}

export interface StudentCreditView {
  m: number;
  reduced: boolean;
  recoveryAt: string | null;
  recentViolations: CreditViolationView[];
}

/** AI 抽查处罚通知（FR-046），学生确认后不再显示 */
export interface ReviewNoticeView {
  id: string;
  category: CreditCategoryView;
  at: string;
  domainId?: string;
  problemId?: string;
  safetyEventId?: string;
  appealable: boolean;
  appealed: boolean;
}

export interface QuotaStatusView extends QuotaSnapshotView {
  /** 信誉换算前的基础额度 */
  base?: number | null;
  disabled?: boolean;
  timezone?: string;
  credit?: StudentCreditView | null;
  notices?: ReviewNoticeView[];
}

export interface CreditReduction {
  /** 基础额度与降低后的当日额度 */
  from: number;
  to: number;
  /** 约几天后恢复（向上取整，至少 1） */
  recoveryDays: number | null;
}

/** 当日额度因违规降低时的说明；额度不受影响（不限额、保底、关闭）时为 null（FR-034） */
export function creditReduction(status: QuotaStatusView | null, now: Date = new Date()): CreditReduction | null {
  if (!status?.credit?.reduced || status.disabled) return null;
  if (status.limit === null || typeof status.base !== 'number' || status.base <= status.limit) return null;
  const recovery = status.credit.recoveryAt ? new Date(status.credit.recoveryAt).getTime() - now.getTime() : NaN;
  return {
    from: status.base,
    to: status.limit,
    recoveryDays: Number.isFinite(recovery) ? Math.max(1, Math.ceil(recovery / (24 * 60 * 60 * 1000))) : null,
  };
}

/** “为什么降低”里一条违规的时间：今天 / 昨天 / 月-日，加 时:分（浏览器本地时间） */
export function violationTimeLabel(at: string, now: Date = new Date()): { kind: 'today' | 'yesterday' | 'date'; time: string; date: string } | null {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return null;
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(when)) / (24 * 60 * 60 * 1000));
  return {
    kind: dayDiff <= 0 ? 'today' : dayDiff === 1 ? 'yesterday' : 'date',
    time: `${pad(when.getHours())}:${pad(when.getMinutes())}`,
    date: `${pad(when.getMonth() + 1)}-${pad(when.getDate())}`,
  };
}

/** 申诉成功后在本地标记（降额说明与抽查通知两处），避免重复申诉 */
export function markAppealed(status: QuotaStatusView | null, safetyEventId: string): QuotaStatusView | null {
  if (!status) return status;
  const mark = <T extends { safetyEventId?: string; appealable: boolean; appealed: boolean }>(item: T): T => (
    item.safetyEventId === safetyEventId ? { ...item, appealable: false, appealed: true } : item
  );
  return {
    ...status,
    ...(status.credit ? { credit: { ...status.credit, recentViolations: status.credit.recentViolations.map(mark) } } : {}),
    ...(status.notices ? { notices: status.notices.map(mark) } : {}),
  };
}

/** 学生点“知道了”后移除这条通知 */
export function dismissNotice(status: QuotaStatusView | null, noticeId: string): QuotaStatusView | null {
  if (!status?.notices) return status;
  return { ...status, notices: status.notices.filter((notice) => notice.id !== noticeId) };
}

/** 违规所在题目的链接（仅在有题号时） */
export function noticeProblemUrl(notice: Pick<ReviewNoticeView, 'domainId' | 'problemId'>): string | null {
  if (!notice.problemId) return null;
  const domain = notice.domainId && notice.domainId !== 'system' ? `/d/${encodeURIComponent(notice.domainId)}` : '';
  return `${domain}/p/${encodeURIComponent(notice.problemId)}`;
}

export type QuotaBlock = 'exhausted' | 'disabled' | null;

/** 管理员关闭优先于额度用完 */
export function quotaBlock(status: QuotaStatusView | null): QuotaBlock {
  if (!status) return null;
  if (status.disabled) return 'disabled';
  if (status.limit !== null && status.remaining !== null && status.remaining <= 0) return 'exhausted';
  return null;
}

/** 不限额且未被关闭时不显示次数条 */
export function shouldShowQuotaBar(status: QuotaStatusView | null): boolean {
  return !!status && (status.limit !== null || !!status.disabled);
}

export function remainingPercent(status: QuotaStatusView): number {
  if (status.limit === null || status.limit <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(((status.remaining ?? 0) / status.limit) * 100)));
}

export interface ResetLabel {
  kind: 'today' | 'tomorrow' | 'date';
  time: string;
  date: string;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 以浏览器本地时间描述重置时间：今天 / 明天 / 某月某日 */
export function resetLabel(resetAt: string, now: Date = new Date()): ResetLabel | null {
  const reset = new Date(resetAt);
  if (Number.isNaN(reset.getTime())) return null;
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(reset) - startOfDay(now)) / (24 * 60 * 60 * 1000));
  return {
    kind: dayDiff <= 0 ? 'today' : dayDiff === 1 ? 'tomorrow' : 'date',
    time: `${pad(reset.getHours())}:${pad(reset.getMinutes())}`,
    date: `${pad(reset.getMonth() + 1)}-${pad(reset.getDate())}`,
  };
}

/** 合并聊天成功后返回的最新用量（保留状态接口里的 disabled / timezone） */
export function mergeSnapshot(prev: QuotaStatusView | null, snapshot: QuotaSnapshotView): QuotaStatusView {
  return { ...(prev || {}), ...snapshot, disabled: false };
}

/** 距离重置还有多久时刷新状态；超过一天或已过期则不安排 */
export function refreshDelayMs(resetAt: string, now: Date = new Date()): number | null {
  const delay = new Date(resetAt).getTime() - now.getTime();
  if (!Number.isFinite(delay) || delay <= 0 || delay > 24 * 60 * 60 * 1000) return null;
  return delay + 2000;
}
