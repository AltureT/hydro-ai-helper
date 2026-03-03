export interface SSEHandlers {
  onMeta?: (data: { conversationId: string }) => void;
  onChunk?: (data: { content: string }) => void;
  onReplace?: (data: { content: string }) => void;
  onDone?: (data: { messageId: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number }; budgetWarning?: string | null }) => void;
  onError?: (data: { error: string; category?: string; retryable?: boolean }) => void;
}

export async function consumeSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  handlers: SSEHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = '';

  const processLine = (line: string) => {
    if (line.startsWith(': ')) return; // comment (keepalive)
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7).trim();
      return;
    }
    if (line.startsWith('data: ')) {
      const raw = line.slice(6);
      let data: any;
      try { data = JSON.parse(raw); } catch { return; }
      switch (currentEvent) {
        case 'meta':    handlers.onMeta?.(data); break;
        case 'chunk':   handlers.onChunk?.(data); break;
        case 'replace': handlers.onReplace?.(data); break;
        case 'done':    handlers.onDone?.(data); break;
        case 'error':   handlers.onError?.(data); break;
      }
      currentEvent = '';
      return;
    }
    if (line === '') {
      currentEvent = '';
    }
  };

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        processLine(line);
      }
    }
    if (buffer.trim()) {
      processLine(buffer);
    }
  } finally {
    reader.releaseLock();
  }
}
