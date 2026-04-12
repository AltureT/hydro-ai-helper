import { useState, useCallback, useRef } from 'react';

export interface StudentSummaryData {
  userId: number;
  userName?: string;
  status: 'pending' | 'generating' | 'completed' | 'failed';
  publishStatus: 'draft' | 'published';
  summary: string | null;
  error?: string;
}

export interface BatchSummaryState {
  jobId: string | null;
  jobStatus: string | null;
  isGenerating: boolean;
  completed: number;
  total: number;
  failed: number;
  newStudentCount: number;
  summaries: Map<number, StudentSummaryData>;
  error: string | null;
  loading: boolean;
}

const initialState: BatchSummaryState = {
  jobId: null,
  jobStatus: null,
  isGenerating: false,
  completed: 0,
  total: 0,
  failed: 0,
  newStudentCount: 0,
  summaries: new Map(),
  error: null,
  loading: false,
};

/** Extract a string message from backend error responses ({ error: string | { code, message } }) */
function extractErrorMsg(data: any, fallback: string): string {
  const err = data?.error;
  if (typeof err === 'string') return err;
  if (err && typeof err.message === 'string') return err.message;
  return fallback;
}

export function buildUrl(domainId: string, path: string): string {
  return domainId !== 'system'
    ? `/d/${domainId}/ai-helper/batch-summaries${path}`
    : `/ai-helper/batch-summaries${path}`;
}

export interface StartGenerationResult {
  needConfirm?: boolean;
  message?: string;
}

export function useBatchSummary(domainId: string) {
  const [state, setState] = useState<BatchSummaryState>(initialState);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);

  const updateSummary = useCallback((userId: number, data: Partial<StudentSummaryData>) => {
    setState(prev => {
      const next = new Map(prev.summaries);
      const existing = next.get(userId) || {
        userId,
        status: 'pending' as const,
        publishStatus: 'draft' as const,
        summary: null,
      };
      next.set(userId, { ...existing, ...data });
      return { ...prev, summaries: next };
    });
  }, []);

  // ── SSE stream reader (shared by startGeneration and continueGeneration) ──

  const readSSEStream = useCallback(async (res: Response): Promise<void> => {
    if (!res.body) {
      setState(prev => ({ ...prev, isGenerating: false, error: 'No response body' }));
      return;
    }

    const reader = res.body.getReader();
    readerRef.current = reader;
    const decoder = new TextDecoder();
    let buffer = '';

    const processEvent = (eventType: string, rawData: string) => {
      let data: any;
      try { data = JSON.parse(rawData); } catch { return; }

      switch (eventType) {
        case 'job_started':
          setState(prev => ({
            ...prev,
            jobId: data.jobId ?? prev.jobId,
            jobStatus: 'running',
            total: data.totalStudents ?? data.total ?? prev.total,
            completed: data.previousCompleted ?? prev.completed,
            failed: data.previousFailed ?? prev.failed,
          }));
          break;

        case 'progress':
          setState(prev => ({
            ...prev,
            completed: data.completed ?? prev.completed,
            total: data.total ?? prev.total,
            failed: data.failed ?? prev.failed,
          }));
          break;

        case 'student_done':
          updateSummary(data.userId, {
            userId: data.userId,
            userName: data.userName,
            status: 'completed',
            publishStatus: data.publishStatus ?? 'draft',
            summary: data.summary ?? null,
          });
          setState(prev => ({ ...prev, completed: prev.completed + 1 }));
          break;

        case 'student_failed':
          updateSummary(data.userId, {
            userId: data.userId,
            userName: data.userName,
            status: 'failed',
            publishStatus: 'draft',
            summary: null,
            error: data.error,
          });
          setState(prev => ({ ...prev, failed: prev.failed + 1 }));
          break;

        case 'job_done':
          setState(prev => ({ ...prev, isGenerating: false, jobStatus: 'completed' }));
          break;

        case 'job_stopped':
          setState(prev => ({ ...prev, isGenerating: false, jobStatus: 'stopped' }));
          break;

        case 'error':
          setState(prev => ({
            ...prev,
            isGenerating: false,
            error: data.error || data.message || 'Unknown error',
          }));
          break;

        default:
          break;
      }
    };

    try {
      let currentEvent = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith(': ')) continue; // keepalive comment
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
            continue;
          }
          if (line.startsWith('data: ')) {
            const raw = line.slice(6);
            processEvent(currentEvent, raw);
            currentEvent = '';
            continue;
          }
          if (line === '') {
            currentEvent = '';
          }
        }
      }

      // Process any remaining buffer content
      if (buffer.trim()) {
        if (buffer.startsWith('data: ')) {
          processEvent('', buffer.slice(6));
        }
      }
    } finally {
      reader.releaseLock();
      readerRef.current = null;
      setState(prev => ({ ...prev, isGenerating: false }));
    }
  }, [updateSummary]);

  // ── Load latest job for a contest (persistence on refresh) ──

  const loadLatest = useCallback(async (contestId: string) => {
    setState(prev => ({ ...prev, loading: true, error: null }));
    try {
      const res = await fetch(buildUrl(domainId, `/latest?contestId=${contestId}`), {
        credentials: 'include',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (!res.ok) {
        setState(prev => ({ ...prev, loading: false }));
        return;
      }
      const data = await res.json();
      if (!data.job) {
        setState(prev => ({ ...prev, loading: false }));
        return;
      }

      const summaries = new Map<number, StudentSummaryData>();
      let completedCount = 0;
      let failedCount = 0;
      if (Array.isArray(data.summaries)) {
        for (const s of data.summaries) {
          summaries.set(s.userId, {
            userId: s.userId,
            userName: s.userName,
            status: s.status ?? 'completed',
            publishStatus: s.publishStatus ?? 'draft',
            summary: s.summary ?? null,
            error: s.error,
          });
          if (s.status === 'completed') completedCount++;
          if (s.status === 'failed') failedCount++;
        }
      }
      const currentAttendeeCount = data.currentAttendeeCount ?? summaries.size;
      const newStudentCount = Math.max(0, currentAttendeeCount - summaries.size);
      setState({
        jobId: String(data.job._id),
        jobStatus: data.job.status,
        isGenerating: data.job.status === 'running',
        completed: completedCount,
        total: summaries.size,
        failed: failedCount,
        newStudentCount,
        summaries,
        error: null,
        loading: false,
      });
    } catch (err) {
      setState(prev => ({ ...prev, loading: false }));
    }
  }, [domainId]);

  // ── Start generation ──

  const startGeneration = useCallback(async (opts: {
    contestId: string | number;
    mode?: 'new_only' | 'regenerate';
    confirmRegenerate?: boolean;
  }): Promise<StartGenerationResult> => {
    const { contestId, mode, confirmRegenerate } = opts;

    // For new_only mode, don't clear existing summaries
    if (mode !== 'new_only') {
      setState(prev => ({ ...prev, isGenerating: true, error: null, summaries: new Map(), completed: 0, failed: 0 }));
    } else {
      setState(prev => ({ ...prev, isGenerating: true, error: null }));
    }

    try {
      const res = await fetch(buildUrl(domainId, '/generate'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'X-Requested-With': 'XMLHttpRequest',
        },
        credentials: 'include',
        body: JSON.stringify({ contestId, mode, confirmRegenerate }),
      });

      if (!res.ok) {
        let errMsg = `HTTP ${res.status}`;
        try {
          const errData = await res.json();
          errMsg = extractErrorMsg(errData, errMsg);
        } catch { /* ignore parse error */ }
        setState(prev => ({ ...prev, isGenerating: false, error: errMsg }));
        return {};
      }

      // Check for JSON responses (needConfirm, noNewStudents)
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('text/event-stream')) {
        try {
          const data = await res.json();
          if (data.needConfirm) {
            setState(prev => ({ ...prev, isGenerating: false }));
            return { needConfirm: true, message: data.message };
          }
          if (data.noNewStudents) {
            setState(prev => ({ ...prev, isGenerating: false, newStudentCount: 0 }));
            return {};
          }
        } catch { /* ignore */ }
        setState(prev => ({ ...prev, isGenerating: false }));
        return {};
      }

      await readSSEStream(res);
      return {};
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      setState(prev => ({ ...prev, isGenerating: false, error: errMsg }));
      return {};
    }
  }, [domainId, readSSEStream]);

  // ── Stop generation ──

  const stopGeneration = useCallback(async () => {
    // 1. Cancel the SSE reader immediately
    if (readerRef.current) {
      try { readerRef.current.cancel(); } catch { /* ignore */ }
      readerRef.current = null;
    }

    // 2. Tell backend to stop
    if (state.jobId) {
      try {
        await fetch(buildUrl(domainId, `/${state.jobId}/stop`), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
          },
          credentials: 'include',
        });
      } catch (err) {
        console.error('[useBatchSummary] stop error:', err);
      }
    }

    setState(prev => ({ ...prev, isGenerating: false, jobStatus: 'stopped' }));
  }, [domainId, state.jobId]);

  // ── Continue generation (resume pending students) ──

  const continueGeneration = useCallback(async () => {
    if (!state.jobId) return;

    setState(prev => ({ ...prev, isGenerating: true, error: null }));

    try {
      const res = await fetch(buildUrl(domainId, `/${state.jobId}/continue`), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'X-Requested-With': 'XMLHttpRequest',
        },
        credentials: 'include',
      });

      if (!res.ok) {
        let errMsg = `HTTP ${res.status}`;
        try {
          const errData = await res.json();
          errMsg = extractErrorMsg(errData, errMsg);
        } catch { /* ignore */ }
        setState(prev => ({ ...prev, isGenerating: false, error: errMsg }));
        return;
      }

      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('text/event-stream')) {
        setState(prev => ({ ...prev, isGenerating: false }));
        return;
      }

      await readSSEStream(res);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      setState(prev => ({ ...prev, isGenerating: false, error: errMsg }));
    }
  }, [domainId, state.jobId, readSSEStream]);

  const loadExisting = useCallback(async (jobId: string) => {
    setState(prev => ({ ...prev, error: null }));
    try {
      const res = await fetch(buildUrl(domainId, `/jobs/${jobId}`), {
        credentials: 'include',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        setState(prev => ({ ...prev, error: extractErrorMsg(errData, `HTTP ${res.status}`) }));
        return;
      }
      const data = await res.json();
      const summaries = new Map<number, StudentSummaryData>();
      if (Array.isArray(data.summaries)) {
        for (const s of data.summaries) {
          summaries.set(s.userId, {
            userId: s.userId,
            userName: s.userName,
            status: s.status ?? 'completed',
            publishStatus: s.publishStatus ?? 'draft',
            summary: s.summary ?? null,
            error: s.error,
          });
        }
      }
      setState(prev => ({
        ...prev,
        jobId,
        isGenerating: false,
        completed: data.completed ?? summaries.size,
        total: data.total ?? summaries.size,
        failed: data.failed ?? 0,
        summaries,
      }));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      setState(prev => ({ ...prev, error: errMsg }));
    }
  }, [domainId]);

  const publishAll = useCallback(async () => {
    if (!state.jobId) return;
    setState(prev => ({ ...prev, error: null }));
    try {
      const res = await fetch(buildUrl(domainId, `/${state.jobId}/publish`), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        credentials: 'include',
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        setState(prev => ({ ...prev, error: extractErrorMsg(errData, `HTTP ${res.status}`) }));
        return;
      }
      // Update all completed summaries to published
      setState(prev => {
        const next = new Map(prev.summaries);
        for (const [uid, s] of next) {
          if (s.status === 'completed') {
            next.set(uid, { ...s, publishStatus: 'published' });
          }
        }
        return { ...prev, summaries: next };
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      setState(prev => ({ ...prev, error: errMsg }));
    }
  }, [domainId, state.jobId]);

  const retryStudent = useCallback(async (userId: number) => {
    if (!state.jobId) return;
    setState(prev => ({ ...prev, error: null }));
    // Optimistically set student to pending
    updateSummary(userId, { status: 'pending', error: undefined });
    try {
      const res = await fetch(buildUrl(domainId, `/${state.jobId}/retry/${userId}`), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        credentials: 'include',
        body: JSON.stringify({ userId }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        const msg = extractErrorMsg(errData, `HTTP ${res.status}`);
        updateSummary(userId, { status: 'failed', error: msg });
        setState(prev => ({ ...prev, error: msg }));
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      updateSummary(userId, { status: 'failed', error: errMsg });
      setState(prev => ({ ...prev, error: errMsg }));
    }
  }, [domainId, state.jobId, updateSummary]);

  /** Reset all failed students to pending, then trigger continue generation */
  const retryFailed = useCallback(async () => {
    if (!state.jobId) return;
    setState(prev => ({ ...prev, error: null }));

    try {
      // 1. Batch-reset all failed → pending
      const res = await fetch(buildUrl(domainId, `/${state.jobId}/retry-failed`), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        credentials: 'include',
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        setState(prev => ({ ...prev, error: extractErrorMsg(errData, `HTTP ${res.status}`) }));
        return;
      }

      // 2. Update local state: mark failed → pending
      setState(prev => {
        const next = new Map(prev.summaries);
        for (const [uid, s] of next) {
          if (s.status === 'failed') {
            next.set(uid, { ...s, status: 'pending', error: undefined });
          }
        }
        return { ...prev, summaries: next, failed: 0 };
      });

      // 3. Trigger continue to actually re-generate them
      await continueGeneration();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      setState(prev => ({ ...prev, error: errMsg }));
    }
  }, [domainId, state.jobId, continueGeneration]);

  const cleanup = useCallback(() => {
    if (readerRef.current) {
      try { readerRef.current.cancel(); } catch { /* ignore */ }
      readerRef.current = null;
    }
    setState(prev => ({ ...prev, isGenerating: false }));
  }, []);

  return {
    state,
    startGeneration,
    stopGeneration,
    continueGeneration,
    retryFailed,
    loadLatest,
    loadExisting,
    publishAll,
    retryStudent,
    cleanup,
  };
}
