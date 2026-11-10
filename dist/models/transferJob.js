"use strict";
/**
 * TransferJob Model - 跨域转移的执行计划与逐步结果（US9，plan R17）
 *
 * 审计记录面向阅读（字符串会被脱敏截断），继续执行和撤销需要原样的计划与结果，
 * 因此单独保存在 ai_transfer_jobs 中；_id 与对应的审计记录相同，保留期一致（180 天）。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TransferJobModel = void 0;
const auditLog_1 = require("./auditLog");
const mongo_1 = require("../utils/mongo");
class TransferJobModel {
    constructor(db) {
        this.collection = db.collection('ai_transfer_jobs');
    }
    async ensureIndexes() {
        await this.collection.createIndex({ expireAt: 1 }, { name: 'ttl_expireAt', expireAfterSeconds: 0 });
        console.log('[TransferJobModel] Indexes created successfully');
    }
    async create(job, now = new Date()) {
        const doc = {
            ...job,
            prepared: [],
            results: [],
            status: 'running',
            createdAt: now,
            updatedAt: now,
            expireAt: new Date(now.getTime() + auditLog_1.AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000),
        };
        await this.collection.insertOne(doc);
        return doc;
    }
    async get(id) {
        return this.collection.findOne({ _id: id });
    }
    async addPrepared(id, key, data) {
        await this.collection.updateOne({ _id: id }, { $push: { prepared: { key, data } }, $set: { updatedAt: new Date() } });
    }
    async addResult(id, result) {
        await this.collection.updateOne({ _id: id }, { $push: { results: result }, $set: { updatedAt: result.at } });
    }
    async setStatus(id, status, extra = {}) {
        const update = { $set: { status, updatedAt: new Date(), ...extra } };
        if (!extra.failedAt)
            update.$unset = { failedAt: '', error: '' };
        await this.collection.updateOne({ _id: id }, update);
    }
    /** 原子地把“部分完成”改为“执行中”，防止两个请求同时继续执行 */
    async claimResume(id) {
        return (0, mongo_1.unwrapModifyResult)(await this.collection.findOneAndUpdate({ _id: id, status: 'partial' }, { $set: { status: 'running', updatedAt: new Date() } }, { returnDocument: 'after' }));
    }
}
exports.TransferJobModel = TransferJobModel;
//# sourceMappingURL=transferJob.js.map