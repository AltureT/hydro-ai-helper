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
