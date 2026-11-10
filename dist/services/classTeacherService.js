"use strict";
/**
 * 负责老师只读视图（FR-058，plan “负责老师”接口）
 *
 * 放行：系统管理员（本域全部小组）；或“负责老师访问”已开启，且当前用户是本域至少一个小组的负责老师
 * （ai_group_meta.teacherUids），此时只能看自己负责的小组。
 * 过滤全部在服务端完成：会话按 groupNames（建会话时的快照）过滤，并且始终限定当前域。
 * 本服务只有读操作。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClassTeacherService = exports.CLASS_STATS_SCAN_LIMIT = exports.CLASS_STATS_DAYS = void 0;
const hydroCompat_1 = require("../utils/hydroCompat");
const hydroGroupService_1 = require("./hydroGroupService");
exports.CLASS_STATS_DAYS = 7;
/** 统计时最多读取的会话数，避免异常数据拖慢页面 */
exports.CLASS_STATS_SCAN_LIMIT = 20000;
const ID_CHUNK = 1000;
function chunks(list, size) {
    const out = [];
    for (let i = 0; i < list.length; i += size)
        out.push(list.slice(i, i + size));
    return out;
}
class ClassTeacherService {
    constructor(db, groupMeta, configModel, now = () => new Date()) {
        this.groupMeta = groupMeta;
        this.configModel = configModel;
        this.now = now;
        this.conversations = db.collection('ai_conversations');
        this.safetyLogs = db.collection('ai_jailbreak_logs');
        this.groups = (0, hydroCompat_1.groupColl)(db);
        this.domains = db.collection('domain');
    }
    /** 解析可访问范围；无权访问时抛出 403 */
    async resolveScope(domainId, uid, systemAdmin) {
        let names;
        let metas;
        if (systemAdmin) {
            const docs = await this.groups.find({ domainId }, { projection: { name: 1 } }).toArray();
            names = docs.map((doc) => doc.name).filter((name) => typeof name === 'string' && !/^\d+$/.test(name));
            metas = await this.groupMeta.listByDomain(domainId);
        }
        else {
            const config = await this.configModel.getConfig();
            if (!config?.groupTeacherAccessEnabled) {
                throw new hydroGroupService_1.GroupServiceError('TEACHER_ACCESS_DISABLED', 403, 'ai_helper_class_err_disabled');
            }
            metas = await this.groupMeta.listByTeacher(domainId, uid);
            names = metas.map((meta) => meta.name);
            if (!names.length)
                throw new hydroGroupService_1.GroupServiceError('NOT_GROUP_TEACHER', 403, 'ai_helper_class_err_not_teacher');
        }
        const unique = [...new Set(names)];
        const hydroDocs = unique.length
            ? await this.groups.find({ domainId, name: { $in: unique } }, { projection: { name: 1, uids: 1 } }).toArray()
            : [];
        const members = new Map(hydroDocs.map((doc) => [doc.name, Array.isArray(doc.uids) ? doc.uids.length : 0]));
        const metaByName = new Map(metas.map((meta) => [meta.name, meta]));
        const groups = unique.map((name) => {
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
    requireGroup(scope, group) {
        const found = typeof group === 'string' ? scope.groups.find((item) => item.name === group) : undefined;
        if (!found)
            throw new hydroGroupService_1.GroupServiceError('GROUP_NOT_ALLOWED', 403, 'ai_helper_class_err_group');
        return found;
    }
    /** 会话是否在可访问范围内：同域，且建会话时的小组与可访问小组有交集 */
    canView(scope, conversation) {
        if (conversation.domainId !== scope.domainId)
            return false;
        const allowed = new Set(scope.groups.map((group) => group.name));
        return (conversation.groupNames || []).some((name) => allowed.has(name));
    }
    async stats(scope, group) {
        const since = new Date(this.now().getTime() - exports.CLASS_STATS_DAYS * 24 * 60 * 60 * 1000);
        const docs = await this.conversations
            .find({ domainId: scope.domainId, groupNames: group.name, startTime: { $gte: since } }, { projection: { _id: 1, userId: 1, messageCount: 1, 'metrics.studentMessageCount': 1 } })
            .limit(exports.CLASS_STATS_SCAN_LIMIT + 1)
            .toArray();
        const truncated = docs.length > exports.CLASS_STATS_SCAN_LIMIT;
        const list = truncated ? docs.slice(0, exports.CLASS_STATS_SCAN_LIMIT) : docs;
        const turns = list.map((conv) => {
            const counted = conv.metrics?.studentMessageCount;
            return typeof counted === 'number' ? counted : Math.ceil((conv.messageCount || 0) / 2);
        });
        const avgTurns = turns.length ? Math.round((turns.reduce((sum, n) => sum + n, 0) / turns.length) * 10) / 10 : null;
        const flags = await this.flagsFor(scope.domainId, list.map((conv) => conv._id));
        const byCategory = {};
        let total = 0;
        for (const flag of flags.values()) {
            total += flag.count;
            for (const category of flag.allCategories)
                byCategory[category] = (byCategory[category] || 0) + 1;
        }
        return {
            group: group.name,
            since,
            days: exports.CLASS_STATS_DAYS,
            conversations: list.length,
            activeStudents: new Set(list.map((conv) => conv.userId)).size,
            memberCount: group.memberCount,
            avgTurns,
            violations: { total, byCategory },
            truncated,
        };
    }
    /** 列表上的违规标记：每个会话的违规记录数与类别（复核为误判的不计） */
    async conversationFlags(domainId, ids) {
        const flags = await this.flagsFor(domainId, ids);
        return new Map([...flags].map(([id, flag]) => [id, { count: flag.count, categories: [...new Set(flag.allCategories)] }]));
    }
    async flagsFor(domainId, ids) {
        const out = new Map();
        for (const part of chunks(ids, ID_CHUNK)) {
            if (!part.length)
                continue;
            const logs = await this.safetyLogs
                .find({ domainId, conversationId: { $in: part }, category: { $exists: true }, reviewStatus: { $ne: 'false_positive' } }, { projection: { conversationId: 1, category: 1 } })
                .toArray();
            for (const log of logs) {
                if (!log.conversationId || !log.category)
                    continue;
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
exports.ClassTeacherService = ClassTeacherService;
//# sourceMappingURL=classTeacherService.js.map