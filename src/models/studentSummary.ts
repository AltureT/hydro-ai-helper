import type { Db, Collection } from 'mongodb';
import { type ObjectIdType } from '../utils/mongo';

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
      { unique: true, name: 'idx_jobId_userId_unique' }
    );
    await this.collection.createIndex(
      { domainId: 1, contestId: 1, userId: 1 },
      { name: 'idx_domainId_contestId_userId' }
    );
    console.log('[StudentSummaryModel] Indexes created successfully');
  }

  async createBatch(
    jobId: ObjectIdType,
    domainId: string,
    contestId: ObjectIdType,
    userIds: number[]
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
    await this.collection.insertMany(docs as StudentSummary[]);
  }

  async findByJobAndUser(jobId: ObjectIdType, userId: number): Promise<StudentSummary | null> {
    return this.collection.findOne({ jobId, userId });
  }

  async findAllByJob(jobId: ObjectIdType): Promise<StudentSummary[]> {
    return this.collection.find({ jobId }).sort({ userId: 1 }).toArray();
  }

  async findPublishedForStudent(
    domainId: string,
    contestId: ObjectIdType,
    userId: number
  ): Promise<StudentSummary | null> {
    return this.collection.findOne({
      domainId,
      contestId,
      userId,
      publishStatus: 'published',
      status: 'completed',
    });
  }

  async markGenerating(id: ObjectIdType): Promise<void> {
    await this.collection.updateOne(
      { _id: id },
      { $set: { status: 'generating', updatedAt: new Date() } }
    );
  }

  async completeSummary(
    id: ObjectIdType,
    summary: string,
    problemSnapshots: ProblemSnapshot[],
    tokenUsage: { prompt: number; completion: number }
  ): Promise<void> {
    await this.collection.updateOne(
      { _id: id },
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
      { _id: id },
      { $set: { status: 'failed', error, updatedAt: new Date() } }
    );
  }

  async resetToPending(id: ObjectIdType): Promise<void> {
    await this.collection.updateOne(
      { _id: id },
      { $set: { status: 'pending', error: null, updatedAt: new Date() } }
    );
  }

  async editSummary(id: ObjectIdType, summary: string): Promise<void> {
    await this.collection.updateOne(
      { _id: id },
      { $set: { summary, updatedAt: new Date() } }
    );
  }

  async publishAll(jobId: ObjectIdType): Promise<number> {
    const result = await this.collection.updateMany(
      { jobId, status: 'completed', publishStatus: 'draft' },
      { $set: { publishStatus: 'published', updatedAt: new Date() } }
    );
    return result.modifiedCount;
  }

  async publishOne(id: ObjectIdType): Promise<void> {
    await this.collection.updateOne(
      { _id: id },
      { $set: { publishStatus: 'published', updatedAt: new Date() } }
    );
  }

  async deleteSummary(id: ObjectIdType): Promise<void> {
    await this.collection.updateOne(
      { _id: id },
      {
        $set: {
          summary: null,
          status: 'pending',
          publishStatus: 'draft',
          updatedAt: new Date(),
        },
      }
    );
  }

  async hasEditedSummaries(jobId: ObjectIdType): Promise<boolean> {
    const doc = await this.collection.findOne({
      jobId,
      $expr: { $ne: ['$summary', '$originalSummary'] },
    });
    return doc !== null;
  }
}
