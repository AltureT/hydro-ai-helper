import type { Db, Collection } from 'mongodb';

export interface RequestDailyStats {
  _id: string;
  successCount: number;
  failureCount: number;
  totalLatencyMs: number;
  errorCountByCategory: Record<string, number>;
  updatedAt: Date;
}

export interface RequestStats24h {
  successCount: number;
  failureCount: number;
  avgLatencyMs: number;
  errorCountByCategory: Record<string, number>;
}

const TTL_DAYS = 90;

export class RequestStatsModel {
  private collection: Collection<RequestDailyStats>;

  constructor(db: Db) {
    this.collection = db.collection<RequestDailyStats>('ai_request_daily_stats');
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex(
      { updatedAt: 1 },
      { expireAfterSeconds: TTL_DAYS * 24 * 60 * 60, name: 'idx_ttl_updatedAt' }
    );
    console.log('[RequestStatsModel] Indexes created successfully');
  }

  private static getDateKey(): string {
    return new Date().toISOString().slice(0, 10);
  }

  async recordSuccess(latencyMs: number): Promise<void> {
    const dateKey = RequestStatsModel.getDateKey();
    await this.collection.updateOne(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { _id: dateKey } as any,
      {
        $inc: {
          successCount: 1,
          totalLatencyMs: latencyMs,
        },
        $set: { updatedAt: new Date() },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      { upsert: true }
    );
  }

  async recordFailure(category: string): Promise<void> {
    const dateKey = RequestStatsModel.getDateKey();
    await this.collection.updateOne(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { _id: dateKey } as any,
      {
        $inc: {
          failureCount: 1,
          [`errorCountByCategory.${category}`]: 1,
        },
        $set: { updatedAt: new Date() },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      { upsert: true }
    );
  }

  async getStats24h(): Promise<RequestStats24h> {
    const today = RequestStatsModel.getDateKey();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc = await this.collection.findOne({ _id: today } as any);

    if (!doc) {
      return { successCount: 0, failureCount: 0, avgLatencyMs: 0, errorCountByCategory: {} };
    }

    const avgLatencyMs = doc.successCount > 0
      ? Math.round(doc.totalLatencyMs / doc.successCount)
      : 0;

    return {
      successCount: doc.successCount || 0,
      failureCount: doc.failureCount || 0,
      avgLatencyMs,
      errorCountByCategory: doc.errorCountByCategory || {},
    };
  }
}
