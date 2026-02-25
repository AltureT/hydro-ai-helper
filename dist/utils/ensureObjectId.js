"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureObjectId = ensureObjectId;
const mongo_1 = require("./mongo");
function ensureObjectId(id) {
    return typeof id === 'string' ? new mongo_1.ObjectId(id) : id;
}
//# sourceMappingURL=ensureObjectId.js.map