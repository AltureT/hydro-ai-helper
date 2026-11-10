/**
 * 小组管理接口（US1）
 *
 * 全部仅限系统管理员（PRIV_EDIT_SYSTEM）：路由层校验之外，处理器内再校验一次。
 * GET  /d/:domainId/ai-helper/groups           本域小组 + 扩展信息 + 漂移
 * POST /d/:domainId/ai-helper/groups/search    搜索与预览
 * POST /d/:domainId/ai-helper/groups/apply     批量加入 / 移出
 * POST /d/:domainId/ai-helper/groups/undo      撤销一次操作
 * POST /d/:domainId/ai-helper/groups/meta      扩展信息（含新建空小组、删除失效扩展信息）
 * POST /d/:domainId/ai-helper/groups/drift     恢复 / 忽略被覆盖的成员
 */

import { Handler, PRIV } from 'hydrooj';
import { rejectIfCsrfInvalid } from '../lib/csrfHelper';
import { applyRateLimit } from '../lib/rateLimitHelper';
import { translateWithParams } from '../utils/i18nHelper';
import { getDomainId } from '../utils/domainHelper';
import { hasSystemPriv } from '../utils/hydroCompat';
import { GroupServiceError, type HydroGroupService, type SearchMode, type SearchScope } from '../services/hydroGroupService';

function json(handler: Handler, status: number, body: Record<string, unknown>): void {
  if (status !== 200) handler.response.status = status;
  handler.response.body = body;
  handler.response.type = 'application/json';
}

/** 处理器内二次校验系统管理员权限（纵深防御） */
export function rejectIfNotSystemAdmin(handler: Handler): boolean {
  const user = handler.user as { hasPriv?: (priv: number) => boolean; priv?: number } | undefined;
  const allowed = typeof user?.hasPriv === 'function'
    ? user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)
    : hasSystemPriv(user?.priv);
  if (allowed) return false;
  json(handler, 403, { error: handler.translate('ai_helper_err_system_admin_required'), code: 'SYSTEM_ADMIN_REQUIRED' });
  return true;
}

export function respondGroupError(handler: Handler, err: unknown, fallbackKey: string, fallbackCode: string): void {
  if (err instanceof GroupServiceError) {
    json(handler, err.status, {
      error: translateWithParams(handler, err.i18nKey, ...err.params),
      code: err.code,
    });
    return;
  }
  console.error(`[AI Helper] ${fallbackCode}:`, err instanceof Error ? err.message : 'unknown');
  json(handler, 500, { error: handler.translate(fallbackKey), code: fallbackCode });
}

function service(handler: Handler): HydroGroupService {
  return handler.ctx.get('hydroGroupService') as HydroGroupService;
}

function body(handler: Handler): Record<string, unknown> {
  const raw = handler.request.body;
  return raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
}

export class GroupListHandler extends Handler {
  async get() {
    if (rejectIfNotSystemAdmin(this)) return;
    try {
      const includeArchived = String(this.request.query?.includeArchived || '') === '1';
      const result = await service(this).list(getDomainId(this), { includeArchived });
      json(this, 200, result as unknown as Record<string, unknown>);
    } catch (err) {
      respondGroupError(this, err, 'ai_helper_group_list_failed', 'GROUP_LIST_FAILED');
    }
  }
}

export class GroupSearchHandler extends Handler {
  async post() {
    if (rejectIfCsrfInvalid(this)) return;
    if (rejectIfNotSystemAdmin(this)) return;
    try {
      if (await applyRateLimit(this, {
        op: 'ai_group_search',
        periodSecs: 60,
        maxOps: 30,
        failOpen: true,
        errorMessage: 'ai_helper_group_search_rate_limited',
      })) return;
      const { mode, query, scope } = body(this);
      const result = await service(this).search(
        getDomainId(this),
        mode as SearchMode,
        query,
        scope === 'all' ? 'all' : 'domain' as SearchScope,
      );
      json(this, 200, result as unknown as Record<string, unknown>);
    } catch (err) {
      respondGroupError(this, err, 'ai_helper_group_search_failed', 'GROUP_SEARCH_FAILED');
    }
  }
}

export class GroupApplyHandler extends Handler {
  async post() {
    if (rejectIfCsrfInvalid(this)) return;
    if (rejectIfNotSystemAdmin(this)) return;
    try {
      const { groupName, action, uids, joinDomain } = body(this);
      const result = await service(this).apply({
        domainId: getDomainId(this),
        groupName,
        action,
        uids,
        joinDomain: joinDomain && typeof joinDomain === 'object' ? joinDomain as { role?: unknown } : null,
        actorUid: Number(this.user?._id),
      });
      json(this, 200, result as unknown as Record<string, unknown>);
    } catch (err) {
      respondGroupError(this, err, 'ai_helper_group_apply_failed', 'GROUP_APPLY_FAILED');
    }
  }
}

export class GroupUndoHandler extends Handler {
  async post() {
    if (rejectIfCsrfInvalid(this)) return;
    if (rejectIfNotSystemAdmin(this)) return;
    try {
      const { auditId } = body(this);
      const result = await service(this).undo(getDomainId(this), auditId, Number(this.user?._id));
      json(this, 200, { success: true, ...result });
    } catch (err) {
      respondGroupError(this, err, 'ai_helper_group_undo_failed', 'GROUP_UNDO_FAILED');
    }
  }
}

export class GroupMetaHandler extends Handler {
  async post() {
    if (rejectIfCsrfInvalid(this)) return;
    if (rejectIfNotSystemAdmin(this)) return;
    try {
      const b = body(this);
      const result = await service(this).updateMeta({
        domainId: getDomainId(this),
        groupName: b.groupName,
        action: b.action,
        kind: b.kind,
        academicYear: b.academicYear,
        teacherUids: b.teacherUids,
        archived: b.archived,
        create: b.create,
        actorUid: Number(this.user?._id),
      });
      json(this, 200, { success: true, ...result });
    } catch (err) {
      respondGroupError(this, err, 'ai_helper_group_meta_failed', 'GROUP_META_FAILED');
    }
  }
}

export class GroupDriftHandler extends Handler {
  async post() {
    if (rejectIfCsrfInvalid(this)) return;
    if (rejectIfNotSystemAdmin(this)) return;
    try {
      const { groupName, action, uids } = body(this);
      const result = await service(this).resolveDrift({
        domainId: getDomainId(this),
        groupName,
        action,
        uids,
        actorUid: Number(this.user?._id),
      });
      json(this, 200, { success: true, ...result });
    } catch (err) {
      respondGroupError(this, err, 'ai_helper_group_drift_failed', 'GROUP_DRIFT_FAILED');
    }
  }
}

export const GroupAdminHandlerPriv = PRIV.PRIV_EDIT_SYSTEM;
