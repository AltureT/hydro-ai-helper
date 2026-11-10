import {
  decideAutoPenalty,
  evaluateBreaker,
  REALTIME_MATCH_WINDOW_MS,
  touchesRealtimeDeduction,
  type PenaltyInput,
} from '../../services/aiReviewPenalty';

const allowed: PenaltyInput = {
  autoPenaltyEnabled: true,
  confidence: 'high',
  evidenceVerified: true,
  conversationAlreadyPenalized: false,
  userPenalizedToday: false,
  touchesRealtimeDeduction: false,
};

describe('decideAutoPenalty (FR-044)', () => {
  it('penalizes only when every condition holds', () => {
    expect(decideAutoPenalty(allowed)).toEqual({ penalize: true, blockers: [] });
  });

  it.each([
    [{ autoPenaltyEnabled: false }, 'auto_penalty_disabled'],
    [{ confidence: 'medium' as const }, 'not_high_confidence'],
    [{ evidenceVerified: false }, 'evidence_unverified'],
    [{ conversationAlreadyPenalized: true }, 'conversation_already_penalized'],
    [{ userPenalizedToday: true }, 'user_penalized_today'],
    [{ touchesRealtimeDeduction: true }, 'realtime_deducted'],
  ])('does not penalize when %o', (change, blocker) => {
    expect(decideAutoPenalty({ ...allowed, ...change })).toEqual({ penalize: false, blockers: [blocker] });
  });
});

describe('touchesRealtimeDeduction', () => {
  const message = new Date('2026-11-09T18:02:00.000Z');

  it('counts a student message answered by the off-topic fixed reply', () => {
    expect(touchesRealtimeDeduction([{ timestamp: message, followedByFixedReply: true }], [])).toBe(true);
  });

  it('counts a realtime deduction within the matching window', () => {
    const near = new Date(message.getTime() - 800);
    const far = new Date(message.getTime() + REALTIME_MATCH_WINDOW_MS + 1000);
    expect(touchesRealtimeDeduction([{ timestamp: message, followedByFixedReply: false }], [near])).toBe(true);
    expect(touchesRealtimeDeduction([{ timestamp: message, followedByFixedReply: false }], [far])).toBe(false);
    expect(touchesRealtimeDeduction([], [near])).toBe(false);
  });
});

describe('evaluateBreaker (FR-047)', () => {
  const config = { breakerWindow: 50, breakerMinSample: 10, breakerThreshold: 0.2 };
  const reviewed = (fp: number, ok: number) => [
    ...Array.from({ length: fp }, () => ({ reviewStatus: 'false_positive' as const })),
    ...Array.from({ length: ok }, () => ({ reviewStatus: 'confirmed' as const })),
  ];

  it('trips at 20% false positives once the minimum sample is reached', () => {
    expect(evaluateBreaker(reviewed(2, 8), config)).toEqual({ window: 50, sample: 10, falsePositives: 2, rate: 0.2, trip: true });
    expect(evaluateBreaker(reviewed(1, 9), config).trip).toBe(false);
  });

  it('does not trip below the minimum sample size', () => {
    expect(evaluateBreaker(reviewed(5, 4), config)).toMatchObject({ sample: 9, trip: false });
    expect(evaluateBreaker([], config)).toMatchObject({ sample: 0, rate: 0, trip: false });
  });

  it('only looks at the most recent window', () => {
    const recent = [...reviewed(4, 46), ...reviewed(20, 0)];
    expect(evaluateBreaker(recent, config)).toMatchObject({ sample: 50, falsePositives: 4, rate: 0.08, trip: false });
  });
});
