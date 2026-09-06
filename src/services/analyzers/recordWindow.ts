import { ObjectId, ObjectIdType } from '../../utils/mongo';

/** ObjectId timestamps have second precision. Use a common, frozen cutoff for
 * submissions and messages; the upper bound excludes the not-yet-complete second. */
export function recordWindow(snapshotAt: Date, start?: Date, end?: Date): { $gte?: ObjectIdType; $lt: ObjectIdType } {
  const cutoff = Math.min(snapshotAt.getTime(), end?.getTime() ?? Infinity);
  return {
    ...(start ? { $gte: ObjectId.createFromTime(Math.ceil(start.getTime() / 1000)) } : {}),
    $lt: ObjectId.createFromTime(Math.floor(cutoff / 1000)),
  };
}
