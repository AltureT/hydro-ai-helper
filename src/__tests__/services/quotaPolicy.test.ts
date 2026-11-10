import { defaultLimitFromConfig, effective, explainBase, isOverrideActive, resolveBase } from '../../services/quotaPolicy';

const now = new Date('2026-11-10T08:00:00Z');
const later = new Date('2026-11-17T00:00:00Z');
const earlier = new Date('2026-11-01T00:00:00Z');

describe('resolveBase', () => {
  it.each([
    // [override, grants, caps, default, expected base, source, capped]
    [null, [], [], null, null, 'default', false],
    [null, [], [], 20, 20, 'default', false],
    [null, [60, 40], [], 20, 60, 'grant', false],
    [null, [10], [], 20, 10, 'grant', false],
    [null, [], [5], 20, 5, 'default', true],
    [null, [60], [5, 8], 20, 5, 'grant', true],
    [null, [3], [5], 20, 3, 'grant', false],
    [null, [], [5], null, 5, 'default', true],
    [null, [], [0], 20, 0, 'default', true],
    [null, [60], [0], null, 0, 'grant', true],
    [{ mode: 'limit', dailyLimit: 100, expiresAt: later }, [60], [0], 20, 100, 'override', false],
    [{ mode: 'disabled', expiresAt: null }, [60], [], null, 0, 'override', false],
    [{ mode: 'limit', dailyLimit: 100, expiresAt: earlier }, [60], [], 20, 60, 'grant', false],
  ] as const)('override=%j grants=%j caps=%j default=%j → %j', (override, grants, caps, def, base, source, capped) => {
    expect(resolveBase(override as any, [...grants], [...caps], def, now)).toEqual({ base, source, capped });
  });

  it('ignores invalid limits', () => {
    expect(resolveBase(null, [-1, 2.5, NaN], [-3], 20, now)).toEqual({ base: 20, source: 'default', capped: false });
    expect(isOverrideActive({ mode: 'limit', dailyLimit: -1 }, now)).toBe(false);
  });
});

describe('effective', () => {
  it('keeps unlimited and disabled as they are', () => {
    expect(effective(null, 0.2, 3)).toBeNull();
    expect(effective(0, 1, 3)).toBe(0);
  });

  it('applies the credit multiplier with a guarantee and never exceeds the base', () => {
    expect(effective(20, 1, 3)).toBe(20);
    expect(effective(20, 0.65, 3)).toBe(13);
    expect(effective(20, 0.95, 3)).toBe(19);
    expect(effective(20, 0.2, 3)).toBe(4);
    expect(effective(10, 0.2, 3)).toBe(3);
    expect(effective(2, 0.2, 3)).toBe(2);
    expect(effective(20, 0.2, 0)).toBe(4);
    expect(effective(3, 0.2, 0)).toBe(0);
  });

  it('rounds down without floating-point surprises', () => {
    // 0.7 × 10 = 7.000000000000001, 0.29 × 100 = 28.999999999999996
    expect(effective(10, 0.7, 0)).toBe(7);
    expect(effective(100, 0.29, 0)).toBe(29);
  });

  it('clamps out-of-range multipliers', () => {
    expect(effective(20, 1.5, 3)).toBe(20);
    expect(effective(20, -1, 3)).toBe(3);
    expect(effective(20, NaN, 3)).toBe(20);
  });
});

describe('defaultLimitFromConfig', () => {
  it('treats 0 and invalid values as unlimited', () => {
    expect(defaultLimitFromConfig(0)).toBeNull();
    expect(defaultLimitFromConfig(undefined)).toBeNull();
    expect(defaultLimitFromConfig(-5)).toBeNull();
    expect(defaultLimitFromConfig(20)).toBe(20);
  });
});

describe('explainBase', () => {
  const now = new Date('2026-11-10T08:00:00Z');
  const g = (id: string, mode: 'grant' | 'cap', dailyLimit: number, enabled = true) => ({ id, mode, dailyLimit, enabled });

  it('names the grant group that wins (largest) and the cap group that applies (smallest)', () => {
    const result = explainBase(null, [g('team', 'grant', 60), g('ta', 'grant', 40), g('watch', 'cap', 5), g('soft', 'cap', 30)], 20, now);
    expect(result).toEqual({ base: 5, source: 'grant', capped: true, grantGroupId: 'team', capGroupId: 'watch' });
  });

  it('ignores disabled groups', () => {
    const result = explainBase(null, [g('team', 'grant', 60, false), g('pause', 'cap', 0, false)], 20, now);
    expect(result).toEqual({ base: 20, source: 'default', capped: false, grantGroupId: null, capGroupId: null });
  });

  it('reports no cap group when the cap is not lower than the base', () => {
    const result = explainBase(null, [g('team', 'grant', 60), g('soft', 'cap', 80)], 20, now);
    expect(result).toEqual(expect.objectContaining({ base: 60, capped: false, grantGroupId: 'team', capGroupId: null }));
  });

  it('caps an unlimited default', () => {
    expect(explainBase(null, [g('watch', 'cap', 5)], null, now)).toEqual(
      expect.objectContaining({ base: 5, source: 'default', capped: true, capGroupId: 'watch' }),
    );
  });

  it('lets an active override win over every group', () => {
    const result = explainBase({ mode: 'limit', dailyLimit: 100 }, [g('team', 'grant', 60), g('watch', 'cap', 5)], 20, now);
    expect(result).toEqual({ base: 100, source: 'override', capped: false, grantGroupId: null, capGroupId: null });
  });
});
