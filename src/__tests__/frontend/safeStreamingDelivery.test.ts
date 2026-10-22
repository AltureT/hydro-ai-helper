import { PassThrough, Readable } from 'stream';
import { createSSEWriter } from '../../lib/sseHelper';
import { consumeSSEStream } from '../../../frontend/utils/sseParser';
import { SafeOutputStream } from '../../services/safeOutputStream';
import { OutputSafetyService } from '../../services/outputSafetyService';
import { OpenAIClient } from '../../services/openaiClient';
import axios from 'axios';

jest.mock('axios');

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

it.each(['reasoning_content', 'reasoning'])('streams provider %s responses to the frontend before generation ends', async (reasoningField) => {
  const provider = new PassThrough();
  (axios.post as jest.Mock).mockResolvedValueOnce({
    headers: { 'content-type': 'text/event-stream' }, data: provider,
  });
  const response = Object.assign(new PassThrough(), { writeHead: jest.fn() });
  const writer = createSSEWriter(response as any);
  const safety = new OutputSafetyService();
  const gate = new SafeOutputStream(content => safety.sanitize(content, { questionType: 'understand' }));
  let published = '';
  let displayed = '';
  let completed = false;
  let proseArrived: () => void;
  const firstProse = new Promise<void>(resolve => { proseArrived = resolve; });
  const read = consumeSSEStream(Readable.toWeb(response).getReader() as any, {
    onChunk: ({ content }) => {
      displayed += content;
      if (displayed.includes('先检查输入。')) proseArrived();
    },
    onDone: () => { completed = true; },
  });
  const client = new OpenAIClient({
    apiBaseUrl: 'https://provider.example/v1', modelName: 'test-reasoner', apiKey: 'test-key', timeoutSeconds: 30,
  });
  let finalContent = '';
  const generation = client.chatStream([], 'Synthetic tutoring prompt', { callbacks: {
    onChunk: content => {
      const checked = gate.push(content);
      if (checked !== undefined) {
        writer.writeEvent('chunk', { content: checked.slice(published.length) });
        published = checked;
      }
    },
    onDone: result => { finalContent = result.content; writer.writeEvent('done', { messageId: 'synthetic' }); },
    onError: error => { throw error; },
  } });
  const delta = (value: Record<string, string>) => provider.write(`data: ${JSON.stringify({ choices: [{ delta: value }] })}\n\n`);
  let deadline: ReturnType<typeof setTimeout>;
  try {
    // The model remains open after its first sentence. A final-only pipeline times out here.
    delta({ [reasoningField]: 'private reasoning must stay hidden' });
    delta({ content: '先检查' });
    delta({ content: '输入。' });
    await Promise.race([firstProse, new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error('Prose was buffered until model completion')), 1000);
    })]);
    expect(completed).toBe(false);
    expect(displayed).toBe('<think>(thinking...)</think>先检查输入。');
    expect(displayed).not.toContain('private reasoning');
    delta({ content: '再比较条件。' });
  } finally {
    clearTimeout(deadline);
    provider.end('data: [DONE]\n\n');
    await generation;
    writer.end();
    await read;
  }
  expect(completed).toBe(true);
  expect(displayed).toBe(finalContent);
});
