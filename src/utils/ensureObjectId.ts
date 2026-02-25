import { ObjectId, type ObjectIdType } from './mongo';

export function ensureObjectId(id: string | ObjectIdType): ObjectIdType {
  return typeof id === 'string' ? new ObjectId(id) : id;
}
