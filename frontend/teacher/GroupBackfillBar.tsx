import React, { useEffect, useState } from 'react';
import { i18n } from '../utils/i18n';
import { buildApiUrl } from '../utils/domainUtils';
import { SPACING, getAlertStyle, getButtonStyle } from '../utils/styles';

interface BackfillResult {
  updated: number;
  remaining: number;
  partial: boolean;
}

interface GroupBackfillBarProps {
  /** 回填写入了数据后调用，用于刷新筛选项与当前统计 */
  onDone: () => void;
}

const BACKFILL_PATH = '/ai-helper/groups/backfill';

/**
 * 统计页顶部：本域还有没有小组记录的历史会话时，提示并提供“按当前小组回填”（FR-057）。
 * 没有待回填会话或接口不可用时不显示。
 */
export const GroupBackfillBar: React.FC<GroupBackfillBarProps> = ({ onDone }) => {
  const [pending, setPending] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(buildApiUrl(BACKFILL_PATH), { credentials: 'include', headers: { Accept: 'application/json' } });
        if (!res.ok) return;
        const json = await res.json();
        if (!cancelled && typeof json.pending === 'number') setPending(json.pending);
      } catch {
        // 统计页本身仍可用，不显示回填入口即可
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const run = async () => {
    if (pending === null) return;
    if (total === 0 && !window.confirm(i18n('ai_helper_group_backfill_confirm', pending))) return;
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(buildApiUrl(BACKFILL_PATH), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: '{}',
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof json.error === 'string' ? json.error : i18n('ai_helper_group_backfill_failed'));
      const result = json as BackfillResult;
      setTotal((value) => value + result.updated);
      setPending(result.remaining);
      if (result.updated > 0) onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : i18n('ai_helper_group_backfill_failed'));
    } finally {
      setRunning(false);
    }
  };

  if (pending === null || (pending === 0 && total === 0)) return null;

  const done = pending === 0;
  return (
    <div
      role="status"
      style={{
        ...getAlertStyle(error ? 'error' : done ? 'success' : 'info'),
        marginBottom: SPACING.lg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: SPACING.md,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ flex: '1 1 320px', minWidth: 0 }}>
        {done
          ? i18n('ai_helper_group_backfill_done', total)
          : total > 0
            ? i18n('ai_helper_group_backfill_progress', total, pending)
            : i18n('ai_helper_group_backfill_hint', pending)}
        {error && <div style={{ marginTop: SPACING.xs }}>{error}</div>}
      </div>
      {!done && (
        <button
          type="button"
          onClick={run}
          disabled={running}
          style={{ ...getButtonStyle('secondary'), whiteSpace: 'nowrap', ...(running ? { opacity: 0.6, cursor: 'not-allowed' } : {}) }}
        >
          {running
            ? i18n('ai_helper_group_backfill_running')
            : total > 0 ? i18n('ai_helper_group_backfill_continue') : i18n('ai_helper_group_backfill_button')}
        </button>
      )}
    </div>
  );
};
