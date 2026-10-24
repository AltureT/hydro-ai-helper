/**
 * AI 访问策略管理 Handler（域管理员）
 *
 * GET  /ai-helper/admin/access               页面（HTML）或域默认配置概览（JSON）
 * GET  /ai-helper/admin/access/users         用户列表 + 今日用量 + 生效策略
 * GET  /ai-helper/admin/access/groups        HydroOJ 域用户组 + 组策略
 * GET  /ai-helper/admin/access/audit         策略变更审计日志
 * POST /ai-helper/admin/access/policy        创建/修改单条策略
 * POST /ai-helper/admin/access/policy/delete 删除单条策略
 * POST /ai-helper/admin/access/batch         对某用户组的全部成员批量写入/清除用户级策略
 *
 * 权限：系统管理员，或在当前域拥有 DomainAdminPerm 的用户。策略始终按 domainId 隔离。
 */

import { Handler, PRIV, db } from 'hydrooj';
import { DomainAdminPerm } from '../constants/permissions';
import { getDomainId } from '../utils/domainHelper';
import { translateWithParams } from '../utils/i18nHelper';
import { rejectIfCsrfInvalid } from '../lib/csrfHelper';
import { applyRateLimit } from '../lib/rateLimitHelper';
import { AIConfigModel } from '../models/aiConfig';
import { TokenUsageModel } from '../models/tokenUsage';
import {
  ACCESS_POLICY_SCOPES, type AccessPolicyScope, type AIAccessPolicy, type AIAccessPolicyModel,
} from '../models/aiAccessPolicy';
import type { AIAccessAuditModel } from '../models/aiAccessAudit';
import {
  ACCESS_LIMITS,
  type AccessPolicyInput,
  deletePolicyWithAudit,
  listHydroGroups,
  newBatchId,
  parseAccessPolicyInput,
  resolveEffectiveAccess,
  todayUTC,
  upsertPolicyWithAudit,
} from '../services/accessPolicyService';
import { effectiveUserDailyLimit } from '../services/budgetService';

const USERS_PAGE_SIZE = 50;
const MAX_BATCH_MEMBERS = 2000;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 5;

export function canManageAccess(handler: Handler): boolean {
  const user = handler.user;
  if (!user) return false;
  if (typeof user.hasPriv === 'function' && user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)) return true;
  return typeof user.hasPerm === 'function' && user.hasPerm(DomainAdminPerm);
}

function sendJson(handler: Handler, status: number, body: Record<string, unknown>): void {
  handler.response.status = status;
  handler.response.body = body;
  handler.response.type = 'application/json';
}

function rejectIfCannotManage(handler: Handler): boolean {
  if (canManageAccess(handler)) return false;
  sendJson(handler, 403, { error: handler.translate('ai_helper_access_err_forbidden'), code: 'PERMISSION_DENIED' });
  return true;
}

function badRequest(handler: Handler, field: string): void {
  sendJson(handler, 400, {
    error: translateWithParams(handler, 'ai_helper_access_err_invalid_field', field),
    code: 'INVALID_ARGUMENT',
    field,
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function serializePolicy(policy: AIAccessPolicy | null | undefined) {
  if (!policy) return null;
  return {
    scope: policy.scope,
    target: policy.target,
    enabled: policy.enabled !== false,
    dailyTokenLimit: policy.dailyTokenLimit ?? null,
    extraTokens: policy.extraTokens ?? null,
    rateLimitPerMinute: policy.rateLimitPerMinute ?? null,
    expiresAt: policy.expiresAt ? new Date(policy.expiresAt).toISOString() : null,
    expired: policy.expiresAt ? new Date(policy.expiresAt).getTime() <= Date.now() : false,
    reason: policy.reason ?? null,
    updatedBy: policy.updatedBy,
    updatedAt: policy.updatedAt ? new Date(policy.updatedAt).toISOString() : null,
  };
}

async function getUserNames(uids: number[]): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  if (uids.length === 0) return names;
  const docs = await db.collection('user').find({ _id: { $in: uids } }).toArray();
  for (const doc of docs) names.set(doc._id as number, (doc as { uname?: string }).uname || String(doc._id));
  return names;
}

function getModels(handler: Handler) {
  return {
    policyModel: handler.ctx.get('aiAccessPolicyModel') as AIAccessPolicyModel,
    auditModel: handler.ctx.get('aiAccessAuditModel') as AIAccessAuditModel,
  };
}

function parseScopeTarget(handler: Handler, body: Record<string, unknown>): { scope: AccessPolicyScope; target: number | string } | null {
  const scope = body.scope as AccessPolicyScope;
  if (!ACCESS_POLICY_SCOPES.includes(scope)) {
    badRequest(handler, 'scope');
    return null;
  }
  if (scope === 'user') {
    const uid = typeof body.target === 'number' ? body.target : Number(body.target);
    if (!Number.isInteger(uid) || uid <= 1) {
      badRequest(handler, 'target');
      return null;
    }
    return { scope, target: uid };
  }
  const name = typeof body.target === 'string' ? body.target.trim() : '';
  if (!name || name.length > ACCESS_LIMITS.maxGroupNameLength) {
    badRequest(handler, 'target');
    return null;
  }
  return { scope, target: name };
}

/**
 * 目标必须真实存在：用户存在于 user 集合；用户组存在于当前域
 */
async function targetExists(domainId: string, scope: AccessPolicyScope, target: number | string): Promise<boolean> {
  if (scope === 'user') {
    return Boolean(await db.collection('user').findOne({ _id: target as number }));
  }
  return Boolean(await db.collection('user.group').findOne({ domainId, name: target as string }));
}

/**
 * GET /ai-helper/admin/access
 */
export class AccessPolicyHandler extends Handler {
  async get() {
    if (rejectIfCannotManage(this)) return;
    const accept = this.request.headers?.accept || '';
    if (accept.includes('text/html')) {
      this.response.template = 'ai-helper/access_policy.html';
      this.response.body = {};
      return;
    }
    const aiConfigModel: AIConfigModel = this.ctx.get('aiConfigModel');
    const config = await aiConfigModel.getConfig();
    const budget = config?.budgetConfig ?? {};
    sendJson(this, 200, {
      domainId: getDomainId(this),
      today: todayUTC(),
      defaults: {
        dailyTokenLimitPerUser: budget.dailyTokenLimitPerUser ?? 0,
        dailyTokenLimitPerDomain: budget.dailyTokenLimitPerDomain ?? 0,
        monthlyTokenLimitPerDomain: budget.monthlyTokenLimitPerDomain ?? 0,
        rateLimitPerMinute: config?.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE,
      },
      limits: ACCESS_LIMITS,
    });
  }
}

/**
 * GET /ai-helper/admin/access/groups
 */
export class AccessPolicyGroupsHandler extends Handler {
  async get() {
    if (rejectIfCannotManage(this)) return;
    const domainId = getDomainId(this);
    const { policyModel } = getModels(this);
    const [groups, policies] = await Promise.all([
      listHydroGroups(domainId),
      policyModel.list(domainId, 'group'),
    ]);
    const policyByName = new Map(policies.map((p) => [String(p.target), p]));
    const known = new Set(groups.map((g) => g.name));
    sendJson(this, 200, {
      groups: groups.map((g) => ({
        name: g.name,
        memberCount: g.uids.length,
        policy: serializePolicy(policyByName.get(g.name)),
      })),
      // 组已在 HydroOJ 中删除但策略仍在：列出以便管理员清理
      orphanPolicies: policies.filter((p) => !known.has(String(p.target))).map(serializePolicy),
    });
  }
}

/**
 * GET /ai-helper/admin/access/users?group=&q=&onlyPolicies=1&page=
 */
export class AccessPolicyUsersHandler extends Handler {
  async get() {
    if (rejectIfCannotManage(this)) return;
    const domainId = getDomainId(this);
    const query = (this.request.query || {}) as Record<string, string | undefined>;
    const page = Math.max(1, parseInt(query.page || '1', 10) || 1);
    const groupFilter = query.group?.trim() || '';
    const q = query.q?.trim().slice(0, 50) || '';
    const onlyPolicies = query.onlyPolicies === '1' || query.onlyPolicies === 'true';

    const { policyModel } = getModels(this);
    const tokenUsageModel: TokenUsageModel = this.ctx.get('tokenUsageModel');
    const aiConfigModel: AIConfigModel = this.ctx.get('aiConfigModel');

    const [groups, groupPolicies, config] = await Promise.all([
      listHydroGroups(domainId),
      policyModel.list(domainId, 'group'),
      aiConfigModel.getConfig(),
    ]);

    // 1. 候选用户集合（未加筛选时直接分页读取 domain.user）
    let candidateUids: number[] | null = null;
    if (groupFilter) {
      candidateUids = groups.find((g) => g.name === groupFilter)?.uids ?? [];
    }
    if (onlyPolicies) {
      const userPolicies = await policyModel.list(domainId, 'user');
      const withPolicy = userPolicies.map((p) => Number(p.target));
      candidateUids = candidateUids ? candidateUids.filter((u) => withPolicy.includes(u)) : withPolicy;
    }
    if (q) {
      const matched: number[] = [];
      if (/^\d+$/.test(q)) matched.push(Number(q));
      const byName = await db.collection('user')
        .find({ unameLower: { $regex: `^${escapeRegex(q.toLowerCase())}` } })
        .limit(200)
        .toArray();
      for (const doc of byName) matched.push(doc._id as number);
      candidateUids = candidateUids ? candidateUids.filter((u) => matched.includes(u)) : matched;
      if (!groupFilter && !onlyPolicies) {
        // 仅保留本域成员
        const members = await db.collection('domain.user')
          .find({ domainId, uid: { $in: candidateUids } })
          .toArray();
        const memberSet = new Set(members.map((m) => m.uid as number));
        candidateUids = candidateUids.filter((u) => memberSet.has(u));
      }
    }

    let total: number;
    let pageUids: number[];
    if (candidateUids) {
      const unique = [...new Set(candidateUids)].filter((u) => u > 1).sort((a, b) => a - b);
      total = unique.length;
      pageUids = unique.slice((page - 1) * USERS_PAGE_SIZE, page * USERS_PAGE_SIZE);
    } else {
      const coll = db.collection('domain.user');
      const filter = { domainId, uid: { $gt: 1 } };
      total = await coll.countDocuments(filter);
      const docs = await coll.find(filter)
        .sort({ uid: 1 })
        .skip((page - 1) * USERS_PAGE_SIZE)
        .limit(USERS_PAGE_SIZE)
        .toArray();
      pageUids = docs.map((d) => d.uid as number);
    }

    // 2. 批量加载本页用户的名称、今日用量和策略，按内存计算生效配置（避免 N 次查询）
    const today = todayUTC();
    const [names, usage, userPolicies] = await Promise.all([
      getUserNames(pageUids),
      tokenUsageModel.getUsersDailyUsage(domainId, pageUids, today),
      pageUids.length ? policyModel.list(domainId, 'user', pageUids) : Promise.resolve([]),
    ]);
    const userPolicyByUid = new Map(userPolicies.map((p) => [Number(p.target), p]));
    const budget = config?.budgetConfig ?? {};
    const defaultRate = config?.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE;

    const users = pageUids.map((uid) => {
      const userGroups = groups.filter((g) => g.uids.includes(uid)).map((g) => g.name);
      const userPolicy = userPolicyByUid.get(uid);
      const related = [
        ...(userPolicy ? [userPolicy] : []),
        ...groupPolicies.filter((p) => userGroups.includes(String(p.target))),
      ];
      const effective = resolveEffectiveAccess(related, { uid, groups: userGroups });
      const day = usage.get(uid);
      return {
        uid,
        uname: names.get(uid) || String(uid),
        groups: userGroups,
        usage: { totalTokens: day?.totalTokens ?? 0, requestCount: day?.requestCount ?? 0 },
        policy: serializePolicy(userPolicy),
        effective: {
          enabled: effective.enabled,
          enabledSource: effective.enabledSource,
          disabledBy: effective.disabledBy ?? null,
          dailyTokenLimit: effectiveUserDailyLimit(budget, {
            dailyTokenLimitPerUser: effective.dailyTokenLimit,
            extraTokens: effective.extraTokens,
          }),
          dailyTokenLimitSource: effective.dailyTokenLimitSource,
          extraTokens: effective.extraTokens,
          rateLimitPerMinute: effective.rateLimitPerMinute ?? defaultRate,
          rateLimitSource: effective.rateLimitSource,
        },
      };
    });

    sendJson(this, 200, { users, total, page, pageSize: USERS_PAGE_SIZE, today });
  }
}

/**
 * GET /ai-helper/admin/access/audit?scope=&target=&limit=
 */
export class AccessPolicyAuditHandler extends Handler {
  async get() {
    if (rejectIfCannotManage(this)) return;
    const domainId = getDomainId(this);
    const query = (this.request.query || {}) as Record<string, string | undefined>;
    const scope = ACCESS_POLICY_SCOPES.includes(query.scope as AccessPolicyScope)
      ? query.scope as AccessPolicyScope
      : undefined;
    let target: number | string | undefined;
    if (scope && query.target) target = scope === 'user' ? Number(query.target) : query.target;
    const limit = parseInt(query.limit || '50', 10) || 50;

    const { auditModel } = getModels(this);
    const records = await auditModel.list(domainId, { scope, target, limit });
    const operatorNames = await getUserNames([...new Set(records.map((r) => r.operatorUid))]);
    sendJson(this, 200, {
      records: records.map((r) => ({
        id: r._id.toHexString(),
        scope: r.scope,
        target: r.target,
        action: r.action,
        before: r.before,
        after: r.after,
        operatorUid: r.operatorUid,
        operatorName: operatorNames.get(r.operatorUid) || String(r.operatorUid),
        batchId: r.batchId ?? null,
        createdAt: new Date(r.createdAt).toISOString(),
      })),
    });
  }
}

/**
 * POST /ai-helper/admin/access/policy
 * body: { scope, target, enabled?, dailyTokenLimit?, extraTokensToday?, rateLimitPerMinute?, expiresAt?, reason? }
 * 字段为 null 表示清除该覆盖，回退到上一级（用户组 / 域默认）
 */
export class AccessPolicyUpsertHandler extends Handler {
  async post() {
    if (rejectIfCsrfInvalid(this)) return;
    if (rejectIfCannotManage(this)) return;
    const domainId = getDomainId(this);
    const body = (this.request.body || {}) as Record<string, unknown>;
    const st = parseScopeTarget(this, body);
    if (!st) return;
    const parsed = parseAccessPolicyInput(body as AccessPolicyInput);
    if (parsed.ok === false) {
      badRequest(this, parsed.field);
      return;
    }
    if (!(await targetExists(domainId, st.scope, st.target))) {
      sendJson(this, 404, { error: this.translate('ai_helper_access_err_target_not_found'), code: 'TARGET_NOT_FOUND' });
      return;
    }
    const policy = await upsertPolicyWithAudit(getModels(this), {
      domainId, ...st, patch: parsed.patch, operatorUid: this.user._id,
    });
    sendJson(this, 200, { policy: serializePolicy(policy) });
  }
}

/**
 * POST /ai-helper/admin/access/policy/delete
 * body: { scope, target }
 */
export class AccessPolicyDeleteHandler extends Handler {
  async post() {
    if (rejectIfCsrfInvalid(this)) return;
    if (rejectIfCannotManage(this)) return;
    const domainId = getDomainId(this);
    const st = parseScopeTarget(this, (this.request.body || {}) as Record<string, unknown>);
    if (!st) return;
    const deleted = await deletePolicyWithAudit(getModels(this), {
      domainId, ...st, operatorUid: this.user._id,
    });
    sendJson(this, 200, { deleted });
  }
}

/**
 * POST /ai-helper/admin/access/batch
 * body: { group, mode: 'apply' | 'clear', ...策略字段 }
 * apply：为组内每个成员写入相同的用户级策略；clear：删除组内每个成员的用户级策略
 */
export class AccessPolicyBatchHandler extends Handler {
  async post() {
    if (rejectIfCsrfInvalid(this)) return;
    if (rejectIfCannotManage(this)) return;
    if (await applyRateLimit(this, {
      op: 'ai_access_batch', periodSecs: 60, maxOps: 10, failOpen: true,
    })) return;

    const domainId = getDomainId(this);
    const body = (this.request.body || {}) as Record<string, unknown>;
    const groupName = typeof body.group === 'string' ? body.group.trim() : '';
    if (!groupName) {
      badRequest(this, 'group');
      return;
    }
    const mode = body.mode;
    if (mode !== 'apply' && mode !== 'clear') {
      badRequest(this, 'mode');
      return;
    }
    let patch = {};
    if (mode === 'apply') {
      const parsed = parseAccessPolicyInput(body as AccessPolicyInput);
      if (parsed.ok === false) {
        badRequest(this, parsed.field);
        return;
      }
      patch = parsed.patch;
    }

    const group = (await listHydroGroups(domainId)).find((g) => g.name === groupName);
    if (!group) {
      sendJson(this, 404, { error: this.translate('ai_helper_access_err_target_not_found'), code: 'TARGET_NOT_FOUND' });
      return;
    }
    const uids = [...new Set(group.uids)].filter((u) => u > 1);
    if (uids.length > MAX_BATCH_MEMBERS) {
      sendJson(this, 400, {
        error: translateWithParams(this, 'ai_helper_access_err_batch_too_large', MAX_BATCH_MEMBERS),
        code: 'BATCH_TOO_LARGE',
      });
      return;
    }

    const models = getModels(this);
    const batchId = newBatchId();
    const operatorUid = this.user._id;
    let affected = 0;
    for (const uid of uids) {
      if (mode === 'apply') {
        // eslint-disable-next-line no-await-in-loop
        await upsertPolicyWithAudit(models, { domainId, scope: 'user', target: uid, patch, operatorUid, batchId });
        affected++;
      } else {
        // eslint-disable-next-line no-await-in-loop
        if (await deletePolicyWithAudit(models, { domainId, scope: 'user', target: uid, operatorUid, batchId })) affected++;
      }
    }
    sendJson(this, 200, { affected, batchId });
  }
}

// 路由层仅要求登录；具体的域管理权限在 Handler 内校验（允许系统管理员或域内 DomainAdminPerm）
export const AccessPolicyHandlerPriv = PRIV.PRIV_USER_PROFILE;
