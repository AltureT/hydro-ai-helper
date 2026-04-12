"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StudentHistoryModel = void 0;
const ensureObjectId_1 = require("../utils/ensureObjectId");
class StudentHistoryModel {
    constructor(db) {
        this.collection = db.collection('ai_student_history');
    }
    async ensureIndexes() {
        await this.collection.createIndex({ domainId: 1, userId: 1, createdAt: -1 }, { name: 'idx_domainId_userId_createdAt' });
        await this.collection.createIndex({ jobId: 1, userId: 1 }, { unique: true, name: 'idx_jobId_userId_unique' });
        console.log('[StudentHistoryModel] Indexes created successfully');
    }
    async create(record) {
        await this.collection.insertOne(record);
    }
    async findRecent(domainId, userId, limit = 3) {
        return this.collection
            .find({ domainId, userId })
            .sort({ createdAt: -1 })
            .limit(limit)
            .toArray();
    }
    async findByJobAndUser(jobId, userId) {
        const _jobId = (0, ensureObjectId_1.ensureObjectId)(jobId);
        return this.collection.findOne({ jobId: _jobId, userId });
    }
}
exports.StudentHistoryModel = StudentHistoryModel;
//# sourceMappingURL=studentHistory.js.map