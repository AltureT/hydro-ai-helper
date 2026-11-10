"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ObjectId = void 0;
exports.unwrapModifyResult = unwrapModifyResult;
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
//# sourceMappingURL=mongo.js.map