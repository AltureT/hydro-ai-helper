/**
 * MongoDB helpers
 *
 * Use the same mongodb/bson version that HydroOJ runtime is using to avoid
 * BSON major-version mismatches when converting ids.
 */
import { createRequire } from 'module';

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
