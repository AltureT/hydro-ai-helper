"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ObjectId = void 0;
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
//# sourceMappingURL=mongo.js.map