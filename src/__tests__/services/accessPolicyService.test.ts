import {
  AccessPolicyResolver,
  deletePolicyWithAudit,
  parseAccessPolicyInput,
  resolveEffectiveAccess,
  upsertPolicyWithAudit,
} from '../../services/accessPolicyService';
import type { AIAccessPolicy } from '../../models/aiAccessPolicy';

const NOW = new Date('2026-10-24T08:00:00Z');
const TODAY = '2026-10-24';

function policy(partial: Partial<AIAccessPolicy> & Pick<AIAccessPolicy, 'scope' | 'target'>): AIAccessPolicy {
  return {
    _id: {} as any,
    domainId: 'd1',
    enabled: true,
    updatedBy: 1,
    updatedAt: NOW,
    ...partial,
  };
}

describe('resolveEffectiveAccess', () => {
  it('falls back to domain defaults when no policy applies', () => {
    const access = resolveEffectiveAccess([], { uid: 42, groups: ['A'], now: NOW });
    expect(access).toMatchObject({
      enabled: true,
      enabledSource: 'default',
      dailyTokenLimit: undefined,
      dailyTokenLimitSource: 'default',
      rateLimitPerMinute: undefined,
      extraTokens: 0,
    });
  });

  it('prefers the user policy over group policies field by field', () => {
    const access = resolveEffectiveAccess([
      policy({ scope: 'user', target: 42, dailyTokenLimit: 500 }),
      policy({ scope: 'group', target: 'A', dailyTokenLimit: 9000, rateLimitPerMinute: 12 }),
    ], { uid: 42, groups: ['A'], now: NOW });
    expect(access.dailyTokenLimit).toBe(500);
    expect(access.dailyTokenLimitSource).toBe('user');
    // 用户策略未设置频率 → 回退到组策略
    expect(access.rateLimitPerMinute).toBe(12);
    expect(access.rateLimitSource).toBe('group');
  });

  it('uses the most permissive limit across several groups, treating 0 as unlimited', () => {
    const groups = ['A', 'B', 'C'];
    expect(resolveEffectiveAccess([
      policy({ scope: 'group', target: 'A', dailyTokenLimit: 1000 }),
      policy({ scope: 'group', target: 'B', dailyTokenLimit: 5000 }),
    ], { uid: 42, groups, now: NOW }).dailyTokenLimit).toBe(5000);

    expect(resolveEffectiveAccess([
      policy({ scope: 'group', target: 'A', dailyTokenLimit: 1000 }),
      policy({ scope: 'group', target: 'C', dailyTokenLimit: 0 }),
    ], { uid: 42, groups, now: NOW }).dailyTokenLimit).toBe(0);
  });

  it('ignores policies of groups the user is not a member of', () => {
    const access = resolveEffectiveAccess([
      policy({ scope: 'group', target: 'Other', enabled: false }),
    ], { uid: 42, groups: ['A'], now: NOW });
    expect(access.enabled).toBe(true);
  });

  it('disables through any disabled group unless the user policy explicitly enables', () => {
    const groupDisabled = policy({ scope: 'group', target: 'B', enabled: false });
    const viaGroup = resolveEffectiveAccess([
      policy({ scope: 'group', target: 'A', enabled: true, dailyTokenLimit: 0 }),
      groupDisabled,
    ], { uid: 42, groups: ['A', 'B'], now: NOW });
    expect(viaGroup.enabled).toBe(false);
    expect(viaGroup.disabledBy).toEqual({ scope: 'group', target: 'B' });

    const userOverride = resolveEffectiveAccess([
      groupDisabled,
      policy({ scope: 'user', target: 42, enabled: true }),
    ], { uid: 42, groups: ['B'], now: NOW });
    expect(userOverride.enabled).toBe(true);
    expect(userOverride.enabledSource).toBe('user');
  });

  it('always lets a disabled user policy win over enabled groups', () => {
    const access = resolveEffectiveAccess([
      policy({ scope: 'group', target: 'A', enabled: true, dailyTokenLimit: 0 }),
      policy({ scope: 'user', target: 42, enabled: false }),
    ], { uid: 42, groups: ['A'], now: NOW });
    expect(access.enabled).toBe(false);
    expect(access.disabledBy).toEqual({ scope: 'user', target: 42 });
  });

  it('ignores expired policies', () => {
    const access = resolveEffectiveAccess([
      policy({ scope: 'user', target: 42, enabled: false, expiresAt: new Date('2026-10-24T07:59:59Z') }),
      policy({ scope: 'group', target: 'A', dailyTokenLimit: 777, expiresAt: new Date('2026-10-25T00:00:00Z') }),
    ], { uid: 42, groups: ['A'], now: NOW });
    expect(access.enabled).toBe(true);
    expect(access.dailyTokenLimit).toBe(777);
  });

  it('counts extra tokens only on the granted date and combines user + best group top-up', () => {
    const access = resolveEffectiveAccess([
      policy({ scope: 'user', target: 42, extraTokens: { date: TODAY, amount: 300 } }),
      policy({ scope: 'group', target: 'A', extraTokens: { date: TODAY, amount: 100 } }),
      policy({ scope: 'group', target: 'B', extraTokens: { date: TODAY, amount: 200 } }),
      policy({ scope: 'group', target: 'C', extraTokens: { date: '2026-10-23', amount: 9999 } }),
    ], { uid: 42, groups: ['A', 'B', 'C'], now: NOW });
    expect(access.extraTokens).toBe(500);

    const stale = resolveEffectiveAccess([
      policy({ scope: 'user', target: 42, extraTokens: { date: '2026-10-23', amount: 300 } }),
    ], { uid: 42, groups: [], now: NOW });
    expect(stale.extraTokens).toBe(0);
  });
});

describe('AccessPolicyResolver', () => {
  it('looks up groups and policies once per user within a request', async () => {
    const findForUser = jest.fn().mockResolvedValue([
      policy({ scope: 'group', target: 'A', enabled: false }),
    ]);
    const groupLookup = jest.fn().mockResolvedValue(['A']);
    const resolver = new AccessPolicyResolver({ findForUser }, groupLookup);

    const [first, second] = await Promise.all([
      resolver.resolve('d1', 42, NOW),
      resolver.resolve('d1', 42, NOW),
    ]);
    await resolver.resolve('d1', 42, NOW);

    expect(first.enabled).toBe(false);
    expect(second).toBe(first);
    expect(groupLookup).toHaveBeenCalledTimes(1);
    expect(findForUser).toHaveBeenCalledWith('d1', 42, ['A']);
    expect(findForUser).toHaveBeenCalledTimes(1);
  });

  it('does not cache failed lookups', async () => {
    const findForUser = jest.fn()
      .mockRejectedValueOnce(new Error('Synthetic database failure'))
      .mockResolvedValueOnce([]);
    const resolver = new AccessPolicyResolver({ findForUser }, async () => []);
    await expect(resolver.resolve('d1', 42)).rejects.toThrow('Synthetic database failure');
    await expect(resolver.resolve('d1', 42)).resolves.toMatchObject({ enabled: true });
  });
});

describe('parseAccessPolicyInput', () => {
  it('maps blank values to null (clear override) and sets today\'s top-up', () => {
    const result = parseAccessPolicyInput({
      enabled: false,
      dailyTokenLimit: '',
      extraTokensToday: 2000,
      rateLimitPerMinute: null,
      expiresAt: '2026-11-01T00:00:00.000Z',
      reason: '  cheating  ',
    }, NOW);
    expect(result).toEqual({
      ok: true,
      patch: {
        enabled: false,
        dailyTokenLimit: null,
        extraTokens: { date: TODAY, amount: 2000 },
        rateLimitPerMinute: null,
        expiresAt: new Date('2026-11-01T00:00:00.000Z'),
        reason: 'cheating',
      },
    });
  });

  it('clears the top-up when 0 is submitted', () => {
    expect(parseAccessPolicyInput({ extraTokensToday: 0 }, NOW)).toEqual({ ok: true, patch: { extraTokens: null } });
  });

  it.each([
    [{ enabled: 'yes' }, 'enabled'],
    [{ dailyTokenLimit: -1 }, 'dailyTokenLimit'],
    [{ dailyTokenLimit: 1.5 }, 'dailyTokenLimit'],
    [{ rateLimitPerMinute: 100000 }, 'rateLimitPerMinute'],
    [{ extraTokensToday: 'abc' }, 'extraTokensToday'],
    [{ expiresAt: '2020-01-01T00:00:00Z' }, 'expiresAt'],
    [{ expiresAt: 'not-a-date' }, 'expiresAt'],
    [{ reason: 'x'.repeat(201) }, 'reason'],
  ])('rejects invalid input %j', (input, field) => {
    expect(parseAccessPolicyInput(input as any, NOW)).toEqual({ ok: false, field });
  });
});

describe('policy writes with audit', () => {
  it('records before/after snapshots for upserts', async () => {
    const before = policy({ scope: 'user', target: 42, dailyTokenLimit: 100 });
    const after = policy({ scope: 'user', target: 42, dailyTokenLimit: 200 });
    const models = {
      policyModel: { upsert: jest.fn().mockResolvedValue({ before, after }), delete: jest.fn() },
      auditModel: { record: jest.fn().mockResolvedValue(undefined) },
    };
    const result = await upsertPolicyWithAudit(models, {
      domainId: 'd1', scope: 'user', target: 42, patch: { dailyTokenLimit: 200 }, operatorUid: 7, batchId: 'b1',
    });
    expect(result).toBe(after);
    expect(models.policyModel.upsert).toHaveBeenCalledWith('d1', 'user', 42, { dailyTokenLimit: 200 }, 7);
    expect(models.auditModel.record).toHaveBeenCalledWith({
      domainId: 'd1', scope: 'user', target: 42, action: 'upsert', before, after, operatorUid: 7, batchId: 'b1',
    });
  });

  it('records deletes and skips the audit when nothing was deleted', async () => {
    const before = policy({ scope: 'group', target: 'A' });
    const models = {
      policyModel: { upsert: jest.fn(), delete: jest.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(null) },
      auditModel: { record: jest.fn().mockResolvedValue(undefined) },
    };
    await expect(deletePolicyWithAudit(models, { domainId: 'd1', scope: 'group', target: 'A', operatorUid: 7 })).resolves.toBe(true);
    await expect(deletePolicyWithAudit(models, { domainId: 'd1', scope: 'group', target: 'A', operatorUid: 7 })).resolves.toBe(false);
    expect(models.auditModel.record).toHaveBeenCalledTimes(1);
    expect(models.auditModel.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'delete', before, after: null }));
  });
});
