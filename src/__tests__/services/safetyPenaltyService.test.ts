import { decideSafetyPenalty } from '../../services/safetyPenaltyService';

describe('decideSafetyPenalty', () => {
  const now = new Date('2026-07-23T00:00:00Z');

  function createModel(recentCount: number) {
    return {
      countRecentByCategories: jest.fn().mockResolvedValue(recentCount),
    } as any;
  }

  it('blocks the first two answer-seeking attempts without a cooldown', async () => {
    const result = await decideSafetyPenalty(createModel(1), 'domain-a', 42, 'answer_seeking', now);
    expect(result).toEqual({ action: 'blocked' });
  });

  it('applies a 60 second cooldown on the third answer-seeking attempt', async () => {
    const result = await decideSafetyPenalty(createModel(2), 'domain-a', 42, 'answer_seeking', now);
    expect(result.action).toBe('cooldown_60s');
    expect(result.retryAfterSeconds).toBe(60);
    expect(result.blockedUntil).toEqual(new Date('2026-07-23T00:01:00Z'));
  });

  it('blocks the first high-risk injection without a cooldown', async () => {
    const result = await decideSafetyPenalty(createModel(0), 'domain-a', 42, 'prompt_injection', now);
    expect(result).toEqual({ action: 'blocked' });
  });

  it('applies a five minute cooldown on the second high-risk event', async () => {
    const model = createModel(1);
    const result = await decideSafetyPenalty(model, 'domain-a', 42, 'obfuscated_injection', now);
    expect(result.action).toBe('cooldown_5m');
    expect(result.retryAfterSeconds).toBe(300);
    expect(result.blockedUntil).toEqual(new Date('2026-07-23T00:05:00Z'));
    expect(model.countRecentByCategories).toHaveBeenCalledWith(
      'domain-a',
      42,
      ['prompt_injection', 'prompt_exfiltration', 'obfuscated_injection'],
      new Date('2026-07-22T23:50:00Z')
    );
  });
});
