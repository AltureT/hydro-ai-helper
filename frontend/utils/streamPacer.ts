/**
 * Smooths bursty SSE text into a steady typewriter reveal.
 *
 * The server publishes checked prose sentence by sentence and may defer the
 * rest of an answer until its final safety scan, so text arrives in large
 * bursts. The pacer reveals the backlog over a few frames instead of
 * rendering each burst at once, and speeds up once the stream has finished.
 */

export interface StreamPacerOptions {
  onUpdate: (text: string) => void;
  /** Schedules one animation tick; returns a cancel function. */
  schedule?: (tick: () => void) => () => void;
  /** Upper bound for revealing the remaining backlog after finish(). */
  maxDrainMs?: number;
}

export interface StreamPacer {
  append(delta: string): void;
  /** Server rewrote the content: retracted text disappears immediately. */
  replace(text: string): void;
  /** Resolves once everything received so far is visible. */
  finish(): Promise<void>;
  flush(): void;
  cancel(): void;
  readonly text: string;
}

// Frames to work through the current backlog: slow enough to read as typing
// while the model is generating, quicker once the answer is complete.
const STREAMING_FRAMES = 24;
const DRAINING_FRAMES = 6;
const TAG_LOOKAHEAD = 40;

function defaultSchedule(tick: () => void): () => void {
  const hidden = typeof document !== 'undefined' && document.hidden;
  if (!hidden && typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(tick, 16);
  return () => clearTimeout(id);
}

/** Moves a cut point off positions that would render broken markup or characters. */
export function adjustRevealEnd(text: string, end: number): number {
  if (end >= text.length) return text.length;
  // Never split a surrogate pair (emoji, rare CJK).
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end += 1;
  // Reveal short tags such as <think> or </think> atomically.
  const open = text.lastIndexOf('<', end - 1);
  if (open !== -1 && text.indexOf('>', open) >= end) {
    const close = text.indexOf('>', open);
    if (close - open <= TAG_LOOKAHEAD) end = close + 1;
  }
  return Math.min(end, text.length);
}

export function createStreamPacer(options: StreamPacerOptions): StreamPacer {
  const schedule = options.schedule ?? defaultSchedule;
  const maxDrainMs = options.maxDrainMs ?? 1500;
  let target = '';
  let shown = 0;
  let draining = false;
  let cancelTick: (() => void) | null = null;
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  let waiters: Array<() => void> = [];

  const settle = () => {
    if (shown < target.length) return;
    if (drainTimer !== null) {
      clearTimeout(drainTimer);
      drainTimer = null;
    }
    const pending = waiters;
    waiters = [];
    pending.forEach(resolve => resolve());
  };

  const tick = () => {
    cancelTick = null;
    const backlog = target.length - shown;
    if (backlog <= 0) {
      settle();
      return;
    }
    const step = Math.max(1, Math.ceil(backlog / (draining ? DRAINING_FRAMES : STREAMING_FRAMES)));
    shown = adjustRevealEnd(target, shown + step);
    options.onUpdate(target.slice(0, shown));
    if (shown < target.length) cancelTick = schedule(tick);
    else settle();
  };

  const kick = () => {
    if (cancelTick === null && shown < target.length) cancelTick = schedule(tick);
  };

  const flush = () => {
    cancelTick?.();
    cancelTick = null;
    if (shown !== target.length) {
      shown = target.length;
      options.onUpdate(target);
    }
    settle();
  };

  return {
    append(delta: string) {
      if (!delta) return;
      target += delta;
      kick();
    },
    replace(text: string) {
      const visible = target.slice(0, shown);
      let common = 0;
      while (common < visible.length && common < text.length && visible[common] === text[common]) common++;
      target = text;
      if (common < shown) {
        shown = common;
        options.onUpdate(target.slice(0, shown));
      }
      kick();
      settle();
    },
    finish() {
      draining = true;
      if (shown >= target.length) return Promise.resolve();
      const done = new Promise<void>(resolve => waiters.push(resolve));
      if (drainTimer === null) drainTimer = setTimeout(flush, maxDrainMs);
      kick();
      return done;
    },
    flush,
    cancel() {
      cancelTick?.();
      cancelTick = null;
      if (drainTimer !== null) {
        clearTimeout(drainTimer);
        drainTimer = null;
      }
      const pending = waiters;
      waiters = [];
      pending.forEach(resolve => resolve());
    },
    get text() {
      return target;
    },
  };
}
