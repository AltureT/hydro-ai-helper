# Batch Student Summary Generation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teachers generate personalized AI learning summaries for each student from the homework scoreboard, with SSE real-time progress, draft/publish flow, and CSV export.

**Architecture:** New MongoDB models (jobs + summaries) → submission sampler service → batch orchestrator with 10-concurrent AI calls → SSE streaming handler → React frontend integrated into HydroOJ scoreboard via expandable rows.

**Tech Stack:** TypeScript, MongoDB, HydroOJ plugin API, OpenAI-compatible API, React 17, SSE (EventSource)

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/models/batchSummaryJob.ts` | Create | Job collection CRUD + indexes |
| `src/models/studentSummary.ts` | Create | Student summary collection CRUD + indexes |
| `src/services/submissionSampler.ts` | Create | Hash dedup + milestone marking + priority sampling |
| `src/services/batchSummaryService.ts` | Create | Orchestration: data collection, concurrent AI calls, progress |
| `src/handlers/batchSummaryHandler.ts` | Create | HTTP endpoints: generate, result, retry, publish, export |
| `src/index.ts` | Modify | Register models + routes |
| `locales/zh.yaml` | Modify | Chinese i18n keys |
| `locales/en.yaml` | Modify | English i18n keys |
| `frontend/batchSummary/BatchSummaryPanel.page.tsx` | Create | Main teacher UI: button, progress, summary cards |
| `frontend/batchSummary/SummaryCard.tsx` | Create | Expandable summary card component |
| `frontend/batchSummary/useBatchSummary.ts` | Create | SSE hook + state management |
| `src/__tests__/services/submissionSampler.test.ts` | Create | Sampler unit tests |
| `src/__tests__/models/batchSummaryJob.test.ts` | Create | Job model tests |
| `src/__tests__/models/studentSummary.test.ts` | Create | Summary model tests |
| `src/__tests__/services/batchSummaryService.test.ts` | Create | Service integration tests |

---

### Task 1: BatchSummaryJob Model

**Files:**
- Create: `src/models/batchSummaryJob.ts`
- Test: `src/__tests__/models/batchSummaryJob.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// src/__tests__/models/batchSummaryJob.test.ts
import { BatchSummaryJobModel } from '../../models/batchSummaryJob';

function createMockCollection() {
  const chainMock: any = {
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    toArray: jest.fn().mockResolvedValue([]),
  };
  return {
    createIndex: jest.fn().mockResolvedValue('ok'),
    insertOne: jest.fn().mockResolvedValue({ insertedId: 'job1' }),
    findOne: jest.fn().mockResolvedValue(null),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    find: jest.fn().mockReturnValue(chainMock),
  };
}

describe('BatchSummaryJobModel', () => {
  let model: BatchSummaryJobModel;
  let col: ReturnType<typeof createMockCollection>;

  beforeEach(() => {
    col = createMockCollection();
    const mockDb = { collection: jest.fn().mockReturnValue(col) } as any;
    model = new BatchSummaryJobModel(mockDb);
  });

  it('should create indexes on ensureIndexes()', async () => {
    await model.ensureIndexes();
    expect(col.createIndex).toHaveBeenCalledWith(
      { domainId: 1, contestId: 1 },
      expect.objectContaining({ unique: true })
    );
  });

  it('should create a job record', async () => {
    const result = await model.create({
      domainId: 'test',
      contestId: 'contest1' as any,
      createdBy: 1,
      totalStudents: 30,
      config: { concurrency: 10, locale: 'zh' },
    });
    expect(col.insertOne).toHaveBeenCalledTimes(1);
    const inserted = col.insertOne.mock.calls[0][0];
    expect(inserted.status).toBe('pending');
    expect(inserted.completedCount).toBe(0);
    expect(inserted.failedCount).toBe(0);
  });

  it('should find active job by domainId + contestId', async () => {
    await model.findActiveJob('test', 'contest1' as any);
    expect(col.findOne).toHaveBeenCalledWith({
      domainId: 'test',
      contestId: 'contest1',
      status: { $ne: 'archived' },
    });
  });

  it('should update job status', async () => {
    await model.updateStatus('job1' as any, 'running');
    expect(col.updateOne).toHaveBeenCalledWith(
      { _id: 'job1' },
      expect.objectContaining({ $set: expect.objectContaining({ status: 'running' }) })
    );
  });

  it('should increment completedCount', async () => {
    await model.incrementCompleted('job1' as any);
    expect(col.updateOne).toHaveBeenCalledWith(
      { _id: 'job1' },
      expect.objectContaining({ $inc: { completedCount: 1 } })
    );
  });

  it('should increment failedCount', async () => {
    await model.incrementFailed('job1' as any);
    expect(col.updateOne).toHaveBeenCalledWith(
      { _id: 'job1' },
      expect.objectContaining({ $inc: { failedCount: 1 } })
    );
  });

  it('should archive a job', async () => {
    await model.archive('job1' as any);
    expect(col.updateOne).toHaveBeenCalledWith(
      { _id: 'job1' },
      expect.objectContaining({ $set: expect.objectContaining({ status: 'archived' }) })
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/models/batchSummaryJob.test.ts --no-cache`
Expected: FAIL — cannot find module `../../models/batchSummaryJob`

- [ ] **Step 3: Implement the model**

```typescript
// src/models/batchSummaryJob.ts
import { Db, Collection } from 'mongodb';
import { ObjectId, ObjectIdType } from '../utils/mongo';

export interface BatchSummaryJobConfig {
  concurrency: number;
  locale: string;
}

export interface BatchSummaryJob {
  _id: ObjectIdType;
  domainId: string;
  contestId: ObjectIdType;
  contestTitle: string;
  createdBy: number;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'archived';
  totalStudents: number;
  completedCount: number;
  failedCount: number;
  config: BatchSummaryJobConfig;
  createdAt: Date;
  completedAt: Date | null;
}

interface CreateJobParams {
  domainId: string;
  contestId: ObjectIdType;
  createdBy: number;
  totalStudents: number;
  config: BatchSummaryJobConfig;
}

export class BatchSummaryJobModel {
  private collection: Collection<BatchSummaryJob>;

  constructor(db: Db) {
    this.collection = db.collection<BatchSummaryJob>('ai_batch_summary_jobs');
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex(
      { domainId: 1, contestId: 1 },
      { unique: true, name: 'idx_domain_contest', partialFilterExpression: { status: { $ne: 'archived' } } }
    );
    console.log('[BatchSummaryJobModel] Indexes created successfully');
  }

  async create(params: CreateJobParams): Promise<ObjectIdType> {
    const doc = {
      ...params,
      status: 'pending' as const,
      completedCount: 0,
      failedCount: 0,
      createdAt: new Date(),
      completedAt: null,
    };
    const result = await this.collection.insertOne(doc as any);
    return result.insertedId;
  }

  async findById(id: ObjectIdType): Promise<BatchSummaryJob | null> {
    return this.collection.findOne({ _id: id } as any);
  }

  async findActiveJob(domainId: string, contestId: ObjectIdType): Promise<BatchSummaryJob | null> {
    return this.collection.findOne({ domainId, contestId, status: { $ne: 'archived' } } as any);
  }

  async updateStatus(id: ObjectIdType, status: BatchSummaryJob['status']): Promise<void> {
    const update: any = { $set: { status } };
    if (status === 'completed' || status === 'failed') {
      update.$set.completedAt = new Date();
    }
    await this.collection.updateOne({ _id: id } as any, update);
  }

  async incrementCompleted(id: ObjectIdType): Promise<void> {
    await this.collection.updateOne({ _id: id } as any, { $inc: { completedCount: 1 } });
  }

  async incrementFailed(id: ObjectIdType): Promise<void> {
    await this.collection.updateOne({ _id: id } as any, { $inc: { failedCount: 1 } });
  }

  async archive(id: ObjectIdType): Promise<void> {
    await this.collection.updateOne({ _id: id } as any, { $set: { status: 'archived' } });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/models/batchSummaryJob.test.ts --no-cache`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/models/batchSummaryJob.ts src/__tests__/models/batchSummaryJob.test.ts
git commit -m "feat(models): add BatchSummaryJobModel with CRUD and indexes"
```

---

### Task 2: StudentSummary Model

**Files:**
- Create: `src/models/studentSummary.ts`
- Test: `src/__tests__/models/studentSummary.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// src/__tests__/models/studentSummary.test.ts
import { StudentSummaryModel } from '../../models/studentSummary';

function createMockCollection() {
  const chainMock: any = {
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    toArray: jest.fn().mockResolvedValue([]),
  };
  return {
    createIndex: jest.fn().mockResolvedValue('ok'),
    insertMany: jest.fn().mockResolvedValue({ insertedCount: 3 }),
    insertOne: jest.fn().mockResolvedValue({ insertedId: 'sum1' }),
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockReturnValue(chainMock),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    updateMany: jest.fn().mockResolvedValue({ modifiedCount: 5 }),
  };
}

describe('StudentSummaryModel', () => {
  let model: StudentSummaryModel;
  let col: ReturnType<typeof createMockCollection>;

  beforeEach(() => {
    col = createMockCollection();
    const mockDb = { collection: jest.fn().mockReturnValue(col) } as any;
    model = new StudentSummaryModel(mockDb);
  });

  it('should create indexes', async () => {
    await model.ensureIndexes();
    expect(col.createIndex).toHaveBeenCalledTimes(2);
  });

  it('should bulk create pending summaries', async () => {
    await model.createBatch('job1' as any, 'test', 'contest1' as any, [1, 2, 3]);
    expect(col.insertMany).toHaveBeenCalledTimes(1);
    const docs = col.insertMany.mock.calls[0][0];
    expect(docs).toHaveLength(3);
    expect(docs[0].status).toBe('pending');
    expect(docs[0].publishStatus).toBe('draft');
  });

  it('should find summary by jobId + userId', async () => {
    await model.findByJobAndUser('job1' as any, 1);
    expect(col.findOne).toHaveBeenCalledWith({ jobId: 'job1', userId: 1 });
  });

  it('should find published summary for student view', async () => {
    await model.findPublishedForStudent('test', 'contest1' as any, 1);
    expect(col.findOne).toHaveBeenCalledWith({
      domainId: 'test',
      contestId: 'contest1',
      userId: 1,
      publishStatus: 'published',
      status: 'completed',
    });
  });

  it('should update summary with AI result', async () => {
    await model.completeSummary('sum1' as any, 'Great job!', [{ pid: 'A', title: 'Test', submissionCount: 3, sampledSubmissions: [], allStatuses: [] }], { prompt: 100, completion: 50 });
    expect(col.updateOne).toHaveBeenCalledWith(
      { _id: 'sum1' },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'completed',
          summary: 'Great job!',
          originalSummary: 'Great job!',
        }),
      })
    );
  });

  it('should publish all drafts for a job', async () => {
    await model.publishAll('job1' as any);
    expect(col.updateMany).toHaveBeenCalledWith(
      { jobId: 'job1', status: 'completed', publishStatus: 'draft' },
      { $set: { publishStatus: 'published', updatedAt: expect.any(Date) } }
    );
  });

  it('should check if any summaries have been edited', async () => {
    col.findOne.mockResolvedValue({ _id: 'sum1', summary: 'edited', originalSummary: 'original' });
    const result = await model.hasEditedSummaries('job1' as any);
    expect(col.findOne).toHaveBeenCalledWith({
      jobId: 'job1',
      $expr: { $ne: ['$summary', '$originalSummary'] },
    });
    expect(result).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/models/studentSummary.test.ts --no-cache`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement the model**

```typescript
// src/models/studentSummary.ts
import { Db, Collection } from 'mongodb';
import { ObjectId, ObjectIdType } from '../utils/mongo';

export interface SampledSubmission {
  recordId: ObjectIdType;
  status: string;
  timestamp: Date;
  milestone: string;
}

export interface ProblemSnapshot {
  pid: string;
  title: string;
  submissionCount: number;
  sampledSubmissions: SampledSubmission[];
  allStatuses: string[];
}

export interface StudentSummary {
  _id: ObjectIdType;
  jobId: ObjectIdType;
  domainId: string;
  contestId: ObjectIdType;
  userId: number;
  status: 'pending' | 'generating' | 'completed' | 'failed';
  publishStatus: 'draft' | 'published';
  summary: string | null;
  originalSummary: string | null;
  problemSnapshots: ProblemSnapshot[];
  tokenUsage: { prompt: number; completion: number };
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class StudentSummaryModel {
  private collection: Collection<StudentSummary>;

  constructor(db: Db) {
    this.collection = db.collection<StudentSummary>('ai_student_summaries');
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex(
      { jobId: 1, userId: 1 },
      { unique: true, name: 'idx_job_user' }
    );
    await this.collection.createIndex(
      { domainId: 1, contestId: 1, userId: 1 },
      { name: 'idx_domain_contest_user' }
    );
    console.log('[StudentSummaryModel] Indexes created successfully');
  }

  async createBatch(
    jobId: ObjectIdType,
    domainId: string,
    contestId: ObjectIdType,
    userIds: number[],
  ): Promise<void> {
    const now = new Date();
    const docs = userIds.map((userId) => ({
      jobId,
      domainId,
      contestId,
      userId,
      status: 'pending' as const,
      publishStatus: 'draft' as const,
      summary: null,
      originalSummary: null,
      problemSnapshots: [],
      tokenUsage: { prompt: 0, completion: 0 },
      error: null,
      createdAt: now,
      updatedAt: now,
    }));
    await this.collection.insertMany(docs as any[]);
  }

  async findByJobAndUser(jobId: ObjectIdType, userId: number): Promise<StudentSummary | null> {
    return this.collection.findOne({ jobId, userId } as any);
  }

  async findAllByJob(jobId: ObjectIdType): Promise<StudentSummary[]> {
    return this.collection.find({ jobId } as any).sort({ userId: 1 }).toArray();
  }

  async findPublishedForStudent(
    domainId: string,
    contestId: ObjectIdType,
    userId: number,
  ): Promise<StudentSummary | null> {
    return this.collection.findOne({
      domainId,
      contestId,
      userId,
      publishStatus: 'published',
      status: 'completed',
    } as any);
  }

  async markGenerating(id: ObjectIdType): Promise<void> {
    await this.collection.updateOne(
      { _id: id } as any,
      { $set: { status: 'generating', updatedAt: new Date() } }
    );
  }

  async completeSummary(
    id: ObjectIdType,
    summary: string,
    problemSnapshots: ProblemSnapshot[],
    tokenUsage: { prompt: number; completion: number },
  ): Promise<void> {
    await this.collection.updateOne(
      { _id: id } as any,
      {
        $set: {
          status: 'completed',
          summary,
          originalSummary: summary,
          problemSnapshots,
          tokenUsage,
          updatedAt: new Date(),
        },
      }
    );
  }

  async markFailed(id: ObjectIdType, error: string): Promise<void> {
    await this.collection.updateOne(
      { _id: id } as any,
      { $set: { status: 'failed', error, updatedAt: new Date() } }
    );
  }

  async resetToPending(id: ObjectIdType): Promise<void> {
    await this.collection.updateOne(
      { _id: id } as any,
      { $set: { status: 'pending', error: null, updatedAt: new Date() } }
    );
  }

  async editSummary(id: ObjectIdType, summary: string): Promise<void> {
    await this.collection.updateOne(
      { _id: id } as any,
      { $set: { summary, updatedAt: new Date() } }
    );
  }

  async publishAll(jobId: ObjectIdType): Promise<number> {
    const result = await this.collection.updateMany(
      { jobId, status: 'completed', publishStatus: 'draft' } as any,
      { $set: { publishStatus: 'published', updatedAt: new Date() } }
    );
    return result.modifiedCount;
  }

  async publishOne(id: ObjectIdType): Promise<void> {
    await this.collection.updateOne(
      { _id: id } as any,
      { $set: { publishStatus: 'published', updatedAt: new Date() } }
    );
  }

  async deleteSummary(id: ObjectIdType): Promise<void> {
    await this.collection.updateOne(
      { _id: id } as any,
      { $set: { summary: null, status: 'pending', publishStatus: 'draft', updatedAt: new Date() } }
    );
  }

  async hasEditedSummaries(jobId: ObjectIdType): Promise<boolean> {
    const doc = await this.collection.findOne({
      jobId,
      $expr: { $ne: ['$summary', '$originalSummary'] },
    } as any);
    return doc !== null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/models/studentSummary.test.ts --no-cache`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/models/studentSummary.ts src/__tests__/models/studentSummary.test.ts
git commit -m "feat(models): add StudentSummaryModel with draft/publish and edit tracking"
```

---

### Task 3: Submission Sampler Service

**Files:**
- Create: `src/services/submissionSampler.ts`
- Test: `src/__tests__/services/submissionSampler.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// src/__tests__/services/submissionSampler.test.ts
import { SubmissionSampler, RawSubmission } from '../../services/submissionSampler';

function makeSubmission(overrides: Partial<RawSubmission> = {}): RawSubmission {
  return {
    recordId: `r${Math.random().toString(36).slice(2, 8)}` as any,
    code: 'int main() { return 0; }',
    status: 'WA',
    score: 0,
    lang: 'cc',
    timestamp: new Date('2026-01-01T10:00:00Z'),
    runtime: 15,
    memory: 1024,
    ...overrides,
  };
}

describe('SubmissionSampler', () => {
  const sampler = new SubmissionSampler();

  describe('normalizeCode', () => {
    it('should strip C++ single-line comments', () => {
      const code = 'int x = 1; // init value\nreturn x;';
      const norm = sampler.normalizeCode(code, 'cc');
      expect(norm).not.toContain('// init value');
      expect(norm).toContain('int x = 1');
    });

    it('should strip C++ multi-line comments', () => {
      const code = 'int x = 1; /* multi\nline */ return x;';
      const norm = sampler.normalizeCode(code, 'cc');
      expect(norm).not.toContain('multi');
    });

    it('should strip Python comments', () => {
      const code = 'x = 1  # init\nprint(x)';
      const norm = sampler.normalizeCode(code, 'py');
      expect(norm).not.toContain('# init');
    });

    it('should collapse whitespace', () => {
      const code = 'int   x  =  1;\n\n\nreturn  x;';
      const norm = sampler.normalizeCode(code, 'cc');
      expect(norm).toBe('int x = 1; return x;');
    });
  });

  describe('hashDedup', () => {
    it('should merge adjacent identical submissions', () => {
      const subs = [
        makeSubmission({ code: 'int main() {}', timestamp: new Date('2026-01-01T10:00:00Z') }),
        makeSubmission({ code: 'int main() {}', timestamp: new Date('2026-01-01T10:01:00Z') }),
        makeSubmission({ code: 'int main() { return 0; }', timestamp: new Date('2026-01-01T10:02:00Z') }),
      ];
      const result = sampler.hashDedup(subs, 'cc');
      expect(result).toHaveLength(2);
      expect(result[0].timestamp).toEqual(new Date('2026-01-01T10:01:00Z'));
    });

    it('should keep non-adjacent identical submissions', () => {
      const subs = [
        makeSubmission({ code: 'v1', timestamp: new Date('2026-01-01T10:00:00Z') }),
        makeSubmission({ code: 'v2', timestamp: new Date('2026-01-01T10:01:00Z') }),
        makeSubmission({ code: 'v1', timestamp: new Date('2026-01-01T10:02:00Z') }),
      ];
      const result = sampler.hashDedup(subs, 'cc');
      expect(result).toHaveLength(3);
    });
  });

  describe('markMilestones', () => {
    it('should mark first and final', () => {
      const subs = [
        makeSubmission({ status: 'WA', timestamp: new Date('2026-01-01T10:00:00Z') }),
        makeSubmission({ status: 'WA', timestamp: new Date('2026-01-01T10:05:00Z') }),
        makeSubmission({ status: 'AC', timestamp: new Date('2026-01-01T10:10:00Z') }),
      ];
      const result = sampler.markMilestones(subs);
      expect(result[0].milestones).toContain('first');
      expect(result[2].milestones).toContain('final');
    });

    it('should mark first_ac', () => {
      const subs = [
        makeSubmission({ status: 'WA' }),
        makeSubmission({ status: 'AC' }),
        makeSubmission({ status: 'AC' }),
      ];
      const result = sampler.markMilestones(subs);
      expect(result[1].milestones).toContain('first_ac');
      expect(result[2].milestones).not.toContain('first_ac');
    });

    it('should mark status_change', () => {
      const subs = [
        makeSubmission({ status: 'WA' }),
        makeSubmission({ status: 'TLE' }),
        makeSubmission({ status: 'TLE' }),
      ];
      const result = sampler.markMilestones(subs);
      expect(result[1].milestones).toContain('status_change');
      expect(result[2].milestones).not.toContain('status_change');
    });

    it('should mark time_gap > 10 min', () => {
      const subs = [
        makeSubmission({ timestamp: new Date('2026-01-01T10:00:00Z') }),
        makeSubmission({ timestamp: new Date('2026-01-01T10:15:00Z') }),
      ];
      const result = sampler.markMilestones(subs);
      expect(result[1].milestones).toContain('time_gap');
    });

    it('should mark lang_change', () => {
      const subs = [
        makeSubmission({ lang: 'cc' }),
        makeSubmission({ lang: 'py' }),
      ];
      const result = sampler.markMilestones(subs);
      expect(result[1].milestones).toContain('lang_change');
    });

    it('should mark score_up', () => {
      const subs = [
        makeSubmission({ score: 30 }),
        makeSubmission({ score: 60 }),
        makeSubmission({ score: 60 }),
      ];
      const result = sampler.markMilestones(subs);
      expect(result[1].milestones).toContain('score_up');
      expect(result[2].milestones).not.toContain('score_up');
    });
  });

  describe('sample (full pipeline)', () => {
    it('should return empty for 0 submissions', () => {
      const result = sampler.sample([], 'cc');
      expect(result.sampledSubmissions).toHaveLength(0);
      expect(result.allStatuses).toHaveLength(0);
    });

    it('should return single submission as first+final', () => {
      const sub = makeSubmission({ status: 'AC' });
      const result = sampler.sample([sub], 'cc');
      expect(result.sampledSubmissions).toHaveLength(1);
      expect(result.sampledSubmissions[0].milestone).toBe('first');
    });

    it('should respect max 5 samples per problem', () => {
      const subs = Array.from({ length: 20 }, (_, i) =>
        makeSubmission({
          code: `version_${i}`,
          status: i === 19 ? 'AC' : 'WA',
          score: i * 5,
          timestamp: new Date(Date.now() + i * 60000),
        })
      );
      const result = sampler.sample(subs, 'cc');
      expect(result.sampledSubmissions.length).toBeLessThanOrEqual(5);
      expect(result.allStatuses).toHaveLength(20);
    });

    it('should merge consecutive CE submissions', () => {
      const subs = [
        makeSubmission({ status: 'CE', code: 'bad1' }),
        makeSubmission({ status: 'CE', code: 'bad2' }),
        makeSubmission({ status: 'CE', code: 'bad3' }),
        makeSubmission({ status: 'WA', code: 'int main() {}' }),
      ];
      const result = sampler.sample(subs, 'cc');
      const ceSamples = result.sampledSubmissions.filter((s) => s.status === 'CE');
      expect(ceSamples.length).toBeLessThanOrEqual(1);
    });

    it('should truncate long code keeping head and tail', () => {
      const longCode = 'x'.repeat(10000);
      const sub = makeSubmission({ code: longCode });
      const result = sampler.sample([sub], 'cc');
      expect(result.sampledSubmissions[0].code.length).toBeLessThan(10000);
      expect(result.sampledSubmissions[0].code).toContain('[...truncated...]');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/services/submissionSampler.test.ts --no-cache`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement the sampler**

```typescript
// src/services/submissionSampler.ts
import { createHash } from 'crypto';
import { ObjectIdType } from '../utils/mongo';

export interface RawSubmission {
  recordId: ObjectIdType;
  code: string;
  status: string;
  score: number;
  lang: string;
  timestamp: Date;
  runtime: number;
  memory: number;
}

interface MilestonedSubmission extends RawSubmission {
  milestones: string[];
  hash: string;
}

export interface SampledSubmission {
  recordId: ObjectIdType;
  code: string;
  status: string;
  timestamp: Date;
  milestone: string;
}

export interface SampleResult {
  sampledSubmissions: SampledSubmission[];
  allStatuses: string[];
  submissionCount: number;
}

const MAX_SAMPLES = 5;
const CODE_TOKEN_BUDGET = 4000;
const CE_TOKEN_CAP = 500;
const SINGLE_CODE_MAX_TOKENS = 2000;
const TIME_GAP_MS = 10 * 60 * 1000; // 10 minutes
const CHARS_PER_TOKEN = 3.5;

const MILESTONE_PRIORITY: Record<string, number> = {
  final: 7,
  first_ac: 6,
  score_up: 5,
  first: 4,
  status_change: 3,
  lang_change: 2,
  time_gap: 1,
};

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function truncateCode(code: string, maxTokens: number): string {
  const maxChars = Math.floor(maxTokens * CHARS_PER_TOKEN);
  if (code.length <= maxChars) return code;
  const half = Math.floor(maxChars / 2) - 15;
  return code.slice(0, half) + '\n[...truncated...]\n' + code.slice(-half);
}

export class SubmissionSampler {
  normalizeCode(code: string, lang: string): string {
    let s = code;
    if (['cc', 'cpp', 'c', 'java'].includes(lang)) {
      s = s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    } else if (['py', 'python', 'py3'].includes(lang)) {
      s = s.replace(/#.*$/gm, '').replace(/"""[\s\S]*?"""/g, '').replace(/'''[\s\S]*?'''/g, '');
    }
    return s.replace(/\s+/g, ' ').trim();
  }

  private hashCode(normalized: string): string {
    return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  }

  hashDedup(submissions: RawSubmission[], lang: string): RawSubmission[] {
    if (submissions.length === 0) return [];
    const result: RawSubmission[] = [];
    let prevHash = '';
    for (const sub of submissions) {
      const normalized = this.normalizeCode(sub.code, lang);
      const hash = this.hashCode(normalized);
      if (hash === prevHash && result.length > 0) {
        result[result.length - 1] = sub; // keep later one
      } else {
        result.push(sub);
      }
      prevHash = hash;
    }
    return result;
  }

  private mergeCE(submissions: RawSubmission[]): RawSubmission[] {
    const result: RawSubmission[] = [];
    for (const sub of submissions) {
      if (sub.status === 'CE' && result.length > 0 && result[result.length - 1].status === 'CE') {
        result[result.length - 1] = sub; // keep last CE in streak
      } else {
        result.push(sub);
      }
    }
    return result;
  }

  markMilestones(submissions: RawSubmission[]): MilestonedSubmission[] {
    if (submissions.length === 0) return [];
    return submissions.map((sub, i) => {
      const milestones: string[] = [];
      if (i === 0) milestones.push('first');
      if (i === submissions.length - 1) milestones.push('final');
      if (sub.status === 'AC' && !submissions.slice(0, i).some((s) => s.status === 'AC')) {
        milestones.push('first_ac');
      }
      if (i > 0 && sub.status !== submissions[i - 1].status) {
        milestones.push('status_change');
      }
      if (i > 0 && sub.score > submissions[i - 1].score) {
        milestones.push('score_up');
      }
      if (i > 0 && sub.lang !== submissions[i - 1].lang) {
        milestones.push('lang_change');
      }
      if (i > 0 && sub.timestamp.getTime() - submissions[i - 1].timestamp.getTime() > TIME_GAP_MS) {
        milestones.push('time_gap');
      }
      const normalized = this.normalizeCode(sub.code, sub.lang);
      return { ...sub, milestones, hash: this.hashCode(normalized) };
    });
  }

  private priorityScore(milestones: string[]): number {
    return milestones.reduce((max, m) => Math.max(max, MILESTONE_PRIORITY[m] || 0), 0);
  }

  sample(submissions: RawSubmission[], lang: string): SampleResult {
    const allStatuses = submissions.map(
      (s) => `${s.timestamp.toISOString()}:${s.status}`
    );

    if (submissions.length === 0) {
      return { sampledSubmissions: [], allStatuses: [], submissionCount: 0 };
    }
    if (submissions.length === 1) {
      const code = truncateCode(submissions[0].code, SINGLE_CODE_MAX_TOKENS);
      return {
        sampledSubmissions: [{
          recordId: submissions[0].recordId,
          code,
          status: submissions[0].status,
          timestamp: submissions[0].timestamp,
          milestone: 'first',
        }],
        allStatuses,
        submissionCount: 1,
      };
    }

    // Pipeline
    let deduped = this.hashDedup(submissions, lang);
    deduped = this.mergeCE(deduped);
    const milestoned = this.markMilestones(deduped);

    // Sort by priority descending, then by original order for tie-breaking
    const indexed = milestoned.map((m, idx) => ({ ...m, origIdx: idx }));
    indexed.sort((a, b) => {
      const pa = this.priorityScore(a.milestones);
      const pb = this.priorityScore(b.milestones);
      if (pa !== pb) return pb - pa;
      return a.origIdx - b.origIdx;
    });

    // Select within token budget
    const selected: typeof indexed = [];
    let tokenBudget = CODE_TOKEN_BUDGET;

    for (const sub of indexed) {
      if (selected.length >= MAX_SAMPLES) break;
      const isCE = sub.status === 'CE';
      const maxTokens = isCE ? CE_TOKEN_CAP : SINGLE_CODE_MAX_TOKENS;
      const code = truncateCode(sub.code, maxTokens);
      const tokens = estimateTokens(code);
      if (tokens > tokenBudget && selected.length > 0) continue;
      selected.push({ ...sub, code });
      tokenBudget -= tokens;
    }

    // Restore original chronological order
    selected.sort((a, b) => a.origIdx - b.origIdx);

    return {
      sampledSubmissions: selected.map((s) => ({
        recordId: s.recordId,
        code: s.code,
        status: s.status,
        timestamp: s.timestamp,
        milestone: s.milestones[0] || 'sampled',
      })),
      allStatuses,
      submissionCount: submissions.length,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/services/submissionSampler.test.ts --no-cache`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/submissionSampler.ts src/__tests__/services/submissionSampler.test.ts
git commit -m "feat(services): add SubmissionSampler with milestone-based sampling"
```

---

### Task 4: Batch Summary Service

**Files:**
- Create: `src/services/batchSummaryService.ts`
- Test: `src/__tests__/services/batchSummaryService.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// src/__tests__/services/batchSummaryService.test.ts
import { BatchSummaryService } from '../../services/batchSummaryService';

const mockJobModel = {
  updateStatus: jest.fn(),
  incrementCompleted: jest.fn(),
  incrementFailed: jest.fn(),
};

const mockSummaryModel = {
  findAllByJob: jest.fn(),
  markGenerating: jest.fn(),
  completeSummary: jest.fn(),
  markFailed: jest.fn(),
  resetToPending: jest.fn(),
};

const mockAiClient = {
  chat: jest.fn().mockResolvedValue({
    content: '这位同学表现良好 [提交 #r001]',
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  }),
};

const mockTokenUsageModel = {
  recordUsage: jest.fn(),
};

const mockDb = {
  collection: jest.fn().mockReturnValue({
    find: jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      toArray: jest.fn().mockResolvedValue([
        { _id: 'r001', uid: 1, pid: 'A', status: 1, code: 'int main(){}', lang: 'cc', score: 100, judgeAt: new Date(), time: 15, memory: 1024 },
      ]),
    }),
  }),
};

describe('BatchSummaryService', () => {
  let service: BatchSummaryService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new BatchSummaryService(
      mockDb as any,
      mockJobModel as any,
      mockSummaryModel as any,
      mockAiClient as any,
      mockTokenUsageModel as any,
    );
  });

  it('should process a single student successfully', async () => {
    const summaryDoc = { _id: 'sum1', userId: 1, status: 'pending' };
    mockSummaryModel.findAllByJob.mockResolvedValue([summaryDoc]);

    const events: any[] = [];
    const onEvent = (e: any) => events.push(e);

    await service.execute(
      { _id: 'job1', domainId: 'test', contestId: 'c1', config: { concurrency: 10, locale: 'zh' }, totalStudents: 1 } as any,
      [{ pid: 'A', title: 'Test Problem', content: 'Description' }],
      onEvent,
    );

    expect(mockSummaryModel.markGenerating).toHaveBeenCalledWith('sum1');
    expect(mockAiClient.chat).toHaveBeenCalledTimes(1);
    expect(mockSummaryModel.completeSummary).toHaveBeenCalledTimes(1);
    expect(mockJobModel.incrementCompleted).toHaveBeenCalledTimes(1);
    expect(mockJobModel.updateStatus).toHaveBeenCalledWith('job1', 'completed');
    expect(events.some((e) => e.type === 'student_done')).toBe(true);
    expect(events.some((e) => e.type === 'job_done')).toBe(true);
  });

  it('should handle AI call failure gracefully', async () => {
    const summaryDoc = { _id: 'sum1', userId: 1, status: 'pending' };
    mockSummaryModel.findAllByJob.mockResolvedValue([summaryDoc]);
    mockAiClient.chat.mockRejectedValueOnce(new Error('API timeout'));

    const events: any[] = [];
    await service.execute(
      { _id: 'job1', domainId: 'test', contestId: 'c1', config: { concurrency: 10, locale: 'zh' }, totalStudents: 1 } as any,
      [{ pid: 'A', title: 'Test', content: 'Desc' }],
      (e) => events.push(e),
    );

    expect(mockSummaryModel.markFailed).toHaveBeenCalledWith('sum1', 'API timeout');
    expect(mockJobModel.incrementFailed).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === 'student_failed')).toBe(true);
  });

  it('should respect concurrency limit', async () => {
    const summaries = Array.from({ length: 25 }, (_, i) => ({
      _id: `sum${i}`, userId: i + 1, status: 'pending',
    }));
    mockSummaryModel.findAllByJob.mockResolvedValue(summaries);

    let maxConcurrent = 0;
    let currentConcurrent = 0;
    mockAiClient.chat.mockImplementation(async () => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      await new Promise((r) => setTimeout(r, 10));
      currentConcurrent--;
      return { content: 'summary', usage: { prompt_tokens: 10, completion_tokens: 5 } };
    });

    await service.execute(
      { _id: 'job1', domainId: 'test', contestId: 'c1', config: { concurrency: 10, locale: 'zh' }, totalStudents: 25 } as any,
      [{ pid: 'A', title: 'Test', content: 'Desc' }],
      () => {},
    );

    expect(maxConcurrent).toBeLessThanOrEqual(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/__tests__/services/batchSummaryService.test.ts --no-cache`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement the service**

```typescript
// src/services/batchSummaryService.ts
import { Db } from 'mongodb';
import { ObjectIdType } from '../utils/mongo';
import { BatchSummaryJobModel, BatchSummaryJob } from '../models/batchSummaryJob';
import { StudentSummaryModel, ProblemSnapshot } from '../models/studentSummary';
import { SubmissionSampler, RawSubmission } from './submissionSampler';

interface ProblemInfo {
  pid: string;
  title: string;
  content: string;
}

interface SSEEvent {
  type: string;
  [key: string]: any;
}

// HydroOJ record status: 1 = AC
const STATUS_MAP: Record<number, string> = {
  1: 'AC', 2: 'WA', 3: 'TLE', 4: 'MLE', 5: 'OLE',
  6: 'RE', 7: 'CE', 8: 'SE', 9: 'IGN', 10: 'Pending',
  11: 'Compiling', 12: 'Judging',
};

function buildSystemPrompt(locale: string, contestTitle: string, domainId: string): string {
  const lang = locale.startsWith('zh') ? '中文' : 'English';
  return `你是 HydroOJ 平台上的资深编程导师。你的任务是根据学生的作业或比赛提交记录，生成一份个性化的学习总结，供学生复盘和教师查阅。

## 当前环境
- 输出语言：${lang}
- 平台名称：HydroOJ
- 作业名称：${contestTitle}
- 提交链接格式：[提交 #rXXXX] — 前端会自动解析为 /d/${domainId}/record/XXXX 的可点击链接

## 原则

1. **教育为先，绝不代笔**：对未通过的题目，指出逻辑漏洞和调试方向，不给完整解法。

2. **强制引用格式**：点评代码时必须使用 [提交 #rXXXX] 格式引用。

3. **洞察全局错误模式**：跨题目分析薄弱环节（如频繁边界条件出错、时间复杂度理解不足），不做逐题流水账。

4. **肯定努力与调试过程**：通过时间线识别试错过程，肯定坚持调试的精神。

5. **因材施教**：
   - 全 AC 学生：关注代码质量、优化空间、高级技巧
   - 挣扎学生：指出概念盲区、给出复习方向、温和鼓励

6. **语气与篇幅**：专业诚恳鼓励，200-800 字灵活控制，使用 Markdown 格式。`;
}

function buildUserPrompt(problems: ProblemInfo[], sampleResults: Map<string, ReturnType<SubmissionSampler['sample']>>): string {
  const sections: string[] = [];
  for (const prob of problems) {
    const result = sampleResults.get(prob.pid);
    if (!result || result.submissionCount === 0) {
      sections.push(`## 题目：${prob.title} (${prob.pid})\n\n该学生未提交此题。\n`);
      continue;
    }

    let section = `## 题目：${prob.title} (${prob.pid})\n\n`;
    // Truncate problem content to ~2000 tokens
    const maxContentChars = Math.floor(2000 * 3.5);
    const content = prob.content.length > maxContentChars
      ? prob.content.slice(0, maxContentChars) + '\n[...题目描述已截断...]'
      : prob.content;
    section += `### 题目描述\n${content}\n\n`;

    section += `### 提交时间线 (共 ${result.submissionCount} 次)\n`;
    section += result.allStatuses.map((s, i) => `${i + 1}. ${s}`).join('\n');
    section += '\n\n';

    section += `### 采样代码 (${result.sampledSubmissions.length} 份)\n`;
    for (const sub of result.sampledSubmissions) {
      section += `\n#### [提交 #r${sub.recordId}] ${sub.milestone} (${sub.status})\n`;
      section += '```\n' + sub.code + '\n```\n';
    }
    sections.push(section);
  }
  return sections.join('\n---\n\n');
}

export class BatchSummaryService {
  private db: Db;
  private jobModel: BatchSummaryJobModel;
  private summaryModel: StudentSummaryModel;
  private aiClient: any;
  private tokenUsageModel: any;
  private sampler: SubmissionSampler;

  constructor(
    db: Db,
    jobModel: BatchSummaryJobModel,
    summaryModel: StudentSummaryModel,
    aiClient: any,
    tokenUsageModel: any,
  ) {
    this.db = db;
    this.jobModel = jobModel;
    this.summaryModel = summaryModel;
    this.aiClient = aiClient;
    this.tokenUsageModel = tokenUsageModel;
    this.sampler = new SubmissionSampler();
  }

  async execute(
    job: BatchSummaryJob,
    problems: ProblemInfo[],
    onEvent: (event: SSEEvent) => void,
  ): Promise<void> {
    await this.jobModel.updateStatus(job._id, 'running');
    const summaries = await this.summaryModel.findAllByJob(job._id);
    const pendingSummaries = summaries.filter((s) => s.status === 'pending');
    const concurrency = job.config.concurrency || 10;
    let completed = 0;
    let failed = 0;
    let totalTokens = 0;

    for (let i = 0; i < pendingSummaries.length; i += concurrency) {
      const batch = pendingSummaries.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        batch.map((summary) =>
          this.processStudent(job, summary, problems)
        )
      );

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        const summary = batch[j];
        if (result.status === 'fulfilled') {
          completed++;
          totalTokens += result.value.totalTokens;
          onEvent({
            type: 'student_done',
            userId: summary.userId,
            status: 'completed',
            summary: result.value.summaryText,
          });
        } else {
          failed++;
          const errorMsg = result.reason?.message || 'Unknown error';
          await this.summaryModel.markFailed(summary._id, errorMsg);
          await this.jobModel.incrementFailed(job._id);
          onEvent({
            type: 'student_failed',
            userId: summary.userId,
            error: errorMsg,
          });
        }
        onEvent({
          type: 'progress',
          completed,
          total: pendingSummaries.length,
          failed,
        });
      }
    }

    const finalStatus = failed === pendingSummaries.length ? 'failed' : 'completed';
    await this.jobModel.updateStatus(job._id, finalStatus);
    onEvent({ type: 'job_done', completed, failed, totalTokens });
  }

  private async processStudent(
    job: BatchSummaryJob,
    summary: any,
    problems: ProblemInfo[],
  ): Promise<{ summaryText: string; totalTokens: number }> {
    await this.summaryModel.markGenerating(summary._id);

    // Fetch all submissions for this student across all problems
    const recordCollection = this.db.collection('record');
    const sampleResults = new Map<string, ReturnType<SubmissionSampler['sample']>>();
    const problemSnapshots: ProblemSnapshot[] = [];

    for (const prob of problems) {
      const records = await recordCollection
        .find({ domainId: job.domainId, uid: summary.userId, pid: prob.pid })
        .sort({ judgeAt: 1 })
        .toArray();

      const rawSubs: RawSubmission[] = records.map((r: any) => ({
        recordId: r._id,
        code: r.code || '',
        status: STATUS_MAP[r.status] || `Status_${r.status}`,
        score: r.score || 0,
        lang: r.lang || 'cc',
        timestamp: r.judgeAt || r._id.getTimestamp(),
        runtime: r.time || 0,
        memory: r.memory || 0,
      }));

      const lang = rawSubs[0]?.lang || 'cc';
      const result = this.sampler.sample(rawSubs, lang);
      sampleResults.set(prob.pid, result);

      problemSnapshots.push({
        pid: prob.pid,
        title: prob.title,
        submissionCount: result.submissionCount,
        sampledSubmissions: result.sampledSubmissions.map((s) => ({
          recordId: s.recordId,
          status: s.status,
          timestamp: s.timestamp,
          milestone: s.milestone,
        })),
        allStatuses: result.allStatuses,
      });
    }

    // Build prompt and call AI
    const systemPrompt = buildSystemPrompt(
      job.config.locale,
      job.contestTitle || '',
      job.domainId
    );
    const userPrompt = buildUserPrompt(problems, sampleResults);
    const aiResult = await this.aiClient.chat(
      [{ role: 'user', content: userPrompt }],
      systemPrompt,
    );

    const promptTokens = aiResult.usage?.prompt_tokens || 0;
    const completionTokens = aiResult.usage?.completion_tokens || 0;

    await this.summaryModel.completeSummary(
      summary._id,
      aiResult.content,
      problemSnapshots,
      { prompt: promptTokens, completion: completionTokens },
    );
    await this.jobModel.incrementCompleted(job._id);

    // Record token usage
    try {
      await this.tokenUsageModel.recordUsage({
        domainId: job.domainId,
        userId: summary.userId,
        modelName: 'batch-summary',
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      });
    } catch (e) {
      console.error('[BatchSummaryService] Failed to record token usage:', e);
    }

    return {
      summaryText: aiResult.content,
      totalTokens: promptTokens + completionTokens,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/__tests__/services/batchSummaryService.test.ts --no-cache`
Expected: All 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/batchSummaryService.ts src/__tests__/services/batchSummaryService.test.ts
git commit -m "feat(services): add BatchSummaryService with concurrent AI calls and SSE events"
```

---

### Task 5: Batch Summary Handler

**Files:**
- Create: `src/handlers/batchSummaryHandler.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Implement the handler**

```typescript
// src/handlers/batchSummaryHandler.ts
import { Handler } from 'hydrooj';
import { ObjectId, ObjectIdType } from '../utils/mongo';
import { getDomainId } from '../utils/domainHelper';
import { createSSEWriter } from '../lib/sseHelper';
import { BatchSummaryJobModel } from '../models/batchSummaryJob';
import { StudentSummaryModel } from '../models/studentSummary';
import { BatchSummaryService } from '../services/batchSummaryService';

export class BatchSummaryGenerateHandler extends Handler {
  async post() {
    const domainId = getDomainId(this);
    const { contestId } = this.request.body;
    if (!contestId) {
      this.response.status = 400;
      this.response.body = { error: 'contestId is required' };
      this.response.type = 'application/json';
      return;
    }

    const jobModel: BatchSummaryJobModel = this.ctx.get('batchSummaryJobModel');
    const summaryModel: StudentSummaryModel = this.ctx.get('studentSummaryModel');
    const aiConfigModel = this.ctx.get('aiConfigModel');

    // Check for existing job with edited summaries
    const existingJob = await jobModel.findActiveJob(domainId, new ObjectId(contestId));
    if (existingJob) {
      const hasEdits = await summaryModel.hasEditedSummaries(existingJob._id);
      const { confirmRegenerate } = this.request.body;
      if (hasEdits && !confirmRegenerate) {
        this.response.body = {
          needConfirm: true,
          message: 'Existing summaries have been edited. Regenerate will overwrite.',
        };
        this.response.type = 'application/json';
        return;
      }
      await jobModel.archive(existingJob._id);
    }

    // Fetch students and problems for this contest
    const db = this.ctx.db;
    const tdocCollection = db.collection('contest');
    const tdoc = await tdocCollection.findOne({ _id: new ObjectId(contestId), domainId });
    if (!tdoc) {
      this.response.status = 404;
      this.response.body = { error: 'Contest not found' };
      this.response.type = 'application/json';
      return;
    }

    const pids: string[] = tdoc.pids || [];
    const attendees: number[] = Object.keys(tdoc.attend || {}).map(Number);
    if (attendees.length === 0) {
      this.response.body = { error: 'No students in this contest' };
      this.response.type = 'application/json';
      return;
    }

    // Fetch problem details
    const pdocCollection = db.collection('document');
    const problems = [];
    for (const pid of pids) {
      const pdoc = await pdocCollection.findOne({ domainId, docType: 10, docId: Number(pid) || pid });
      problems.push({
        pid: String(pid),
        title: pdoc?.title || `Problem ${pid}`,
        content: pdoc?.content || '',
      });
    }

    // Get AI config for locale and concurrency
    const config = await aiConfigModel.getConfig(domainId);
    const locale = this.user?.viewLang || 'zh';

    // Create job
    const jobId = await jobModel.create({
      domainId,
      contestId: new ObjectId(contestId),
      createdBy: this.user._id,
      totalStudents: attendees.length,
      config: {
        concurrency: config?.batchConcurrency || 10,
        locale,
      },
    });
    await jobModel.updateStatus(jobId, 'running');

    // Create pending summaries
    await summaryModel.createBatch(jobId, domainId, new ObjectId(contestId), attendees);

    // Setup SSE
    const writer = createSSEWriter(this.response.raw);
    writer.writeEvent('job_started', { jobId: jobId.toString(), total: attendees.length });

    // Get AI client
    const openaiClient = this.ctx.get('openaiClient');

    // Execute in background
    const tokenUsageModel = this.ctx.get('tokenUsageModel');
    const service = new BatchSummaryService(
      db, jobModel, summaryModel, openaiClient, tokenUsageModel,
    );

    const job = await jobModel.findById(jobId);
    service.execute(job!, problems, (event) => {
      if (!writer.closed) {
        writer.writeEvent(event.type, event);
      }
    }).then(() => {
      if (!writer.closed) writer.end();
    }).catch((err) => {
      console.error('[BatchSummaryHandler] Execute error:', err);
      if (!writer.closed) {
        writer.writeEvent('error', { message: err.message });
        writer.end();
      }
    });
  }
}

export class BatchSummaryResultHandler extends Handler {
  async get() {
    const domainId = getDomainId(this);
    const { jobId } = this.request.params;
    const jobModel: BatchSummaryJobModel = this.ctx.get('batchSummaryJobModel');
    const summaryModel: StudentSummaryModel = this.ctx.get('studentSummaryModel');

    const job = await jobModel.findById(new ObjectId(jobId));
    if (!job || job.domainId !== domainId) {
      this.response.status = 404;
      this.response.body = { error: 'Job not found' };
      this.response.type = 'application/json';
      return;
    }

    const isTeacher = this.user.hasPriv(this.ctx.get('PRIV_READ_RECORD_CODE') || 0);
    let summaries;
    if (isTeacher) {
      summaries = await summaryModel.findAllByJob(job._id);
    } else {
      const mine = await summaryModel.findPublishedForStudent(domainId, job.contestId, this.user._id);
      summaries = mine ? [mine] : [];
    }

    this.response.body = { job, summaries };
    this.response.type = 'application/json';
  }
}

export class BatchSummaryRetryHandler extends Handler {
  async post() {
    const domainId = getDomainId(this);
    const { jobId, userId } = this.request.params;
    const summaryModel: StudentSummaryModel = this.ctx.get('studentSummaryModel');
    const jobModel: BatchSummaryJobModel = this.ctx.get('batchSummaryJobModel');

    const job = await jobModel.findById(new ObjectId(jobId));
    if (!job || job.domainId !== domainId) {
      this.response.status = 404;
      this.response.body = { error: 'Job not found' };
      this.response.type = 'application/json';
      return;
    }

    const summary = await summaryModel.findByJobAndUser(new ObjectId(jobId), Number(userId));
    if (!summary || summary.status !== 'failed') {
      this.response.status = 400;
      this.response.body = { error: 'Summary not in failed state' };
      this.response.type = 'application/json';
      return;
    }

    await summaryModel.resetToPending(summary._id);
    // Re-trigger single student processing would be done by the service
    // For now return success, frontend will re-trigger generation
    this.response.body = { success: true };
    this.response.type = 'application/json';
  }
}

export class BatchSummaryPublishHandler extends Handler {
  async post() {
    const domainId = getDomainId(this);
    const { jobId } = this.request.params;
    const { userId } = this.request.body; // optional: publish single student
    const summaryModel: StudentSummaryModel = this.ctx.get('studentSummaryModel');
    const jobModel: BatchSummaryJobModel = this.ctx.get('batchSummaryJobModel');

    const job = await jobModel.findById(new ObjectId(jobId));
    if (!job || job.domainId !== domainId) {
      this.response.status = 404;
      this.response.body = { error: 'Job not found' };
      this.response.type = 'application/json';
      return;
    }

    if (userId) {
      const summary = await summaryModel.findByJobAndUser(new ObjectId(jobId), Number(userId));
      if (summary) await summaryModel.publishOne(summary._id);
      this.response.body = { published: 1 };
    } else {
      const count = await summaryModel.publishAll(job._id);
      this.response.body = { published: count };
    }
    this.response.type = 'application/json';
  }
}

export class BatchSummaryExportHandler extends Handler {
  async get() {
    const domainId = getDomainId(this);
    const { jobId } = this.request.params;
    const summaryModel: StudentSummaryModel = this.ctx.get('studentSummaryModel');
    const jobModel: BatchSummaryJobModel = this.ctx.get('batchSummaryJobModel');

    const job = await jobModel.findById(new ObjectId(jobId));
    if (!job || job.domainId !== domainId) {
      this.response.status = 404;
      this.response.body = { error: 'Job not found' };
      this.response.type = 'application/json';
      return;
    }

    const summaries = await summaryModel.findAllByJob(job._id);
    const header = 'userId,status,publishStatus,summary,promptTokens,completionTokens,createdAt';
    const rows = summaries.map((s) => {
      const fields = [
        s.userId,
        s.status,
        s.publishStatus,
        escapeCsv(s.summary || ''),
        s.tokenUsage.prompt,
        s.tokenUsage.completion,
        s.createdAt.toISOString(),
      ];
      return fields.join(',');
    });

    const csv = [header, ...rows].join('\n');
    const filename = `ai_summaries_${jobId}_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    this.response.type = 'text/csv';
    this.response.body = csv;
    this.response.addHeader('Content-Disposition', `attachment; filename="${filename}"`);
  }
}

function escapeCsv(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export class BatchSummaryEditHandler extends Handler {
  async post() {
    const domainId = getDomainId(this);
    const { jobId, userId } = this.request.params;
    const { summary } = this.request.body;
    const summaryModel: StudentSummaryModel = this.ctx.get('studentSummaryModel');

    const doc = await summaryModel.findByJobAndUser(new ObjectId(jobId), Number(userId));
    if (!doc || doc.domainId !== domainId) {
      this.response.status = 404;
      this.response.body = { error: 'Summary not found' };
      this.response.type = 'application/json';
      return;
    }

    await summaryModel.editSummary(doc._id, summary);
    this.response.body = { success: true };
    this.response.type = 'application/json';
  }
}
```

- [ ] **Step 2: Register models and routes in src/index.ts**

Add after existing model registrations (~line 186):
```typescript
import { BatchSummaryJobModel } from './models/batchSummaryJob';
import { StudentSummaryModel } from './models/studentSummary';
```

In the `apply(ctx)` function, after existing `ctx.provide()` calls:
```typescript
const batchSummaryJobModel = new BatchSummaryJobModel(ctx.db);
const studentSummaryModel = new StudentSummaryModel(ctx.db);
await batchSummaryJobModel.ensureIndexes();
await studentSummaryModel.ensureIndexes();
ctx.provide('batchSummaryJobModel', batchSummaryJobModel);
ctx.provide('studentSummaryModel', studentSummaryModel);
```

Add imports for handlers:
```typescript
import {
  BatchSummaryGenerateHandler,
  BatchSummaryResultHandler,
  BatchSummaryRetryHandler,
  BatchSummaryPublishHandler,
  BatchSummaryExportHandler,
  BatchSummaryEditHandler,
} from './handlers/batchSummaryHandler';
```

Add route registrations after existing routes:
```typescript
ctx.Route('ai_batch_summary_generate', '/ai-helper/batch-summaries/generate', BatchSummaryGenerateHandler, PRIV.PRIV_READ_RECORD_CODE);
ctx.Route('ai_batch_summary_generate_domain', '/d/:domainId/ai-helper/batch-summaries/generate', BatchSummaryGenerateHandler, PRIV.PRIV_READ_RECORD_CODE);
ctx.Route('ai_batch_summary_result', '/ai-helper/batch-summaries/:jobId', BatchSummaryResultHandler);
ctx.Route('ai_batch_summary_result_domain', '/d/:domainId/ai-helper/batch-summaries/:jobId', BatchSummaryResultHandler);
ctx.Route('ai_batch_summary_retry', '/ai-helper/batch-summaries/:jobId/retry/:userId', BatchSummaryRetryHandler, PRIV.PRIV_READ_RECORD_CODE);
ctx.Route('ai_batch_summary_retry_domain', '/d/:domainId/ai-helper/batch-summaries/:jobId/retry/:userId', BatchSummaryRetryHandler, PRIV.PRIV_READ_RECORD_CODE);
ctx.Route('ai_batch_summary_publish', '/ai-helper/batch-summaries/:jobId/publish', BatchSummaryPublishHandler, PRIV.PRIV_READ_RECORD_CODE);
ctx.Route('ai_batch_summary_publish_domain', '/d/:domainId/ai-helper/batch-summaries/:jobId/publish', BatchSummaryPublishHandler, PRIV.PRIV_READ_RECORD_CODE);
ctx.Route('ai_batch_summary_export', '/ai-helper/batch-summaries/:jobId/export', BatchSummaryExportHandler, PRIV.PRIV_READ_RECORD_CODE);
ctx.Route('ai_batch_summary_export_domain', '/d/:domainId/ai-helper/batch-summaries/:jobId/export', BatchSummaryExportHandler, PRIV.PRIV_READ_RECORD_CODE);
ctx.Route('ai_batch_summary_edit', '/ai-helper/batch-summaries/:jobId/edit/:userId', BatchSummaryEditHandler, PRIV.PRIV_READ_RECORD_CODE);
ctx.Route('ai_batch_summary_edit_domain', '/d/:domainId/ai-helper/batch-summaries/:jobId/edit/:userId', BatchSummaryEditHandler, PRIV.PRIV_READ_RECORD_CODE);
```

- [ ] **Step 3: Build to verify compilation**

Run: `npm run build:plugin`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add src/handlers/batchSummaryHandler.ts src/index.ts
git commit -m "feat(handlers): add batch summary HTTP endpoints with SSE streaming"
```

---

### Task 6: i18n Keys

**Files:**
- Modify: `locales/zh.yaml`
- Modify: `locales/en.yaml`

- [ ] **Step 1: Add Chinese locale keys**

Append to `locales/zh.yaml`:
```yaml
ai_helper_batch_summary: "AI 学习总结"
ai_helper_batch_summary_generate: "生成 AI 学习总结"
ai_helper_batch_summary_generating: "正在生成 AI 总结..."
ai_helper_batch_summary_completed: "已完成"
ai_helper_batch_summary_failed: "生成失败"
ai_helper_batch_summary_draft: "草稿"
ai_helper_batch_summary_published: "已发布"
ai_helper_batch_summary_publish_all: "一键发布全部"
ai_helper_batch_summary_publish_one: "发布"
ai_helper_batch_summary_edit: "编辑"
ai_helper_batch_summary_delete: "删除"
ai_helper_batch_summary_retry: "重试"
ai_helper_batch_summary_expand_all: "全部展开"
ai_helper_batch_summary_collapse_all: "全部折叠"
ai_helper_batch_summary_export_csv: "导出 CSV"
ai_helper_batch_summary_confirm_regenerate: "已有总结被编辑过，重新生成将覆盖。确认继续？"
ai_helper_batch_summary_progress: "已完成 {0} / {1} · {2} 失败"
ai_helper_batch_summary_cancel: "取消"
ai_helper_batch_summary_no_students: "该作业暂无学生参与"
ai_helper_batch_summary_ref_submissions: "参考提交"
```

- [ ] **Step 2: Add English locale keys**

Append to `locales/en.yaml`:
```yaml
ai_helper_batch_summary: "AI Learning Summary"
ai_helper_batch_summary_generate: "Generate AI Summary"
ai_helper_batch_summary_generating: "Generating AI summaries..."
ai_helper_batch_summary_completed: "Completed"
ai_helper_batch_summary_failed: "Failed"
ai_helper_batch_summary_draft: "Draft"
ai_helper_batch_summary_published: "Published"
ai_helper_batch_summary_publish_all: "Publish All"
ai_helper_batch_summary_publish_one: "Publish"
ai_helper_batch_summary_edit: "Edit"
ai_helper_batch_summary_delete: "Delete"
ai_helper_batch_summary_retry: "Retry"
ai_helper_batch_summary_expand_all: "Expand All"
ai_helper_batch_summary_collapse_all: "Collapse All"
ai_helper_batch_summary_export_csv: "Export CSV"
ai_helper_batch_summary_confirm_regenerate: "Some summaries have been edited. Regeneration will overwrite. Continue?"
ai_helper_batch_summary_progress: "Completed {0} / {1} · {2} failed"
ai_helper_batch_summary_cancel: "Cancel"
ai_helper_batch_summary_no_students: "No students in this assignment"
ai_helper_batch_summary_ref_submissions: "Reference Submissions"
```

- [ ] **Step 3: Build to verify**

Run: `npm run build:plugin`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add locales/zh.yaml locales/en.yaml
git commit -m "feat(i18n): add batch summary locale keys for zh and en"
```

---

### Task 7: Frontend — SSE Hook and State Management

**Files:**
- Create: `frontend/batchSummary/useBatchSummary.ts`

- [ ] **Step 1: Implement the SSE hook**

```typescript
// frontend/batchSummary/useBatchSummary.ts
import { useState, useCallback, useRef } from 'react';

export interface StudentSummaryData {
  userId: number;
  userName?: string;
  status: 'pending' | 'generating' | 'completed' | 'failed';
  publishStatus: 'draft' | 'published';
  summary: string | null;
  error?: string;
}

export interface BatchSummaryState {
  jobId: string | null;
  isGenerating: boolean;
  completed: number;
  total: number;
  failed: number;
  summaries: Map<number, StudentSummaryData>;
  error: string | null;
}

const initialState: BatchSummaryState = {
  jobId: null,
  isGenerating: false,
  completed: 0,
  total: 0,
  failed: 0,
  summaries: new Map(),
  error: null,
};

export function useBatchSummary(domainId: string) {
  const [state, setState] = useState<BatchSummaryState>(initialState);
  const eventSourceRef = useRef<EventSource | null>(null);

  const startGeneration = useCallback(async (contestId: string, confirmRegenerate = false) => {
    const url = domainId !== 'system'
      ? `/d/${domainId}/ai-helper/batch-summaries/generate`
      : '/ai-helper/batch-summaries/generate';

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
      body: JSON.stringify({ contestId, confirmRegenerate }),
    });

    if (!res.ok) {
      const err = await res.json();
      if (err.needConfirm) return { needConfirm: true, message: err.message };
      throw new Error(err.error || 'Failed to start generation');
    }

    setState((s) => ({ ...s, isGenerating: true, error: null }));

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const processLine = (line: string) => {
      if (!line.startsWith('data: ')) return;
      try {
        const event = JSON.parse(line.slice(6));
        handleEvent(event);
      } catch { /* skip malformed */ }
    };

    const handleEvent = (event: any) => {
      setState((prev) => {
        const next = { ...prev, summaries: new Map(prev.summaries) };
        switch (event.type) {
          case 'job_started':
            next.jobId = event.jobId;
            next.total = event.total;
            break;
          case 'progress':
            next.completed = event.completed;
            next.total = event.total;
            next.failed = event.failed;
            break;
          case 'student_done':
            next.summaries.set(event.userId, {
              userId: event.userId,
              userName: event.userName,
              status: 'completed',
              publishStatus: 'draft',
              summary: event.summary,
            });
            break;
          case 'student_failed':
            next.summaries.set(event.userId, {
              userId: event.userId,
              userName: event.userName,
              status: 'failed',
              publishStatus: 'draft',
              summary: null,
              error: event.error,
            });
            break;
          case 'job_done':
            next.isGenerating = false;
            next.completed = event.completed;
            next.failed = event.failed;
            break;
          case 'error':
            next.isGenerating = false;
            next.error = event.message;
            break;
        }
        return next;
      });
    };

    // Read SSE stream
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) processLine(line.trim());
        }
      } catch (err: any) {
        setState((s) => ({ ...s, isGenerating: false, error: err.message }));
      }
    })();

    return { needConfirm: false };
  }, [domainId]);

  const loadExisting = useCallback(async (jobId: string) => {
    const url = domainId !== 'system'
      ? `/d/${domainId}/ai-helper/batch-summaries/${jobId}`
      : `/ai-helper/batch-summaries/${jobId}`;
    const res = await fetch(url);
    const data = await res.json();
    const summaryMap = new Map<number, StudentSummaryData>();
    for (const s of data.summaries) {
      summaryMap.set(s.userId, {
        userId: s.userId,
        status: s.status,
        publishStatus: s.publishStatus,
        summary: s.summary,
        error: s.error,
      });
    }
    setState({
      jobId: data.job._id,
      isGenerating: data.job.status === 'running',
      completed: data.job.completedCount,
      total: data.job.totalStudents,
      failed: data.job.failedCount,
      summaries: summaryMap,
      error: null,
    });
  }, [domainId]);

  const publishAll = useCallback(async () => {
    if (!state.jobId) return;
    const url = domainId !== 'system'
      ? `/d/${domainId}/ai-helper/batch-summaries/${state.jobId}/publish`
      : `/ai-helper/batch-summaries/${state.jobId}/publish`;
    await fetch(url, { method: 'POST' });
    setState((prev) => {
      const next = { ...prev, summaries: new Map(prev.summaries) };
      for (const [uid, s] of next.summaries) {
        if (s.status === 'completed') {
          next.summaries.set(uid, { ...s, publishStatus: 'published' });
        }
      }
      return next;
    });
  }, [domainId, state.jobId]);

  const retryStudent = useCallback(async (userId: number) => {
    if (!state.jobId) return;
    const url = domainId !== 'system'
      ? `/d/${domainId}/ai-helper/batch-summaries/${state.jobId}/retry/${userId}`
      : `/ai-helper/batch-summaries/${state.jobId}/retry/${userId}`;
    await fetch(url, { method: 'POST' });
    setState((prev) => {
      const next = { ...prev, summaries: new Map(prev.summaries) };
      const existing = next.summaries.get(userId);
      if (existing) next.summaries.set(userId, { ...existing, status: 'pending', error: undefined });
      return next;
    });
  }, [domainId, state.jobId]);

  const cleanup = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  return {
    state,
    startGeneration,
    loadExisting,
    publishAll,
    retryStudent,
    cleanup,
  };
}
```

- [ ] **Step 2: Build to verify no TypeScript errors**

Run: `npm run build:plugin`
Expected: 0 errors (frontend files are compiled by HydroOJ, not our build)

- [ ] **Step 3: Commit**

```bash
git add frontend/batchSummary/useBatchSummary.ts
git commit -m "feat(frontend): add useBatchSummary SSE hook and state management"
```

---

### Task 8: Frontend — Summary Card Component

**Files:**
- Create: `frontend/batchSummary/SummaryCard.tsx`

- [ ] **Step 1: Implement SummaryCard**

```tsx
// frontend/batchSummary/SummaryCard.tsx
import React, { useState } from 'react';
import { i18n } from '@hydrooj/ui-default';
import { COLORS, SPACING, RADIUS, SHADOWS, getButtonStyle } from '../utils/styles';

interface SummaryCardProps {
  userId: number;
  userName: string;
  status: 'pending' | 'generating' | 'completed' | 'failed';
  publishStatus: 'draft' | 'published';
  summary: string | null;
  error?: string;
  domainId: string;
  isTeacher: boolean;
  onRetry?: () => void;
  onPublish?: () => void;
  onEdit?: (newSummary: string) => void;
}

function renderSummaryWithLinks(summary: string, domainId: string): React.ReactNode {
  const parts = summary.split(/(\[提交 #r[a-f0-9]+\])/g);
  return parts.map((part, i) => {
    const match = part.match(/\[提交 #r([a-f0-9]+)\]/);
    if (match) {
      const recordId = match[1];
      return (
        <a
          key={i}
          href={`/d/${domainId}/record/${recordId}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            color: COLORS.primary,
            textDecoration: 'none',
            fontSize: '11px',
            background: '#eff6ff',
            padding: '1px 5px',
            borderRadius: RADIUS.sm,
            margin: '0 2px',
          }}
        >
          #{recordId.slice(0, 8)}
        </a>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

export function SummaryCard(props: SummaryCardProps) {
  const { userId, userName, status, publishStatus, summary, error, domainId, isTeacher, onRetry, onPublish, onEdit } = props;
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(summary || '');

  if (status === 'failed') {
    return (
      <div style={{
        margin: `0 ${SPACING.base} ${SPACING.md} ${SPACING.base}`,
        padding: SPACING.base,
        background: COLORS.errorBg,
        border: `1px solid ${COLORS.error}40`,
        borderRadius: RADIUS.md,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 600 }}>{userName}</span>
          <span style={{ fontSize: '12px', color: COLORS.error }}>{i18n('ai_helper_batch_summary_failed')}</span>
        </div>
        {error && <div style={{ fontSize: '12px', color: COLORS.errorText, marginTop: SPACING.xs }}>{error}</div>}
        {isTeacher && onRetry && (
          <button onClick={onRetry} style={{ ...getButtonStyle('primary'), marginTop: SPACING.sm, fontSize: '12px', padding: '4px 12px' }}>
            {i18n('ai_helper_batch_summary_retry')}
          </button>
        )}
      </div>
    );
  }

  if (status !== 'completed' || !summary) return null;

  return (
    <div style={{
      margin: `0 ${SPACING.base} ${SPACING.md} ${SPACING.base}`,
      padding: `${SPACING.base} 20px`,
      background: COLORS.bgCard,
      border: `1px solid ${COLORS.border}`,
      borderRadius: RADIUS.md,
      boxShadow: SHADOWS.sm,
      borderLeft: `3px solid ${COLORS.primary}`,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: SPACING.sm }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: SPACING.sm }}>
          <span style={{ fontWeight: 600, color: COLORS.textPrimary, fontSize: '13px' }}>
            {userName} · {i18n('ai_helper_batch_summary')}
          </span>
          {publishStatus === 'draft' && isTeacher && (
            <span style={{
              fontSize: '10px', padding: '2px 6px',
              background: '#fef3c7', color: '#92400e',
              borderRadius: RADIUS.sm,
            }}>
              {i18n('ai_helper_batch_summary_draft')}
            </span>
          )}
        </div>
        {isTeacher && (
          <div style={{ display: 'flex', gap: SPACING.xs }}>
            {publishStatus === 'draft' && onPublish && (
              <button onClick={onPublish} style={{ ...getButtonStyle('primary'), fontSize: '11px', padding: '2px 8px' }}>
                {i18n('ai_helper_batch_summary_publish_one')}
              </button>
            )}
            <button
              onClick={() => { setIsEditing(!isEditing); setEditText(summary); }}
              style={{ ...getButtonStyle('secondary'), fontSize: '11px', padding: '2px 8px' }}
            >
              {i18n('ai_helper_batch_summary_edit')}
            </button>
          </div>
        )}
      </div>

      {isEditing ? (
        <div>
          <textarea
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            style={{
              width: '100%', minHeight: '120px', padding: SPACING.sm,
              border: `1px solid ${COLORS.border}`, borderRadius: RADIUS.sm,
              fontFamily: 'inherit', fontSize: '12px', resize: 'vertical',
            }}
          />
          <div style={{ display: 'flex', gap: SPACING.xs, marginTop: SPACING.sm }}>
            <button
              onClick={() => { onEdit?.(editText); setIsEditing(false); }}
              style={{ ...getButtonStyle('primary'), fontSize: '11px', padding: '4px 12px' }}
            >
              Save
            </button>
            <button
              onClick={() => setIsEditing(false)}
              style={{ ...getButtonStyle('secondary'), fontSize: '11px', padding: '4px 12px' }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div style={{ fontSize: '12px', color: '#475569', lineHeight: 1.8 }}>
          {renderSummaryWithLinks(summary, domainId)}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/batchSummary/SummaryCard.tsx
git commit -m "feat(frontend): add SummaryCard component with edit, publish, and submission links"
```

---

### Task 9: Frontend — BatchSummaryPanel Page

**Files:**
- Create: `frontend/batchSummary/BatchSummaryPanel.page.tsx`

- [ ] **Step 1: Implement the page component**

```tsx
// frontend/batchSummary/BatchSummaryPanel.page.tsx
import React, { useEffect, useState, useCallback } from 'react';
import { i18n } from '@hydrooj/ui-default';
import { COLORS, SPACING, RADIUS, getButtonStyle } from '../utils/styles';
import { useBatchSummary } from './useBatchSummary';
import { SummaryCard } from './SummaryCard';

interface BatchSummaryPanelProps {
  domainId: string;
  contestId: string;
  isTeacher: boolean;
  existingJobId?: string;
}

export function BatchSummaryPanel(props: BatchSummaryPanelProps) {
  const { domainId, contestId, isTeacher, existingJobId } = props;
  const { state, startGeneration, loadExisting, publishAll, retryStudent, cleanup } = useBatchSummary(domainId);
  const [allExpanded, setAllExpanded] = useState(false);
  const [expandedUsers, setExpandedUsers] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (existingJobId) loadExisting(existingJobId);
    return cleanup;
  }, [existingJobId]);

  const handleGenerate = useCallback(async () => {
    const result = await startGeneration(contestId);
    if (result?.needConfirm) {
      if (confirm(i18n('ai_helper_batch_summary_confirm_regenerate'))) {
        await startGeneration(contestId, true);
      }
    }
  }, [contestId, startGeneration]);

  const toggleExpand = useCallback((userId: number) => {
    setExpandedUsers((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }, []);

  const toggleExpandAll = useCallback(() => {
    if (allExpanded) {
      setExpandedUsers(new Set());
    } else {
      const allUserIds = new Set(Array.from(state.summaries.keys()));
      setExpandedUsers(allUserIds);
    }
    setAllExpanded(!allExpanded);
  }, [allExpanded, state.summaries]);

  const handleExport = useCallback(() => {
    if (!state.jobId) return;
    const url = domainId !== 'system'
      ? `/d/${domainId}/ai-helper/batch-summaries/${state.jobId}/export`
      : `/ai-helper/batch-summaries/${state.jobId}/export`;
    window.open(url, '_blank');
  }, [domainId, state.jobId]);

  const progressPercent = state.total > 0 ? (state.completed / state.total) * 100 : 0;
  const hasCompletedSummaries = Array.from(state.summaries.values()).some((s) => s.status === 'completed');
  const hasDrafts = Array.from(state.summaries.values()).some((s) => s.publishStatus === 'draft' && s.status === 'completed');

  return (
    <div>
      {/* Action bar */}
      {isTeacher && (
        <div style={{
          display: 'flex', justifyContent: 'flex-end', alignItems: 'center',
          gap: SPACING.sm, padding: `${SPACING.sm} 0`,
        }}>
          {hasCompletedSummaries && (
            <>
              <button onClick={toggleExpandAll} style={{ ...getButtonStyle('ghost'), fontSize: '12px', padding: '4px 10px' }}>
                {allExpanded ? i18n('ai_helper_batch_summary_collapse_all') : i18n('ai_helper_batch_summary_expand_all')}
              </button>
              <button onClick={handleExport} style={{ ...getButtonStyle('secondary'), fontSize: '12px', padding: '4px 10px' }}>
                {i18n('ai_helper_batch_summary_export_csv')}
              </button>
              {hasDrafts && (
                <button onClick={publishAll} style={{ ...getButtonStyle('primary'), fontSize: '12px', padding: '4px 10px' }}>
                  {i18n('ai_helper_batch_summary_publish_all')}
                </button>
              )}
            </>
          )}
          <button
            onClick={handleGenerate}
            disabled={state.isGenerating}
            style={{
              ...getButtonStyle('primary'),
              fontSize: '12px', padding: '6px 16px',
              opacity: state.isGenerating ? 0.6 : 1,
              cursor: state.isGenerating ? 'not-allowed' : 'pointer',
            }}
          >
            {state.isGenerating ? i18n('ai_helper_batch_summary_generating') : i18n('ai_helper_batch_summary_generate')}
          </button>
        </div>
      )}

      {/* Progress bar */}
      {state.isGenerating && (
        <div style={{
          padding: `${SPACING.sm} ${SPACING.base}`,
          background: '#eff6ff', borderBottom: '1px solid #bfdbfe',
          borderRadius: RADIUS.sm, marginBottom: SPACING.sm,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
            <span style={{ fontSize: '11px', color: COLORS.primary, fontWeight: 500 }}>
              {i18n('ai_helper_batch_summary_generating')}
            </span>
            <span style={{ fontSize: '11px', color: '#64748b' }}>
              {state.completed} / {state.total} · {state.failed} {i18n('ai_helper_batch_summary_failed')}
            </span>
          </div>
          <div style={{ background: '#dbeafe', borderRadius: RADIUS.sm, height: '4px', overflow: 'hidden' }}>
            <div style={{
              background: COLORS.primary, width: `${progressPercent}%`,
              height: '100%', borderRadius: RADIUS.sm, transition: 'width 0.3s',
            }} />
          </div>
        </div>
      )}

      {/* Error display */}
      {state.error && (
        <div style={{
          padding: SPACING.sm, background: COLORS.errorBg,
          border: `1px solid ${COLORS.error}40`, borderRadius: RADIUS.sm,
          fontSize: '12px', color: COLORS.errorText, marginBottom: SPACING.sm,
        }}>
          {state.error}
        </div>
      )}

      {/* Summary cards */}
      {Array.from(state.summaries.entries()).map(([userId, data]) => {
        const isExpanded = expandedUsers.has(userId);
        if (!isExpanded && data.status === 'completed') return null;
        return (
          <SummaryCard
            key={userId}
            userId={userId}
            userName={data.userName || `User ${userId}`}
            status={data.status}
            publishStatus={data.publishStatus}
            summary={data.summary}
            error={data.error}
            domainId={domainId}
            isTeacher={isTeacher}
            onRetry={() => retryStudent(userId)}
            onPublish={async () => {
              if (!state.jobId) return;
              const url = domainId !== 'system'
                ? `/d/${domainId}/ai-helper/batch-summaries/${state.jobId}/publish`
                : `/ai-helper/batch-summaries/${state.jobId}/publish`;
              await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId }),
              });
              // Update local state
              const updated = new Map(state.summaries);
              const existing = updated.get(userId);
              if (existing) updated.set(userId, { ...existing, publishStatus: 'published' });
            }}
            onEdit={async (newSummary) => {
              if (!state.jobId) return;
              const url = domainId !== 'system'
                ? `/d/${domainId}/ai-helper/batch-summaries/${state.jobId}/edit/${userId}`
                : `/ai-helper/batch-summaries/${state.jobId}/edit/${userId}`;
              await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ summary: newSummary }),
              });
            }}
          />
        );
      })}
    </div>
  );
}

export default BatchSummaryPanel;
```

- [ ] **Step 2: Build to verify**

Run: `npm run build:plugin`
Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add frontend/batchSummary/BatchSummaryPanel.page.tsx
git commit -m "feat(frontend): add BatchSummaryPanel with progress, expand/collapse, publish flow"
```

---

### Task 10: Integration Verification

**Files:** All files from Tasks 1-9

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests PASS including new tests from Tasks 1-4

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: No errors (warnings acceptable)

- [ ] **Step 3: Run full build**

Run: `npm run build:plugin`
Expected: 0 errors

- [ ] **Step 4: Fix any issues found**

If any test/lint/build errors, fix them before proceeding.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore: fix any integration issues from batch summary feature"
```

(Only if there were fixes needed. Skip if all passed clean.)
