import {
  findingActionKey,
  formatPercent,
  formatTokens,
  formatUSD,
  markFindingReviewed,
  parseNameList,
  parseSettingsForm,
  runStatusKey,
  runTone,
  sameSettings,
  settingsToForm,
  type AIReviewSettings,
  type ReviewFindingView,
} from '../../../frontend/admin/reviewLogic';

const saved: AIReviewSettings = {
  enabled: false, runAt: '02:00', sampleRate: 0.05, maxConversations: 200,
  breakerWindow: 50, breakerMinSample: 10, breakerThreshold: 0.2,
};

describe('AI review settings form', () => {
  it('round-trips the saved settings with the sample rate as a percentage', () => {
    const form = settingsToForm(saved);
    expect(form).toEqual({ enabled: false, runAt: '02:00', samplePercent: '5', maxConversations: '200' });
    const parsed = parseSettingsForm(form);
    expect(parsed.errors).toEqual([]);
    expect(sameSettings(parsed.patch, saved)).toBe(true);
  });

  it('converts percentages and detects changes', () => {
    const parsed = parseSettingsForm({ enabled: true, runAt: '03:30', samplePercent: '12.5%', maxConversations: '300' });
    expect(parsed).toEqual({ patch: { enabled: true, runAt: '03:30', sampleRate: 0.125, maxConversations: 300 }, errors: [] });
    expect(sameSettings(parsed.patch, saved)).toBe(false);
  });

  it('rejects values the server would reject', () => {
    expect(parseSettingsForm({ enabled: true, runAt: '24:00', samplePercent: '101', maxConversations: '0' }).errors)
      .toEqual(['runAt', 'samplePercent', 'maxConversations']);
    expect(parseSettingsForm({ enabled: true, runAt: '2:00', samplePercent: 'abc', maxConversations: '5001' }).errors)
      .toEqual(['runAt', 'samplePercent', 'maxConversations']);
  });
});

describe('AI review display helpers', () => {
  it('parses name lists separated by lines, commas or spaces', () => {
    expect(parseNameList('2302吴九\n2303郑十，2302吴九、 alice  bob')).toEqual(['2302吴九', '2303郑十', 'alice', 'bob']);
    expect(parseNameList('  \n ')).toEqual([]);
  });

  it('formats rates, tokens and cost', () => {
    expect(formatPercent(0.08)).toBe('8%');
    expect(formatPercent(0.125)).toBe('12.5%');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(410_000)).toBe('410k');
    expect(formatTokens(1_230_000)).toBe('1.2M');
    expect(formatUSD(0.0021)).toBe('$0.002');
    expect(formatUSD(1.734)).toBe('$1.73');
  });

  it('labels run status with the reason for skipped or failed runs', () => {
    expect(runStatusKey({ status: 'skipped', error: 'model_unavailable' })).toBe('ai_helper_review_run_status_model_unavailable');
    expect(runStatusKey({ status: 'failed', error: 'model_failed' })).toBe('ai_helper_review_run_status_model_failed');
    expect(runStatusKey({ status: 'completed' })).toBe('ai_helper_review_run_status_completed');
    expect([runTone({ status: 'completed' }), runTone({ status: 'failed' }), runTone({ status: 'skipped' }), runTone({ status: 'running' })])
      .toEqual(['ok', 'error', 'muted', 'info']);
  });

  it('labels findings as “auto-penalized, awaiting review” (FR-045)', () => {
    expect(findingActionKey({ autoPenalized: true, reviewStatus: 'pending' })).toBe('ai_helper_review_auto_penalized_pending');
    expect(findingActionKey({ autoPenalized: true, reviewStatus: 'confirmed' })).toBe('ai_helper_review_auto_penalized');
    expect(findingActionKey({ autoPenalized: false, reviewStatus: 'pending' })).toBe('ai_helper_review_flagged_pending');
    expect(findingActionKey({ autoPenalized: true, reviewStatus: 'false_positive' })).toBe('ai_helper_review_penalty_revoked');
  });

  it('updates a reviewed finding in place', () => {
    const findings = [{ id: 'a', reviewStatus: 'pending' }, { id: 'b', reviewStatus: 'pending' }] as ReviewFindingView[];
    expect(markFindingReviewed(findings, 'b', 'false_positive').map((f) => f.reviewStatus)).toEqual(['pending', 'false_positive']);
  });
});
