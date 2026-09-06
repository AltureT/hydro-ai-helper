"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordWindow = recordWindow;
const mongo_1 = require("../../utils/mongo");
/** ObjectId timestamps have second precision. Use a common, frozen cutoff for
 * submissions and messages; the upper bound excludes the not-yet-complete second. */
function recordWindow(snapshotAt, start, end) {
    const cutoff = Math.min(snapshotAt.getTime(), end?.getTime() ?? Infinity);
    return {
        ...(start ? { $gte: mongo_1.ObjectId.createFromTime(Math.ceil(start.getTime() / 1000)) } : {}),
        $lt: mongo_1.ObjectId.createFromTime(Math.floor(cutoff / 1000)),
    };
}
//# sourceMappingURL=recordWindow.js.map