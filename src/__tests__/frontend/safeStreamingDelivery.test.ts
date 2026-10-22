import { PassThrough, Readable } from 'stream';
import { createSSEWriter } from '../../lib/sseHelper';
import { consumeSSEStream } from '../../../frontend/utils/sseParser';
import { SafeOutputStream } from '../../services/safeOutputStream';
import { OutputSafetyService } from '../../services/outputSafetyService';

it('delivers checked prose through SSE to the frontend parser before the final done event', async () => {
  const response = Object.assign(new PassThrough(), { writeHead: jest.fn() });
  const writer = createSSEWriter(response as any);
  const safety = new OutputSafetyService();
  const gate = new SafeOutputStream(content => safety.sanitize(content, { questionType: 'understand' }));
  const received: string[] = [];
  let finished = false;
  let firstChunk: () => void;
  const firstChunkArrived = new Promise<void>(resolve => { firstChunk = resolve; });
  const read = consumeSSEStream(Readable.toWeb(response).getReader() as any, {
    onChunk: ({ content }) => { received.push(content); firstChunk(); },
    onDone: () => { finished = true; },
  });
  const checked = gate.push('先检查输入。');
  writer.writeEvent('chunk', { content: checked });
  await firstChunkArrived;
  expect(received).toEqual(['先检查输入。']);
  expect(finished).toBe(false);
  writer.writeEvent('chunk', { content: '再比较条件。' });
  writer.writeEvent('done', { messageId: 'synthetic-message' });
  writer.end();
  await read;
  expect(received.join('')).toBe('先检查输入。再比较条件。');
  expect(finished).toBe(true);
});
