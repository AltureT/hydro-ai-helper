import type { Db, Collection } from 'mongodb';
import { type ObjectIdType } from '../utils/mongo';
import { ensureObjectId } from '../utils/ensureObjectId';

export interface ErrorDistribution {
  CE: number;
  RE: number;
  WA: number;
  TLE: number;
  MLE: number;
  AC: number;
}

export interface StudentHistoryRecord {
  _id: ObjectIdType;
  domainId: string;
  userId: number;
  contestId: ObjectIdType;
  contestTitle: string;
  jobId: ObjectIdType;
  errorDistribution: ErrorDistribution;
  avgAttemptsToAC: number;
  gaveUpCount: number;
  notAttemptedCount: number;
  totalProblems: number;
  solvedCount: number;
  actionableAdvice: string;
  createdAt: Date;
}

export class StudentHistoryModel {
  private collection: Collection<StudentHistoryRecord>;

  constructor(db: Db) {
    this.collection = db.collection<StudentHistoryRecord>('ai_student_history');
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex(
      { domainId: 1, userId: 1, createdAt: -1 },
      { name: 'idx_domainId_userId_createdAt' },
    );
    await this.collection.createIndex(
      { jobId: 1, userId: 1 },
      { unique: true, name: 'idx_jobId_userId_unique' },
    );
    console.log('[StudentHistoryModel] Indexes created successfully');
  }

  async create(record: Omit<StudentHistoryRecord, '_id'>): Promise<void> {
    await this.collection.insertOne(record as StudentHistoryRecord);
  }

  async findRecent(
    domainId: string,
    userId: number,
    limit = 3,
  ): Promise<StudentHistoryRecord[]> {
    return this.collection
      .find({ domainId, userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
  }

  async findByJobAndUser(
    jobId: string | ObjectIdType,
    userId: number,
  ): Promise<StudentHistoryRecord | null> {
    const _jobId = ensureObjectId(jobId);
    return this.collection.findOne({ jobId: _jobId, userId });
  }
}
