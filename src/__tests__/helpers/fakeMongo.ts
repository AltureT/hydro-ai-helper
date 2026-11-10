/**
 * 极简内存 Mongo 集合，仅覆盖用户管理相关测试用到的查询与更新操作符。
 * 每个方法都是 jest.fn，便于断言调用参数（例如“从不对 uids 使用 $set”）。
 */
import { ObjectId } from 'mongodb';

type Doc = Record<string, any>;

function getPath(doc: Doc, path: string): any {
  return path.split('.').reduce((value, key) => (value == null ? undefined : value[key]), doc as any);
}

function setPath(doc: Doc, path: string, value: any): void {
  const keys = path.split('.');
  let target = doc;
  for (const key of keys.slice(0, -1)) {
    if (target[key] == null || typeof target[key] !== 'object') target[key] = {};
    target = target[key];
  }
  target[keys[keys.length - 1]] = value;
}

function unsetPath(doc: Doc, path: string): void {
  const keys = path.split('.');
  let target = doc;
  for (const key of keys.slice(0, -1)) {
    if (target[key] == null) return;
    target = target[key];
  }
  delete target[keys[keys.length - 1]];
}

function eq(a: any, b: any): boolean {
  if (a instanceof ObjectId || b instanceof ObjectId) return String(a) === String(b);
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

function matchCondition(value: any, cond: any): boolean {
  const isOperatorObject = cond && typeof cond === 'object' && !Array.isArray(cond)
    && !(cond instanceof ObjectId) && !(cond instanceof Date) && !(cond instanceof RegExp)
    && Object.keys(cond).some((key) => key.startsWith('$'));
  if (!isOperatorObject) {
    if (Array.isArray(value)) return value.some((item) => eq(item, cond));
    return eq(value, cond);
  }
  const values = Array.isArray(value) ? value : [value];
  for (const [op, arg] of Object.entries(cond)) {
    switch (op) {
      case '$in':
        if (!values.some((item) => (arg as any[]).some((a) => eq(item, a)))) return false;
        break;
      case '$nin':
        if (values.some((item) => (arg as any[]).some((a) => eq(item, a)))) return false;
        break;
      case '$ne':
        if (arg === null ? value == null : values.some((item) => eq(item, arg))) return false;
        break;
      case '$gt':
        if (!(value > (arg as any))) return false;
        break;
      case '$gte':
        if (!(value >= (arg as any))) return false;
        break;
      case '$lte':
        if (!(value <= (arg as any))) return false;
        break;
      case '$exists':
        if ((value !== undefined) !== arg) return false;
        break;
      case '$bitsAllSet':
        if (typeof value !== 'number' || (value & (arg as number)) !== arg) return false;
        break;
      case '$regex': {
        const re = new RegExp(arg as string, (cond as any).$options || '');
        if (typeof value !== 'string' || !re.test(value)) return false;
        break;
      }
      case '$options':
        break;
      default:
        throw new Error(`fakeMongo: unsupported operator ${op}`);
    }
  }
  return true;
}

export function matches(doc: Doc, filter: Doc = {}): boolean {
  return Object.entries(filter).every(([key, cond]) => matchCondition(getPath(doc, key), cond));
}

function applyUpdate(doc: Doc, update: Doc, inserting: boolean): void {
  for (const [op, fields] of Object.entries(update)) {
    for (const [path, arg] of Object.entries(fields as Doc)) {
      switch (op) {
        case '$set':
          setPath(doc, path, arg);
          break;
        case '$setOnInsert':
          if (inserting) setPath(doc, path, arg);
          break;
        case '$unset':
          unsetPath(doc, path);
          break;
        case '$inc':
          setPath(doc, path, (getPath(doc, path) || 0) + arg);
          break;
        case '$push': {
          const list = getPath(doc, path) || [];
          list.push(arg);
          setPath(doc, path, list);
          break;
        }
        case '$addToSet': {
          const list: any[] = getPath(doc, path) || [];
          const items = arg && typeof arg === 'object' && '$each' in arg ? arg.$each : [arg];
          for (const item of items) if (!list.some((x) => eq(x, item))) list.push(item);
          setPath(doc, path, list);
          break;
        }
        case '$pull': {
          const list: any[] = getPath(doc, path) || [];
          setPath(doc, path, list.filter((item) => !matchCondition(item, arg)));
          break;
        }
        default:
          throw new Error(`fakeMongo: unsupported update ${op}`);
      }
    }
  }
}

function clone<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (value instanceof ObjectId || value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(clone) as unknown as T;
  if (typeof value === 'object') {
    const out: Doc = {};
    for (const [key, item] of Object.entries(value as Doc)) out[key] = clone(item);
    return out as T;
  }
  return value;
}

function equalityFields(filter: Doc): Doc {
  const out: Doc = {};
  for (const [key, value] of Object.entries(filter)) {
    if (key.startsWith('$')) continue;
    if (value && typeof value === 'object' && !(value instanceof ObjectId) && !(value instanceof Date)
      && Object.keys(value).some((k) => k.startsWith('$'))) continue;
    setPath(out, key, clone(value));
  }
  return out;
}

export function createFakeCollection(initial: Doc[] = []) {
  const docs: Doc[] = initial.map(clone);

  const cursorFor = (list: Doc[]) => {
    let result = list;
    const cursor = {
      sort: jest.fn((spec: Doc) => {
        const [[key, dir]] = Object.entries(spec);
        result = [...result].sort((a, b) => (getPath(a, key) > getPath(b, key) ? dir : -dir));
        return cursor;
      }),
      skip: jest.fn((n: number) => { result = result.slice(n); return cursor; }),
      limit: jest.fn((n: number) => { result = result.slice(0, n); return cursor; }),
      project: jest.fn(() => cursor),
      toArray: jest.fn(async () => result.map(clone)),
    };
    return cursor;
  };

  const upsertDoc = (filter: Doc, update: Doc) => {
    const doc: Doc = { ...equalityFields(filter) };
    if (doc._id === undefined) doc._id = new ObjectId();
    applyUpdate(doc, update, true);
    docs.push(doc);
    return doc;
  };

  const collection = {
    docs,
    createIndex: jest.fn(async () => 'ok'),
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    find: jest.fn((filter: Doc = {}, _options?: Doc) => cursorFor(docs.filter((doc) => matches(doc, filter)))),
    findOne: jest.fn(async (filter: Doc = {}) => clone(docs.find((doc) => matches(doc, filter)) ?? null)),
    countDocuments: jest.fn(async (filter: Doc = {}) => docs.filter((doc) => matches(doc, filter)).length),
    insertOne: jest.fn(async (doc: Doc) => {
      const stored = clone(doc);
      if (stored._id === undefined) stored._id = new ObjectId();
      docs.push(stored);
      return { insertedId: stored._id };
    }),
    updateOne: jest.fn(async (filter: Doc, update: Doc, options: Doc = {}) => {
      const doc = docs.find((item) => matches(item, filter));
      if (doc) {
        applyUpdate(doc, update, false);
        return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
      }
      if (options.upsert) {
        upsertDoc(filter, update);
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
      }
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    }),
    findOneAndUpdate: jest.fn(async (filter: Doc, update: Doc, options: Doc = {}) => {
      const doc = docs.find((item) => matches(item, filter));
      if (doc) {
        const before = clone(doc);
        applyUpdate(doc, update, false);
        return options.returnDocument === 'after' ? clone(doc) : before;
      }
      if (options.upsert) {
        const created = upsertDoc(filter, update);
        return options.returnDocument === 'after' ? clone(created) : null;
      }
      return null;
    }),
    findOneAndDelete: jest.fn(async (filter: Doc) => {
      const index = docs.findIndex((item) => matches(item, filter));
      if (index < 0) return null;
      const [removed] = docs.splice(index, 1);
      return removed;
    }),
  };
  return collection;
}

export type FakeCollection = ReturnType<typeof createFakeCollection>;

export function createFakeDb(collections: Record<string, FakeCollection> = {}) {
  const store: Record<string, FakeCollection> = { ...collections };
  return {
    store,
    collection: jest.fn((name: string) => {
      if (!store[name]) store[name] = createFakeCollection();
      return store[name];
    }),
  };
}
