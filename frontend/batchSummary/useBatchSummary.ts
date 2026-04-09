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
  isGenerating: boolean;
  completed: number;
  total: number;
  failed: number;
  summaries: Map<number, StudentSummaryData>;
  error: string | null;
}

const initialState: BatchSummaryState = {
  jobId: null,
  isGenerating: false,
  completed: 0,
  total: 0,
  failed: 0,
  summaries: new Map(),
  error: null,
};

function buildUrl(domainId: string, path: string): string {
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

  const startGeneration = useCallback(async (
    contestId: string | number,
    confirmRegenerate?: boolean,
  ): Promise<StartGenerationResult> => {
    setState(prev => ({ ...prev, isGenerating: true, error: null }));

    try {
      const res = await fetch(buildUrl(domainId, '/generate'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'X-Requested-With': 'XMLHttpRequest',
        },
        credentials: 'include',
        body: JSON.stringify({ contestId, confirmRegenerate }),
      });

      if (!res.ok) {
        let errMsg = `HTTP ${res.status}`;
        try {
          const errData = await res.json();
          errMsg = errData.error || errMsg;
        } catch { /* ignore parse error */ }
        setState(prev => ({ ...prev, isGenerating: false, error: errMsg }));
        return {};
      }

      // Check for needConfirm JSON response (non-SSE)
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('text/event-stream')) {
        try {
          const data = await res.json();
          if (data.needConfirm) {
            setState(prev => ({ ...prev, isGenerating: false }));
            return { needConfirm: true, message: data.message };
          }
        } catch { /* ignore */ }
        setState(prev => ({ ...prev, isGenerating: false }));
        return {};
      }

      if (!res.body) {
        setState(prev => ({ ...prev, isGenerating: false, error: 'No response body' }));
        return {};
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
              total: data.total ?? prev.total,
              completed: 0,
              failed: 0,
              summaries: new Map(),
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
            setState(prev => ({ ...prev, isGenerating: false }));
            break;

          case 'error':
            setState(prev => ({
              ...prev,
              isGenerating: false,
              error: data.error || 'Unknown error',
            }));
            break;

          default:
            break;
        }
      };

      // Read SSE stream
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

      return {};
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      setState(prev => ({ ...prev, isGenerating: false, error: errMsg }));
      return {};
    }
  }, [domainId, updateSummary]);

  const loadExisting = useCallback(async (jobId: string) => {
    setState(prev => ({ ...prev, error: null }));
    try {
      const res = await fetch(buildUrl(domainId, `/jobs/${jobId}`), {
        credentials: 'include',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        setState(prev => ({ ...prev, error: errData.error || `HTTP ${res.status}` }));
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
    setState(prev => ({ ...prev, error: null }));
    try {
      const res = await fetch(buildUrl(domainId, '/publish'), {
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
        setState(prev => ({ ...prev, error: errData.error || `HTTP ${res.status}` }));
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
  }, [domainId]);

  const retryStudent = useCallback(async (userId: number) => {
    setState(prev => ({ ...prev, error: null }));
    // Optimistically set student to pending
    updateSummary(userId, { status: 'pending', error: undefined });
    try {
      const res = await fetch(buildUrl(domainId, `/retry/${userId}`), {
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
        updateSummary(userId, { status: 'failed', error: errData.error || `HTTP ${res.status}` });
        setState(prev => ({ ...prev, error: errData.error || `HTTP ${res.status}` }));
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      updateSummary(userId, { status: 'failed', error: errMsg });
      setState(prev => ({ ...prev, error: errMsg }));
    }
  }, [domainId, updateSummary]);

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
    loadExisting,
    publishAll,
    retryStudent,
    cleanup,
  };
}
