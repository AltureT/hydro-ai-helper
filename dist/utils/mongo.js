"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ObjectId = void 0;
exports.unwrapModifyResult = unwrapModifyResult;
exports.createIndexReusingExisting = createIndexReusingExisting;
/**
 * MongoDB helpers
 *
 * Use the same mongodb/bson version that HydroOJ runtime is using to avoid
 * BSON major-version mismatches when converting ids.
 */
const module_1 = require("module");
// Resolve modules relative to the HydroOJ installation (the host runtime),
// so we always share the same mongodb / bson implementation.
const requireFromHydro = (0, module_1.createRequire)(require.resolve('hydrooj'));
const mongodb = requireFromHydro('mongodb');
exports.ObjectId = mongodb.ObjectId;
/**
 * findOneAndUpdate 的返回值在 mongodb 5（Hydro 4）中是 ModifyResult `{ ok, value, lastErrorObject }`，
 * 在 mongodb 6（Hydro 5）中直接是文档或 null。统一取出文档。
 */
function unwrapModifyResult(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const maybe = raw;
    if ('value' in maybe && ('ok' in maybe || 'lastErrorObject' in maybe)) {
        return (maybe.value ?? null);
    }
    return raw;
}
/** MongoDB IndexOptionsConflict：同样的键已有其他名字或其他选项的索引 */
const INDEX_OPTIONS_CONFLICT = 85;
/**
 * 创建索引。同样的键已有一个名字不同的索引时（旧版本遗留，MongoDB 报 85），沿用已有索引并继续，
 * 避免一个冲突让同一集合后面的索引都没有建。其他错误照常抛出。
 */
async function createIndexReusingExisting(collection, keys, options) {
    try {
        await collection.createIndex(keys, options);
    }
    catch (err) {
        if (err?.code !== INDEX_OPTIONS_CONFLICT)
            throw err;
        console.warn(`[AI-Helper] 索引 ${options.name} 未创建，已有等价的索引：${err instanceof Error ? err.message : String(err)}`);
    }
}
//# sourceMappingURL=mongo.js.map