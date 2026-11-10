/**
 * MongoDB helpers
 *
 * Use the same mongodb/bson version that HydroOJ runtime is using to avoid
 * BSON major-version mismatches when converting ids.
 */
import { createRequire } from 'module';
import type { Collection, CreateIndexesOptions, Document, IndexSpecification } from 'mongodb';

// Resolve modules relative to the HydroOJ installation (the host runtime),
// so we always share the same mongodb / bson implementation.
const requireFromHydro = createRequire(require.resolve('hydrooj'));
const mongodb = requireFromHydro('mongodb') as typeof import('mongodb');

export const ObjectId = mongodb.ObjectId;
export type ObjectIdType = import('mongodb').ObjectId;

/**
 * findOneAndUpdate 的返回值在 mongodb 5（Hydro 4）中是 ModifyResult `{ ok, value, lastErrorObject }`，
 * 在 mongodb 6（Hydro 5）中直接是文档或 null。统一取出文档。
 */
export function unwrapModifyResult<T>(raw: unknown): T | null {
  if (!raw || typeof raw !== 'object') return null;
  const maybe = raw as { ok?: unknown; value?: unknown; lastErrorObject?: unknown };
  if ('value' in maybe && ('ok' in maybe || 'lastErrorObject' in maybe)) {
    return (maybe.value ?? null) as T | null;
  }
  return raw as T;
}

/** MongoDB IndexOptionsConflict：同样的键已有其他名字或其他选项的索引 */
const INDEX_OPTIONS_CONFLICT = 85;

/**
 * 创建索引。同样的键已有一个名字不同的索引时（旧版本遗留，MongoDB 报 85），沿用已有索引并继续，
 * 避免一个冲突让同一集合后面的索引都没有建。其他错误照常抛出。
 */
export async function createIndexReusingExisting<T extends Document>(
  collection: Pick<Collection<T>, 'createIndex'>,
  keys: IndexSpecification,
  options: CreateIndexesOptions & { name: string },
): Promise<void> {
  try {
    await collection.createIndex(keys, options);
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== INDEX_OPTIONS_CONFLICT) throw err;
    console.warn(`[AI-Helper] 索引 ${options.name} 未创建，已有等价的索引：${err instanceof Error ? err.message : String(err)}`);
  }
}
