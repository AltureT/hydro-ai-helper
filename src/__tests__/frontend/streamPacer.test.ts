import { adjustRevealEnd, createStreamPacer } from '../../../frontend/utils/streamPacer';

function createManualPacer(maxDrainMs?: number) {
  const updates: string[] = [];
  let queued: (() => void) | null = null;
  const pacer = createStreamPacer({
    onUpdate: text => updates.push(text),
    schedule: tick => {
      queued = tick;
      return () => { queued = null; };
    },
    maxDrainMs,
  });
  const frame = () => {
    const tick = queued;
    queued = null;
    tick?.();
  };
  const frames = (count: number) => { for (let i = 0; i < count; i++) frame(); };
  return { pacer, updates, frame, frames, pending: () => queued !== null };
}

describe('createStreamPacer', () => {
  it('reveals a burst over several frames instead of all at once', () => {
    const { pacer, updates, frame, frames, pending } = createManualPacer();
    const sentence = '先检查输入数据的范围，再思考怎样比较相邻的两个元素。';
    pacer.append(sentence);
    expect(updates).toHaveLength(0);
    frame();
    expect(updates[0].length).toBeGreaterThan(0);
    expect(updates[0].length).toBeLessThan(sentence.length);
    frames(200);
    expect(updates[updates.length - 1]).toBe(sentence);
    expect(pending()).toBe(false);
    // Every update is a prefix of the content: the reveal never jumps backwards.
    updates.forEach(text => expect(sentence.startsWith(text)).toBe(true));
  });

  it('drains a large final burst quickly after finish', async () => {
    const { pacer, updates, frames } = createManualPacer();
    const answer = '解释。'.repeat(700);
    pacer.append(answer);
    let finished = false;
    const done = pacer.finish().then(() => { finished = true; });
    frames(80);
    await done;
    expect(finished).toBe(true);
    expect(updates[updates.length - 1]).toBe(answer);
    expect(updates.length).toBeGreaterThan(10);
  });

  it('flushes after the drain deadline when frames stop (background tab)', async () => {
    jest.useFakeTimers();
    try {
      const { pacer, updates } = createManualPacer(500);
      pacer.append('很长的回答。'.repeat(50));
      const done = pacer.finish();
      jest.advanceTimersByTime(500);
      await done;
      expect(updates[updates.length - 1]).toBe(pacer.text);
    } finally {
      jest.useRealTimers();
    }
  });

  it('removes retracted text immediately on replace', () => {
    const { pacer, updates, frames } = createManualPacer();
    pacer.append('第一句提示。第二句提示。');
    frames(200);
    pacer.replace('第一句提示。完整实现已隐藏。');
    expect(updates[updates.length - 1]).toBe('第一句提示。');
    frames(200);
    expect(updates[updates.length - 1]).toBe('第一句提示。完整实现已隐藏。');
  });

  it('cancel resolves pending finish without revealing more', async () => {
    const { pacer, updates } = createManualPacer();
    pacer.append('未展示的内容。');
    const done = pacer.finish();
    pacer.cancel();
    await done;
    expect(updates).toHaveLength(0);
  });
});

describe('adjustRevealEnd', () => {
  it('reveals the thinking tags atomically', () => {
    const text = '<think>(thinking...)</think>先检查输入。';
    expect(adjustRevealEnd(text, 2)).toBe('<think>'.length);
    expect(adjustRevealEnd(text, text.indexOf('</think>') + 2)).toBe(text.indexOf('先'));
  });

  it('does not split surrogate pairs', () => {
    const text = 'a😀b';
    expect(adjustRevealEnd(text, 2)).toBe(3);
  });

  it('leaves prose comparisons alone', () => {
    const text = '当 a < b 时继续，' + '说明'.repeat(40) + '>';
    expect(adjustRevealEnd(text, 5)).toBe(5);
  });
});
