"use strict";
/**
 * Persistent test-data generation jobs. Results can contain a full reference
 * solution, so handlers must also enforce creator and problem-edit access.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TestdataGenerationJobModel = exports.TESTDATA_JOB_LEASE_MS = exports.TESTDATA_JOB_RETENTION_MS = void 0;
const ensureObjectId_1 = require("../utils/ensureObjectId");
exports.TESTDATA_JOB_RETENTION_MS = 24 * 60 * 60 * 1000;
exports.TESTDATA_JOB_LEASE_MS = 90 * 1000;
const interruptedError = {
    message: '生成服务在任务执行期间重启或失去连接，请重新生成。',
    code: 'WORKER_INTERRUPTED',
    retryable: true,
};
class TestdataGenerationJobModel {
    constructor(db) {
        this.collection = db.collection('ai_testdata_generation_jobs');
    }
    async ensureIndexes() {
        await this.collection.createIndex({ domainId: 1, problemDocId: 1, createdBy: 1 }, {
            name: 'idx_testdata_job_one_active',
            unique: true,
            partialFilterExpression: { active: true },
        });
        await this.collection.createIndex({ expiresAt: 1 }, { name: 'idx_testdata_job_expiry', expireAfterSeconds: 0 });
        await this.collection.createIndex({ domainId: 1, problemDocId: 1, createdBy: 1, restorable: 1, createdAt: -1 }, { name: 'idx_testdata_job_restore' });
    }
    scope(params) {
        return {
            domainId: params.domainId,
            problemDocId: params.problemDocId,
            createdBy: params.createdBy,
        };
    }
    async createOrGetActive(params) {
        const scope = this.scope(params);
        const now = new Date();
        await this.collection.updateMany({ ...scope, active: true, leaseExpiresAt: { $lte: now } }, {
            $set: {
                status: 'interrupted', active: false, restorable: false,
                updatedAt: now, completedAt: now, error: interruptedError,
            },
        });
        const active = await this.collection.findOne({ ...scope, active: true });
        if (active)
            return { job: active, created: false };
        await this.collection.updateMany({ ...scope, active: false, restorable: true }, { $set: { restorable: false, updatedAt: now } });
        const doc = {
            ...params,
            status: 'pending',
            active: true,
            restorable: true,
            cancelRequested: false,
            progress: { stage: 'preparing', percent: 2, attempt: 1 },
            createdAt: now,
            startedAt: null,
            updatedAt: now,
            progressUpdatedAt: now,
            completedAt: null,
            leaseExpiresAt: new Date(now.getTime() + exports.TESTDATA_JOB_LEASE_MS),
            expiresAt: new Date(now.getTime() + exports.TESTDATA_JOB_RETENTION_MS),
        };
        try {
            const result = await this.collection.insertOne(doc);
            return { job: { ...doc, _id: result.insertedId }, created: true };
        }
        catch (err) {
            if (err?.code !== 11000)
                throw err;
            const concurrent = await this.collection.findOne({ ...scope, active: true });
            if (!concurrent)
                throw err;
            return { job: concurrent, created: false };
        }
    }
    async findById(id) {
        return this.collection.findOne({ _id: (0, ensureObjectId_1.ensureObjectId)(id) });
    }
    async findRestorable(domainId, problemDocId, createdBy) {
        return this.collection.findOne({ domainId, problemDocId, createdBy, restorable: true }, { sort: { createdAt: -1 } });
    }
    async markRunning(id) {
        const now = new Date();
        await this.collection.updateOne({ _id: (0, ensureObjectId_1.ensureObjectId)(id), status: 'pending', active: true }, { $set: {
                status: 'running', startedAt: now, updatedAt: now,
                leaseExpiresAt: new Date(now.getTime() + exports.TESTDATA_JOB_LEASE_MS),
            } });
    }
    async updateProgress(id, progress) {
        const now = new Date();
        await this.collection.updateOne({ _id: (0, ensureObjectId_1.ensureObjectId)(id), active: true }, { $set: {
                progress, progressUpdatedAt: now, updatedAt: now,
                leaseExpiresAt: new Date(now.getTime() + exports.TESTDATA_JOB_LEASE_MS),
            } });
    }
    async renewLease(id) {
        const now = new Date();
        const result = await this.collection.updateOne({ _id: (0, ensureObjectId_1.ensureObjectId)(id), active: true, cancelRequested: false }, { $set: { updatedAt: now, leaseExpiresAt: new Date(now.getTime() + exports.TESTDATA_JOB_LEASE_MS) } });
        return result.modifiedCount > 0;
    }
    async complete(id, plan) {
        const now = new Date();
        const result = await this.collection.updateOne({ _id: (0, ensureObjectId_1.ensureObjectId)(id), active: true, cancelRequested: false }, { $set: {
                status: 'completed', active: false, restorable: true,
                progress: {
                    stage: 'complete', percent: 100,
                    attempt: plan.verification?.modelEscalation ? 2 : 1,
                },
                progressUpdatedAt: now, plan, updatedAt: now, completedAt: now,
            } });
        return result.modifiedCount > 0;
    }
    async fail(id, error, status = 'failed') {
        const now = new Date();
        await this.collection.updateOne({ _id: (0, ensureObjectId_1.ensureObjectId)(id), active: true }, { $set: {
                status, active: false, restorable: false, error,
                updatedAt: now, completedAt: now,
            } });
    }
    async cancel(id) {
        const now = new Date();
        await this.collection.updateOne({ _id: (0, ensureObjectId_1.ensureObjectId)(id), status: { $in: ['pending', 'running'] } }, { $set: {
                status: 'canceled', active: false, restorable: false,
                cancelRequested: true, updatedAt: now, completedAt: now,
            } });
    }
    async dismiss(id) {
        await this.collection.updateOne({ _id: (0, ensureObjectId_1.ensureObjectId)(id), active: false }, { $set: { restorable: false, updatedAt: new Date() } });
    }
    async markApplied(id) {
        await this.dismiss(id);
    }
    async markExpiredLeaseInterrupted(id) {
        const now = new Date();
        const result = await this.collection.updateOne({ _id: (0, ensureObjectId_1.ensureObjectId)(id), active: true, leaseExpiresAt: { $lte: now } }, { $set: {
                status: 'interrupted', active: false, restorable: false,
                updatedAt: now, completedAt: now, error: interruptedError,
            } });
        return result.modifiedCount > 0;
    }
    async markAllExpiredLeasesInterrupted() {
        const now = new Date();
        const result = await this.collection.updateMany({ active: true, leaseExpiresAt: { $lte: now } }, { $set: {
                status: 'interrupted', active: false, restorable: false,
                updatedAt: now, completedAt: now, error: interruptedError,
            } });
        return result.modifiedCount;
    }
}
exports.TestdataGenerationJobModel = TestdataGenerationJobModel;
//# sourceMappingURL=testdataGenerationJob.js.map