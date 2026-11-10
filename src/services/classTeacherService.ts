/**
 * 负责老师只读视图（FR-058，plan “负责老师”接口）
 *
 * 放行：系统管理员（本域全部小组）；或“负责老师访问”已开启，且当前用户是本域至少一个小组的负责老师
 * （ai_group_meta.teacherUids），此时只能看自己负责的小组。
 * 过滤全部在服务端完成：会话按 groupNames（建会话时的快照）过滤，并且始终限定当前域。
 * 本服务只有读操作。
 */

import type { Collection, Db } from 'mongodb';
import type { AIConfigModel } from '../models/aiConfig';
import type { Conversation } from '../models/conversation';
import type { GroupKind, GroupMeta, GroupMetaModel } from '../models/groupMeta';
import type { JailbreakLog } from '../models/jailbreakLog';
import type { SafetyViolationCategory } from '../types/safety';
import { groupColl, type HydroGroupDoc } from '../utils/hydroCompat';
import type { ObjectIdType } from '../utils/mongo';
import { GroupServiceError } from './hydroGroupService';

export const CLASS_STATS_DAYS = 7;
/** 统计时最多读取的会话数，避免异常数据拖慢页面 */
export const CLASS_STATS_SCAN_LIMIT = 20000;
const ID_CHUNK = 1000;

export interface ClassGroupView {
  name: string;
  /** Hydro 小组当前成员数；小组已在 Hydro 中删除时为 0 */
  memberCount: number;
  kind?: GroupKind;
  academicYear?: string;
  archived: boolean;
}

export interface ClassScope {
  domainId: string;
  domainName: string;
  systemAdmin: boolean;
  groups: ClassGroupView[];
}

export interface ClassStats {
  group: string;
  since: Date;
  days: number;
  conversations: number;
  activeStudents: number;
  memberCount: number;
  /** 平均每次对话的学生提问数；没有对话时为 null */
  avgTurns: number | null;
  violations: { total: number; byCategory: Partial<Record<SafetyViolationCategory, number>> };
  /** 达到读取上限，数字只统计了前 CLASS_STATS_SCAN_LIMIT 条 */
  truncated: boolean;
}

export interface ConversationFlags {
  count: number;
  categories: SafetyViolationCategory[];
}

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export class ClassTeacherService {
  private readonly conversations: Collection<Conversation>;
  private readonly safetyLogs: Collection<JailbreakLog>;
  private readonly groups: Collection<HydroGroupDoc>;
  private readonly domains: Collection<{ _id: string; name?: string }>;

  constructor(
    db: Db,
    private readonly groupMeta: GroupMetaModel,
    private readonly configModel: Pick<AIConfigModel, 'getConfig'>,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.conversations = db.collection<Conversation>('ai_conversations');
    this.safetyLogs = db.collection<JailbreakLog>('ai_jailbreak_logs');
    this.groups = groupColl(db);
    this.domains = db.collection<{ _id: string; name?: string }>('domain');
  }

  /** 解析可访问范围；无权访问时抛出 403 */
  async resolveScope(domainId: string, uid: number, systemAdmin: boolean): Promise<ClassScope> {
    let names: string[];
    let metas: GroupMeta[];
    if (systemAdmin) {
      const docs = await this.groups.find({ domainId }, { projection: { name: 1 } }).toArray();
      names = docs.map((doc) => doc.name).filter((name) => typeof name === 'string' && !/^\d+$/.test(name));
      metas = await this.groupMeta.listByDomain(domainId);
    } else {
      const config = await this.configModel.getConfig();
      if (!config?.groupTeacherAccessEnabled) {
        throw new GroupServiceError('TEACHER_ACCESS_DISABLED', 403, 'ai_helper_class_err_disabled');
      }
      metas = await this.groupMeta.listByTeacher(domainId, uid);
      names = metas.map((meta) => meta.name);
      if (!names.length) throw new GroupServiceError('NOT_GROUP_TEACHER', 403, 'ai_helper_class_err_not_teacher');
    }

    const unique = [...new Set(names)];
    const hydroDocs = unique.length
      ? await this.groups.find({ domainId, name: { $in: unique } }, { projection: { name: 1, uids: 1 } }).toArray()
      : [];
    const members = new Map(hydroDocs.map((doc) => [doc.name, Array.isArray(doc.uids) ? doc.uids.length : 0]));
    const metaByName = new Map(metas.map((meta) => [meta.name, meta]));
    const groups = unique.map((name): ClassGroupView => {
      const meta = metaByName.get(name);
      return {
        name,
        memberCount: members.get(name) ?? 0,
        ...(meta?.kind ? { kind: meta.kind } : {}),
        ...(meta?.academicYear ? { academicYear: meta.academicYear } : {}),
        archived: !!meta?.archived,
      };
    });
    groups.sort((a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name));
    const domain = await this.domains.findOne({ _id: domainId }, { projection: { name: 1 } });
    return { domainId, domainName: domain?.name || domainId, systemAdmin, groups };
  }

  /** 请求的小组必须在可访问范围内 */
  requireGroup(scope: ClassScope, group: unknown): ClassGroupView {
    const found = typeof group === 'string' ? scope.groups.find((item) => item.name === group) : undefined;
    if (!found) throw new GroupServiceError('GROUP_NOT_ALLOWED', 403, 'ai_helper_class_err_group');
    return found;
  }

  /** 会话是否在可访问范围内：同域，且建会话时的小组与可访问小组有交集 */
  canView(scope: ClassScope, conversation: Pick<Conversation, 'domainId' | 'groupNames'>): boolean {
    if (conversation.domainId !== scope.domainId) return false;
    const allowed = new Set(scope.groups.map((group) => group.name));
    return (conversation.groupNames || []).some((name) => allowed.has(name));
  }

  async stats(scope: ClassScope, group: ClassGroupView): Promise<ClassStats> {
    const since = new Date(this.now().getTime() - CLASS_STATS_DAYS * 24 * 60 * 60 * 1000);
    const docs = await this.conversations
      .find(
        { domainId: scope.domainId, groupNames: group.name, startTime: { $gte: since } },
        { projection: { _id: 1, userId: 1, messageCount: 1, 'metrics.studentMessageCount': 1 } },
      )
      .limit(CLASS_STATS_SCAN_LIMIT + 1)
      .toArray();
    const truncated = docs.length > CLASS_STATS_SCAN_LIMIT;
    const list = truncated ? docs.slice(0, CLASS_STATS_SCAN_LIMIT) : docs;

    const turns = list.map((conv) => {
      const counted = conv.metrics?.studentMessageCount;
      return typeof counted === 'number' ? counted : Math.ceil((conv.messageCount || 0) / 2);
    });
    const avgTurns = turns.length ? Math.round((turns.reduce((sum, n) => sum + n, 0) / turns.length) * 10) / 10 : null;

    const flags = await this.flagsFor(scope.domainId, list.map((conv) => conv._id));
    const byCategory: Partial<Record<SafetyViolationCategory, number>> = {};
    let total = 0;
    for (const flag of flags.values()) {
      total += flag.count;
      for (const category of flag.allCategories) byCategory[category] = (byCategory[category] || 0) + 1;
    }

    return {
      group: group.name,
      since,
      days: CLASS_STATS_DAYS,
      conversations: list.length,
      activeStudents: new Set(list.map((conv) => conv.userId)).size,
      memberCount: group.memberCount,
      avgTurns,
      violations: { total, byCategory },
      truncated,
    };
  }

  /** 列表上的违规标记：每个会话的违规记录数与类别（复核为误判的不计） */
  async conversationFlags(domainId: string, ids: ObjectIdType[]): Promise<Map<string, ConversationFlags>> {
    const flags = await this.flagsFor(domainId, ids);
    return new Map([...flags].map(([id, flag]) => [id, { count: flag.count, categories: [...new Set(flag.allCategories)] }]));
  }

  private async flagsFor(domainId: string, ids: ObjectIdType[]):
    Promise<Map<string, { count: number; allCategories: SafetyViolationCategory[] }>> {
    const out = new Map<string, { count: number; allCategories: SafetyViolationCategory[] }>();
    for (const part of chunks(ids, ID_CHUNK)) {
      if (!part.length) continue;
      const logs = await this.safetyLogs
        .find(
          { domainId, conversationId: { $in: part }, category: { $exists: true }, reviewStatus: { $ne: 'false_positive' } },
          { projection: { conversationId: 1, category: 1 } },
        )
        .toArray();
      for (const log of logs) {
        if (!log.conversationId || !log.category) continue;
        const key = String(log.conversationId);
        const entry = out.get(key) ?? { count: 0, allCategories: [] };
        entry.count += 1;
        entry.allCategories.push(log.category);
        out.set(key, entry);
      }
    }
    return out;
  }
}
