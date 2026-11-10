/**
 * 学生端每日次数状态：打开面板时读取，聊天成功后用返回的最新用量更新，到重置时间自动刷新
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { buildApiUrl } from '../../utils/domainUtils';
import {
  dismissNotice,
  markAppealed,
  mergeSnapshot,
  refreshDelayMs,
  type QuotaSnapshotView,
  type QuotaStatusView,
} from '../quotaView';

export function useQuotaStatus() {
  const [status, setStatus] = useState<QuotaStatusView | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(buildApiUrl('/ai-helper/quota-status'), {
        credentials: 'include',
        headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (!res.ok) return;
      setStatus(await res.json() as QuotaStatusView);
    } catch {
      // 状态读取失败不影响提问：服务端仍会校验次数
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const delay = status ? refreshDelayMs(status.resetAt) : null;
    if (delay !== null) timerRef.current = setTimeout(refresh, delay);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [status?.resetAt, refresh]);

  /** 聊天成功：用响应里的最新用量更新 */
  const applySnapshot = useCallback((snapshot: QuotaSnapshotView) => {
    setStatus((prev) => mergeSnapshot(prev, snapshot));
  }, []);

  /** 聊天被拒：额度用完或被管理员关闭 */
  const markBlocked = useCallback((code: 'QUOTA_EXHAUSTED' | 'AI_DISABLED_BY_ADMIN', snapshot?: QuotaSnapshotView) => {
    if (code === 'AI_DISABLED_BY_ADMIN') {
      setStatus((prev) => ({
        limit: 0,
        used: prev?.used ?? 0,
        remaining: 0,
        resetAt: prev?.resetAt || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        ...(prev?.timezone ? { timezone: prev.timezone } : {}),
        disabled: true,
      }));
      return;
    }
    if (snapshot) setStatus((prev) => mergeSnapshot(prev, snapshot));
    else refresh();
  }, [refresh]);

  /** 对降低额度的某条违规申诉（复用安全记录申诉接口，按本人记录跨域查找） */
  const appeal = useCallback(async (safetyEventId: string): Promise<{ ok: boolean; message?: string }> => {
    try {
      const res = await fetch(buildApiUrl(`/ai-helper/safety-events/${encodeURIComponent(safetyEventId)}/appeal`), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({})) as { error?: string; message?: string };
      if (!res.ok) return { ok: false, message: data.error };
      setStatus((prev) => markAppealed(prev, safetyEventId));
      return { ok: true, message: data.message };
    } catch {
      return { ok: false };
    }
  }, []);

  /** 确认 AI 抽查处罚通知；先在本地移除，失败时下次刷新会重新出现 */
  const ackNotice = useCallback(async (noticeId: string): Promise<void> => {
    setStatus((prev) => dismissNotice(prev, noticeId));
    try {
      await fetch(buildApiUrl(`/ai-helper/quota-status/notices/${encodeURIComponent(noticeId)}/ack`), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({}),
      });
    } catch {
      /* 网络失败：下次刷新时通知会再次出现 */
    }
  }, []);

  return { status, refresh, applySnapshot, markBlocked, appeal, ackNotice };
}
