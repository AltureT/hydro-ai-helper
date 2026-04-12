/**
 * useTeachingSummary — React hook for teaching summary API interactions.
 * Handles fetch, generate (with polling), and feedback submission.
 */

import { useState, useCallback, useRef, useEffect } from 'react';

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface TeachingFinding {
  id: string;
  dimension: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  evidence: {
    affectedStudents: number[];
    affectedProblems: number[];
    metrics: Record<string, number>;
    samples?: { code?: string[]; conversations?: string[] };
  };
  needsDeepDive: boolean;
  aiSuggestion?: string;
  aiAnalysis?: string;
}

export interface TeachingSummary {
  _id: string;
  domainId: string;
  contestId: string;
  contestTitle: string;
  contestContent: string;
  teachingFocus?: string;
  createdBy: number;
  createdAt: string;
  dataSnapshotAt: string;
  status: 'pending' | 'generating' | 'completed' | 'failed';
  stats: {
    totalStudents: number;
    participatedStudents: number;
    aiUserCount: number;
    problemCount: number;
  };
  findings: TeachingFinding[];
  overallSuggestion: string;
  deepDiveResults: Record<string, string>;
  feedback?: { rating: 'up' | 'down'; comment?: string };
  tokenUsage: { promptTokens: number; completionTokens: number };
  generationTimeMs: number;
}

// ─── URL builders ─────────────────────────────────────────────────────────────

export function buildUrl(domainId: string, path: string): string {
  return domainId !== 'system'
    ? `/d/${domainId}/ai-helper/teaching-summary${path}`
    : `/ai-helper/teaching-summary${path}`;
}

export function buildReviewUrl(domainId: string): string {
  return domainId !== 'system'
    ? `/d/${domainId}/ai-helper/teaching-review`
    : `/ai-helper/teaching-review`;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export interface UseTeachingSummaryReturn {
  summary: TeachingSummary | null;
  loading: boolean;
  error: string | null;
  fetchSummary: () => Promise<void>;
  generate: (teachingFocus?: string, regenerate?: boolean) => Promise<void>;
  submitFeedback: (summaryId: string, rating: 'up' | 'down', comment?: string) => Promise<void>;
}

const POLL_INTERVAL_MS = 5000;

export function useTeachingSummary(domainId: string, contestId: string): UseTeachingSummaryReturn {
  const [summary, setSummary] = useState<TeachingSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, [stopPolling]);

  const fetchSummary = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = buildUrl(domainId, `/${contestId}`);
      const res = await fetch(url, {
        credentials: 'include',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (res.status === 404) {
        setSummary(null);
        setLoading(false);
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const msg = extractErrorMsg(data, `HTTP ${res.status}`);
        setError(msg);
        setLoading(false);
        return;
      }
      const data = await res.json();
      setSummary(data.summary ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [domainId, contestId]);

  const startPolling = useCallback(() => {
    stopPolling();
    pollTimerRef.current = setInterval(async () => {
      try {
        const url = buildUrl(domainId, `/${contestId}`);
        const res = await fetch(url, {
          credentials: 'include',
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });
        if (!res.ok) return;
        const data = await res.json();
        const fetched: TeachingSummary | null = data.summary ?? null;
        if (fetched) {
          setSummary(fetched);
          if (fetched.status === 'completed' || fetched.status === 'failed') {
            stopPolling();
          }
        }
      } catch {
        // ignore transient poll errors
      }
    }, POLL_INTERVAL_MS);
  }, [domainId, contestId, stopPolling]);

  const generate = useCallback(async (teachingFocus?: string, regenerate?: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const url = buildUrl(domainId, `/${contestId}`);
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({ teachingFocus, regenerate }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const msg = extractErrorMsg(data, `HTTP ${res.status}`);
        setError(msg);
        setLoading(false);
        return;
      }
      const data = await res.json();
      const newSummary: TeachingSummary | null = data.summary ?? null;
      setSummary(newSummary);

      // If generation started, begin polling
      if (data.started && newSummary) {
        startPolling();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [domainId, contestId, startPolling]);

  const submitFeedback = useCallback(async (
    summaryId: string,
    rating: 'up' | 'down',
    comment?: string,
  ) => {
    try {
      const url = buildUrl(domainId, `/${summaryId}/feedback`);
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({ rating, comment }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const msg = extractErrorMsg(data, `HTTP ${res.status}`);
        setError(msg);
        return;
      }
      // Update local feedback state
      setSummary(prev => prev ? { ...prev, feedback: { rating, comment } } : prev);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  }, [domainId]);

  return { summary, loading, error, fetchSummary, generate, submitFeedback };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractErrorMsg(data: any, fallback: string): string {
  const err = data?.error;
  if (typeof err === 'string') return err;
  if (err && typeof err.message === 'string') return err.message;
  return fallback;
}
