import {
  DEFAULT_CREDIT_RULES,
  creditExample,
  formatMultiplier,
  parseRulesForm,
  recoveryDaysFrom,
  rulesToForm,
  sameRules,
} from '../../../frontend/admin/creditLogic';
import { parseKeywordLines, parseTopicGuardForm, sameTopicGuard, DEFAULT_TOPIC_GUARD } from '../../../frontend/admin/offTopicLogic';

describe('creditLogic', () => {
  it('matches the design example with the default rules: 0.65, 13 a day, 7 days to recover', () => {
    expect(creditExample(DEFAULT_CREDIT_RULES, 20, 3)).toEqual({ base: 20, deductions: [0.05, 0.1, 0.2], m: 0.65, daily: 13, recoveryDays: 7 });
  });

  it('applies the cap, floor and guarantee in the example', () => {
    const rules = { ...DEFAULT_CREDIT_RULES, maxDeduction: 0.1, floor: 0.9, weights: { ...DEFAULT_CREDIT_RULES.weights, off_topic: 0.08 } };
    expect(creditExample(rules, 5, 3)).toEqual(expect.objectContaining({ deductions: [0.08, 0.1, 0.1], m: 0.9, daily: 4 }));
    expect(creditExample({ ...DEFAULT_CREDIT_RULES, floor: 0 }, 4, 3).daily).toBe(3);
    expect(creditExample({ ...DEFAULT_CREDIT_RULES, recoveryPerDay: 0 }, 20, 3).recoveryDays).toBeNull();
    expect(creditExample({ ...DEFAULT_CREDIT_RULES, weights: { ...DEFAULT_CREDIT_RULES.weights, off_topic: 0 } }, 20, 3))
      .toEqual(expect.objectContaining({ m: 1, daily: 20, recoveryDays: 0 }));
  });

  it('round-trips the form and validates ranges like the server', () => {
    const form = rulesToForm(DEFAULT_CREDIT_RULES);
    const parsed = parseRulesForm(form);
    expect(parsed).toEqual({ ok: true, rules: DEFAULT_CREDIT_RULES });
    expect(parseRulesForm({ ...form, floor: '1.5', escalationWindowMinutes: '0', weights: { ...form.weights, answer_seeking: '-0.1' } }))
      .toEqual({ ok: false, errors: ['floor', 'escalationWindowMinutes', 'weights.answer_seeking'] });
    expect(parseRulesForm({ ...form, recoveryPerDay: '.5' })).toEqual(expect.objectContaining({ ok: true }));
  });

  it('compares rule sets field by field', () => {
    expect(sameRules(DEFAULT_CREDIT_RULES, { ...DEFAULT_CREDIT_RULES, weights: { ...DEFAULT_CREDIT_RULES.weights } })).toBe(true);
    expect(sameRules(DEFAULT_CREDIT_RULES, { ...DEFAULT_CREDIT_RULES, weights: { ...DEFAULT_CREDIT_RULES.weights, off_topic: 0.06 } })).toBe(false);
  });

  it('rounds recovery to whole days and formats the multiplier', () => {
    const now = new Date('2026-11-10T00:00:00Z');
    expect(recoveryDaysFrom('2026-11-11T06:00:00Z', now)).toBe(2);
    expect(recoveryDaysFrom('2026-11-10T00:30:00Z', now)).toBe(1);
    expect(recoveryDaysFrom(null, now)).toBeNull();
    expect(formatMultiplier(0.65)).toBe('0.65');
    expect(formatMultiplier(0.9)).toBe('0.9');
    expect(formatMultiplier(1)).toBe('1');
    expect(formatMultiplier(0.3503)).toBe('0.35');
  });
});

describe('offTopicLogic', () => {
  it('splits keywords by line, trimming blanks and duplicates', () => {
    expect(parseKeywordLines(' 火锅 \n\n追剧\n火锅\r\n明星八卦 ')).toEqual(['火锅', '追剧', '明星八卦']);
  });

  it('validates the form like the server', () => {
    expect(parseTopicGuardForm({ keywordsText: '火锅', codeChars: '30', windowHours: '24' }))
      .toEqual({ settings: { customOffTopicKeywords: ['火锅'], codeExemptMinChars: 30, strikeWindowHours: 24 }, errors: [] });
    expect(parseTopicGuardForm({ keywordsText: 'x'.repeat(51), codeChars: '-1', windowHours: '200' }).errors)
      .toEqual(['too_long', 'code_chars', 'window']);
    const many = Array.from({ length: 201 }, (_, i) => `词${i}`).join('\n');
    expect(parseTopicGuardForm({ keywordsText: many, codeChars: '0', windowHours: '1' }).errors).toEqual(['too_many']);
  });

  it('detects unsaved changes', () => {
    expect(sameTopicGuard(DEFAULT_TOPIC_GUARD, { ...DEFAULT_TOPIC_GUARD, customOffTopicKeywords: [] })).toBe(true);
    expect(sameTopicGuard(DEFAULT_TOPIC_GUARD, { ...DEFAULT_TOPIC_GUARD, customOffTopicKeywords: ['火锅'] })).toBe(false);
  });
});
