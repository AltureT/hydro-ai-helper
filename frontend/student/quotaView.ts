/**
 * 学生端每日次数的展示逻辑（不依赖 React / i18n，可单元测试）
 */

export interface QuotaSnapshotView {
  limit: number | null;
  used: number;
  remaining: number | null;
  resetAt: string;
}

export interface QuotaStatusView extends QuotaSnapshotView {
  disabled?: boolean;
  timezone?: string;
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
