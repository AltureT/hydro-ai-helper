/**
 * TeachingSummary Model - 教学总结数据模型
 *
 * 管理竞赛教学分析总结，提供对学生学习模式的洞察
 */

import type { Db, Collection } from 'mongodb';
import { type ObjectIdType } from '../utils/mongo';
import { ensureObjectId } from '../utils/ensureObjectId';

export type FindingDimension =
  | 'commonError' | 'comprehension' | 'strategy'
  | 'atRisk' | 'difficulty' | 'progress' | 'cognitivePath' | 'aiEffectiveness'
  | 'errorCluster';

export interface TeachingFinding {
  id: string;
  dimension: FindingDimension;
  severity: 'high' | 'medium' | 'low';
  title: string;
  evidence: {
    affectedStudents: number[];
    affectedProblems: number[];
    metrics: Record<string, number>;
    samples?: { code?: string[]; conversations?: string[] };
  };
  needsDeepDive: boolean;
  aiSuggestion?: string;
  aiAnalysis?: string;
}

export interface ErrorCluster {
  signature: string;
  statusLabel: string;
  failingTestIds: (number | string)[];
  normalizedError: string;
  affectedStudentCount: number;
  totalStudents: number;
  ratio: number;
  sampleCode?: string;
}

export interface TeachingSummary {
  _id: ObjectIdType;
  domainId: string;
  contestId: ObjectIdType;
  contestTitle: string;
  contestContent: string;
  teachingFocus?: string;
  createdBy: number;
  createdAt: Date;
  dataSnapshotAt: Date;
  status: 'pending' | 'generating' | 'completed' | 'failed';
  stats: {
    totalStudents: number;
    participatedStudents: number;
    aiUserCount: number;
    problemCount: number;
  };
  findings: TeachingFinding[];
  overallSuggestion: string;
  deepDiveResults: Record<string, string>;
  feedback?: { rating: 'up' | 'down'; comment?: string };
  tokenUsage: { promptTokens: number; completionTokens: number };
  generationTimeMs: number;
}

export class TeachingSummaryModel {
  private collection: Collection<TeachingSummary>;

  constructor(db: Db) {
    this.collection = db.collection<TeachingSummary>('ai_teaching_summaries');
  }

  /**
   * 确保索引已创建
   */
  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex(
      { domainId: 1, createdAt: -1 },
      { name: 'idx_domainId_createdAt' },
    );

    await this.collection.createIndex(
      { domainId: 1, contestId: 1 },
      { name: 'idx_domainId_contestId' },
    );

    console.log('[TeachingSummaryModel] Indexes created successfully');
  }

  /**
   * 创建新的教学总结（初始状态为 pending）
   */
  async create(params: {
    domainId: string;
    contestId: ObjectIdType;
    contestTitle: string;
    contestContent: string;
    teachingFocus?: string;
    createdBy: number;
    dataSnapshotAt: Date;
  }): Promise<ObjectIdType> {
    const doc: Omit<TeachingSummary, '_id'> = {
      domainId: params.domainId,
      contestId: params.contestId,
      contestTitle: params.contestTitle,
      contestContent: params.contestContent,
      teachingFocus: params.teachingFocus,
      createdBy: params.createdBy,
      createdAt: new Date(),
      dataSnapshotAt: params.dataSnapshotAt,
      status: 'pending',
      stats: {
        totalStudents: 0,
        participatedStudents: 0,
        aiUserCount: 0,
        problemCount: 0,
      },
      findings: [],
      overallSuggestion: '',
      deepDiveResults: {},
      tokenUsage: { promptTokens: 0, completionTokens: 0 },
      generationTimeMs: 0,
    };

    const result = await this.collection.insertOne(doc as TeachingSummary);
    return result.insertedId;
  }

  /**
   * 根据 ID 查找教学总结
   */
  async findById(id: string | ObjectIdType): Promise<TeachingSummary | null> {
    const _id = ensureObjectId(id);
    return this.collection.findOne({ _id });
  }

  /**
   * 查找指定域+竞赛的最新教学总结
   */
  async findByContest(
    domainId: string,
    contestId: ObjectIdType,
  ): Promise<TeachingSummary | null> {
    return this.collection.findOne(
      { domainId, contestId },
      { sort: { createdAt: -1 } },
    );
  }

  /**
   * 分页查询指定域的教学总结列表（按创建时间倒序）
   */
  async findByDomain(
    domainId: string,
    page: number,
    limit: number,
  ): Promise<TeachingSummary[]> {
    const skip = (page - 1) * limit;
    return this.collection
      .find({ domainId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();
  }

  /**
   * 更新总结状态
   */
  async updateStatus(
    id: string | ObjectIdType,
    status: TeachingSummary['status'],
  ): Promise<void> {
    const _id = ensureObjectId(id);
    await this.collection.updateOne({ _id }, { $set: { status } });
  }

  /**
   * 保存分析结果并将状态设置为 completed
   */
  async saveResults(
    id: string | ObjectIdType,
    data: {
      stats: TeachingSummary['stats'];
      findings: TeachingFinding[];
      overallSuggestion: string;
      deepDiveResults?: Record<string, string>;
      tokenUsage: TeachingSummary['tokenUsage'];
      generationTimeMs: number;
    },
  ): Promise<void> {
    const _id = ensureObjectId(id);
    await this.collection.updateOne(
      { _id },
      {
        $set: {
          status: 'completed',
          stats: data.stats,
          findings: data.findings,
          overallSuggestion: data.overallSuggestion,
          deepDiveResults: data.deepDiveResults ?? {},
          tokenUsage: data.tokenUsage,
          generationTimeMs: data.generationTimeMs,
        },
      },
    );
  }

  /**
   * 保存教师反馈
   */
  async saveFeedback(
    id: string | ObjectIdType,
    rating: 'up' | 'down',
    comment?: string,
  ): Promise<void> {
    const _id = ensureObjectId(id);
    const feedback: TeachingSummary['feedback'] = { rating };
    if (comment !== undefined) {
      feedback.comment = comment;
    }
    await this.collection.updateOne({ _id }, { $set: { feedback } });
  }

  /**
   * 删除教学总结
   */
  async deleteById(id: string | ObjectIdType): Promise<void> {
    const _id = ensureObjectId(id);
    await this.collection.deleteOne({ _id });
  }
}
