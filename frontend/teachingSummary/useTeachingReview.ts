/**
 * useTeachingReview — hook for fetching paginated teaching review records.
 */

import { useState, useCallback } from 'react';
import { buildReviewUrl, TeachingSummary } from './useTeachingSummary';

// ─── Return type ──────────────────────────────────────────────────────────────

export interface FeedbackStats {
  up: number;
  down: number;
}

export interface UseTeachingReviewReturn {
  summaries: TeachingSummary[];
  total: number;
  page: number;
  loading: boolean;
  error: string | null;
  feedbackStats: FeedbackStats;
  fetchList: (page: number) => Promise<void>;
}

const PAGE_LIMIT = 20;

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useTeachingReview(domainId: string): UseTeachingReviewReturn {
  const [summaries, setSummaries] = useState<TeachingSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedbackStats, setFeedbackStats] = useState<FeedbackStats>({ up: 0, down: 0 });

  const fetchList = useCallback(async (targetPage: number) => {
    setLoading(true);
    setError(null);
    try {
      const base = buildReviewUrl(domainId);
      const url = `${base}?page=${targetPage}&limit=${PAGE_LIMIT}`;
      const res = await fetch(url, {
        credentials: 'include',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const message = data?.error?.message || `HTTP ${res.status}`;
        throw new Error(message);
      }
      const data = await res.json();
      setSummaries(data.summaries ?? []);
      setTotal(data.total ?? 0);
      setPage(targetPage);
      if (data.feedbackStats) {
        setFeedbackStats(data.feedbackStats);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [domainId]);

  return { summaries, total, page, loading, error, feedbackStats, fetchList };
}
