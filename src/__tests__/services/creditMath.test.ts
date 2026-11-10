import { computeCredit, realtimeDeduction, DAY_MS } from '../../services/creditMath';
import { effective } from '../../services/quotaPolicy';

const PARAMS = { floor: 0.2, recoveryPerDay: 0.05 };
const T0 = new Date('2026-11-10T02:00:00Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60 * 1000);
const deduction = (when: Date, value: number, extra: Record<string, unknown> = {}) => ({ at: when, type: 'deduction' as const, deduction: value, ...extra });

describe('creditMath', () => {
  it('starts at 1.0 with nothing to recover', () => {
    expect(computeCredit([], PARAMS, T0)).toEqual({ m: 1, gap: 0, recoveryAt: null });
  });

  it('scenario 1: one answer-seeking deduction turns a base of 20 into 18 today', () => {
    const state = computeCredit([deduction(T0, 0.1)], PARAMS, T0);
    expect(state.m).toBe(0.9);
    expect(effective(20, state.m, 3)).toBe(18);
  });

  it('scenario 2: three off-topic violations within the hour deduct 0.05, 0.1 and 0.2', () => {
    const steps = [1, 2, 3].map((k) => realtimeDeduction(0.05, k, 0.4));
    expect(steps).toEqual([0.05, 0.1, 0.2]);
    const events = steps.map((value) => deduction(T0, value));
    expect(computeCredit(events, PARAMS, T0).m).toBe(0.65);
  });

  it('caps a single deduction at the configured maximum', () => {
    expect(realtimeDeduction(0.25, 1, 0.4)).toBe(0.25);
    expect(realtimeDeduction(0.25, 2, 0.4)).toBe(0.4);
    expect(realtimeDeduction(0.1, 10, 0.4)).toBe(0.4);
    expect(realtimeDeduction(0.1, 0, 0.4)).toBe(0.1);
  });

  it('scenario 3: recovers 0.05 per day without violations, linearly', () => {
    const events = [deduction(T0, 0.4)];
    expect(computeCredit(events, PARAMS, T0).m).toBe(0.6);
    expect(computeCredit(events, PARAMS, new Date(T0.getTime() + 4 * DAY_MS)).m).toBe(0.8);
    expect(computeCredit(events, PARAMS, new Date(T0.getTime() + 12 * DAY_MS)).m).toBe(1);
  });

  it('applies recovery between events before adding the next deduction', () => {
    const events = [deduction(T0, 0.3), deduction(new Date(T0.getTime() + 2 * DAY_MS), 0.1)];
    // 0.3 → 两天后恢复到 0.2 → 再扣 0.1 → 差距 0.3
    expect(computeCredit(events, PARAMS, new Date(T0.getTime() + 2 * DAY_MS)).m).toBe(0.7);
  });

  it('scenario 4: never drops below the floor, and the guarantee keeps at least 3 a day', () => {
    const events = Array.from({ length: 10 }, (_, i) => deduction(at(i), 0.4));
    const state = computeCredit(events, PARAMS, at(10));
    expect(state.m).toBe(0.2);
    expect(effective(20, state.m, 3)).toBe(4);
    expect(effective(10, state.m, 3)).toBe(3);
    // 基础额度低于保底时以基础额度为准；为 0 时仍是 0
    expect(effective(2, state.m, 3)).toBe(2);
    expect(effective(0, state.m, 3)).toBe(0);
    expect(effective(null, state.m, 3)).toBeNull();
  });

  it('scenario 5: ignores revoked deductions, so a false positive is recomputed away', () => {
    const events = [deduction(T0, 0.1), deduction(at(5), 0.2, { revokedAt: at(30) })];
    // 30 分钟内恢复约 0.001
    expect(computeCredit(events, PARAMS, at(30)).m).toBe(0.901);
  });

  it('a reset at the same instant as a deduction clears it', () => {
    const events = [{ at: T0, type: 'reset' as const }, deduction(T0, 0.3)];
    expect(computeCredit(events, PARAMS, T0).m).toBe(1);
  });

  it('a reset brings the coefficient back to 1.0; later deductions count again', () => {
    const events = [
      deduction(T0, 0.4),
      { at: at(10), type: 'reset' as const },
      deduction(at(20), 0.1),
    ];
    expect(computeCredit(events.slice(0, 2), PARAMS, at(10)).m).toBe(1);
    expect(computeCredit(events, PARAMS, at(20)).m).toBe(0.9);
  });

  it('ignores events in the future and processes events in time order', () => {
    const events = [deduction(at(60), 0.2), deduction(T0, 0.1)];
    expect(computeCredit(events, PARAMS, at(30)).m).toBe(0.901);
  });

  it('reports the exact time the coefficient is back to 1.0', () => {
    const state = computeCredit([deduction(T0, 0.1)], PARAMS, T0);
    expect(state.recoveryAt).toEqual(new Date(T0.getTime() + 2 * DAY_MS));
    expect(computeCredit([deduction(T0, 0.1)], { floor: 0.2, recoveryPerDay: 0 }, T0).recoveryAt).toBeNull();
  });

  it('events older than the 30-day lookback no longer matter with default settings', () => {
    // 最大差距 0.8 ÷ 每天 0.05 = 16 天恢复完
    const events = Array.from({ length: 5 }, (_, i) => deduction(at(i), 0.4));
    expect(computeCredit(events, PARAMS, at(4)).m).toBe(0.2);
    expect(computeCredit(events, PARAMS, new Date(at(4).getTime() + 16 * DAY_MS)).m).toBe(1);
  });
});
