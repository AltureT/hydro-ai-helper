import {
  AnalyticsFilterOptionsHandler,
  AnalyticsHandler,
  buildConversationMatch,
  buildGroupDimensionPipeline,
} from '../../handlers/analyticsHandler';
import { UNGROUPED_KEY } from '../../utils/groupFilter';
import { createFakeCollection, matches } from '../helpers/fakeMongo';

type Doc = Record<string, any>;

/**
 * 只覆盖小组维度管道用到的阶段与表达式，用来检查 $unwind 与两次 $group 的语义，
 * 而不只是比较管道的字面结构。
 */
function evalExpr(doc: Doc, expr: any): any {
  if (typeof expr === 'string' && expr.startsWith('$')) {
    return expr.slice(1).split('.').reduce((value, key) => (value == null ? undefined : value[key]), doc as any);
  }
  if (expr && typeof expr === 'object' && !Array.isArray(expr) && !(expr instanceof Date)) {
    const [op] = Object.keys(expr);
    if (!op.startsWith('$')) {
      return Object.fromEntries(Object.entries(expr).map(([key, value]) => [key, evalExpr(doc, value) ?? null]));
    }
    const args = (expr[op] as any[]).map((arg) => evalExpr(doc, arg));
    switch (op) {
      case '$ifNull': return args[0] ?? args[1];
      case '$cond': return args[0] ? args[1] : args[2];
      case '$gt': return args[0] > args[1];
      case '$divide': return args[0] / args[1];
      default: throw new Error(`unsupported ${op}`);
    }
  }
  return expr;
}

function runPipeline(docs: Doc[], pipeline: Doc[]): Doc[] {
  let rows = docs.map((doc) => ({ ...doc }));
  for (const stage of pipeline) {
    const [[name, spec]] = Object.entries(stage);
    if (name === '$match') {
      rows = rows.filter((row) => matches(row, spec));
    } else if (name === '$unwind') {
      const field = spec.path.slice(1);
      rows = rows.flatMap((row) => {
        const value = row[field];
        if (Array.isArray(value) && value.length > 0) return value.map((item) => ({ ...row, [field]: item }));
        if (spec.preserveNullAndEmptyArrays) {
          const copy = { ...row };
          delete copy[field];
          return [copy];
        }
        return [];
      });
    } else if (name === '$group') {
      const buckets = new Map<string, Doc>();
      for (const row of rows) {
        const id = evalExpr(row, spec._id) ?? null;
        const bucketKey = JSON.stringify(id);
        const bucket = buckets.get(bucketKey) ?? { _id: id };
        for (const [field, acc] of Object.entries(spec)) {
          if (field === '_id') continue;
          bucket[field] = (bucket[field] ?? 0) + evalExpr(row, (acc as Doc).$sum);
        }
        buckets.set(bucketKey, bucket);
      }
      rows = [...buckets.values()];
    } else if (name === '$project') {
      rows = rows.map((row) => {
        const out: Doc = {};
        for (const [field, value] of Object.entries(spec)) {
          if (value === 0) continue;
          out[field] = value === 1 ? row[field] : evalExpr(row, value);
        }
        return out;
      });
    } else if (name === '$sort') {
      rows = [...rows].sort((a, b) => (b.totalConversations - a.totalConversations) || String(a.key).localeCompare(String(b.key)));
    } else {
      throw new Error(`unsupported stage ${name}`);
    }
  }
  return rows;
}

const conversations: Doc[] = [
  { domainId: 'oi2023', userId: 1, groupNames: ['2023级1班'], isEffective: true, startTime: new Date('2026-11-02') },
  { domainId: 'oi2023', userId: 1, groupNames: ['2023级1班', '竞赛组'], isEffective: false, startTime: new Date('2026-11-03') },
  { domainId: 'oi2023', userId: 2, groupNames: ['2023级1班'], isEffective: true, startTime: new Date('2026-11-04') },
  { domainId: 'oi2023', userId: 3, isEffective: false, startTime: new Date('2026-11-05') },
  { domainId: 'oi2023', userId: 3, groupNames: [], isEffective: true, startTime: new Date('2026-11-06') },
  { domainId: 'other', userId: 4, groupNames: ['2023级1班'], isEffective: true, startTime: new Date('2026-11-06') },
];

describe('buildConversationMatch', () => {
  it('always scopes by domain and applies dates, group, problem and user', () => {
    const start = new Date('2026-11-01');
    const end = new Date('2026-11-08');
    expect(buildConversationMatch({ domainId: 'oi2023', startDate: start, endDate: end, group: '竞赛组', problemId: 'P1', userId: 7 }))
      .toEqual({ domainId: 'oi2023', startTime: { $gte: start, $lte: end }, groupNames: '竞赛组', problemId: 'P1', userId: 7 });
    expect(buildConversationMatch({ domainId: 'oi2023', group: UNGROUPED_KEY }))
      .toEqual({ domainId: 'oi2023', $or: [{ groupNames: { $exists: false } }, { groupNames: { $size: 0 } }] });
  });
});

describe('buildGroupDimensionPipeline (FR-056)', () => {
  it('counts a conversation once per group it belonged to, and ungrouped ones together', () => {
    const rows = runPipeline(conversations, buildGroupDimensionPipeline({ domainId: 'oi2023' }));
    expect(rows).toEqual([
      expect.objectContaining({ key: '2023级1班', totalConversations: 3, effectiveConversations: 2, studentCount: 2, avgConversationsPerStudent: 1.5 }),
      expect.objectContaining({ key: UNGROUPED_KEY, totalConversations: 2, effectiveConversations: 1, studentCount: 1 }),
      expect.objectContaining({ key: '竞赛组', totalConversations: 1, effectiveConversations: 0, studentCount: 1, effectiveRatio: 0 }),
    ]);
  });

  it('keeps only the selected group even when a conversation belongs to several', () => {
    const rows = runPipeline(conversations, buildGroupDimensionPipeline({ domainId: 'oi2023', group: '竞赛组' }));
    expect(rows).toEqual([expect.objectContaining({ key: '竞赛组', totalConversations: 1, studentCount: 1 })]);
  });

  it('returns only the ungrouped row for the ungrouped filter', () => {
    const rows = runPipeline(conversations, buildGroupDimensionPipeline({ domainId: 'oi2023', group: UNGROUPED_KEY }));
    expect(rows).toEqual([expect.objectContaining({ key: UNGROUPED_KEY, totalConversations: 2, studentCount: 1 })]);
  });

  it('unwinds with preserveNullAndEmptyArrays so ungrouped conversations are not dropped', () => {
    const pipeline = buildGroupDimensionPipeline({ domainId: 'oi2023' });
    expect(pipeline[1]).toEqual({ $unwind: { path: '$groupNames', preserveNullAndEmptyArrays: true } });
  });
});

function makeAnalyticsHandler(query: Record<string, string>) {
  const handler = new AnalyticsHandler();
  const aggregate = jest.fn(() => ({ toArray: jest.fn().mockResolvedValue([]) }));
  handler.request = { headers: { accept: 'application/json' }, query };
  handler.response = {};
  handler.args = { domainId: 'oi2023' };
  (handler as any).translate = (key: string) => key;
  handler.ctx = { db: { collection: jest.fn(() => ({ aggregate })) } } as any;
  return { handler, aggregate };
}

describe('AnalyticsHandler group parameter', () => {
  it('accepts the old classId parameter as an alias for group', async () => {
    const { handler, aggregate } = makeAnalyticsHandler({ dimension: 'class', classId: '2023级1班' });
    await handler.get();
    const pipeline = (aggregate.mock.calls[0] as any[])[0];
    expect(pipeline[0]).toEqual({ $match: { domainId: 'oi2023', groupNames: '2023级1班' } });
    expect(pipeline).toContainEqual({ $match: { groupNames: '2023级1班' } });
  });

  it('filters the problem and student dimensions by group too', async () => {
    for (const dimension of ['problem', 'student']) {
      const { handler, aggregate } = makeAnalyticsHandler({ dimension, group: UNGROUPED_KEY });
      await handler.get();
      const pipeline = (aggregate.mock.calls[0] as any[])[0];
      expect(pipeline[0].$match).toEqual({
        domainId: 'oi2023',
        $or: [{ groupNames: { $exists: false } }, { groupNames: { $size: 0 } }],
      });
    }
  });
});

describe('AnalyticsFilterOptionsHandler groups', () => {
  it('lists sorted group names from this domain, whether ungrouped ones exist, and keeps classIds as an alias', async () => {
    const handler = new AnalyticsFilterOptionsHandler();
    const col = createFakeCollection(conversations.map(({ userId, ...rest }) => ({ ...rest, userId: userId + 1000 })));
    handler.request = { headers: { accept: 'application/json' }, query: {} };
    handler.response = {};
    handler.args = { domainId: 'oi2023' };
    (handler as any).translate = (key: string) => key;
    handler.ctx = { db: { collection: jest.fn(() => col) } } as any;
    await handler.get();
    expect(handler.response.body.groups).toEqual(['2023级1班', '竞赛组'].sort((a, b) => a.localeCompare(b)));
    expect(handler.response.body.hasUngrouped).toBe(true);
    expect(handler.response.body.classIds).toEqual(handler.response.body.groups);
  });

  it('reports no ungrouped conversations when every conversation has a group', async () => {
    const handler = new AnalyticsFilterOptionsHandler();
    const col = createFakeCollection([conversations[0], conversations[1]]);
    handler.request = { headers: { accept: 'application/json' }, query: {} };
    handler.response = {};
    handler.args = { domainId: 'oi2023' };
    (handler as any).translate = (key: string) => key;
    handler.ctx = { db: { collection: jest.fn(() => col) } } as any;
    await handler.get();
    expect(handler.response.body.hasUngrouped).toBe(false);
  });
});
