/**
 * useTeachingReview — hook for fetching paginated teaching review records.
 */

import { useState, useCallback } from 'react';
import { buildReviewUrl, TeachingSummary } from './useTeachingSummary';

// ─── Return type ──────────────────────────────────────────────────────────────

export interface UseTeachingReviewReturn {
  summaries: TeachingSummary[];
  total: number;
  page: number;
  loading: boolean;
  fetchList: (page: number) => Promise<void>;
}

const PAGE_LIMIT = 20;

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useTeachingReview(domainId: string): UseTeachingReviewReturn {
  const [summaries, setSummaries] = useState<TeachingSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);

  const fetchList = useCallback(async (targetPage: number) => {
    setLoading(true);
    try {
      const base = buildReviewUrl(domainId);
      const url = `${base}?page=${targetPage}&limit=${PAGE_LIMIT}`;
      const res = await fetch(url, {
        credentials: 'include',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (!res.ok) return;
      const data = await res.json();
      setSummaries(data.summaries ?? []);
      setTotal(data.total ?? 0);
      setPage(targetPage);
    } catch {
      // ignore transient errors
    } finally {
      setLoading(false);
    }
  }, [domainId]);

  return { summaries, total, page, loading, fetchList };
}
