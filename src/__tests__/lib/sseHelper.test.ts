import { createSSEWriter } from '../../lib/sseHelper';
import { EventEmitter } from 'events';

function createMockResponse() {
  const res = new EventEmitter() as any;
  res.writeHead = jest.fn();
  res.write = jest.fn();
  res.end = jest.fn();
  return res;
}

describe('createSSEWriter', () => {
  it('should set correct SSE headers', () => {
    const res = createMockResponse();
    createSSEWriter(res);

    expect(res.writeHead).toHaveBeenCalledWith(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
  });

  it('should write event with JSON data', () => {
    const res = createMockResponse();
    const writer = createSSEWriter(res);

    writer.writeEvent('message', { text: 'hello' });

    expect(res.write).toHaveBeenCalledWith(
      'event: message\ndata: {"text":"hello"}\n\n'
    );
  });

  it('should write event with string data', () => {
    const res = createMockResponse();
    const writer = createSSEWriter(res);

    writer.writeEvent('ping', 'pong');

    expect(res.write).toHaveBeenCalledWith(
      'event: ping\ndata: pong\n\n'
    );
  });

  it('should write comments', () => {
    const res = createMockResponse();
    const writer = createSSEWriter(res);

    writer.writeComment('keep-alive');

    expect(res.write).toHaveBeenCalledWith(': keep-alive\n\n');
  });

  it('should call res.end() on end()', () => {
    const res = createMockResponse();
    const writer = createSSEWriter(res);

    writer.end();

    expect(res.end).toHaveBeenCalled();
  });

  it('should report closed=false initially', () => {
    const res = createMockResponse();
    const writer = createSSEWriter(res);

    expect(writer.closed).toBe(false);
  });

  it('should report closed=true after end()', () => {
    const res = createMockResponse();
    const writer = createSSEWriter(res);

    writer.end();

    expect(writer.closed).toBe(true);
  });

  it('should report closed=true after client disconnect', () => {
    const res = createMockResponse();
    const writer = createSSEWriter(res);

    res.emit('close');

    expect(writer.closed).toBe(true);
  });

  it('should not write after client disconnect', () => {
    const res = createMockResponse();
    const writer = createSSEWriter(res);

    res.emit('close');
    writer.writeEvent('message', { text: 'late' });
    writer.writeComment('late');

    // writeHead was called during init, but no write calls after close
    expect(res.write).not.toHaveBeenCalled();
  });

  it('should not call res.end() twice', () => {
    const res = createMockResponse();
    const writer = createSSEWriter(res);

    writer.end();
    writer.end();

    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('should not call res.end() after client disconnect', () => {
    const res = createMockResponse();
    const writer = createSSEWriter(res);

    res.emit('close');
    writer.end();

    expect(res.end).not.toHaveBeenCalled();
  });
});
