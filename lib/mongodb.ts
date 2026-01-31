import { Db, MongoClient } from 'mongodb';

const DEFAULT_DB_NAME = 'hydro_ai_stats';
const PLUGIN_STATS_COLLECTION = 'plugin_stats';
const TTL_DAYS = 90;
const TTL_SECONDS = 60 * 60 * 24 * TTL_DAYS;

type GlobalWithMongo = typeof globalThis & {
  __mongoClientPromise?: Promise<MongoClient>;
  __pluginStatsIndexesEnsured?: boolean;
};

const globalWithMongo = globalThis as GlobalWithMongo;

function getMongoUri(): string {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is not set');
  }
  return uri;
}

function getDbName(): string {
  return process.env.MONGODB_DB || DEFAULT_DB_NAME;
}

// Reuse a single MongoClient across lambda invocations and hot reloads.
async function getMongoClient(): Promise<MongoClient> {
  if (!globalWithMongo.__mongoClientPromise) {
    const client = new MongoClient(getMongoUri(), {
      maxPoolSize: 10,
      minPoolSize: 0
    });
    globalWithMongo.__mongoClientPromise = client.connect();
  }
  return globalWithMongo.__mongoClientPromise;
}

export async function getDb(): Promise<Db> {
  const client = await getMongoClient();
  return client.db(getDbName());
}

export async function ensurePluginStatsIndexes(db: Db): Promise<void> {
  if (globalWithMongo.__pluginStatsIndexesEnsured) {
    return;
  }

  const collection = db.collection(PLUGIN_STATS_COLLECTION);

  // TTL index to expire instances after 90 days without reports.
  await collection.createIndex(
    { lastReportAt: 1 },
    { expireAfterSeconds: TTL_SECONDS, name: 'lastReportAt_ttl_90d' }
  );

  globalWithMongo.__pluginStatsIndexesEnsured = true;
}

export { PLUGIN_STATS_COLLECTION, TTL_SECONDS };
