# Teaching Suggestions (教学建议) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Teaching Suggestions" feature that analyzes per-assignment student data via rule engine + selective LLM deep-dive, producing an interactive drill-down report for teachers.

**Architecture:** Three-layer pipeline — (1) data aggregation from MongoDB collections, (2) rule engine anomaly detection across 8 dimensions, (3) LLM generates teaching suggestions + on-demand deep-dive cognitive diagnosis. Results stored in `ai_teaching_summaries` collection. Frontend: new dashboard tab + scoreboard entry point.

**Tech Stack:** TypeScript, MongoDB, React 17, HydroOJ plugin framework, OpenAI-compatible API client

**Spec:** `docs/superpowers/specs/2026-04-12-teaching-suggestions-design.md`

---

## File Structure

### New Files (Backend)

| File | Responsibility |
|---|---|
| `src/models/teachingSummary.ts` | MongoDB CRUD for `ai_teaching_summaries` collection |
| `src/services/teachingAnalysisService.ts` | Layer 1+2: data aggregation + rule engine anomaly detection |
| `src/services/teachingSuggestionService.ts` | Layer 3: LLM prompt construction + deep-dive orchestration |
| `src/handlers/teachingSummaryHandler.ts` | HTTP handlers: generate, get, list, feedback |

### New Files (Frontend)

| File | Responsibility |
|---|---|
| `frontend/teachingSummary/TeachingSummaryPanel.tsx` | Main panel: overview bar + findings list + drill-down |
| `frontend/teachingSummary/useTeachingSummary.ts` | Hook: API calls, polling, state management |
| `frontend/teachingSummary/TeachingReviewPanel.tsx` | Dashboard tab: timeline list of all summaries |
| `frontend/teachingSummary/useTeachingReview.ts` | Hook: list/filter summaries for review tab |

### Modified Files

| File | Change |
|---|---|
| `src/index.ts` | Instantiate model, provide to ctx, register routes |
| `frontend/components/AIHelperDashboard.tsx` | Add "教学总结回顾" tab |
| `locales/zh.yaml` | Add i18n keys |
| `locales/en.yaml` | Add i18n keys |

---

## Task 1: TeachingSummary Model

**Files:**
- Create: `src/models/teachingSummary.ts`
- Test: `src/__tests__/models/teachingSummary.test.ts`

- [ ] **Step 1: Write failing test for TeachingSummaryModel**

```typescript
// src/__tests__/models/teachingSummary.test.ts
import { TeachingSummaryModel, TeachingSummary } from '../../models/teachingSummary';

// Mock MongoDB
const mockCollection = {
  createIndex: jest.fn().mockResolvedValue(undefined),
  insertOne: jest.fn().mockResolvedValue({ insertedId: 'mock-id' }),
  findOne: jest.fn().mockResolvedValue(null),
  find: jest.fn().mockReturnValue({
    sort: jest.fn().mockReturnValue({
      skip: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({
          toArray: jest.fn().mockResolvedValue([]),
        }),
      }),
    }),
  }),
  countDocuments: jest.fn().mockResolvedValue(0),
  updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
  deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
};
const mockDb = { collection: jest.fn().mockReturnValue(mockCollection) } as any;

describe('TeachingSummaryModel', () => {
  let model: TeachingSummaryModel;

  beforeEach(() => {
    jest.clearAllMocks();
    model = new TeachingSummaryModel(mockDb);
  });

  it('should create collection with correct name', () => {
    expect(mockDb.collection).toHaveBeenCalledWith('ai_teaching_summaries');
  });

  it('should create indexes', async () => {
    await model.ensureIndexes();
    expect(mockCollection.createIndex).toHaveBeenCalledTimes(2);
  });

  it('should create a teaching summary', async () => {
    const params = {
      domainId: 'test',
      contestId: 'contest-1' as any,
      contestTitle: 'Test Assignment',
      contestContent: 'Learn recursion',
      createdBy: 1,
    };
    await model.create(params);
    expect(mockCollection.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({
        domainId: 'test',
        contestTitle: 'Test Assignment',
        status: 'pending',
        findings: [],
      }),
    );
  });

  it('should find by domain and list in reverse chronological order', async () => {
    await model.findByDomain('test', 1, 20);
    expect(mockCollection.find).toHaveBeenCalledWith({ domainId: 'test' });
  });

  it('should update status', async () => {
    await model.updateStatus('id-1' as any, 'generating');
    expect(mockCollection.updateOne).toHaveBeenCalled();
  });

  it('should save feedback', async () => {
    await model.saveFeedback('id-1' as any, 'up', 'Great suggestions');
    expect(mockCollection.updateOne).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        $set: expect.objectContaining({
          'feedback.rating': 'up',
          'feedback.comment': 'Great suggestions',
        }),
      }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/models/teachingSummary.test.ts --no-coverage`
Expected: FAIL — module not found

- [ ] **Step 3: Write the TeachingSummaryModel**

```typescript
// src/models/teachingSummary.ts
/**
 * TeachingSummary Model - 教学建议数据模型
 *
 * 存储基于作业数据生成的教学建议,支持规则引擎发现 + LLM 深潜分析
 */

import type { Db, Collection } from 'mongodb';
import { type ObjectIdType } from '../utils/mongo';
import { ensureObjectId } from '../utils/ensureObjectId';

export type FindingDimension =
  | 'commonError'
  | 'comprehension'
  | 'strategy'
  | 'atRisk'
  | 'difficulty'
  | 'progress'
  | 'cognitivePath'
  | 'aiEffectiveness';

export interface TeachingFinding {
  id: string;
  dimension: FindingDimension;
  severity: 'high' | 'medium' | 'low';
  title: string;
  evidence: {
    affectedStudents: number[];
    affectedProblems: number[];
    metrics: Record<string, number>;
    samples?: {
      code?: string[];
      conversations?: string[];
    };
  };
  needsDeepDive: boolean;
  aiSuggestion?: string;
  aiAnalysis?: string;
}

export interface TeachingSummary {
  _id: ObjectIdType;
  domainId: string;
  contestId: ObjectIdType;
  contestTitle: string;
  contestContent: string;
  teachingFocus?: string;
  createdBy: number;
  createdAt: Date;
  dataSnapshotAt: Date;
  status: 'pending' | 'generating' | 'completed' | 'failed';

  stats: {
    totalStudents: number;
    participatedStudents: number;
    aiUserCount: number;
    problemCount: number;
  };
  findings: TeachingFinding[];

  overallSuggestion: string;
  deepDiveResults: Record<string, string>;

  feedback?: {
    rating: 'up' | 'down';
    comment?: string;
  };

  tokenUsage: { promptTokens: number; completionTokens: number };
  generationTimeMs: number;
}

export interface TeachingSummaryCreateParams {
  domainId: string;
  contestId: string | ObjectIdType;
  contestTitle: string;
  contestContent: string;
  teachingFocus?: string;
  createdBy: number;
}

export class TeachingSummaryModel {
  private collection: Collection<TeachingSummary>;

  constructor(db: Db) {
    this.collection = db.collection<TeachingSummary>('ai_teaching_summaries');
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex(
      { domainId: 1, createdAt: -1 },
      { name: 'idx_domainId_createdAt' },
    );
    await this.collection.createIndex(
      { domainId: 1, contestId: 1 },
      { name: 'idx_domainId_contestId' },
    );
    console.log('[TeachingSummaryModel] Indexes created successfully');
  }

  async create(params: TeachingSummaryCreateParams): Promise<ObjectIdType> {
    const now = new Date();
    const doc: Omit<TeachingSummary, '_id'> = {
      domainId: params.domainId,
      contestId: ensureObjectId(params.contestId),
      contestTitle: params.contestTitle,
      contestContent: params.contestContent,
      teachingFocus: params.teachingFocus,
      createdBy: params.createdBy,
      createdAt: now,
      dataSnapshotAt: now,
      status: 'pending',
      stats: { totalStudents: 0, participatedStudents: 0, aiUserCount: 0, problemCount: 0 },
      findings: [],
      overallSuggestion: '',
      deepDiveResults: {},
      tokenUsage: { promptTokens: 0, completionTokens: 0 },
      generationTimeMs: 0,
    };
    const result = await this.collection.insertOne(doc as TeachingSummary);
    return result.insertedId;
  }

  async findById(id: string | ObjectIdType): Promise<TeachingSummary | null> {
    return this.collection.findOne({ _id: ensureObjectId(id) });
  }

  async findByContest(domainId: string, contestId: string | ObjectIdType): Promise<TeachingSummary | null> {
    return this.collection.findOne(
      { domainId, contestId: ensureObjectId(contestId) },
      { sort: { createdAt: -1 } },
    );
  }

  async findByDomain(
    domainId: string,
    page: number = 1,
    limit: number = 20,
  ): Promise<{ summaries: TeachingSummary[]; total: number }> {
    const query = { domainId };
    const [summaries, total] = await Promise.all([
      this.collection
        .find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray(),
      this.collection.countDocuments(query),
    ]);
    return { summaries, total };
  }

  async updateStatus(id: string | ObjectIdType, status: TeachingSummary['status']): Promise<void> {
    await this.collection.updateOne(
      { _id: ensureObjectId(id) },
      { $set: { status } },
    );
  }

  async saveResults(
    id: string | ObjectIdType,
    data: {
      stats: TeachingSummary['stats'];
      findings: TeachingFinding[];
      overallSuggestion: string;
      deepDiveResults: Record<string, string>;
      tokenUsage: TeachingSummary['tokenUsage'];
      generationTimeMs: number;
    },
  ): Promise<void> {
    await this.collection.updateOne(
      { _id: ensureObjectId(id) },
      {
        $set: {
          status: 'completed' as const,
          stats: data.stats,
          findings: data.findings,
          overallSuggestion: data.overallSuggestion,
          deepDiveResults: data.deepDiveResults,
          tokenUsage: data.tokenUsage,
          generationTimeMs: data.generationTimeMs,
        },
      },
    );
  }

  async saveFeedback(id: string | ObjectIdType, rating: 'up' | 'down', comment?: string): Promise<void> {
    await this.collection.updateOne(
      { _id: ensureObjectId(id) },
      { $set: { 'feedback.rating': rating, 'feedback.comment': comment || '' } },
    );
  }

  async deleteById(id: string | ObjectIdType): Promise<void> {
    await this.collection.deleteOne({ _id: ensureObjectId(id) });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/models/teachingSummary.test.ts --no-coverage`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/models/teachingSummary.ts src/__tests__/models/teachingSummary.test.ts
git commit -m "feat: add TeachingSummaryModel for teaching suggestions"
```

---

## Task 2: Teaching Analysis Service (Data Aggregation + Rule Engine)

**Files:**
- Create: `src/services/teachingAnalysisService.ts`
- Test: `src/__tests__/services/teachingAnalysisService.test.ts`

This is the largest and most critical service. It implements Layers 1 and 2 of the pipeline.

- [ ] **Step 1: Write failing test**

```typescript
// src/__tests__/services/teachingAnalysisService.test.ts
import { TeachingAnalysisService } from '../../services/teachingAnalysisService';
import type { TeachingFinding } from '../../models/teachingSummary';

// Mock db with collections
function createMockDb(overrides: Record<string, any> = {}) {
  const defaults: Record<string, any[]> = {
    record: [],
    ai_conversations: [],
    ai_messages: [],
    ai_jailbreak_logs: [],
    ai_student_history: [],
    'document.status': [],
  };
  const data = { ...defaults, ...overrides };
  return {
    collection: jest.fn((name: string) => ({
      find: jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnValue({
          toArray: jest.fn().mockResolvedValue(data[name] || []),
        }),
        toArray: jest.fn().mockResolvedValue(data[name] || []),
      }),
      aggregate: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([]),
      }),
    })),
  } as any;
}

describe('TeachingAnalysisService', () => {
  it('should detect common error pattern when >30% students have same status on same problem', async () => {
    const records = [];
    // 20 students total, 8 get WA on pid 1 (40% > 30% threshold)
    for (let i = 1; i <= 20; i++) {
      records.push({
        domainId: 'd1', uid: i, pid: 1,
        status: i <= 8 ? 30 : 1, // 30=WA, 1=AC
        judgeAt: new Date(), score: i <= 8 ? 0 : 100,
      });
    }
    const db = createMockDb({ record: records });
    const service = new TeachingAnalysisService(db);
    const result = await service.analyze({
      domainId: 'd1',
      contestId: 'c1' as any,
      pids: [1],
      studentUids: Array.from({ length: 20 }, (_, i) => i + 1),
    });

    const commonErrors = result.findings.filter(f => f.dimension === 'commonError');
    expect(commonErrors.length).toBeGreaterThan(0);
    expect(commonErrors[0].evidence.affectedStudents.length).toBe(8);
  });

  it('should not trigger finding when affected students < 5 (min sample gate)', async () => {
    const records = [];
    // 10 students, 3 get WA (30% but only 3 people < 5 min gate)
    for (let i = 1; i <= 10; i++) {
      records.push({
        domainId: 'd1', uid: i, pid: 1,
        status: i <= 3 ? 30 : 1,
        judgeAt: new Date(), score: i <= 3 ? 0 : 100,
      });
    }
    const db = createMockDb({ record: records });
    const service = new TeachingAnalysisService(db);
    const result = await service.analyze({
      domainId: 'd1',
      contestId: 'c1' as any,
      pids: [1],
      studentUids: Array.from({ length: 10 }, (_, i) => i + 1),
    });

    const highFindings = result.findings.filter(f => f.severity === 'high' || f.severity === 'medium');
    // Should be empty or marked as observation-only
    expect(highFindings.filter(f => f.dimension === 'commonError').length).toBe(0);
  });

  it('should detect difficulty anomaly when pass rate < 20%', async () => {
    const records = [];
    // 50 students, only 5 AC (10% pass rate)
    for (let i = 1; i <= 50; i++) {
      records.push({
        domainId: 'd1', uid: i, pid: 1,
        status: i <= 5 ? 1 : 30,
        judgeAt: new Date(), score: i <= 5 ? 100 : 0,
      });
    }
    const db = createMockDb({ record: records });
    const service = new TeachingAnalysisService(db);
    const result = await service.analyze({
      domainId: 'd1',
      contestId: 'c1' as any,
      pids: [1],
      studentUids: Array.from({ length: 50 }, (_, i) => i + 1),
    });

    const diffFindings = result.findings.filter(f => f.dimension === 'difficulty');
    expect(diffFindings.length).toBe(1);
    expect(diffFindings[0].severity).toBe('high');
  });

  it('should return stats with aiUserCount', async () => {
    const conversations = [
      { domainId: 'd1', userId: 1, problemId: '1', startTime: new Date() },
      { domainId: 'd1', userId: 2, problemId: '1', startTime: new Date() },
    ];
    const db = createMockDb({ ai_conversations: conversations });
    const service = new TeachingAnalysisService(db);
    const result = await service.analyze({
      domainId: 'd1',
      contestId: 'c1' as any,
      pids: [1],
      studentUids: [1, 2, 3, 4, 5],
    });

    expect(result.stats.aiUserCount).toBe(2);
    expect(result.stats.participatedStudents).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/services/teachingAnalysisService.test.ts --no-coverage`
Expected: FAIL — module not found

- [ ] **Step 3: Write TeachingAnalysisService**

```typescript
// src/services/teachingAnalysisService.ts
/**
 * Teaching Analysis Service - 教学分析服务
 *
 * Layer 1: 从 MongoDB 采集并聚合数据
 * Layer 2: 规则引擎异常检测,生成 findings
 */

import type { Db } from 'mongodb';
import type { TeachingFinding, FindingDimension } from '../models/teachingSummary';

// HydroOJ record status codes
const STATUS_AC = 1;
const STATUS_WA = 30;
const STATUS_TLE = 3;
const STATUS_MLE = 4;
const STATUS_RE = 6;
const STATUS_CE = 7;

const STATUS_LABELS: Record<number, string> = {
  [STATUS_AC]: 'AC', [STATUS_WA]: 'WA', [STATUS_TLE]: 'TLE',
  [STATUS_MLE]: 'MLE', [STATUS_RE]: 'RE', [STATUS_CE]: 'CE',
};

const MIN_AFFECTED = 5; // Minimum students to trigger a finding
const COMMON_ERROR_THRESHOLD = 0.30;
const COMPREHENSION_THRESHOLD = 0.40;
const DIFFICULTY_PASS_RATE_THRESHOLD = 0.20;

interface AnalyzeInput {
  domainId: string;
  contestId: any;
  pids: number[];
  studentUids: number[];
  contestStartTime?: Date;
  contestEndTime?: Date;
}

interface AnalyzeResult {
  stats: {
    totalStudents: number;
    participatedStudents: number;
    aiUserCount: number;
    problemCount: number;
  };
  findings: TeachingFinding[];
}

export class TeachingAnalysisService {
  private db: Db;
  private findingCounter = 0;

  constructor(db: Db) {
    this.db = db;
  }

  async analyze(input: AnalyzeInput): Promise<AnalyzeResult> {
    this.findingCounter = 0;

    // Layer 1: Data aggregation
    const [records, conversations, messages, jailbreakLogs] = await Promise.all([
      this.fetchRecords(input),
      this.fetchConversations(input),
      this.fetchMessages(input, []), // will be filled after conversations
      this.fetchJailbreakLogs(input),
    ]);

    // Get conversation IDs for message query
    const convIds = conversations.map((c: any) => c._id);
    const allMessages = convIds.length > 0
      ? await this.db.collection('ai_messages')
          .find({ conversationId: { $in: convIds } })
          .sort({ timestamp: 1 })
          .toArray()
      : [];

    // Build lookup maps
    const aiUserIds = new Set(conversations.map((c: any) => c.userId));
    const messagesByConv = new Map<string, any[]>();
    for (const msg of allMessages) {
      const key = String(msg.conversationId);
      if (!messagesByConv.has(key)) messagesByConv.set(key, []);
      messagesByConv.get(key)!.push(msg);
    }

    const stats = {
      totalStudents: input.studentUids.length,
      participatedStudents: input.studentUids.length,
      aiUserCount: aiUserIds.size,
      problemCount: input.pids.length,
    };

    // Layer 2: Rule engine
    const findings: TeachingFinding[] = [];

    // A. Common error patterns
    findings.push(...this.detectCommonErrors(records, input));

    // B. Comprehension issues
    findings.push(...this.detectComprehensionIssues(conversations, allMessages, records, input));

    // C. Learning strategy issues
    findings.push(...this.detectStrategyIssues(jailbreakLogs, conversations, records, input));

    // D. At-risk students (requires history — basic version for now)
    findings.push(...this.detectAtRiskStudents(records, input));

    // E. Difficulty anomalies
    findings.push(...this.detectDifficultyAnomalies(records, input));

    // F. Progress trends
    findings.push(...this.detectProgressTrends(records, input));

    // G. Cognitive evolution path
    findings.push(...this.detectCognitivePath(conversations, allMessages, records, input));

    // H. AI tutoring effectiveness
    findings.push(...this.detectAIEffectiveness(conversations, records, input));

    return { stats, findings };
  }

  private nextId(): string {
    return `f-${++this.findingCounter}`;
  }

  private makeFinding(
    dimension: FindingDimension,
    severity: 'high' | 'medium' | 'low',
    title: string,
    affectedStudents: number[],
    affectedProblems: number[],
    metrics: Record<string, number>,
    needsDeepDive: boolean = false,
    samples?: { code?: string[]; conversations?: string[] },
  ): TeachingFinding | null {
    // Min sample gate: skip if < MIN_AFFECTED students
    if (affectedStudents.length < MIN_AFFECTED) return null;
    return {
      id: this.nextId(),
      dimension,
      severity,
      title,
      evidence: { affectedStudents, affectedProblems, metrics, samples },
      needsDeepDive,
    };
  }

  // --- Dimension A: Common Error Patterns ---
  private detectCommonErrors(records: any[], input: AnalyzeInput): TeachingFinding[] {
    const findings: TeachingFinding[] = [];
    for (const pid of input.pids) {
      const pidRecords = records.filter((r: any) => r.pid === pid);
      const studentBestStatus = new Map<number, number>();
      // Get each student's final status (last submission)
      for (const r of pidRecords) {
        studentBestStatus.set(r.uid, r.status);
      }
      const totalStudents = studentBestStatus.size;
      if (totalStudents === 0) continue;

      // Count by non-AC status
      const statusCounts = new Map<number, number[]>();
      for (const [uid, status] of studentBestStatus) {
        if (status === STATUS_AC) continue;
        if (!statusCounts.has(status)) statusCounts.set(status, []);
        statusCounts.get(status)!.push(uid);
      }

      for (const [status, uids] of statusCounts) {
        const ratio = uids.length / totalStudents;
        if (ratio >= COMMON_ERROR_THRESHOLD) {
          const label = STATUS_LABELS[status] || `Status${status}`;
          const f = this.makeFinding(
            'commonError',
            ratio >= 0.5 ? 'high' : 'medium',
            `题目 ${pid}：${Math.round(ratio * 100)}% 的学生最终结果为 ${label}`,
            uids, [pid],
            { ratio: Math.round(ratio * 100), count: uids.length, total: totalStudents },
            true,
          );
          if (f) findings.push(f);
        }
      }
    }
    return findings;
  }

  // --- Dimension B: Comprehension Issues ---
  private detectComprehensionIssues(
    conversations: any[], messages: any[], records: any[], input: AnalyzeInput,
  ): TeachingFinding[] {
    const findings: TeachingFinding[] = [];
    for (const pid of input.pids) {
      const pidConvs = conversations.filter((c: any) => String(c.problemId) === String(pid));
      if (pidConvs.length === 0) continue;

      const affectedStudents: number[] = [];
      for (const conv of pidConvs) {
        const convMsgs = messages.filter(
          (m: any) => String(m.conversationId) === String(conv._id) && m.role === 'student',
        );
        const total = convMsgs.length;
        if (total === 0) continue;
        const understandCount = convMsgs.filter(
          (m: any) => m.questionType === 'understand' || m.questionType === 'clarify',
        ).length;
        if (understandCount / total >= COMPREHENSION_THRESHOLD) {
          affectedStudents.push(conv.userId);
        }
      }

      if (affectedStudents.length > 0) {
        const f = this.makeFinding(
          'comprehension',
          affectedStudents.length >= input.studentUids.length * 0.3 ? 'high' : 'medium',
          `题目 ${pid}：${affectedStudents.length} 名学生的 AI 对话以理解/澄清类问题为主（基于 ${pidConvs.length} 名 AI 用户数据）`,
          affectedStudents, [pid],
          { affectedCount: affectedStudents.length, totalAIUsers: pidConvs.length },
          true,
        );
        if (f) findings.push(f);
      }
    }
    return findings;
  }

  // --- Dimension C: Learning Strategy Issues ---
  private detectStrategyIssues(
    jailbreakLogs: any[], conversations: any[], records: any[], input: AnalyzeInput,
  ): TeachingFinding[] {
    const findings: TeachingFinding[] = [];

    // C1: Jailbreak attempts
    const jailbreakUserIds = [...new Set(jailbreakLogs.map((j: any) => j.userId).filter(Boolean))];
    if (jailbreakUserIds.length > 0) {
      const f = this.makeFinding(
        'strategy', 'medium',
        `${jailbreakUserIds.length} 名学生触发了内容安全检测（尝试获取完整答案）`,
        jailbreakUserIds as number[], [],
        { jailbreakCount: jailbreakLogs.length, uniqueStudents: jailbreakUserIds.length },
      );
      if (f) findings.push(f);
    }

    // C2: High AI usage frequency (top 10% by conversation count)
    const convCountByUser = new Map<number, number>();
    for (const c of conversations) {
      convCountByUser.set(c.userId, (convCountByUser.get(c.userId) || 0) + 1);
    }
    if (convCountByUser.size >= 10) {
      const counts = [...convCountByUser.entries()].sort((a, b) => b[1] - a[1]);
      const p90Index = Math.floor(counts.length * 0.1);
      const threshold = counts[p90Index]?.[1] || Infinity;
      const highUsers = counts.filter(([, c]) => c >= threshold && c > 3).map(([uid]) => uid);
      if (highUsers.length > 0) {
        const f = this.makeFinding(
          'strategy', 'low',
          `${highUsers.length} 名学生的 AI 使用频率偏高（对话次数位于前 10%）`,
          highUsers, [],
          { threshold, topCount: highUsers.length },
        );
        if (f) findings.push(f);
      }
    }

    return findings;
  }

  // --- Dimension D: At-Risk Students ---
  private detectAtRiskStudents(records: any[], input: AnalyzeInput): TeachingFinding[] {
    const findings: TeachingFinding[] = [];
    const gaveUpStudents: number[] = [];

    for (const uid of input.studentUids) {
      const userRecords = records.filter((r: any) => r.uid === uid);
      if (userRecords.length === 0) {
        // No submissions at all — potential give-up
        gaveUpStudents.push(uid);
        continue;
      }
      // Check if student attempted but never AC'd on majority of problems
      const attemptedPids = new Set(userRecords.map((r: any) => r.pid));
      const acPids = new Set(userRecords.filter((r: any) => r.status === STATUS_AC).map((r: any) => r.pid));
      const gaveUpPids = [...attemptedPids].filter(p => !acPids.has(p));
      if (gaveUpPids.length >= input.pids.length * 0.7 && attemptedPids.size > 0) {
        gaveUpStudents.push(uid);
      }
    }

    if (gaveUpStudents.length > 0) {
      const f = this.makeFinding(
        'atRisk',
        gaveUpStudents.length >= 5 ? 'high' : 'medium',
        `${gaveUpStudents.length} 名学生在大部分题目上未能通过或未提交`,
        gaveUpStudents, [],
        { gaveUpCount: gaveUpStudents.length, totalStudents: input.studentUids.length },
      );
      if (f) findings.push(f);
    }
    return findings;
  }

  // --- Dimension E: Difficulty Anomalies ---
  private detectDifficultyAnomalies(records: any[], input: AnalyzeInput): TeachingFinding[] {
    const findings: TeachingFinding[] = [];
    for (const pid of input.pids) {
      const pidRecords = records.filter((r: any) => r.pid === pid);
      const studentResults = new Map<number, boolean>();
      for (const r of pidRecords) {
        if (r.status === STATUS_AC) studentResults.set(r.uid, true);
        else if (!studentResults.has(r.uid)) studentResults.set(r.uid, false);
      }
      const total = studentResults.size;
      if (total < 5) continue;
      const acCount = [...studentResults.values()].filter(Boolean).length;
      const passRate = acCount / total;

      if (passRate < DIFFICULTY_PASS_RATE_THRESHOLD) {
        const nonAcStudents = [...studentResults.entries()]
          .filter(([, ac]) => !ac).map(([uid]) => uid);
        const f = this.makeFinding(
          'difficulty', 'high',
          `题目 ${pid}：通过率仅 ${Math.round(passRate * 100)}%（${acCount}/${total}），远低于预期`,
          nonAcStudents, [pid],
          { passRate: Math.round(passRate * 100), acCount, total },
          true,
        );
        if (f) findings.push(f);
      }
    }
    return findings;
  }

  // --- Dimension F: Progress Trends ---
  private detectProgressTrends(records: any[], input: AnalyzeInput): TeachingFinding[] {
    // Simple: identify students who AC'd all problems
    const allAcStudents: number[] = [];
    for (const uid of input.studentUids) {
      const userRecords = records.filter((r: any) => r.uid === uid);
      const acPids = new Set(userRecords.filter((r: any) => r.status === STATUS_AC).map((r: any) => r.pid));
      if (acPids.size === input.pids.length && input.pids.length > 0) {
        allAcStudents.push(uid);
      }
    }
    const findings: TeachingFinding[] = [];
    if (allAcStudents.length >= MIN_AFFECTED) {
      const f = this.makeFinding(
        'progress', 'low',
        `${allAcStudents.length} 名学生全部通过所有题目`,
        allAcStudents, input.pids,
        { count: allAcStudents.length, totalProblems: input.pids.length },
      );
      if (f) findings.push(f);
    }
    return findings;
  }

  // --- Dimension G: Cognitive Evolution Path ---
  private detectCognitivePath(
    conversations: any[], messages: any[], records: any[], input: AnalyzeInput,
  ): TeachingFinding[] {
    const findings: TeachingFinding[] = [];
    // Detect "brute-force guessing": many submissions in short time without AI consultation
    const bruteForceStudents: number[] = [];

    for (const pid of input.pids) {
      const pidRecords = records.filter((r: any) => r.pid === pid);
      const pidConvUserIds = new Set(
        conversations.filter((c: any) => String(c.problemId) === String(pid)).map((c: any) => c.userId),
      );

      const byStudent = new Map<number, any[]>();
      for (const r of pidRecords) {
        if (!byStudent.has(r.uid)) byStudent.set(r.uid, []);
        byStudent.get(r.uid)!.push(r);
      }

      for (const [uid, subs] of byStudent) {
        if (subs.length < 5) continue;
        // Many submissions but no AI use — possible brute-force
        const hasAC = subs.some((s: any) => s.status === STATUS_AC);
        if (!hasAC && !pidConvUserIds.has(uid) && subs.length >= 8) {
          bruteForceStudents.push(uid);
        }
      }
    }

    const unique = [...new Set(bruteForceStudents)];
    if (unique.length > 0) {
      const f = this.makeFinding(
        'cognitivePath', 'medium',
        `${unique.length} 名学生表现出"无脑试错"模式（大量提交但未寻求帮助且未通过）`,
        unique, [],
        { count: unique.length },
      );
      if (f) findings.push(f);
    }
    return findings;
  }

  // --- Dimension H: AI Tutoring Effectiveness ---
  private detectAIEffectiveness(
    conversations: any[], records: any[], input: AnalyzeInput,
  ): TeachingFinding[] {
    const findings: TeachingFinding[] = [];
    // Compare AI users vs non-AI users pass rates
    const aiUserIds = new Set(conversations.map((c: any) => c.userId));
    if (aiUserIds.size < MIN_AFFECTED) return findings;

    let aiAcCount = 0, aiTotal = 0, nonAiAcCount = 0, nonAiTotal = 0;
    for (const uid of input.studentUids) {
      const userRecords = records.filter((r: any) => r.uid === uid);
      const acPids = new Set(userRecords.filter((r: any) => r.status === STATUS_AC).map((r: any) => r.pid));
      if (aiUserIds.has(uid)) {
        aiTotal += input.pids.length;
        aiAcCount += acPids.size;
      } else {
        nonAiTotal += input.pids.length;
        nonAiAcCount += acPids.size;
      }
    }

    const aiPassRate = aiTotal > 0 ? aiAcCount / aiTotal : 0;
    const nonAiPassRate = nonAiTotal > 0 ? nonAiAcCount / nonAiTotal : 0;

    if (aiTotal > 0 && nonAiTotal > 0) {
      const diff = Math.round((aiPassRate - nonAiPassRate) * 100);
      const f = this.makeFinding(
        'aiEffectiveness', 'low',
        `AI 用户通过率 ${Math.round(aiPassRate * 100)}% vs 非 AI 用户 ${Math.round(nonAiPassRate * 100)}%（差值 ${diff > 0 ? '+' : ''}${diff}%）（基于 ${aiUserIds.size} 名 AI 用户数据）`,
        [...aiUserIds] as number[], [],
        { aiPassRate: Math.round(aiPassRate * 100), nonAiPassRate: Math.round(nonAiPassRate * 100), diff, aiUserCount: aiUserIds.size },
      );
      if (f) findings.push(f);
    }

    return findings;
  }

  // --- Data Fetching (Layer 1) ---
  private async fetchRecords(input: AnalyzeInput): Promise<any[]> {
    return this.db.collection('record').find({
      domainId: input.domainId,
      uid: { $in: input.studentUids },
      pid: { $in: input.pids },
    }).sort({ judgeAt: 1 }).toArray();
  }

  private async fetchConversations(input: AnalyzeInput): Promise<any[]> {
    const query: any = {
      domainId: input.domainId,
      userId: { $in: input.studentUids },
      problemId: { $in: input.pids.map(String) },
    };
    if (input.contestStartTime && input.contestEndTime) {
      query.startTime = { $gte: input.contestStartTime, $lte: input.contestEndTime };
    }
    return this.db.collection('ai_conversations').find(query).toArray();
  }

  private async fetchMessages(input: AnalyzeInput, convIds: any[]): Promise<any[]> {
    if (convIds.length === 0) return [];
    return this.db.collection('ai_messages')
      .find({ conversationId: { $in: convIds } })
      .sort({ timestamp: 1 })
      .toArray();
  }

  private async fetchJailbreakLogs(input: AnalyzeInput): Promise<any[]> {
    const query: any = {
      userId: { $in: input.studentUids },
    };
    if (input.contestStartTime && input.contestEndTime) {
      query.createdAt = { $gte: input.contestStartTime, $lte: input.contestEndTime };
    }
    return this.db.collection('ai_jailbreak_logs').find(query).toArray();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/services/teachingAnalysisService.test.ts --no-coverage`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/teachingAnalysisService.ts src/__tests__/services/teachingAnalysisService.test.ts
git commit -m "feat: add TeachingAnalysisService with rule engine for 8 analysis dimensions"
```

---

## Task 3: Teaching Suggestion Service (LLM Layer)

**Files:**
- Create: `src/services/teachingSuggestionService.ts`
- Test: `src/__tests__/services/teachingSuggestionService.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/__tests__/services/teachingSuggestionService.test.ts
import { TeachingSuggestionService, buildMainPrompt, buildDeepDivePrompt } from '../../services/teachingSuggestionService';
import type { TeachingFinding } from '../../models/teachingSummary';

describe('TeachingSuggestionService', () => {
  describe('buildMainPrompt', () => {
    it('should include teaching context in user prompt', () => {
      const result = buildMainPrompt({
        contestTitle: 'Assignment 3',
        contestContent: 'Focus on recursion',
        teachingFocus: undefined,
        stats: { totalStudents: 50, participatedStudents: 50, aiUserCount: 30, problemCount: 5 },
        findings: [],
      });
      expect(result.userPrompt).toContain('Assignment 3');
      expect(result.userPrompt).toContain('Focus on recursion');
      expect(result.userPrompt).toContain('30');
    });

    it('should mark teaching focus as not provided when empty', () => {
      const result = buildMainPrompt({
        contestTitle: 'HW3',
        contestContent: '',
        teachingFocus: undefined,
        stats: { totalStudents: 50, participatedStudents: 50, aiUserCount: 0, problemCount: 3 },
        findings: [],
      });
      expect(result.userPrompt).toContain('教学目标未提供');
    });

    it('should include system prompt with priority framework', () => {
      const result = buildMainPrompt({
        contestTitle: 'HW3',
        contestContent: 'recursion',
        stats: { totalStudents: 50, participatedStudents: 50, aiUserCount: 10, problemCount: 3 },
        findings: [],
      });
      expect(result.systemPrompt).toContain('P0');
      expect(result.systemPrompt).toContain('P1');
      expect(result.systemPrompt).toContain('P2');
      expect(result.systemPrompt).toContain('严禁捏造');
    });
  });

  describe('buildDeepDivePrompt', () => {
    it('should include finding details and samples', () => {
      const finding: TeachingFinding = {
        id: 'f-1',
        dimension: 'commonError',
        severity: 'high',
        title: 'Q3: 40% WA',
        evidence: {
          affectedStudents: [1, 2, 3, 4, 5],
          affectedProblems: [3],
          metrics: { ratio: 40 },
          samples: {
            code: ['int arr[10]; arr[10] = 1;'],
            conversations: ['Student: I don\'t know why it crashes'],
          },
        },
        needsDeepDive: true,
      };
      const result = buildDeepDivePrompt(finding, 'Write a program that...');
      expect(result.userPrompt).toContain('Q3: 40% WA');
      expect(result.userPrompt).toContain('arr[10] = 1');
      expect(result.systemPrompt).toContain('布卢姆');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/services/teachingSuggestionService.test.ts --no-coverage`
Expected: FAIL — module not found

- [ ] **Step 3: Write TeachingSuggestionService**

```typescript
// src/services/teachingSuggestionService.ts
/**
 * Teaching Suggestion Service - 教学建议 LLM 服务
 *
 * Layer 3: 构建 prompt 并调用 LLM 生成教学建议和深潜分析
 */

import type { TeachingFinding } from '../models/teachingSummary';

interface MainPromptInput {
  contestTitle: string;
  contestContent: string;
  teachingFocus?: string;
  stats: {
    totalStudents: number;
    participatedStudents: number;
    aiUserCount: number;
    problemCount: number;
  };
  findings: TeachingFinding[];
}

const MAIN_SYSTEM_PROMPT = `你是一位精通形成性评价与精准教学的资深编程教研员。根据规则引擎提取的客观课堂数据，为教师生成高度结构化的学情概览。

【分析框架与优先级规则】
1. P0级（全局知识缺陷）：与本次教学目标强相关，且大面积（>20%）报错的共性问题。
2. P1级（题目认知障碍）：大面积向AI询问题意，说明题目设计可能超出了学生的最近发展区(ZPD)。
3. P2级（学习策略/高危个体）：过度依赖AI、或连续提交失败导致严重挫败感的学生。

【处理边缘情况】
- 如果发现的问题很少或通过率极高，将重点转向"培优建议"（推荐进阶挑战）和肯定教学成果。
- 必须基于给定的JSON数据说话，严禁捏造数据或比例。
- 如果"教学上下文"中标注"教学目标未提供"，则退回纯数据驱动分析：只报告客观现象和建议的教学动作，不做"是否偏离教学目标"的判断。

【输出格式要求】
请严格按照以下Markdown结构输出，不要输出多余的寒暄：

### 📊 班级学情诊断结论
（1-2句话总结本次作业整体达成情况）

### 🚨 核心教学建议 (按优先级排序)
- **[P0/P1/P2] {问题简述}** (受影响人数/比例)：
  - **教学动作**：{具体且可执行的动作}`;

const DEEP_DIVE_SYSTEM_PROMPT = `你是一位擅长认知诊断的编程教育专家。分析特定题目的异常数据、代码切片和AI交互日志，为教师提供深度微观诊断和课堂干预素材。

【分析维度：布卢姆认知层级】
判断学生主要卡在哪个认知层级：
- 记忆/理解层：看不懂题意，或忘记了基本语法结构。
- 应用层：理解逻辑，但无法用代码正确实现（如边界条件遗漏）。
- 分析/评价层：算法超时（TLE），无法分析时间复杂度并优化。

【处理边缘情况】
如果代码样本看起来完善，但AI对话显示学生在索要完整代码或频繁询问低级问题，优先判定为"学习策略与元认知问题（过度依赖）"，而非知识问题。

【输出格式要求】
严格按照以下Markdown结构输出：

### 🧠 认知障碍诊断
（学生卡在哪个布卢姆认知层级，根本原因：前置知识薄弱还是缺乏特定思维图式？）

### 🔍 典型误区还原
（结合代码或对话样本，指出学生脑海中错误的思维逻辑）

### 🛠️ 教学干预与脚手架 (Scaffolding)
1. **反例设计**：一组能打破学生错误逻辑的测试数据（Input/Output）
2. **提问设计**：1-2个引导学生自主发现错误的启发式提问（Socratic Questioning）`;

export function buildMainPrompt(input: MainPromptInput): { systemPrompt: string; userPrompt: string } {
  const teachingContext = input.teachingFocus || (input.contestContent?.trim() ? undefined : undefined);
  const focusLine = input.teachingFocus
    ? input.teachingFocus
    : (input.contestContent?.trim() ? undefined : '教学目标未提供');

  // Strip samples from findings to reduce token usage in main prompt
  const findingsForPrompt = input.findings.map(f => ({
    id: f.id,
    dimension: f.dimension,
    severity: f.severity,
    title: f.title,
    evidence: {
      affectedStudents: f.evidence.affectedStudents.length,
      affectedProblems: f.evidence.affectedProblems,
      metrics: f.evidence.metrics,
    },
    needsDeepDive: f.needsDeepDive,
  }));

  const userPrompt = `## 教学上下文
作业标题：${input.contestTitle}
作业介绍：${input.contestContent || '未提供'}
${focusLine ? `教师补充教学重点：${focusLine}\n` : ''}参与情况：${input.stats.participatedStudents}/${input.stats.totalStudents} (共 ${input.stats.problemCount} 题)
其中 ${input.stats.aiUserCount} 名学生使用了AI助手

## 规则引擎异常发现 (JSON)
${JSON.stringify(findingsForPrompt, null, 2)}`;

  return { systemPrompt: MAIN_SYSTEM_PROMPT, userPrompt };
}

export function buildDeepDivePrompt(
  finding: TeachingFinding,
  problemContent: string,
): { systemPrompt: string; userPrompt: string } {
  const codeSection = finding.evidence.samples?.code?.length
    ? `【代表性错误代码 (节选)】\n${finding.evidence.samples.code.join('\n\n---\n\n')}`
    : '（无代码样本）';

  const convSection = finding.evidence.samples?.conversations?.length
    ? `【代表性AI辅导对话 (节选)】\n${finding.evidence.samples.conversations.join('\n\n---\n\n')}`
    : '（无对话样本）';

  const userPrompt = `## 异常上下文
问题描述：${finding.title}
影响面：${finding.evidence.affectedStudents.length}人 (${finding.severity})

## 题目信息
${problemContent || '（题目内容未提供）'}

## 证据样本
${codeSection}

${convSection}

## 统计数据
${JSON.stringify(finding.evidence.metrics, null, 2)}`;

  return { systemPrompt: DEEP_DIVE_SYSTEM_PROMPT, userPrompt };
}

export class TeachingSuggestionService {
  private aiClient: any;

  constructor(aiClient: any) {
    this.aiClient = aiClient;
  }

  async generateOverallSuggestion(input: MainPromptInput): Promise<{ text: string; tokenUsage: { promptTokens: number; completionTokens: number } }> {
    const { systemPrompt, userPrompt } = buildMainPrompt(input);
    const messages = [{ role: 'user' as const, content: userPrompt }];
    const result = await this.aiClient.chat(messages, systemPrompt);
    return {
      text: result.content || '',
      tokenUsage: {
        promptTokens: result.usage?.promptTokens || 0,
        completionTokens: result.usage?.completionTokens || 0,
      },
    };
  }

  async generateDeepDive(
    finding: TeachingFinding,
    problemContent: string,
  ): Promise<{ text: string; tokenUsage: { promptTokens: number; completionTokens: number } }> {
    const { systemPrompt, userPrompt } = buildDeepDivePrompt(finding, problemContent);
    const messages = [{ role: 'user' as const, content: userPrompt }];
    const result = await this.aiClient.chat(messages, systemPrompt);
    return {
      text: result.content || '',
      tokenUsage: {
        promptTokens: result.usage?.promptTokens || 0,
        completionTokens: result.usage?.completionTokens || 0,
      },
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/services/teachingSuggestionService.test.ts --no-coverage`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/teachingSuggestionService.ts src/__tests__/services/teachingSuggestionService.test.ts
git commit -m "feat: add TeachingSuggestionService with LLM prompt construction"
```

---

## Task 4: Teaching Summary Handler

**Files:**
- Create: `src/handlers/teachingSummaryHandler.ts`
- Test: `src/__tests__/handlers/teachingSummaryHandler.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/__tests__/handlers/teachingSummaryHandler.test.ts
import { TeachingSummaryGenerateHandler } from '../../handlers/teachingSummaryHandler';

// Minimal test: verify handler class exists and has required methods
describe('TeachingSummaryHandler', () => {
  it('should export TeachingSummaryGenerateHandler class', () => {
    expect(TeachingSummaryGenerateHandler).toBeDefined();
    expect(typeof TeachingSummaryGenerateHandler).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/handlers/teachingSummaryHandler.test.ts --no-coverage`
Expected: FAIL — module not found

- [ ] **Step 3: Write the handler**

```typescript
// src/handlers/teachingSummaryHandler.ts
/**
 * Teaching Summary Handlers - 教学建议请求处理
 *
 * Handles generation, retrieval, listing, and feedback for teaching suggestions.
 */

import { Handler, PRIV } from 'hydrooj';
import type { Db } from 'mongodb';
import { getDomainId } from '../utils/domainHelper';
import { ensureObjectId } from '../utils/ensureObjectId';
import { TeachingSummaryModel } from '../models/teachingSummary';
import { TeachingAnalysisService } from '../services/teachingAnalysisService';
import { TeachingSuggestionService } from '../services/teachingSuggestionService';
import { createOpenAIClientFromConfig } from '../services/openaiClient';

export const TeachingSummaryHandlerPriv = PRIV.PRIV_READ_RECORD_CODE;

/**
 * POST /ai-helper/teaching-summary/:contestId — Generate teaching suggestions
 * GET  /ai-helper/teaching-summary/:contestId — Get existing summary
 */
export class TeachingSummaryHandler extends Handler {
  async get() {
    const domainId = getDomainId(this);
    const { contestId } = this.request.params;
    const model: TeachingSummaryModel = this.ctx.get('teachingSummaryModel');

    const summary = await model.findByContest(domainId, contestId);
    if (!summary) {
      this.response.status = 404;
      this.response.body = { error: { code: 'NOT_FOUND', message: 'No teaching summary found for this contest' } };
      this.response.type = 'application/json';
      return;
    }

    this.response.body = { summary };
    this.response.type = 'application/json';
  }

  async post() {
    const domainId = getDomainId(this);
    const { contestId } = this.request.params;
    const { teachingFocus, regenerate } = this.request.body as {
      teachingFocus?: string;
      regenerate?: boolean;
    };
    const db: Db = this.ctx.db;
    const model: TeachingSummaryModel = this.ctx.get('teachingSummaryModel');

    // Check for existing summary
    const existing = await model.findByContest(domainId, contestId);
    if (existing && !regenerate) {
      this.response.body = { summary: existing, exists: true };
      this.response.type = 'application/json';
      return;
    }

    // Delete old if regenerating
    if (existing && regenerate) {
      await model.deleteById(existing._id);
    }

    // Get contest document
    const documentColl = db.collection('document');
    const contestObjId = ensureObjectId(contestId);
    const tdoc = await documentColl.findOne({ domainId, docType: 30, docId: contestObjId });
    if (!tdoc) {
      this.response.status = 404;
      this.response.body = { error: { code: 'CONTEST_NOT_FOUND', message: 'Contest not found' } };
      this.response.type = 'application/json';
      return;
    }

    // Get attendees
    const statusColl = db.collection('document.status');
    const tsdocs = await statusColl
      .find({ domainId, docType: 30, docId: contestObjId }, { projection: { uid: 1 } })
      .toArray();
    const studentUids = tsdocs.map((d: any) => d.uid).filter(Boolean);
    const pids = (tdoc.pids || []) as number[];

    if (studentUids.length === 0) {
      this.response.status = 400;
      this.response.body = { error: { code: 'NO_STUDENTS', message: 'No students found for this contest' } };
      this.response.type = 'application/json';
      return;
    }

    // Create summary record
    const summaryId = await model.create({
      domainId,
      contestId,
      contestTitle: tdoc.title || '',
      contestContent: tdoc.content || '',
      teachingFocus,
      createdBy: this.user._id,
    });

    // Run generation asynchronously
    this.generateAsync(summaryId, model, db, domainId, contestObjId, pids, studentUids, tdoc);

    const summary = await model.findById(summaryId);
    this.response.body = { summary, started: true };
    this.response.type = 'application/json';
  }

  private async generateAsync(
    summaryId: any, model: TeachingSummaryModel, db: Db,
    domainId: string, contestId: any, pids: number[], studentUids: number[], tdoc: any,
  ) {
    const startTime = Date.now();
    try {
      await model.updateStatus(summaryId, 'generating');

      // Layer 1+2: Data analysis
      const analysisService = new TeachingAnalysisService(db);
      const analysisResult = await analysisService.analyze({
        domainId,
        contestId,
        pids,
        studentUids,
        contestStartTime: tdoc.beginAt,
        contestEndTime: tdoc.endAt,
      });

      // Layer 3a: LLM overall suggestion
      const aiClient = await createOpenAIClientFromConfig(this.ctx);
      const suggestionService = new TeachingSuggestionService(aiClient);

      const mainResult = await suggestionService.generateOverallSuggestion({
        contestTitle: tdoc.title || '',
        contestContent: tdoc.content || '',
        teachingFocus: (await model.findById(summaryId))?.teachingFocus,
        stats: analysisResult.stats,
        findings: analysisResult.findings,
      });

      let totalPromptTokens = mainResult.tokenUsage.promptTokens;
      let totalCompletionTokens = mainResult.tokenUsage.completionTokens;

      // Layer 3b: Deep-dive for findings that need it
      const deepDiveResults: Record<string, string> = {};
      const deepDiveFindings = analysisResult.findings.filter(f => f.needsDeepDive);

      // Fetch problem content for deep-dives
      const problemDocs = await db.collection('document')
        .find({ domainId, docType: 10, docId: { $in: pids } })
        .toArray();
      const problemContentMap = new Map<number, string>();
      for (const pdoc of problemDocs) {
        const content = (pdoc.content || '').slice(0, 3000);
        problemContentMap.set(pdoc.docId as number, content);
      }

      for (const finding of deepDiveFindings) {
        try {
          // Collect code samples from records
          const sampleUids = finding.evidence.affectedStudents.slice(0, 8);
          const sampleRecords = await db.collection('record')
            .find({
              domainId,
              uid: { $in: sampleUids },
              pid: { $in: finding.evidence.affectedProblems },
              status: { $ne: 1 }, // non-AC
            })
            .sort({ judgeAt: -1 })
            .limit(8)
            .toArray();
          finding.evidence.samples = finding.evidence.samples || {};
          finding.evidence.samples.code = sampleRecords
            .filter((r: any) => r.code)
            .slice(0, 8)
            .map((r: any) => (r.code || '').slice(0, 1000));

          const problemContent = finding.evidence.affectedProblems
            .map(pid => problemContentMap.get(pid) || '')
            .join('\n\n');

          const ddResult = await suggestionService.generateDeepDive(finding, problemContent);
          deepDiveResults[finding.id] = ddResult.text;
          totalPromptTokens += ddResult.tokenUsage.promptTokens;
          totalCompletionTokens += ddResult.tokenUsage.completionTokens;
        } catch (err) {
          console.warn(`[TeachingSummary] Deep-dive failed for finding ${finding.id}:`, err);
          deepDiveResults[finding.id] = '深潜分析生成失败，请重试';
        }
      }

      await model.saveResults(summaryId, {
        stats: analysisResult.stats,
        findings: analysisResult.findings,
        overallSuggestion: mainResult.text,
        deepDiveResults,
        tokenUsage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens },
        generationTimeMs: Date.now() - startTime,
      });
    } catch (err) {
      console.error('[TeachingSummary] Generation failed:', err);
      await model.updateStatus(summaryId, 'failed');
    }
  }
}

/**
 * GET /ai-helper/teaching-review — List all teaching summaries for domain
 */
export class TeachingReviewHandler extends Handler {
  async get() {
    const domainId = getDomainId(this);
    const page = parseInt(this.request.query?.page as string, 10) || 1;
    const limit = Math.min(parseInt(this.request.query?.limit as string, 10) || 20, 50);
    const model: TeachingSummaryModel = this.ctx.get('teachingSummaryModel');

    const result = await model.findByDomain(domainId, page, limit);
    this.response.body = { ...result, page, limit };
    this.response.type = 'application/json';
  }
}

/**
 * POST /ai-helper/teaching-summary/:summaryId/feedback — Save teacher feedback
 */
export class TeachingSummaryFeedbackHandler extends Handler {
  async post() {
    const { summaryId } = this.request.params;
    const { rating, comment } = this.request.body as { rating: 'up' | 'down'; comment?: string };
    const model: TeachingSummaryModel = this.ctx.get('teachingSummaryModel');

    if (rating !== 'up' && rating !== 'down') {
      this.response.status = 400;
      this.response.body = { error: { code: 'INVALID_RATING', message: 'Rating must be up or down' } };
      this.response.type = 'application/json';
      return;
    }

    await model.saveFeedback(summaryId, rating, comment);
    this.response.body = { success: true };
    this.response.type = 'application/json';
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/handlers/teachingSummaryHandler.test.ts --no-coverage`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/handlers/teachingSummaryHandler.ts src/__tests__/handlers/teachingSummaryHandler.test.ts
git commit -m "feat: add teaching summary handlers (generate, get, list, feedback)"
```

---

## Task 5: Register in index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add import at top of file**

After existing handler imports, add:

```typescript
import { TeachingSummaryHandler, TeachingReviewHandler, TeachingSummaryFeedbackHandler, TeachingSummaryHandlerPriv } from './handlers/teachingSummaryHandler';
import { TeachingSummaryModel } from './models/teachingSummary';
```

- [ ] **Step 2: Instantiate model and ensure indexes**

After `const studentHistoryModel = new StudentHistoryModel(db);` (around line 148), add:

```typescript
const teachingSummaryModel = new TeachingSummaryModel(db);
```

After `await safeEnsureIndexes(studentHistoryModel, 'studentHistoryModel');` (around line 173), add:

```typescript
await safeEnsureIndexes(teachingSummaryModel, 'teachingSummaryModel');
```

- [ ] **Step 3: Provide model to ctx**

After `ctx.provide('studentHistoryModel', studentHistoryModel);` (around line 212), add:

```typescript
ctx.provide('teachingSummaryModel', teachingSummaryModel);
```

- [ ] **Step 4: Register routes**

Before the closing `}` of the `apply` function (before line 359), add:

```typescript
    // 教学建议路由
    // GET/POST /ai-helper/teaching-summary/:contestId - 获取/生成教学建议
    ctx.Route('ai_teaching_summary', '/ai-helper/teaching-summary/:contestId', TeachingSummaryHandler, TeachingSummaryHandlerPriv);
    ctx.Route('ai_teaching_summary_domain', '/d/:domainId/ai-helper/teaching-summary/:contestId', TeachingSummaryHandler, TeachingSummaryHandlerPriv);

    // GET /ai-helper/teaching-review - 教学总结回顾列表
    ctx.Route('ai_teaching_review', '/ai-helper/teaching-review', TeachingReviewHandler, TeachingSummaryHandlerPriv);
    ctx.Route('ai_teaching_review_domain', '/d/:domainId/ai-helper/teaching-review', TeachingReviewHandler, TeachingSummaryHandlerPriv);

    // POST /ai-helper/teaching-summary/:summaryId/feedback - 教学建议反馈
    ctx.Route('ai_teaching_summary_feedback', '/ai-helper/teaching-summary/:summaryId/feedback', TeachingSummaryFeedbackHandler, TeachingSummaryHandlerPriv);
    ctx.Route('ai_teaching_summary_feedback_domain', '/d/:domainId/ai-helper/teaching-summary/:summaryId/feedback', TeachingSummaryFeedbackHandler, TeachingSummaryHandlerPriv);
```

- [ ] **Step 5: Build to verify**

Run: `npm run build:plugin`
Expected: 0 errors

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat: register teaching summary model and routes in index.ts"
```

---

## Task 6: i18n Keys

**Files:**
- Modify: `locales/zh.yaml`
- Modify: `locales/en.yaml`

- [ ] **Step 1: Add Chinese translations**

Append to `locales/zh.yaml`:

```yaml
# 教学建议
ai_helper_dashboard_tab_teaching_review: 教学总结回顾
ai_helper_teaching_generate: 生成教学建议
ai_helper_teaching_regenerate: 重新生成
ai_helper_teaching_generating: 正在生成教学建议...
ai_helper_teaching_overview: 概览
ai_helper_teaching_findings: 发现的问题
ai_helper_teaching_suggestion: AI 教学建议
ai_helper_teaching_detail: 查看详情
ai_helper_teaching_students_affected: 涉及 {0} 名学生
ai_helper_teaching_severity_high: 高优先
ai_helper_teaching_severity_medium: 中优先
ai_helper_teaching_severity_low: 低优先
ai_helper_teaching_feedback_prompt: 这份教学建议对您有帮助吗？
ai_helper_teaching_feedback_thanks: 感谢您的反馈！
ai_helper_teaching_no_data: 参与人数过少，统计结果可能不具代表性
ai_helper_teaching_snapshot_time: 数据截止时间
ai_helper_teaching_ai_user_note: 基于 {0} 名使用 AI 助手的学生数据
ai_helper_teaching_focus_placeholder: 本次教学重点（可选）
ai_helper_teaching_exists_confirm: 该作业已有教学建议，是否重新生成？
ai_helper_teaching_deep_dive: 深度分析
ai_helper_teaching_student_list: 涉及学生列表
ai_helper_teaching_code_samples: 代表性代码样本
ai_helper_teaching_copy_warning: 注意：高度一致的错误可能涉及代码共享
```

- [ ] **Step 2: Add English translations**

Append to `locales/en.yaml`:

```yaml
# Teaching Suggestions
ai_helper_dashboard_tab_teaching_review: Teaching Review
ai_helper_teaching_generate: Generate Teaching Suggestions
ai_helper_teaching_regenerate: Regenerate
ai_helper_teaching_generating: Generating teaching suggestions...
ai_helper_teaching_overview: Overview
ai_helper_teaching_findings: Findings
ai_helper_teaching_suggestion: AI Teaching Suggestions
ai_helper_teaching_detail: View Details
ai_helper_teaching_students_affected: "{0} students affected"
ai_helper_teaching_severity_high: High Priority
ai_helper_teaching_severity_medium: Medium Priority
ai_helper_teaching_severity_low: Low Priority
ai_helper_teaching_feedback_prompt: Was this helpful?
ai_helper_teaching_feedback_thanks: Thanks for your feedback!
ai_helper_teaching_no_data: Too few participants for reliable statistics
ai_helper_teaching_snapshot_time: Data snapshot time
ai_helper_teaching_ai_user_note: Based on data from {0} AI assistant users
ai_helper_teaching_focus_placeholder: Teaching focus for this lesson (optional)
ai_helper_teaching_exists_confirm: Teaching suggestions already exist. Regenerate?
ai_helper_teaching_deep_dive: Deep Analysis
ai_helper_teaching_student_list: Affected Students
ai_helper_teaching_code_samples: Representative Code Samples
ai_helper_teaching_copy_warning: "Note: Highly consistent errors may indicate code sharing"
```

- [ ] **Step 3: Build to verify YAML parses correctly**

Run: `npm run build:plugin`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add locales/zh.yaml locales/en.yaml
git commit -m "feat: add i18n keys for teaching suggestions feature"
```

---

## Task 7: Frontend Hook — useTeachingSummary

**Files:**
- Create: `frontend/teachingSummary/useTeachingSummary.ts`

- [ ] **Step 1: Write the hook**

```typescript
// frontend/teachingSummary/useTeachingSummary.ts
import { useState, useCallback, useRef, useEffect } from 'react';

export interface TeachingFinding {
  id: string;
  dimension: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  evidence: {
    affectedStudents: number[];
    affectedProblems: number[];
    metrics: Record<string, number>;
    samples?: { code?: string[]; conversations?: string[] };
  };
  needsDeepDive: boolean;
  aiSuggestion?: string;
  aiAnalysis?: string;
}

export interface TeachingSummary {
  _id: string;
  domainId: string;
  contestId: string;
  contestTitle: string;
  contestContent: string;
  teachingFocus?: string;
  createdAt: string;
  dataSnapshotAt: string;
  status: 'pending' | 'generating' | 'completed' | 'failed';
  stats: {
    totalStudents: number;
    participatedStudents: number;
    aiUserCount: number;
    problemCount: number;
  };
  findings: TeachingFinding[];
  overallSuggestion: string;
  deepDiveResults: Record<string, string>;
  feedback?: { rating: 'up' | 'down'; comment?: string };
  tokenUsage: { promptTokens: number; completionTokens: number };
  generationTimeMs: number;
}

export function buildUrl(domainId: string, path: string): string {
  return domainId !== 'system'
    ? `/d/${domainId}/ai-helper/teaching-summary${path}`
    : `/ai-helper/teaching-summary${path}`;
}

export function buildReviewUrl(domainId: string): string {
  return domainId !== 'system'
    ? `/d/${domainId}/ai-helper/teaching-review`
    : `/ai-helper/teaching-review`;
}

export function useTeachingSummary(domainId: string, contestId: string) {
  const [summary, setSummary] = useState<TeachingSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchSummary = useCallback(async () => {
    try {
      const res = await fetch(buildUrl(domainId, `/${contestId}`), {
        credentials: 'include',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (res.status === 404) {
        setSummary(null);
        return null;
      }
      const data = await res.json();
      setSummary(data.summary);
      return data.summary;
    } catch (err) {
      setError('Failed to fetch teaching summary');
      return null;
    }
  }, [domainId, contestId]);

  const generate = useCallback(async (teachingFocus?: string, regenerate?: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(buildUrl(domainId, `/${contestId}`), {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({ teachingFocus, regenerate }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error.message);
        setLoading(false);
        return;
      }
      setSummary(data.summary);
      // Start polling if generation started
      if (data.started || data.summary?.status === 'pending' || data.summary?.status === 'generating') {
        startPolling();
      } else {
        setLoading(false);
      }
    } catch (err) {
      setError('Failed to start generation');
      setLoading(false);
    }
  }, [domainId, contestId]);

  const startPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const s = await fetchSummary();
      if (s && (s.status === 'completed' || s.status === 'failed')) {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        setLoading(false);
      }
    }, 3000);
  }, [fetchSummary]);

  const submitFeedback = useCallback(async (summaryId: string, rating: 'up' | 'down', comment?: string) => {
    const url = domainId !== 'system'
      ? `/d/${domainId}/ai-helper/teaching-summary/${summaryId}/feedback`
      : `/ai-helper/teaching-summary/${summaryId}/feedback`;
    await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify({ rating, comment }),
    });
    if (summary) {
      setSummary({ ...summary, feedback: { rating, comment } });
    }
  }, [domainId, summary]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  return { summary, loading, error, fetchSummary, generate, submitFeedback };
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/teachingSummary/useTeachingSummary.ts
git commit -m "feat: add useTeachingSummary hook for frontend API integration"
```

---

## Task 8: Frontend — TeachingSummaryPanel

**Files:**
- Create: `frontend/teachingSummary/TeachingSummaryPanel.tsx`

- [ ] **Step 1: Write the panel component**

```typescript
// frontend/teachingSummary/TeachingSummaryPanel.tsx
import React, { useState, useEffect } from 'react';
import { i18n } from '@hydrooj/ui-default';
import { COLORS, SPACING, RADIUS, SHADOWS, getButtonStyle, cardStyle, markdownTheme } from '../utils/styles';
import { useTeachingSummary, TeachingFinding } from './useTeachingSummary';

const I18N_FALLBACK: Record<string, string> = {
  ai_helper_teaching_generate: '生成教学建议',
  ai_helper_teaching_regenerate: '重新生成',
  ai_helper_teaching_generating: '正在生成教学建议...',
  ai_helper_teaching_overview: '概览',
  ai_helper_teaching_findings: '发现的问题',
  ai_helper_teaching_suggestion: 'AI 教学建议',
  ai_helper_teaching_detail: '查看详情',
  ai_helper_teaching_severity_high: '高优先',
  ai_helper_teaching_severity_medium: '中优先',
  ai_helper_teaching_severity_low: '低优先',
  ai_helper_teaching_feedback_prompt: '这份教学建议对您有帮助吗？',
  ai_helper_teaching_feedback_thanks: '感谢您的反馈！',
  ai_helper_teaching_no_data: '参与人数过少，统计结果可能不具代表性',
  ai_helper_teaching_snapshot_time: '数据截止时间',
  ai_helper_teaching_focus_placeholder: '本次教学重点（可选）',
  ai_helper_teaching_exists_confirm: '该作业已有教学建议，是否重新生成？',
  ai_helper_teaching_deep_dive: '深度分析',
  ai_helper_teaching_student_list: '涉及学生列表',
  ai_helper_teaching_copy_warning: '注意：高度一致的错误可能涉及代码共享',
};

function t(key: string): string {
  const val = i18n(key);
  return val === key ? (I18N_FALLBACK[key] || val) : val;
}

const SEVERITY_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  high: { bg: '#FEF2F2', text: '#DC2626', border: '#FECACA' },
  medium: { bg: '#FFFBEB', text: '#D97706', border: '#FDE68A' },
  low: { bg: '#F0FDF4', text: '#16A34A', border: '#BBF7D0' },
};

const DIMENSION_LABELS: Record<string, string> = {
  commonError: '共性错误',
  comprehension: '题意理解',
  strategy: '学习策略',
  atRisk: '高危预警',
  difficulty: '难度异常',
  progress: '进步趋势',
  cognitivePath: '认知路径',
  aiEffectiveness: 'AI 实效',
};

interface Props {
  domainId: string;
  contestId: string;
}

export function TeachingSummaryPanel({ domainId, contestId }: Props) {
  const { summary, loading, error, fetchSummary, generate, submitFeedback } = useTeachingSummary(domainId, contestId);
  const [teachingFocus, setTeachingFocus] = useState('');
  const [expandedFinding, setExpandedFinding] = useState<string | null>(null);
  const [showSuggestion, setShowSuggestion] = useState(false);
  const [feedbackSent, setFeedbackSent] = useState(false);

  useEffect(() => { fetchSummary(); }, [fetchSummary]);

  const handleGenerate = () => {
    if (summary && summary.status === 'completed') {
      if (!confirm(t('ai_helper_teaching_exists_confirm'))) return;
      generate(teachingFocus || undefined, true);
    } else {
      generate(teachingFocus || undefined);
    }
  };

  const handleFeedback = (rating: 'up' | 'down') => {
    if (summary) {
      submitFeedback(summary._id, rating);
      setFeedbackSent(true);
    }
  };

  // No summary yet — show generate button
  if (!summary || summary.status === 'failed') {
    return (
      <div style={{ ...cardStyle, padding: SPACING.lg }}>
        <div style={{ marginBottom: SPACING.md }}>
          <input
            type="text"
            placeholder={t('ai_helper_teaching_focus_placeholder')}
            value={teachingFocus}
            onChange={e => setTeachingFocus(e.target.value)}
            style={{
              width: '100%',
              padding: `${SPACING.sm}px ${SPACING.md}px`,
              border: `1px solid ${COLORS.border}`,
              borderRadius: RADIUS.md,
              fontSize: 14,
              boxSizing: 'border-box' as const,
            }}
          />
        </div>
        <button onClick={handleGenerate} disabled={loading} style={getButtonStyle('primary')}>
          {loading ? t('ai_helper_teaching_generating') : t('ai_helper_teaching_generate')}
        </button>
        {error && <p style={{ color: COLORS.error, marginTop: SPACING.sm }}>{error}</p>}
        {summary?.status === 'failed' && <p style={{ color: COLORS.error, marginTop: SPACING.sm }}>生成失败，请重试</p>}
      </div>
    );
  }

  // Generating — show loading state
  if (summary.status === 'pending' || summary.status === 'generating') {
    return (
      <div style={{ ...cardStyle, padding: SPACING.lg, textAlign: 'center' as const }}>
        <p>{t('ai_helper_teaching_generating')}</p>
      </div>
    );
  }

  // Completed — show results
  const highFindings = summary.findings.filter(f => f.severity === 'high');
  const mediumFindings = summary.findings.filter(f => f.severity === 'medium');
  const lowFindings = summary.findings.filter(f => f.severity === 'low');

  return (
    <div>
      {/* Data snapshot notice */}
      <div style={{ fontSize: 12, color: COLORS.textSecondary, marginBottom: SPACING.sm }}>
        {t('ai_helper_teaching_snapshot_time')}：{new Date(summary.dataSnapshotAt).toLocaleString()}
      </div>

      {/* Overview bar */}
      <div style={{
        ...cardStyle,
        padding: SPACING.md,
        display: 'flex',
        gap: SPACING.lg,
        marginBottom: SPACING.md,
      }}>
        <div>参与学生 <strong>{summary.stats.participatedStudents}/{summary.stats.totalStudents}</strong></div>
        <div>发现问题 <strong>{summary.findings.length} 条</strong></div>
        <div>高优先 <strong style={{ color: COLORS.error }}>{highFindings.length}</strong></div>
        <div>AI 用户 <strong>{summary.stats.aiUserCount}</strong></div>
      </div>

      {/* Findings list */}
      {summary.stats.participatedStudents < 10 && (
        <div style={{ padding: SPACING.sm, background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: RADIUS.md, marginBottom: SPACING.md, fontSize: 13 }}>
          ⚠ {t('ai_helper_teaching_no_data')}
        </div>
      )}

      {[
        { label: t('ai_helper_teaching_severity_high'), findings: highFindings, color: SEVERITY_COLORS.high },
        { label: t('ai_helper_teaching_severity_medium'), findings: mediumFindings, color: SEVERITY_COLORS.medium },
        { label: t('ai_helper_teaching_severity_low'), findings: lowFindings, color: SEVERITY_COLORS.low },
      ].map(group => group.findings.length > 0 && (
        <div key={group.label} style={{ marginBottom: SPACING.md }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: group.color.text, marginBottom: SPACING.xs }}>
            {group.label}
          </div>
          {group.findings.map(finding => (
            <FindingCard
              key={finding.id}
              finding={finding}
              color={group.color}
              expanded={expandedFinding === finding.id}
              deepDiveText={summary.deepDiveResults[finding.id]}
              onToggle={() => setExpandedFinding(expandedFinding === finding.id ? null : finding.id)}
            />
          ))}
        </div>
      ))}

      {/* Overall AI suggestion (collapsed by default) */}
      <div style={{ ...cardStyle, marginBottom: SPACING.md }}>
        <div
          onClick={() => setShowSuggestion(!showSuggestion)}
          style={{ padding: SPACING.md, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <strong>{t('ai_helper_teaching_suggestion')}</strong>
          <span style={{ fontSize: 12, color: COLORS.textSecondary }}>{showSuggestion ? '▲ 收起' : '▼ 展开'}</span>
        </div>
        {showSuggestion && (
          <div style={{ padding: `0 ${SPACING.md}px ${SPACING.md}px`, ...markdownTheme }}>
            <div dangerouslySetInnerHTML={{ __html: simpleMarkdown(summary.overallSuggestion) }} />
          </div>
        )}
      </div>

      {/* Feedback */}
      {!feedbackSent && !summary.feedback ? (
        <div style={{ ...cardStyle, padding: SPACING.md, display: 'flex', alignItems: 'center', gap: SPACING.md }}>
          <span>{t('ai_helper_teaching_feedback_prompt')}</span>
          <button onClick={() => handleFeedback('up')} style={{ ...getButtonStyle('default'), padding: '4px 12px' }}>👍</button>
          <button onClick={() => handleFeedback('down')} style={{ ...getButtonStyle('default'), padding: '4px 12px' }}>👎</button>
        </div>
      ) : (
        <div style={{ fontSize: 13, color: COLORS.textSecondary }}>{t('ai_helper_teaching_feedback_thanks')}</div>
      )}

      {/* Regenerate */}
      <div style={{ marginTop: SPACING.md }}>
        <button onClick={handleGenerate} disabled={loading} style={getButtonStyle('default')}>
          {t('ai_helper_teaching_regenerate')}
        </button>
      </div>
    </div>
  );
}

function FindingCard({
  finding, color, expanded, deepDiveText, onToggle,
}: {
  finding: TeachingFinding;
  color: { bg: string; text: string; border: string };
  expanded: boolean;
  deepDiveText?: string;
  onToggle: () => void;
}) {
  return (
    <div style={{
      background: color.bg,
      border: `1px solid ${color.border}`,
      borderRadius: RADIUS.md,
      marginBottom: SPACING.xs,
    }}>
      <div
        onClick={onToggle}
        style={{ padding: SPACING.md, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <div>
          <span style={{
            display: 'inline-block',
            padding: '2px 8px',
            borderRadius: RADIUS.sm,
            fontSize: 11,
            fontWeight: 600,
            background: color.text,
            color: '#fff',
            marginRight: SPACING.sm,
          }}>
            {DIMENSION_LABELS[finding.dimension] || finding.dimension}
          </span>
          <span style={{ fontSize: 14 }}>{finding.title}</span>
        </div>
        <span style={{ fontSize: 12, color: COLORS.textSecondary }}>
          {finding.evidence.affectedStudents.length} 人 {expanded ? '▲' : '▼'}
        </span>
      </div>

      {expanded && (
        <div style={{ padding: `0 ${SPACING.md}px ${SPACING.md}px`, borderTop: `1px solid ${color.border}` }}>
          {/* Metrics */}
          <div style={{ display: 'flex', gap: SPACING.lg, marginTop: SPACING.sm, fontSize: 13 }}>
            {Object.entries(finding.evidence.metrics).map(([key, val]) => (
              <div key={key}><span style={{ color: COLORS.textSecondary }}>{key}:</span> <strong>{val}</strong></div>
            ))}
          </div>

          {/* Deep-dive analysis */}
          {deepDiveText && (
            <div style={{ marginTop: SPACING.md }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: SPACING.xs }}>{t('ai_helper_teaching_deep_dive')}</div>
              <div style={{ ...markdownTheme, background: '#fff', padding: SPACING.md, borderRadius: RADIUS.md }}>
                <div dangerouslySetInnerHTML={{ __html: simpleMarkdown(deepDiveText) }} />
              </div>
            </div>
          )}

          {/* Copy warning for common errors */}
          {finding.dimension === 'commonError' && finding.evidence.affectedStudents.length > 10 && (
            <div style={{ fontSize: 12, color: COLORS.warning, marginTop: SPACING.sm }}>
              ⚠ {t('ai_helper_teaching_copy_warning')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function simpleMarkdown(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/### (.+)/g, '<h4>$1</h4>')
    .replace(/## (.+)/g, '<h3>$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n- /g, '\n<li>')
    .replace(/\n(\d+)\. /g, '\n<li>')
    .replace(/\n/g, '<br/>');
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/teachingSummary/TeachingSummaryPanel.tsx
git commit -m "feat: add TeachingSummaryPanel frontend component"
```

---

## Task 9: Frontend — TeachingReviewPanel + Dashboard Tab

**Files:**
- Create: `frontend/teachingSummary/useTeachingReview.ts`
- Create: `frontend/teachingSummary/TeachingReviewPanel.tsx`
- Modify: `frontend/components/AIHelperDashboard.tsx`

- [ ] **Step 1: Write useTeachingReview hook**

```typescript
// frontend/teachingSummary/useTeachingReview.ts
import { useState, useCallback } from 'react';
import { TeachingSummary, buildReviewUrl } from './useTeachingSummary';

export function useTeachingReview(domainId: string) {
  const [summaries, setSummaries] = useState<TeachingSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);

  const fetchList = useCallback(async (p: number = 1) => {
    setLoading(true);
    try {
      const res = await fetch(`${buildReviewUrl(domainId)}?page=${p}&limit=20`, {
        credentials: 'include',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      const data = await res.json();
      setSummaries(data.summaries || []);
      setTotal(data.total || 0);
      setPage(p);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [domainId]);

  return { summaries, total, page, loading, fetchList, setPage };
}
```

- [ ] **Step 2: Write TeachingReviewPanel**

```typescript
// frontend/teachingSummary/TeachingReviewPanel.tsx
import React, { useEffect } from 'react';
import { i18n } from '@hydrooj/ui-default';
import { COLORS, SPACING, RADIUS, cardStyle, getButtonStyle, getPaginationButtonStyle } from '../utils/styles';
import { useTeachingReview } from './useTeachingReview';

const SEVERITY_DOTS: Record<string, string> = {
  high: '#DC2626',
  medium: '#D97706',
  low: '#16A34A',
};

interface Props {
  domainId: string;
}

export function TeachingReviewPanel({ domainId }: Props) {
  const { summaries, total, page, loading, fetchList } = useTeachingReview(domainId);

  useEffect(() => { fetchList(1); }, [fetchList]);

  const totalPages = Math.ceil(total / 20);

  if (loading && summaries.length === 0) {
    return <div style={{ textAlign: 'center' as const, padding: SPACING.xl, color: COLORS.textSecondary }}>加载中...</div>;
  }

  if (summaries.length === 0) {
    return <div style={{ textAlign: 'center' as const, padding: SPACING.xl, color: COLORS.textSecondary }}>暂无教学总结记录</div>;
  }

  return (
    <div>
      {summaries.map(s => {
        const highCount = s.findings.filter(f => f.severity === 'high').length;
        const medCount = s.findings.filter(f => f.severity === 'medium').length;
        const lowCount = s.findings.filter(f => f.severity === 'low').length;
        const topFindings = s.findings
          .filter(f => f.severity === 'high')
          .slice(0, 3)
          .map(f => f.title);

        return (
          <div key={s._id} style={{ ...cardStyle, padding: SPACING.md, marginBottom: SPACING.sm }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <span style={{ fontSize: 13, color: COLORS.textSecondary }}>
                  {new Date(s.createdAt).toLocaleDateString()}
                </span>
                <span style={{ fontSize: 15, fontWeight: 600, marginLeft: SPACING.sm }}>{s.contestTitle}</span>
              </div>
              <div style={{ display: 'flex', gap: SPACING.xs, fontSize: 12 }}>
                {highCount > 0 && <span style={{ color: SEVERITY_DOTS.high }}>● 高{highCount}</span>}
                {medCount > 0 && <span style={{ color: SEVERITY_DOTS.medium }}>● 中{medCount}</span>}
                {lowCount > 0 && <span style={{ color: SEVERITY_DOTS.low }}>● 低{lowCount}</span>}
              </div>
            </div>
            {topFindings.length > 0 && (
              <div style={{ fontSize: 13, color: COLORS.textSecondary, marginTop: SPACING.xs }}>
                关键问题：{topFindings.join('、')}
              </div>
            )}
            <div style={{ fontSize: 12, color: COLORS.textSecondary, marginTop: SPACING.xs }}>
              学生 {s.stats.participatedStudents}/{s.stats.totalStudents} | 发现 {s.findings.length} 条
              {s.status !== 'completed' && <span style={{ color: COLORS.warning, marginLeft: SPACING.sm }}>({s.status})</span>}
            </div>
          </div>
        );
      })}

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: SPACING.xs, marginTop: SPACING.md }}>
          {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
            <button
              key={p}
              onClick={() => fetchList(p)}
              style={getPaginationButtonStyle(p === page, false)}
            >
              {p}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Add tab to AIHelperDashboard.tsx**

In `frontend/components/AIHelperDashboard.tsx`, find the tabs array (around line 45):

```typescript
const tabs: { id: TabType; label: string }[] = [
  { id: 'conversations', label: i18n('ai_helper_dashboard_tab_conversations') },
  { id: 'analytics', label: i18n('ai_helper_dashboard_tab_analytics') },
  { id: 'cost', label: i18n('ai_helper_dashboard_tab_cost') },
  { id: 'config', label: i18n('ai_helper_dashboard_tab_config') },
];
```

Change to:

```typescript
const tabs: { id: TabType; label: string }[] = [
  { id: 'conversations', label: i18n('ai_helper_dashboard_tab_conversations') },
  { id: 'analytics', label: i18n('ai_helper_dashboard_tab_analytics') },
  { id: 'teaching_review', label: i18n('ai_helper_dashboard_tab_teaching_review') || '教学总结回顾' },
  { id: 'cost', label: i18n('ai_helper_dashboard_tab_cost') },
  { id: 'config', label: i18n('ai_helper_dashboard_tab_config') },
];
```

Also update the `TabType` type (find around line 10) to include `'teaching_review'`.

Then add the import at top:

```typescript
import { TeachingReviewPanel } from '../teachingSummary/TeachingReviewPanel';
```

And add the tab content render case (in the tab content rendering section):

```typescript
{activeTab === 'teaching_review' && <TeachingReviewPanel domainId={domainId} />}
```

- [ ] **Step 4: Build to verify**

Run: `npm run build:plugin`
Expected: 0 errors (frontend is compiled by HydroOJ separately, but TS should compile clean)

- [ ] **Step 5: Commit**

```bash
git add frontend/teachingSummary/useTeachingReview.ts frontend/teachingSummary/TeachingReviewPanel.tsx frontend/components/AIHelperDashboard.tsx
git commit -m "feat: add teaching review dashboard tab and review panel"
```

---

## Task 10: Integration — Batch Summary Page Entry Point

**Files:**
- Create: `frontend/teachingSummary/teachingSummary.page.tsx`

This registers the TeachingSummaryPanel on the homework scoreboard page.

- [ ] **Step 1: Write the page entry**

```typescript
// frontend/teachingSummary/teachingSummary.page.tsx
import React from 'react';
import { renderComponent } from '../utils/renderHelper';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { TeachingSummaryPanel } from './TeachingSummaryPanel';

const SCOREBOARD_SELECTORS = [
  '[data-teaching-summary-root]',
];

function getDomainId(): string {
  const match = window.location.pathname.match(/^\/d\/([^/]+)\//);
  return match ? match[1] : 'system';
}

function getContestId(): string | null {
  // Extract from URL: /d/:domainId/homework/:contestId or /contest/:contestId
  const match = window.location.pathname.match(/\/(homework|contest)\/([a-f0-9]+)/);
  return match ? match[2] : null;
}

const renderPanel = () => {
  const contestId = getContestId();
  if (!contestId) return;

  for (const selector of SCOREBOARD_SELECTORS) {
    const container = document.querySelector(selector);
    if (container) {
      const domainId = getDomainId();
      renderComponent(
        <ErrorBoundary>
          <TeachingSummaryPanel domainId={domainId} contestId={contestId} />
        </ErrorBoundary>,
        container as HTMLElement,
      );
      return;
    }
  }
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', renderPanel, { once: true });
} else {
  renderPanel();
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/teachingSummary/teachingSummary.page.tsx
git commit -m "feat: add teaching summary page entry point for homework scoreboard"
```

---

## Task 11: Verify Full Build + Run Tests

- [ ] **Step 1: Run full build**

Run: `npm run build:plugin`
Expected: 0 errors

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: Fix any warnings

- [ ] **Step 3: Run all tests**

Run: `npm test`
Expected: All existing + new tests pass

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve build and lint issues for teaching suggestions"
```
