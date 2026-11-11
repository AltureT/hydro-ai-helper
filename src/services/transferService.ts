/**
 * TransferService - 跨域复制 / 移动小组与用户（US9，FR-064–FR-074，plan R17）
 *
 * 预览（只读）→ 执行。执行按“先写目标域、后改源域”的顺序（FR-072），
 * 每完成一步就把实际变化写入 ai_transfer_jobs（供继续执行与撤销）并追加到审计记录（供阅读）。
 * - 预览结果带 previewToken（内容哈希 + 10 分钟过期）；执行时重新计算，变化了就要求重新预览。
 * - 中途失败：报告已完成与未完成部分，可“继续完成剩余部分”或“撤销已完成部分”。
 * - 撤销按已完成步骤倒序回退，只回退该次操作实际做出的改变（FR-073）。
 * - 提交记录、AI 对话、安全记录都不动（FR-074）。
 */

import { createHash } from 'crypto';
import type { Collection, Db } from 'mongodb';
import { DomainModel, PERM } from 'hydrooj';
import { GroupMetaModel, type GroupMeta } from '../models/groupMeta';
import { QuotaGroupModel } from '../models/quotaGroup';
import {
  TransferJobModel,
  type TransferJob,
  type TransferKind,
  type TransferMode,
  type TransferStep,
  type TransferStepResult,
  type TransferStepType,
} from '../models/transferJob';
import {
  allowedJoinRoles,
  clearDomainUserCache,
  defaultJoinRole,
  domainUserColl,
  groupColl,
  hasSystemPriv,
  joinDomain,
  leaveDomain,
  memberFilter,
  restoreDomainMembership,
  roleHasPerm,
  type ContextLike,
  type DomainDocLike,
  type HydroGroupDoc,
} from '../utils/hydroCompat';
import { validateGroupName } from '../utils/groupName';
import { ObjectId, unwrapModifyResult, type ObjectIdType } from '../utils/mongo';
import { AuditService } from './auditService';
import { GroupServiceError } from './hydroGroupService';
import type { QuotaGroupResolver } from './quotaGroupResolver';

export const TRANSFER_MAX_GROUPS = 20;
export const TRANSFER_MAX_USERS = 2000;
export const TRANSFER_MAX_GROUP_MEMBERS = 5000;
export const TRANSFER_BATCH_SIZE = 200;
export const PREVIEW_TTL_MS = 10 * 60 * 1000;
/** Hydro 的全站默认域：学生移出后在站点中心变成游客，不允许作为“移动学生”的源域 */
export const SYSTEM_DOMAIN_ID = 'system';
const DOC_TYPE_CONTEST = 30;

export type ConflictChoice = 'merge' | { renameTo: string };

export interface TransferRequest {
  kind: TransferKind;
  mode: TransferMode;
  sourceDomainId: string;
  targetDomainId: string;
  groupNames: string[];
  conflicts: Record<string, ConflictChoice>;
  uids: number[];
  targetGroup: string | null;
}

export interface TransferProblem {
  code: 'SOURCE_GROUP_MISSING' | 'CONFLICT_UNRESOLVED' | 'RENAME_TAKEN' | 'DUPLICATE_TARGET' | 'USER_NOT_FOUND' | 'TOO_MANY_MEMBERS';
  group?: string;
  uid?: number;
}

export interface GroupPreviewItem {
  name: string;
  targetName: string;
  exists: boolean;
  memberCount: number;
  /** 目标域已有同名小组（需选择合并或改名） */
  conflict: boolean;
  resolution: 'new' | 'merge' | 'rename' | null;
  targetMemberCount: number;
  willAdd: number;
  alreadyIn: number;
  /** 源域中分配给该组的作业和比赛数量 */
  assignments: number;
  quotaLinks: Array<{ id: string; name: string }>;
}

export interface UserPreviewItem {
  uid: number;
  uname: string;
  inSource: boolean;
  inTarget: boolean;
  isOwner: boolean;
  isManager: boolean;
  sourceGroups: string[];
}

export interface TransferPreview {
  kind: TransferKind;
  mode: TransferMode;
  source: { id: string; name: string };
  target: { id: string; name: string };
  groups?: GroupPreviewItem[];
  users?: UserPreviewItem[];
  targetGroup?: { name: string; exists: boolean; memberCount: number } | null;
  /** 需要加入目标域的人（小组转移：全部成员中的非目标域成员；用户转移：按默认勾选计算） */
  joinUids: number[];
  /** 小组移动并勾选“同时移出源域”时会退出源域的人（源域所有者除外） */
  leaveCandidates: number[];
  owner: { uid: number; uname: string } | null;
  joinRoles: string[];
  defaultJoinRole: string | null;
  problems: TransferProblem[];
  previewToken: string;
  expiresAt: string;
}

export interface TransferExecuteOptions {
  previewToken?: unknown;
  joinRole?: unknown;
  removeMembersFromSource?: unknown;
  selectedUids?: unknown;
}

export interface TransferSummaryItem {
  type: TransferStepType;
  name?: string;
  status: 'done' | 'partial' | 'failed' | 'pending';
  done: number;
  total: number;
  created?: boolean;
  added?: number;
}

export interface TransferRunResult {
  auditId: string;
  status: TransferJob['status'];
  failedAt?: string;
  error?: string;
  summary: TransferSummaryItem[];
}

interface UserDocLite {
  _id: number;
  uname: string;
  priv?: number;
}

interface DomainUserRow {
  domainId: string;
  uid: number;
  role?: string | null;
  join?: boolean;
}

interface InternalState {
  preview: Omit<TransferPreview, 'previewToken' | 'expiresAt'>;
  ddocTarget: DomainDocLike | null;
  /** 小组：每组的源成员 */
  groupMembers: Map<string, number[]>;
}

function invalid(code: string, key: string, params: Array<string | number> = []): GroupServiceError {
  return new GroupServiceError(code, 400, key, params);
}

function uniqueSorted(uids: number[]): number[] {
  return [...new Set(uids)].sort((a, b) => a - b);
}

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function isMember(row: DomainUserRow | undefined): boolean {
  if (!row) return false;
  const filter = memberFilter();
  if ('join' in filter) return row.join === true;
  return !!row.role && row.role !== 'default' && row.role !== 'guest';
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function requireName(raw: unknown): string {
  const result = validateGroupName(raw);
  if ('error' in result) throw invalid('INVALID_GROUP_NAME', `ai_helper_group_name_err_${result.error}`);
  return result.name;
}

/** 校验并规范化请求（排序去重，使相同请求得到相同的预览令牌） */
export function normalizeTransferRequest(raw: Record<string, unknown>): TransferRequest {
  const kind = raw.kind;
  const mode = raw.mode;
  if (kind !== 'groups' && kind !== 'users') throw invalid('INVALID_TRANSFER_KIND', 'ai_helper_transfer_kind_invalid');
  if (mode !== 'copy' && mode !== 'move') throw invalid('INVALID_TRANSFER_MODE', 'ai_helper_transfer_mode_invalid');
  const sourceDomainId = typeof raw.sourceDomainId === 'string' ? raw.sourceDomainId.trim() : '';
  const targetDomainId = typeof raw.targetDomainId === 'string' ? raw.targetDomainId.trim() : '';
  if (!sourceDomainId || !targetDomainId) throw invalid('INVALID_DOMAIN', 'ai_helper_transfer_domain_required');
  if (sourceDomainId === targetDomainId) throw invalid('SAME_DOMAIN', 'ai_helper_transfer_same_domain');

  let groupNames: string[] = [];
  const conflicts: Record<string, ConflictChoice> = {};
  let uids: number[] = [];
  let targetGroup: string | null = null;

  if (kind === 'groups') {
    if (!Array.isArray(raw.groupNames) || !raw.groupNames.length) throw invalid('INVALID_GROUPS', 'ai_helper_transfer_groups_required');
    groupNames = [...new Set(raw.groupNames.map((name) => requireName(name)))].sort();
    if (groupNames.length > TRANSFER_MAX_GROUPS) throw invalid('TOO_MANY_GROUPS', 'ai_helper_transfer_too_many_groups', [TRANSFER_MAX_GROUPS]);
    const rawConflicts = raw.conflicts && typeof raw.conflicts === 'object' ? raw.conflicts as Record<string, unknown> : {};
    for (const name of groupNames) {
      const choice = rawConflicts[name];
      if (choice === 'merge') conflicts[name] = 'merge';
      else if (choice && typeof choice === 'object' && 'renameTo' in choice) {
        conflicts[name] = { renameTo: requireName((choice as { renameTo: unknown }).renameTo) };
      }
    }
  } else {
    if (!Array.isArray(raw.uids) || !raw.uids.length) throw invalid('INVALID_UIDS', 'ai_helper_group_uids_invalid');
    for (const item of raw.uids) {
      const uid = typeof item === 'string' && /^\d+$/.test(item) ? Number(item) : item;
      if (typeof uid !== 'number' || !Number.isSafeInteger(uid) || uid <= 1) throw invalid('INVALID_UIDS', 'ai_helper_group_uids_invalid');
      uids.push(uid);
    }
    uids = uniqueSorted(uids);
    if (uids.length > TRANSFER_MAX_USERS) throw invalid('TOO_MANY_USERS', 'ai_helper_group_too_many_users', [TRANSFER_MAX_USERS]);
    if (raw.targetGroup !== undefined && raw.targetGroup !== null && raw.targetGroup !== '') targetGroup = requireName(raw.targetGroup);
    if (mode === 'move' && sourceDomainId === SYSTEM_DOMAIN_ID) {
      throw invalid('SYSTEM_DOMAIN_SOURCE', 'ai_helper_transfer_system_source');
    }
  }
  return { kind, mode, sourceDomainId, targetDomainId, groupNames, conflicts, uids, targetGroup };
}

function tokenHash(request: TransferRequest, preview: InternalState['preview'], expiresAt: number): string {
  const payload = JSON.stringify({ v: 1, request, preview, expiresAt });
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

export class TransferService {
  private readonly groups: Collection<HydroGroupDoc>;
  private readonly domainUsers: Collection<DomainUserRow>;
  private readonly users: Collection<UserDocLite>;
  private readonly domains: Collection<{ _id: string; name?: string }>;
  private readonly documents: Collection<{ domainId: string; docType: number; assign?: string[] }>;

  constructor(
    private readonly db: Db,
    private readonly groupMeta: GroupMetaModel,
    private readonly quotaGroups: QuotaGroupModel,
    private readonly jobs: TransferJobModel,
    private readonly audit: AuditService,
    private readonly resolver?: Pick<QuotaGroupResolver, 'invalidate'>,
    private readonly ctx?: ContextLike,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.groups = groupColl(db);
    this.domainUsers = domainUserColl(db) as unknown as Collection<DomainUserRow>;
    this.users = db.collection<UserDocLite>('user');
    this.domains = db.collection<{ _id: string; name?: string }>('domain');
    this.documents = db.collection('document');
  }

  // ─── 预览 ──────────────────────────────────────────────────────────────────

  private async domainInfo(id: string): Promise<{ doc: DomainDocLike | null; name: string }> {
    const row = await this.domains.findOne({ _id: id }, { projection: { _id: 1, name: 1 } });
    if (!row) throw new GroupServiceError('DOMAIN_NOT_FOUND', 404, 'ai_helper_transfer_domain_not_found', [id]);
    let doc: DomainDocLike | null = null;
    try {
      doc = (await DomainModel.get(id)) || null;
    } catch {
      doc = null;
    }
    return { doc, name: row.name || id };
  }

  private async rowsIn(domainId: string, uids: number[]): Promise<Map<number, DomainUserRow>> {
    if (!uids.length) return new Map();
    const rows = await this.domainUsers
      .find({ domainId, uid: { $in: uids } }, { projection: { uid: 1, role: 1, join: 1 } })
      .toArray();
    return new Map(rows.map((row) => [row.uid, row]));
  }

  private async unameMap(uids: number[]): Promise<Map<number, UserDocLite>> {
    if (!uids.length) return new Map();
    const docs = await this.users.find({ _id: { $in: uids } }, { projection: { _id: 1, uname: 1, priv: 1 } }).toArray();
    return new Map(docs.map((doc) => [doc._id, doc]));
  }

  private async computeState(request: TransferRequest): Promise<InternalState> {
    const [source, target] = await Promise.all([
      this.domainInfo(request.sourceDomainId),
      this.domainInfo(request.targetDomainId),
    ]);
    const ownerUid = typeof source.doc?.owner === 'number' ? source.doc.owner : null;
    const problems: TransferProblem[] = [];
    const base = {
      kind: request.kind,
      mode: request.mode,
      source: { id: request.sourceDomainId, name: source.name },
      target: { id: request.targetDomainId, name: target.name },
      joinRoles: allowedJoinRoles(target.doc),
      defaultJoinRole: defaultJoinRole(target.doc),
    };
    const groupMembers = new Map<string, number[]>();

    if (request.kind === 'groups') {
      const sourceDocs = await this.groups
        .find({ domainId: request.sourceDomainId, name: { $in: request.groupNames } }, { projection: { name: 1, uids: 1 } })
        .toArray();
      const sourceByName = new Map(sourceDocs.map((doc) => [doc.name, uniqueSorted(doc.uids || [])]));
      const targetNames = new Set<string>();
      for (const name of request.groupNames) {
        targetNames.add(name);
        const choice = request.conflicts[name];
        if (choice && choice !== 'merge') targetNames.add(choice.renameTo);
      }
      const targetDocs = await this.groups
        .find({ domainId: request.targetDomainId, name: { $in: [...targetNames] } }, { projection: { name: 1, uids: 1 } })
        .toArray();
      const targetByName = new Map(targetDocs.map((doc) => [doc.name, new Set(doc.uids || [])]));
      const allQuotaGroups = request.mode === 'move' ? await this.quotaGroups.list() : [];

      const items: GroupPreviewItem[] = [];
      const usedTargets = new Map<string, string>();
      for (const name of request.groupNames) {
        const members = sourceByName.get(name);
        if (!members) problems.push({ code: 'SOURCE_GROUP_MISSING', group: name });
        groupMembers.set(name, members || []);
        const conflict = targetByName.has(name);
        const choice = request.conflicts[name];
        let resolution: GroupPreviewItem['resolution'] = conflict ? null : 'new';
        let targetName = name;
        if (choice === 'merge' && conflict) resolution = 'merge';
        if (choice && choice !== 'merge') {
          targetName = choice.renameTo;
          resolution = 'rename';
          if (targetByName.has(targetName)) problems.push({ code: 'RENAME_TAKEN', group: name });
        }
        if (resolution === null) problems.push({ code: 'CONFLICT_UNRESOLVED', group: name });
        if (usedTargets.has(targetName)) problems.push({ code: 'DUPLICATE_TARGET', group: name });
        usedTargets.set(targetName, name);
        const existing = targetByName.get(targetName) || new Set<number>();
        const alreadyIn = (members || []).filter((uid) => existing.has(uid)).length;
        const assignments = await this.documents.countDocuments({
          domainId: request.sourceDomainId, docType: DOC_TYPE_CONTEST, assign: name,
        });
        items.push({
          name,
          targetName,
          exists: !!members,
          memberCount: members?.length ?? 0,
          conflict,
          resolution,
          targetMemberCount: resolution === 'rename' ? 0 : existing.size,
          willAdd: (members?.length ?? 0) - alreadyIn,
          alreadyIn,
          assignments,
          quotaLinks: allQuotaGroups
            .filter((group) => (group.linkedGroups || []).some((link) => link.domainId === request.sourceDomainId && link.name === name))
            .map((group) => ({ id: String(group._id), name: group.name })),
        });
      }
      const union = uniqueSorted([...groupMembers.values()].flat());
      if (union.length > TRANSFER_MAX_GROUP_MEMBERS) problems.push({ code: 'TOO_MANY_MEMBERS' });
      const [rowsTarget, rowsSource, owner] = await Promise.all([
        this.rowsIn(request.targetDomainId, union),
        this.rowsIn(request.sourceDomainId, union),
        ownerUid !== null ? this.unameMap([ownerUid]) : Promise.resolve(new Map<number, UserDocLite>()),
      ]);
      return {
        groupMembers,
        ddocTarget: target.doc,
        preview: {
          ...base,
          groups: items,
          joinUids: union.filter((uid) => !isMember(rowsTarget.get(uid))),
          leaveCandidates: request.mode === 'move'
            ? union.filter((uid) => uid !== ownerUid && isMember(rowsSource.get(uid)))
            : [],
          owner: ownerUid !== null ? { uid: ownerUid, uname: owner.get(ownerUid)?.uname || `#${ownerUid}` } : null,
          problems,
        },
      };
    }

    // 用户转移
    const [userDocs, rowsSource, rowsTarget, sourceGroupDocs, targetGroupDoc] = await Promise.all([
      this.unameMap(request.uids.concat(ownerUid !== null ? [ownerUid] : [])),
      this.rowsIn(request.sourceDomainId, request.uids),
      this.rowsIn(request.targetDomainId, request.uids),
      this.groups.find({ domainId: request.sourceDomainId, uids: { $in: request.uids } }, { projection: { name: 1, uids: 1 } }).toArray(),
      request.targetGroup
        ? this.groups.findOne({ domainId: request.targetDomainId, name: request.targetGroup })
        : Promise.resolve(null),
    ]);
    const groupsByUid = new Map<number, string[]>();
    const wanted = new Set(request.uids);
    for (const group of sourceGroupDocs) {
      if (/^\d+$/.test(group.name)) continue;
      for (const uid of group.uids || []) {
        if (wanted.has(uid)) groupsByUid.set(uid, [...(groupsByUid.get(uid) || []), group.name]);
      }
    }
    const editDomain = BigInt(PERM.PERM_EDIT_DOMAIN);
    const users: UserPreviewItem[] = [];
    for (const uid of request.uids) {
      const doc = userDocs.get(uid);
      if (!doc) {
        problems.push({ code: 'USER_NOT_FOUND', uid });
        continue;
      }
      const row = rowsSource.get(uid);
      const inSource = isMember(row);
      users.push({
        uid,
        uname: doc.uname,
        inSource,
        inTarget: isMember(rowsTarget.get(uid)),
        isOwner: uid === ownerUid,
        isManager: (inSource && roleHasPerm(source.doc, row?.role, editDomain)) || hasSystemPriv(doc.priv),
        sourceGroups: (groupsByUid.get(uid) || []).sort(),
      });
    }
    const defaults = users.filter((user) => !user.isManager);
    return {
      groupMembers,
      ddocTarget: target.doc,
      preview: {
        ...base,
        users,
        targetGroup: request.targetGroup
          ? { name: request.targetGroup, exists: !!targetGroupDoc, memberCount: targetGroupDoc?.uids?.length ?? 0 }
          : null,
        joinUids: defaults.filter((user) => !user.inTarget).map((user) => user.uid),
        leaveCandidates: [],
        owner: ownerUid !== null ? { uid: ownerUid, uname: userDocs.get(ownerUid)?.uname || `#${ownerUid}` } : null,
        problems,
      },
    };
  }

  async preview(raw: Record<string, unknown>): Promise<TransferPreview> {
    const request = normalizeTransferRequest(raw);
    const state = await this.computeState(request);
    const expiresAt = this.clock().getTime() + PREVIEW_TTL_MS;
    return {
      ...state.preview,
      previewToken: `${expiresAt}.${tokenHash(request, state.preview, expiresAt)}`,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  // ─── 执行 ──────────────────────────────────────────────────────────────────

  async execute(raw: Record<string, unknown> & TransferExecuteOptions, actorUid: number): Promise<TransferRunResult> {
    const request = normalizeTransferRequest(raw);
    const state = await this.computeState(request);
    this.verifyToken(raw.previewToken, request, state);
    if (state.preview.problems.length) {
      throw new GroupServiceError('TRANSFER_BLOCKED', 400, 'ai_helper_transfer_blocked');
    }
    const plan = this.buildPlan(request, state, raw);
    const auditId = await this.audit.record({
      actorUid,
      action: request.kind === 'groups' ? 'transfer.groups' : 'transfer.users',
      domainId: request.sourceDomainId,
      target: {
        type: 'transfer',
        id: `${request.sourceDomainId}->${request.targetDomainId}`,
        label: request.kind === 'groups'
          ? `${request.groupNames.join(', ')} → ${state.preview.target.name}`
          : `${plan.selected.length} → ${state.preview.target.name}`,
      },
      detail: {
        kind: request.kind,
        mode: request.mode,
        sourceDomainId: request.sourceDomainId,
        targetDomainId: request.targetDomainId,
        ...(request.kind === 'groups' ? { groupNames: request.groupNames } : { uids: plan.selected }),
        ...(request.targetGroup ? { targetGroup: request.targetGroup } : {}),
        ...(plan.joinRole ? { joinRole: plan.joinRole } : {}),
        removeMembersFromSource: plan.removeMembersFromSource,
        status: 'running',
      },
      undoable: true,
    });
    const job = await this.jobs.create({
      _id: auditId,
      kind: request.kind,
      mode: request.mode,
      sourceDomainId: request.sourceDomainId,
      targetDomainId: request.targetDomainId,
      actorUid,
      plan: plan.steps,
    }, this.clock());
    return this.run(job);
  }

  private verifyToken(rawToken: unknown, request: TransferRequest, state: InternalState): void {
    const token = typeof rawToken === 'string' ? rawToken : '';
    const [expText, hash] = token.split('.');
    const expiresAt = Number(expText);
    if (!hash || !Number.isFinite(expiresAt)) throw invalid('PREVIEW_REQUIRED', 'ai_helper_transfer_preview_required');
    if (expiresAt <= this.clock().getTime()) {
      throw new GroupServiceError('PREVIEW_EXPIRED', 409, 'ai_helper_transfer_preview_expired');
    }
    if (tokenHash(request, state.preview, expiresAt) !== hash) {
      throw new GroupServiceError('PREVIEW_STALE', 409, 'ai_helper_transfer_preview_stale');
    }
  }

  private buildPlan(request: TransferRequest, state: InternalState, options: TransferExecuteOptions) {
    const { preview } = state;
    const steps: TransferStep[] = [];
    const A = request.sourceDomainId;
    const B = request.targetDomainId;

    let selected: number[] = [];
    let joinUids: number[];
    if (request.kind === 'users') {
      const known = new Map((preview.users || []).map((user) => [user.uid, user]));
      if (options.selectedUids === undefined) {
        selected = (preview.users || []).filter((user) => !user.isManager).map((user) => user.uid);
      } else {
        if (!Array.isArray(options.selectedUids)) throw invalid('INVALID_UIDS', 'ai_helper_group_uids_invalid');
        selected = uniqueSorted(options.selectedUids.map(Number).filter((uid) => known.has(uid)));
        if (selected.length !== new Set(options.selectedUids.map(Number)).size) {
          throw invalid('INVALID_UIDS', 'ai_helper_transfer_selection_invalid');
        }
      }
      if (!selected.length) throw invalid('INVALID_UIDS', 'ai_helper_transfer_selection_empty');
      joinUids = selected.filter((uid) => !known.get(uid)?.inTarget);
    } else {
      joinUids = preview.joinUids;
    }

    let joinRole: string | null = null;
    if (joinUids.length) {
      const allowed = allowedJoinRoles(state.ddocTarget);
      const requested = typeof options.joinRole === 'string' && options.joinRole ? options.joinRole : preview.defaultJoinRole;
      if (!requested) throw invalid('JOIN_ROLE_REQUIRED', 'ai_helper_group_join_role_required');
      if (!allowed.includes(requested)) throw invalid('INVALID_JOIN_ROLE', 'ai_helper_group_join_role_invalid', [requested]);
      joinRole = requested;
      chunks(joinUids, TRANSFER_BATCH_SIZE).forEach((uids, i) => {
        steps.push({ key: `join#${i}`, type: 'join', domainId: B, uids, role: requested });
      });
    }

    const removeMembersFromSource = request.kind === 'groups' && request.mode === 'move' && options.removeMembersFromSource === true;
    if (request.kind === 'groups') {
      (preview.groups || []).forEach((group, i) => {
        steps.push({
          key: `group#${i}`, type: 'group', domainId: B, name: group.targetName,
          uids: state.groupMembers.get(group.name) || [], sourceDomainId: A, sourceName: group.name,
        });
      });
      if (request.mode === 'move') {
        (preview.groups || []).forEach((group, i) => {
          group.quotaLinks.forEach((link, j) => {
            steps.push({
              key: `relink#${i}#${j}`, type: 'relink', quotaGroupId: link.id, quotaGroupName: link.name,
              from: { domainId: A, name: group.name }, to: { domainId: B, name: group.targetName },
            });
          });
        });
        (preview.groups || []).forEach((group, i) => {
          steps.push({ key: `delete#${i}`, type: 'delete_group', domainId: A, name: group.name });
        });
        if (removeMembersFromSource) {
          chunks(preview.leaveCandidates, TRANSFER_BATCH_SIZE).forEach((uids, i) => {
            steps.push({ key: `leave#${i}`, type: 'leave', domainId: A, uids });
          });
        }
      }
    } else {
      if (request.targetGroup) {
        steps.push({ key: 'group#0', type: 'group', domainId: B, name: request.targetGroup, uids: selected });
      }
      if (request.mode === 'move') {
        const ownerUid = preview.owner?.uid;
        const movable = selected.filter((uid) => uid !== ownerUid);
        if (movable.length) steps.push({ key: 'pull', type: 'pull', domainId: A, uids: movable });
        const leaving = movable.filter((uid) => (preview.users || []).find((user) => user.uid === uid)?.inSource);
        chunks(leaving, TRANSFER_BATCH_SIZE).forEach((uids, i) => {
          steps.push({ key: `leave#${i}`, type: 'leave', domainId: A, uids });
        });
      }
    }
    if (!steps.length) throw invalid('NOTHING_TO_DO', 'ai_helper_transfer_nothing_to_do');
    return { steps, selected, joinRole, removeMembersFromSource };
  }

  private async run(job: TransferJob): Promise<TransferRunResult> {
    const done = new Set(job.results.map((result) => result.key));
    const prepared = new Map((job.prepared || []).map((item) => [item.key, item.data]));
    const results = [...job.results];
    const touched = new Set<string>();
    let quotaTouched = false;
    try {
      for (const step of job.plan) {
        if (done.has(step.key)) continue;
        let result: TransferStepResult;
        try {
          let data = prepared.get(step.key);
          if (!data) {
            data = await this.snapshot(step);
            await this.jobs.addPrepared(job._id, step.key, data);
            prepared.set(step.key, data);
          }
          result = await this.apply(step, data);
        } catch (err) {
          const error = errorText(err).slice(0, 200);
          await this.jobs.setStatus(job._id, 'partial', { failedAt: step.key, error });
          await this.audit.appendStep(job._id, { name: step.key, status: 'failed', detail: { type: step.type, error } });
          await this.audit.mergeDetail(job._id, { status: 'partial' });
          return this.result({ ...job, results, status: 'partial', failedAt: step.key, error });
        }
        if ('domainId' in step) touched.add(step.domainId);
        quotaTouched = true;
        results.push(result);
        await this.jobs.addResult(job._id, result);
        await this.audit.appendStep(job._id, { name: step.key, status: 'done', detail: this.stepAuditDetail(step, result) });
      }
      await this.jobs.setStatus(job._id, 'done');
      await this.audit.mergeDetail(job._id, { status: 'done' });
      return this.result({ ...job, results, status: 'done' });
    } finally {
      this.afterWrites(job, touched, quotaTouched);
    }
  }

  /** 写入后清除两个域的用户缓存（作业可见性立即生效），并让额度组解析缓存失效 */
  private afterWrites(job: Pick<TransferJob, 'sourceDomainId' | 'targetDomainId'>, touched: Set<string>, quotaTouched: boolean): void {
    for (const domainId of [job.targetDomainId, job.sourceDomainId]) {
      if (touched.has(domainId)) clearDomainUserCache(this.ctx, domainId);
    }
    if (quotaTouched) this.resolver?.invalidate();
  }

  private stepAuditDetail(step: TransferStep, result: TransferStepResult): Record<string, unknown> {
    switch (step.type) {
      case 'join': return { type: step.type, domainId: step.domainId, role: step.role, count: step.uids.length };
      case 'group': return { type: step.type, domainId: step.domainId, name: step.name, created: !!result.created, added: result.added?.length ?? 0 };
      case 'relink': return { type: step.type, quotaGroup: step.quotaGroupName, from: step.from, to: step.to };
      case 'delete_group': return { type: step.type, domainId: step.domainId, name: step.name, members: result.snapshot?.uids.length ?? 0 };
      case 'leave': return { type: step.type, domainId: step.domainId, count: result.rows?.length ?? 0 };
      case 'pull': return { type: step.type, domainId: step.domainId, groups: (result.removed || []).map((item) => item.name) };
      default: return {};
    }
  }

  private async atomicAdd(domainId: string, name: string, uids: number[]): Promise<{ created: boolean; added: number[] }> {
    if (!uids.length) {
      const exists = await this.groups.findOne({ domainId, name });
      if (exists) return { created: false, added: [] };
    }
    const before = unwrapModifyResult<HydroGroupDoc>(await this.groups.findOneAndUpdate(
      { domainId, name },
      { $addToSet: { uids: { $each: uids } } },
      { upsert: true, returnDocument: 'before' },
    ));
    const existing = new Set(before?.uids || []);
    return { created: !before, added: uids.filter((uid) => !existing.has(uid)) };
  }

  private async atomicRemove(domainId: string, name: string, uids: number[]): Promise<number[]> {
    if (!uids.length) return [];
    const before = unwrapModifyResult<HydroGroupDoc>(await this.groups.findOneAndUpdate(
      { domainId, name },
      { $pull: { uids: { $in: uids } } },
      { returnDocument: 'before' },
    ));
    const existing = new Set(before?.uids || []);
    return uids.filter((uid) => existing.has(uid));
  }

  private rowSnapshot(row: DomainUserRow) {
    return { uid: row.uid, role: row.role ?? null, ...(row.join !== undefined ? { join: row.join } : {}) };
  }

  /** 写入前的状态（只读） */
  private async snapshot(step: TransferStep): Promise<Record<string, unknown>> {
    switch (step.type) {
      case 'join': {
        const rows = await this.rowsIn(step.domainId, step.uids);
        return { rows: [...rows.values()].map((row) => this.rowSnapshot(row)), absent: step.uids.filter((uid) => !rows.has(uid)) };
      }
      case 'group': {
        const [doc, meta] = await Promise.all([
          this.groups.findOne({ domainId: step.domainId, name: step.name }),
          this.groupMeta.get(step.domainId, step.name),
        ]);
        return { existed: !!doc, before: doc?.uids || [], metaExisted: !!meta };
      }
      case 'relink': {
        const group = await this.quotaGroups.get(step.quotaGroupId);
        const has = (link: { domainId: string; name: string }) => (group?.linkedGroups || [])
          .some((item) => item.domainId === link.domainId && item.name === link.name);
        return { exists: !!group, hadFrom: has(step.from), hadTo: has(step.to) };
      }
      case 'delete_group': {
        const [doc, meta] = await Promise.all([
          this.groups.findOne({ domainId: step.domainId, name: step.name }),
          this.groupMeta.get(step.domainId, step.name),
        ]);
        return { snapshot: doc ? { uids: doc.uids || [] } : null, metaSnapshot: meta ? this.metaSnapshot(meta) : null };
      }
      case 'leave': {
        const rows = await this.rowsIn(step.domainId, step.uids);
        return { rows: step.uids.filter((uid) => isMember(rows.get(uid))).map((uid) => this.rowSnapshot(rows.get(uid) as DomainUserRow)) };
      }
      case 'pull': {
        const wanted = new Set(step.uids);
        const docs = await this.groups
          .find({ domainId: step.domainId, uids: { $in: step.uids } }, { projection: { name: 1, uids: 1 } })
          .toArray();
        const removed: Array<{ name: string; uids: number[]; ledger: number[] }> = [];
        for (const doc of docs) {
          if (/^\d+$/.test(doc.name)) continue;
          const uids = (doc.uids || []).filter((uid) => wanted.has(uid));
          if (!uids.length) continue;
          const meta = await this.groupMeta.get(step.domainId, doc.name);
          const ledger = new Set(meta?.pluginAdded || []);
          removed.push({ name: doc.name, uids, ledger: uids.filter((uid) => ledger.has(uid)) });
        }
        return { removed };
      }
      default:
        throw new Error('unknown step');
    }
  }

  /** 由写入前的快照推出该步“做了什么”（执行后记录；中途失败的步骤撤销时也据此回退） */
  private derive(step: TransferStep, data: Record<string, unknown>, at: Date): TransferStepResult {
    switch (step.type) {
      case 'join':
        return { key: step.key, at, rows: data.rows as TransferStepResult['rows'], absent: data.absent as number[] };
      case 'group': {
        const before = new Set(data.before as number[]);
        return {
          key: step.key,
          at,
          created: !data.existed,
          added: step.uids.filter((uid) => !before.has(uid)),
          metaCreated: !data.metaExisted,
        };
      }
      case 'relink':
        return data.exists
          ? { key: step.key, at, unlinked: !!data.hadFrom, linked: !data.hadTo }
          : { key: step.key, at, unlinked: false, linked: false };
      case 'delete_group':
        return {
          key: step.key,
          at,
          snapshot: data.snapshot as TransferStepResult['snapshot'],
          metaSnapshot: data.metaSnapshot as TransferStepResult['metaSnapshot'],
        };
      case 'leave':
        return { key: step.key, at, rows: data.rows as TransferStepResult['rows'] };
      case 'pull':
        return { key: step.key, at, removed: data.removed as TransferStepResult['removed'] };
      default:
        throw new Error('unknown step');
    }
  }

  /** 按快照执行写入；所有写入都是幂等的，重试不会重复生效 */
  private async apply(step: TransferStep, data: Record<string, unknown>): Promise<TransferStepResult> {
    const at = this.clock();
    const result = this.derive(step, data, at);
    switch (step.type) {
      case 'join':
        await joinDomain(step.domainId, step.uids, step.role);
        break;
      case 'group': {
        await this.atomicAdd(step.domainId, step.name, step.uids);
        await this.groupMeta.addPluginAdded(step.domainId, step.name, result.added || []);
        if (result.metaCreated) {
          const sourceMeta = step.sourceDomainId && step.sourceName
            ? await this.groupMeta.get(step.sourceDomainId, step.sourceName)
            : null;
          // 扩展信息随组复制（类型、学年），负责老师不复制（FR-074）
          await this.groupMeta.update(step.domainId, step.name, sourceMeta
            ? { kind: sourceMeta.kind, academicYear: sourceMeta.academicYear || null }
            : {});
        }
        break;
      }
      case 'relink':
        if (data.exists) {
          const id = new ObjectId(step.quotaGroupId);
          await this.quotaGroups.unlink(id, step.from, at);
          await this.quotaGroups.link(id, step.to, at);
        }
        break;
      case 'delete_group':
        await this.groups.deleteOne({ domainId: step.domainId, name: step.name });
        await this.groupMeta.delete(step.domainId, step.name);
        break;
      case 'leave':
        await leaveDomain(step.domainId, (result.rows || []).map((row) => row.uid));
        break;
      case 'pull':
        for (const item of result.removed || []) {
          await this.atomicRemove(step.domainId, item.name, item.uids);
          await this.groupMeta.removePluginAdded(step.domainId, item.name, item.uids);
        }
        break;
      default:
        throw new Error('unknown step');
    }
    return result;
  }

  private metaSnapshot(meta: GroupMeta): Record<string, unknown> {
    return {
      kind: meta.kind,
      ...(meta.academicYear ? { academicYear: meta.academicYear } : {}),
      teacherUids: meta.teacherUids || [],
      archived: !!meta.archived,
      pluginAdded: meta.pluginAdded || [],
    };
  }

  // ─── 继续执行 / 撤销 ───────────────────────────────────────────────────────

  private parseId(raw: unknown): ObjectIdType {
    if (typeof raw !== 'string' || !/^[0-9a-f]{24}$/i.test(raw)) {
      throw new GroupServiceError('TRANSFER_NOT_FOUND', 404, 'ai_helper_transfer_not_found');
    }
    return new ObjectId(raw);
  }

  async resume(rawId: unknown, actorUid: number): Promise<TransferRunResult> {
    const id = this.parseId(rawId);
    const log = await this.audit.findById(id);
    if (!log || log.undoneAt) throw new GroupServiceError('TRANSFER_NOT_RESUMABLE', 409, 'ai_helper_transfer_not_resumable');
    const job = await this.jobs.claimResume(id);
    if (!job) throw new GroupServiceError('TRANSFER_NOT_RESUMABLE', 409, 'ai_helper_transfer_not_resumable');
    await this.audit.appendStep(id, { name: 'resume', status: 'done', detail: { actorUid } });
    return this.run(job);
  }

  async undo(rawId: unknown, actorUid: number): Promise<{ undone: number; status: 'undone' }> {
    const id = this.parseId(rawId);
    const job = await this.jobs.get(id);
    if (!job) throw new GroupServiceError('TRANSFER_NOT_FOUND', 404, 'ai_helper_transfer_not_found');
    if (job.status === 'running') throw new GroupServiceError('TRANSFER_RUNNING', 409, 'ai_helper_transfer_running');
    const claimed = await this.audit.markUndone(id, actorUid);
    if (!claimed) throw new GroupServiceError('ALREADY_UNDONE', 409, 'ai_helper_transfer_already_undone');

    const results = new Map(job.results.map((result) => [result.key, result]));
    const prepared = new Map((job.prepared || []).map((item) => [item.key, item.data]));
    const touched = new Set<string>();
    let undone = 0;
    try {
      // 按计划倒序：已完成的步骤用其结果；中途失败的步骤用写入前的快照（回退操作都是幂等的）
      for (const step of [...job.plan].reverse()) {
        const data = prepared.get(step.key);
        const result = results.get(step.key) || (data ? this.derive(step, data, this.clock()) : null);
        if (!result) continue;
        await this.undoStep(step, result);
        if ('domainId' in step) touched.add(step.domainId);
        undone++;
      }
    } catch (err) {
      await this.audit.revertUndoMark(id);
      console.error('[AI Helper] transfer undo failed:', errorText(err));
      throw new GroupServiceError('TRANSFER_UNDO_FAILED', 500, 'ai_helper_transfer_undo_failed');
    } finally {
      this.afterWrites(job, touched, undone > 0);
    }
    await this.jobs.setStatus(id, 'undone');
    await this.audit.mergeDetail(id, { status: 'undone' });
    return { undone, status: 'undone' };
  }

  private async undoStep(step: TransferStep, result: TransferStepResult): Promise<void> {
    switch (step.type) {
      case 'join':
        await restoreDomainMembership(step.domainId, result.rows || [], result.absent || []);
        return;
      case 'group': {
        const added = result.added || [];
        await this.atomicRemove(step.domainId, step.name, added);
        await this.groupMeta.removePluginAdded(step.domainId, step.name, added);
        if (result.created) {
          // 只删除本次新建、且之后没有别人加人的组
          const doc = await this.groups.findOne({ domainId: step.domainId, name: step.name });
          if (doc && !(doc.uids || []).length) {
            await this.groups.deleteOne({ domainId: step.domainId, name: step.name });
            if (result.metaCreated) await this.groupMeta.delete(step.domainId, step.name);
          }
        } else if (result.metaCreated) {
          await this.groupMeta.delete(step.domainId, step.name);
        }
        return;
      }
      case 'relink': {
        const id = new ObjectId(step.quotaGroupId);
        if (result.linked) await this.quotaGroups.unlink(id, step.to);
        if (result.unlinked) await this.quotaGroups.link(id, step.from);
        return;
      }
      case 'delete_group': {
        if (result.snapshot) await this.atomicAdd(step.domainId, step.name, result.snapshot.uids);
        const meta = result.metaSnapshot as (Record<string, unknown> & { pluginAdded?: number[] }) | null | undefined;
        if (meta && !(await this.groupMeta.get(step.domainId, step.name))) {
          await this.groupMeta.update(step.domainId, step.name, {
            kind: meta.kind as GroupMeta['kind'],
            academicYear: (meta.academicYear as string | undefined) || null,
            teacherUids: (meta.teacherUids as number[]) || [],
            archived: !!meta.archived,
          });
          await this.groupMeta.addPluginAdded(step.domainId, step.name, meta.pluginAdded || []);
        }
        return;
      }
      case 'leave':
        await restoreDomainMembership(step.domainId, result.rows || []);
        return;
      case 'pull':
        for (const item of result.removed || []) {
          await this.atomicAdd(step.domainId, item.name, item.uids);
          if (item.ledger?.length) await this.groupMeta.addPluginAdded(step.domainId, item.name, item.ledger);
        }
        return;
      default:
        return;
    }
  }

  // ─── 结果汇总（前端“执行结果”） ──────────────────────────────────────────

  private result(job: TransferJob): TransferRunResult {
    return {
      auditId: String(job._id),
      status: job.status,
      ...(job.failedAt ? { failedAt: job.failedAt, error: job.error } : {}),
      summary: summarizeTransfer(job),
    };
  }
}

/** 按步骤类型汇总：分批的入域 / 退出合并为一项，其余每步一项 */
export function summarizeTransfer(job: Pick<TransferJob, 'plan' | 'results' | 'failedAt'>): TransferSummaryItem[] {
  const results = new Map(job.results.map((result) => [result.key, result]));
  const items: TransferSummaryItem[] = [];
  const batches = new Map<'join' | 'leave', { item: TransferSummaryItem; steps: number; doneSteps: number; failed: boolean }>();

  for (const step of job.plan) {
    const result = results.get(step.key);
    const failed = job.failedAt === step.key;
    if (step.type === 'join' || step.type === 'leave') {
      let entry = batches.get(step.type);
      if (!entry) {
        entry = { item: { type: step.type, status: 'pending', done: 0, total: 0 }, steps: 0, doneSteps: 0, failed: false };
        batches.set(step.type, entry);
        items.push(entry.item);
      }
      entry.item.total += step.uids.length;
      entry.steps += 1;
      if (result) {
        entry.doneSteps += 1;
        entry.item.done += step.uids.length;
      }
      entry.failed = entry.failed || failed;
      continue;
    }
    const total = 'uids' in step ? step.uids.length : 1;
    items.push({
      type: step.type,
      ...(step.type === 'group' || step.type === 'delete_group' ? { name: step.name } : {}),
      ...(step.type === 'relink' ? { name: step.quotaGroupName } : {}),
      status: result ? 'done' : failed ? 'failed' : 'pending',
      done: result ? total : 0,
      total,
      ...(step.type === 'group' && result ? { created: !!result.created, added: result.added?.length ?? 0 } : {}),
    });
  }
  for (const entry of batches.values()) {
    if (entry.doneSteps === entry.steps) entry.item.status = 'done';
    else if (entry.doneSteps) entry.item.status = 'partial';
    else entry.item.status = entry.failed ? 'failed' : 'pending';
  }
  return items;
}
