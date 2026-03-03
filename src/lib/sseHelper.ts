import type { ServerResponse } from 'http';

export interface SSEWriter {
  writeEvent(event: string, data: unknown): void;
  writeComment(comment: string): void;
  end(): void;
  readonly closed: boolean;
}

export function createSSEWriter(res: ServerResponse): SSEWriter {
  let isClosed = false;

  res.on('close', () => { isClosed = true; });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  return {
    writeEvent(event: string, data: unknown) {
      if (isClosed) return;
      const json = typeof data === 'string' ? data : JSON.stringify(data);
      res.write(`event: ${event}\ndata: ${json}\n\n`);
    },
    writeComment(comment: string) {
      if (isClosed) return;
      res.write(`: ${comment}\n\n`);
    },
    end() {
      if (isClosed) return;
      isClosed = true;
      res.end();
    },
    get closed() {
      return isClosed;
    },
  };
}
