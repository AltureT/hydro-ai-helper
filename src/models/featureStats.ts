import type { Db, Collection } from 'mongodb';

/**
 * Per-feature daily health counters.
 *
 * Detects the "aggregate error rate is 0% but a whole feature is 100% broken"
 * blind spot: background features that fail silently (produce nothing without
 * throwing) leave no trace in the error stream. By tracking attempts vs
 * successes per feature, telemetry can flag `attempts>0 && successes==0`.
 *
 * One document per (UTC day, feature). All writes are `$inc` upserts on a single
 * doc, so they are cheap enough to call from hot paths in a fire-and-forget way.
 */
export interface FeatureDailyStats {
  _id: string; // `${date}:${feature}`
  date: string; // YYYY-MM-DD (UTC)
  feature: string;
  attemptCount: number;
  successCount: number;
  lastSuccessAt: Date | null;
  updatedAt: Date;
}

export interface FeatureStats24h {
  feature: string;
  attempts: number;
  successes: number;
  lastSuccessAt: Date | null;
}

/** 按日的功能计数（随心跳上报，供遥测平台做跨日累计统计） */
export interface FeatureStatsDaily {
  date: string; // YYYY-MM-DD (UTC)
  feature: string;
  attempts: number;
  successes: number;
  lastSuccessAt: Date | null;
}

const TTL_DAYS = 14;

export class FeatureStatsModel {
  private collection: Collection<FeatureDailyStats>;

  constructor(db: Db) {
    this.collection = db.collection<FeatureDailyStats>('ai_feature_stats');
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex(
      { updatedAt: 1 },
      { expireAfterSeconds: TTL_DAYS * 24 * 60 * 60, name: 'idx_ttl_updatedAt' },
    );
    await this.collection.createIndex({ date: 1 }, { name: 'idx_date' });
    console.log('[FeatureStatsModel] Indexes created successfully');
  }

  private static getDateKey(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private docId(feature: string): string {
    return `${FeatureStatsModel.getDateKey()}:${feature}`;
  }

  /** Record that a feature ran (regardless of outcome). Best-effort. */
  async recordAttempt(feature: string): Promise<void> {
    const date = FeatureStatsModel.getDateKey();
    await this.collection.updateOne(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { _id: this.docId(feature) } as any,
      {
        $inc: { attemptCount: 1 },
        $set: { date, feature, updatedAt: new Date() },
        $setOnInsert: { successCount: 0, lastSuccessAt: null },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      { upsert: true },
    );
  }

  /** Record that a feature produced a valid result. Best-effort. */
  async recordSuccess(feature: string): Promise<void> {
    const date = FeatureStatsModel.getDateKey();
    const now = new Date();
    await this.collection.updateOne(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { _id: this.docId(feature) } as any,
      {
        $inc: { successCount: 1 },
        $set: { date, feature, lastSuccessAt: now, updatedAt: now },
        $setOnInsert: { attemptCount: 0 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      { upsert: true },
    );
  }

  /** Today's per-feature counters, one entry per feature seen today. */
  async getStats24h(): Promise<FeatureStats24h[]> {
    const today = FeatureStatsModel.getDateKey();
    const docs = await this.collection.find({ date: today }).toArray();
    return docs.map((doc) => ({
      feature: doc.feature,
      attempts: doc.attemptCount || 0,
      successes: doc.successCount || 0,
      lastSuccessAt: doc.lastSuccessAt || null,
    }));
  }

  /**
   * 近 N 天（含今天）的按日计数。
   *
   * 心跳每 24 小时触发一次，只带"今天"的快照会系统性丢失上次心跳之后到
   * 当天结束之间的计数；带上最近两天，让平台按 (date, feature) 取最大值
   * 累计，即可得到完整的按日用量。
   */
  async getStatsRecentDays(days: number): Promise<FeatureStatsDaily[]> {
    const dates: string[] = [];
    const now = Date.now();
    for (let i = 0; i < days; i++) {
      dates.push(new Date(now - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
    }
    const docs = await this.collection.find({ date: { $in: dates } }).toArray();
    return docs.map((doc) => ({
      date: doc.date,
      feature: doc.feature,
      attempts: doc.attemptCount || 0,
      successes: doc.successCount || 0,
      lastSuccessAt: doc.lastSuccessAt || null,
    }));
  }
}
