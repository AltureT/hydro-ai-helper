"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StudentSummaryModel = void 0;
class StudentSummaryModel {
    constructor(db) {
        this.collection = db.collection('ai_student_summaries');
    }
    async ensureIndexes() {
        await this.collection.createIndex({ jobId: 1, userId: 1 }, { unique: true, name: 'idx_jobId_userId_unique' });
        await this.collection.createIndex({ domainId: 1, contestId: 1, userId: 1 }, { name: 'idx_domainId_contestId_userId' });
        console.log('[StudentSummaryModel] Indexes created successfully');
    }
    async createBatch(jobId, domainId, contestId, userIds) {
        await this.createBatchSafe(jobId, domainId, contestId, userIds);
    }
    async findByJobAndUser(jobId, userId) {
        return this.collection.findOne({ jobId, userId });
    }
    async findAllByJob(jobId) {
        return this.collection.find({ jobId }).sort({ userId: 1 }).toArray();
    }
    async findPublishedForStudent(domainId, contestId, userId) {
        return this.collection.findOne({
            domainId,
            contestId,
            userId,
            publishStatus: 'published',
            status: 'completed',
        });
    }
    async markGenerating(id) {
        await this.collection.updateOne({ _id: id }, { $set: { status: 'generating', updatedAt: new Date() } });
    }
    async completeSummary(id, summary, problemSnapshots, tokenUsage) {
        await this.collection.updateOne({ _id: id }, {
            $set: {
                status: 'completed',
                summary,
                originalSummary: summary,
                problemSnapshots,
                tokenUsage,
                updatedAt: new Date(),
            },
        });
    }
    async markFailed(id, error) {
        await this.collection.updateOne({ _id: id }, { $set: { status: 'failed', error, updatedAt: new Date() } });
    }
    async resetToPending(id) {
        await this.collection.updateOne({ _id: id }, { $set: { status: 'pending', error: null, updatedAt: new Date() } });
    }
    async resetFailedToPending(jobId) {
        const result = await this.collection.updateMany({ jobId, status: 'failed' }, { $set: { status: 'pending', error: null, updatedAt: new Date() } });
        return result.modifiedCount;
    }
    async editSummary(id, summary) {
        await this.collection.updateOne({ _id: id }, { $set: { summary, updatedAt: new Date() } });
    }
    async publishAll(jobId) {
        const result = await this.collection.updateMany({ jobId, status: 'completed', publishStatus: 'draft' }, { $set: { publishStatus: 'published', updatedAt: new Date() } });
        return result.modifiedCount;
    }
    async publishOne(id) {
        await this.collection.updateOne({ _id: id }, { $set: { publishStatus: 'published', updatedAt: new Date() } });
    }
    async deleteSummary(id) {
        await this.collection.updateOne({ _id: id }, {
            $set: {
                summary: null,
                status: 'pending',
                publishStatus: 'draft',
                updatedAt: new Date(),
            },
        });
    }
    async findPendingByJob(jobId) {
        return this.collection.find({ jobId, status: 'pending' }).sort({ userId: 1 }).toArray();
    }
    async resetGeneratingToPending(jobId) {
        const result = await this.collection.updateMany({ jobId, status: 'generating' }, { $set: { status: 'pending', updatedAt: new Date() } });
        return result.modifiedCount;
    }
    async hasEditedSummaries(jobId) {
        const doc = await this.collection.findOne({
            jobId,
            $expr: { $ne: ['$summary', '$originalSummary'] },
        });
        return doc !== null;
    }
    async createBatchSafe(jobId, domainId, contestId, userIds) {
        if (userIds.length === 0)
            return 0;
        const now = new Date();
        const docs = userIds.map((userId) => ({
            jobId,
            domainId,
            contestId,
            userId,
            status: 'pending',
            publishStatus: 'draft',
            summary: null,
            originalSummary: null,
            problemSnapshots: [],
            tokenUsage: { prompt: 0, completion: 0 },
            error: null,
            createdAt: now,
            updatedAt: now,
        }));
        try {
            const result = await this.collection.insertMany(docs, { ordered: false });
            return result.insertedCount;
        }
        catch (err) {
            if (err.code === 11000 || err.writeErrors) {
                return err.result?.insertedCount ?? 0;
            }
            throw err;
        }
    }
    async findUserIdsByJob(jobId) {
        const docs = await this.collection
            .find({ jobId }, { projection: { userId: 1 } })
            .toArray();
        return docs.map((d) => d.userId);
    }
}
exports.StudentSummaryModel = StudentSummaryModel;
//# sourceMappingURL=studentSummary.js.map