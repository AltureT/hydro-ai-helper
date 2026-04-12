import { getClassSizeStrategy } from '../../../services/analyzers/classSizeStrategy';

describe('getClassSizeStrategy', () => {
  it('returns individual-only strategy for <10 students', () => {
    const strategy = getClassSizeStrategy(8, 0);
    expect(strategy.label).toBe('individual');
    expect(strategy.disabledDimensions).toContain('commonError');
    expect(strategy.disabledDimensions).toContain('aiEffectiveness');
    expect(strategy.disabledDimensions).toContain('difficulty');
    expect(strategy.minAffected).toBe(3);
  });

  it('returns mixed strategy for 10-20 students', () => {
    const strategy = getClassSizeStrategy(15, 3);
    expect(strategy.label).toBe('mixed');
    expect(strategy.minAffected).toBe(3);
    expect(strategy.ratioThreshold).toBe(0.25);
  });

  it('disables aiEffectiveness in mixed mode when AI users < 5', () => {
    const strategy = getClassSizeStrategy(15, 2);
    expect(strategy.disabledDimensions).toContain('aiEffectiveness');
  });

  it('enables aiEffectiveness in mixed mode when AI users >= 5', () => {
    const strategy = getClassSizeStrategy(15, 5);
    expect(strategy.disabledDimensions).not.toContain('aiEffectiveness');
  });

  it('returns full strategy for 20-100 students', () => {
    const strategy = getClassSizeStrategy(50, 10);
    expect(strategy.label).toBe('full');
    expect(strategy.disabledDimensions).toEqual([]);
    expect(strategy.minAffected).toBe(5);
  });

  it('returns full strategy for >100 students', () => {
    const strategy = getClassSizeStrategy(150, 30);
    expect(strategy.label).toBe('full');
    expect(strategy.disabledDimensions).toEqual([]);
  });
});
