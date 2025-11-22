/**
 * JailbreakLog Model - 越狱尝试记录
 */

import type { Collection, Db } from 'mongodb';
import { ObjectId, type ObjectIdType } from '../utils/mongo';

export type JailbreakQuestionType = 'understand' | 'think' | 'debug' | 'review';

export interface JailbreakLog {
  _id: ObjectIdType;
  userId?: number;
  problemId?: string;
  conversationId?: ObjectIdType;
  questionType?: JailbreakQuestionType;
  matchedPattern: string;
  matchedText: string;
  createdAt: Date;
}

export interface JailbreakLogCreateInput {
  userId?: number;
  problemId?: string;
  conversationId?: string | ObjectIdType;
  questionType?: JailbreakQuestionType;
  matchedPattern: string;
  matchedText: string;
  createdAt?: Date;
}

export class JailbreakLogModel {
  private collection: Collection<JailbreakLog>;

  constructor(db: Db) {
    this.collection = db.collection<JailbreakLog>('ai_jailbreak_logs');
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ createdAt: -1 }, { name: 'idx_createdAt' });
    await this.collection.createIndex({ userId: 1, createdAt: -1 }, { name: 'idx_userId_createdAt' });
    console.log('[JailbreakLogModel] Indexes ensured');
  }

  async create(data: JailbreakLogCreateInput): Promise<ObjectIdType> {
    const insertDoc: Omit<JailbreakLog, '_id'> = {
      userId: data.userId,
      problemId: data.problemId,
      conversationId:
        data.conversationId === undefined
          ? undefined
          : typeof data.conversationId === 'string'
            ? new ObjectId(data.conversationId)
            : data.conversationId,
      questionType: data.questionType,
      matchedPattern: data.matchedPattern,
      matchedText: data.matchedText,
      createdAt: data.createdAt ?? new Date()
    };

    const result = await this.collection.insertOne(insertDoc as JailbreakLog);
    return result.insertedId;
  }

  async listRecent(limit: number = 20): Promise<JailbreakLog[]> {
    return this.collection.find().sort({ createdAt: -1 }).limit(limit).toArray();
  }
}
