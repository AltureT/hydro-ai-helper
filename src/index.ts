/**
 * HydroOJ AI Learning Assistant Plugin
 *
 * 教学优先的 AI 辅助学习插件
 * - 引导式学习，不提供完整代码
 * - 对话记录可追踪
 * - 符合教学研究需求
 */

console.log('[AI-Helper] Loading plugin...');

import path from 'path';
import fs from 'fs';
import yaml from 'js-yaml';
import { Context, definePlugin, Schema, PRIV } from 'hydrooj';
console.log('[AI-Helper] hydrooj imports OK');

import { HelloHandler, HelloHandlerPriv } from './handlers/testHandler';
console.log('[AI-Helper] testHandler OK');

import { ChatHandler, ChatHandlerPriv, ProblemStatusHandler, ProblemStatusHandlerPriv } from './handlers/studentHandler';
console.log('[AI-Helper] studentHandler OK');

import {
  ConversationListHandler,
  ConversationListHandlerPriv,
  ConversationDetailHandler,
  ConversationDetailHandlerPriv
} from './handlers/teacherHandler';
console.log('[AI-Helper] teacherHandler OK');

import { AnalyticsHandler, AnalyticsHandlerPriv, AnalyticsFilterOptionsHandler, AnalyticsFilterOptionsHandlerPriv } from './handlers/analyticsHandler';
console.log('[AI-Helper] analyticsHandler OK');

import {
  AdminConfigHandler,
  AdminConfigHandlerPriv,
  JailbreakLogsHandler,
  JailbreakLogsHandlerPriv,
  JailbreakLogReviewHandler,
  JailbreakLogReviewHandlerPriv,
  JailbreakLogBulkReviewHandler,
  JailbreakLogBulkReviewHandlerPriv,
} from './handlers/adminConfigHandler';
import { TestdataBenchmarkHandler, TestdataBenchmarkHandlerPriv } from './handlers/testdataBenchmarkHandler';
console.log('[AI-Helper] adminConfigHandler OK');

import { AIHelperDashboardHandler, AIHelperDashboardHandlerPriv } from './handlers/dashboardHandler';
console.log('[AI-Helper] dashboardHandler OK');

import { ExportHandler, ExportHandlerPriv } from './handlers/exportHandler';
console.log('[AI-Helper] exportHandler OK');

import { TestConnectionHandler, TestConnectionHandlerPriv, FetchModelsHandler, FetchModelsHandlerPriv } from './handlers/adminHandler';
console.log('[AI-Helper] adminHandler OK');

import { VersionCheckHandler, VersionCheckHandlerPriv } from './handlers/versionHandler';
console.log('[AI-Helper] versionHandler OK');

import { CostAnalyticsHandler, CostAnalyticsHandlerPriv } from './handlers/costAnalyticsHandler';
console.log('[AI-Helper] costAnalyticsHandler OK');

import {
  BatchSummaryGenerateHandler,
  BatchSummaryResultHandler,
  BatchSummaryRetryHandler,
  BatchSummaryPublishHandler,
  BatchSummaryExportHandler,
  BatchSummaryEditHandler,
  BatchSummaryLatestHandler,
  BatchSummaryStopHandler,
  BatchSummaryContinueHandler,
  BatchSummaryRetryFailedHandler,
  StudentSummaryHandler,
} from './handlers/batchSummaryHandler';
console.log('[AI-Helper] batchSummaryHandler OK');

import { FeedbackHandler, FeedbackHandlerPriv } from './handlers/feedbackHandler';
console.log('[AI-Helper] feedbackHandler OK');

import { TeachingSummaryHandler, TeachingReviewHandler, TeachingSummaryFeedbackHandler, TeachingSummaryHandlerPriv } from './handlers/teachingSummaryHandler';
import { TeachingSummaryModel } from './models/teachingSummary';

import { UpdateInfoHandler, UpdateInfoHandlerPriv, UpdateHandler, UpdateHandlerPriv } from './handlers/updateHandler';
console.log('[AI-Helper] updateHandler OK');

import {
  TestdataGenContextHandler,
  TestdataGenGenerateHandler,
  TestdataGenSkeletonHandler,
  TestdataGenApplyHandler,
  TestdataGenHandlerPriv,
} from './handlers/testdataGenHandler';
console.log('[AI-Helper] testdataGenHandler OK');

import { ConversationModel } from './models/conversation';
import { MessageModel } from './models/message';
import { RateLimitRecordModel } from './models/rateLimitRecord';
import { AIConfigModel } from './models/aiConfig';
import { JailbreakLogModel } from './models/jailbreakLog';
import { VersionCacheModel } from './models/versionCache';
import { PluginInstallModel } from './models/pluginInstall';
import { TokenUsageModel } from './models/tokenUsage';
import { BatchSummaryJobModel } from './models/batchSummaryJob';
import { StudentSummaryModel } from './models/studentSummary';
import { StudentHistoryModel } from './models/studentHistory';
console.log('[AI-Helper] models OK');

import { MigrationService } from './services/migrationService';
import { VersionService } from './services/versionService';
import { TelemetryService } from './services/telemetryService';
import { EffectivenessService } from './services/effectivenessService';
import { ErrorReporter } from './services/errorReporter';
import { RequestStatsModel } from './models/requestStats';
import { FeatureStatsModel } from './models/featureStats';
console.log('[AI-Helper] services OK');

console.log('[AI-Helper] All imports completed successfully');

/**
 * 插件配置接口
 */
export interface AIHelperConfig {
  // 未来可在此添加配置项
}

/**
 * 插件入口函数
 * @param ctx HydroOJ Context
 * @param config 插件配置
 */
const configSchema = Schema.object({}).description('AI 助手插件配置（预留）').default({});

const aiHelperPlugin = definePlugin<AIHelperConfig>({
  name: 'hydro-ai-helper',
  schema: configSchema,
  async apply(ctx: Context) {
    // 加载 locale 文件（确保插件翻译注册到 HydroOJ i18n 系统）
    const localesDir = path.resolve(__dirname, '..', 'locales');
    if (fs.existsSync(localesDir)) {
      for (const file of fs.readdirSync(localesDir)) {
        if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
        try {
          const content = fs.readFileSync(path.join(localesDir, file), 'utf-8');
          const dict = yaml.load(content) as Record<string, string>;
          if (dict && typeof dict === 'object') {
            ctx.i18n.load(file.split('.')[0], dict);
          }
        } catch (e) {
          console.warn(`[AI-Helper] Failed to load locale ${file}:`, e);
        }
      }
      console.log('[AI-Helper] Locales loaded');
    }

    // 初始化数据库模型
    const db = ctx.db;
    const conversationModel = new ConversationModel(db);
    const messageModel = new MessageModel(db);
    // @deprecated — 限流已迁移到 HydroOJ 内置 limitRate (opcount)，
    // rateLimitRecordModel 仅保留以防止引用断裂，ai_rate_limit_records 集合通过 TTL 自动清空。
    const rateLimitRecordModel = new RateLimitRecordModel(db);
    const aiConfigModel = new AIConfigModel(db);
    const jailbreakLogModel = new JailbreakLogModel(db);
    const versionCacheModel = new VersionCacheModel(db);
    const pluginInstallModel = new PluginInstallModel(db);
    const tokenUsageModel = new TokenUsageModel(db);
    const requestStatsModel = new RequestStatsModel(db);
    const featureStatsModel = new FeatureStatsModel(db);
    const batchSummaryJobModel = new BatchSummaryJobModel(db);
    const studentSummaryModel = new StudentSummaryModel(db);
    const studentHistoryModel = new StudentHistoryModel(db);
    const teachingSummaryModel = new TeachingSummaryModel(db);

    // ErrorReporter 需要在索引创建之前实例化，以便捕获启动错误
    const errorReporter = new ErrorReporter(pluginInstallModel);

    // 采集运行环境，随错误上报以便面板定位版本相关故障。
    // node 版本同步可得；MongoDB 版本异步 best-effort 查询一次后缓存（buildInfo
    // 无需特殊权限），就绪后回填——错误在 flush 时才附加 env，早期空值会被覆盖。
    errorReporter.setRuntimeEnv({ node_version: process.version });
    (async () => {
      try {
        // ctx.db 是 HydroOJ 的 MongoService 包装器，本身没有 .admin()；底层原生
        // mongodb Db 暴露在 db.db 上（this.db = client.db(...)），用它跑 buildInfo。
        const info = await db.db.admin().command({ buildInfo: 1 });
        if (info && typeof info.version === 'string') {
          errorReporter.setRuntimeEnv({ mongodb_version: info.version });
        }
      } catch (err) {
        console.warn('[AI-Helper] MongoDB buildInfo 查询失败（非致命）:', err instanceof Error ? err.message : String(err));
      }
    })();

    // 创建数据库索引（逐个容错，单个失败不阻塞插件加载）
    const safeEnsureIndexes = async (model: { ensureIndexes(): Promise<void> }, name: string) => {
      try {
        await model.ensureIndexes();
      } catch (err) {
        console.warn(`[AI-Helper] ${name} 索引创建失败，插件继续运行:`, err);
        // Include the underlying error text so the telemetry dashboard shows the
        // real cause (e.g. E11000 / partialFilterExpression unsupported) instead
        // of an opaque "Index creation failed: <name>". Fingerprint is computed
        // from the stack, so a varying message does not fragment error grouping.
        const detail = err instanceof Error ? err.message : String(err);
        errorReporter.capture('startup_failure', 'db', `Index creation failed: ${name}: ${detail}`, undefined, err instanceof Error ? err.stack : undefined);
      }
    };
    await safeEnsureIndexes(conversationModel, 'conversationModel');
    await safeEnsureIndexes(messageModel, 'messageModel');
    await safeEnsureIndexes(rateLimitRecordModel, 'rateLimitRecordModel');
    await safeEnsureIndexes(aiConfigModel, 'aiConfigModel');
    await safeEnsureIndexes(jailbreakLogModel, 'jailbreakLogModel');
    await safeEnsureIndexes(versionCacheModel, 'versionCacheModel');
    await safeEnsureIndexes(pluginInstallModel, 'pluginInstallModel');
    await safeEnsureIndexes(tokenUsageModel, 'tokenUsageModel');
    await safeEnsureIndexes(requestStatsModel, 'requestStatsModel');
    await safeEnsureIndexes(featureStatsModel, 'featureStatsModel');
    await safeEnsureIndexes(batchSummaryJobModel, 'batchSummaryJobModel');
    await safeEnsureIndexes(studentSummaryModel, 'studentSummaryModel');
    await safeEnsureIndexes(studentHistoryModel, 'studentHistoryModel');
    await safeEnsureIndexes(teachingSummaryModel, 'teachingSummaryModel');

    // 执行数据迁移（为历史数据添加 domainId）
    const migrationService = new MigrationService(db);
    await migrationService.runAllMigrations();

    // 历史安全日志没有 expiresAt：从本次升级起按保留期渐进清理，
    // 避免部署时立即删除旧审计记录。新日志则从创建时开始计算保留期。
    try {
      const backfilledExpiryCount = await jailbreakLogModel.backfillExpiry();
      if (backfilledExpiryCount > 0) {
        console.log(`[AI-Helper] Added retention expiry to ${backfilledExpiryCount} legacy safety log(s)`);
      }
    } catch (err) {
      console.warn('[AI-Helper] 安全日志保留期回填失败（非致命）:', err instanceof Error ? err.message : String(err));
      errorReporter.capture(
        'startup_failure',
        'db',
        `Safety log retention backfill failed: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        err instanceof Error ? err.stack : undefined
      );
    }

    // 初始化插件安装记录
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const packageJson = require('../package.json');
    const currentVersion = packageJson.version || '1.8.0';
    await pluginInstallModel.createIfMissing(currentVersion);

    // 密钥轮换：当 OLD_ENCRYPTION_KEY 存在时，自动重加密所有 API Key
    if (process.env.OLD_ENCRYPTION_KEY) {
      try {
        const reEncryptedCount = await aiConfigModel.reEncryptAllKeys();
        if (reEncryptedCount > 0) {
          console.log(`[AI-Helper] Key rotation: re-encrypted ${reEncryptedCount} key(s). You can now remove OLD_ENCRYPTION_KEY.`);
        } else {
          console.log('[AI-Helper] Key rotation: all keys already use current encryption key.');
        }
      } catch (err) {
        console.error('[AI-Helper] Key rotation failed:', err instanceof Error ? err.message : 'unknown error');
        errorReporter.capture('startup_failure', 'config', `Key rotation failed: ${err instanceof Error ? err.message : 'unknown'}`, undefined, err instanceof Error ? err.stack : undefined);
      }
    }

    // 将模型实例注入到 ctx 中,供 Handler 使用
    ctx.provide('conversationModel', conversationModel);
    ctx.provide('messageModel', messageModel);
    ctx.provide('rateLimitRecordModel', rateLimitRecordModel);
    ctx.provide('aiConfigModel', aiConfigModel);
    ctx.provide('jailbreakLogModel', jailbreakLogModel);
    ctx.provide('versionCacheModel', versionCacheModel);
    ctx.provide('pluginInstallModel', pluginInstallModel);
    ctx.provide('tokenUsageModel', tokenUsageModel);
    ctx.provide('requestStatsModel', requestStatsModel);
    ctx.provide('featureStatsModel', featureStatsModel);
    ctx.provide('batchSummaryJobModel', batchSummaryJobModel);
    ctx.provide('studentSummaryModel', studentSummaryModel);
    ctx.provide('studentHistoryModel', studentHistoryModel);
    ctx.provide('teachingSummaryModel', teachingSummaryModel);
    ctx.provide('errorReporter', errorReporter);

    // 初始化版本服务
    const versionService = new VersionService(versionCacheModel);
    ctx.provide('versionService', versionService);

    // 初始化遥测服务（延迟 5 秒启动，避免阻塞插件加载）
    const telemetryService = new TelemetryService(
      pluginInstallModel, conversationModel,
      aiConfigModel, requestStatsModel, errorReporter, featureStatsModel,
    );
    ctx.provide('telemetryService', telemetryService);
    setTimeout(() => {
      telemetryService.init().catch(err => {
        console.error('[AI-Helper] Telemetry service initialization failed:', err);
      });
      errorReporter.start();
    }, 5000);

    // 补偿回填独立延迟启动，避免阻塞遥测初始化
    setTimeout(() => {
      const effectivenessService = new EffectivenessService(ctx);
      effectivenessService.compensateBackfill().catch(err => {
        console.error('[AI-Helper] Effectiveness compensate backfill failed:', err);
      });
    }, 10000);

    // 注册测试路由
    // GET /ai-helper/hello - 返回插件状态
    ctx.Route('ai_helper_hello', '/ai-helper/hello', HelloHandler, HelloHandlerPriv);

    // 注册学生端对话路由 (支持域前缀)
    // POST /ai-helper/chat - 学生提交问题获得 AI 回答
    ctx.Route('ai_helper_chat', '/ai-helper/chat', ChatHandler, ChatHandlerPriv);
    // 域前缀路由: /d/:domainId/ai-helper/chat
    ctx.Route('ai_helper_chat_domain', '/d/:domainId/ai-helper/chat', ChatHandler, ChatHandlerPriv);

    // GET /ai-helper/problem-status/:problemId - 查询用户在该题的提交状态（是否已 AC）
    ctx.Route('ai_helper_problem_status', '/ai-helper/problem-status/:problemId', ProblemStatusHandler, ProblemStatusHandlerPriv);
    ctx.Route('ai_helper_problem_status_domain', '/d/:domainId/ai-helper/problem-status/:problemId', ProblemStatusHandler, ProblemStatusHandlerPriv);

    // 注册教师端路由 (支持域前缀)
    // 当前设计：AI 学习助手对话统计非常敏感，仅允许 root 访问。
    // 注意：这里使用的是 root-only 的系统权限（PRIV.PRIV_EDIT_SYSTEM），普通老师也无权访问。
    // TODO(如需求变更): 未来若有专门的教师统计角色，再考虑降低权限。

    // 注入控制面板菜单项（统一入口）
    ctx.injectUI('ControlPanel', 'ai_helper');

    // AI 助手统一入口路由
    ctx.Route('ai_helper', '/ai-helper', AIHelperDashboardHandler, AIHelperDashboardHandlerPriv);
    ctx.Route('ai_helper_domain', '/d/:domainId/ai-helper', AIHelperDashboardHandler, AIHelperDashboardHandlerPriv);

    // GET /ai-helper/conversations - 获取对话列表
    ctx.Route('ai_helper_conversations', '/ai-helper/conversations', ConversationListHandler, ConversationListHandlerPriv);
    ctx.Route('ai_helper_conversations_domain', '/d/:domainId/ai-helper/conversations', ConversationListHandler, ConversationListHandlerPriv);

    // GET /ai-helper/conversations/:id - 获取对话详情
    ctx.Route('ai_helper_conversation_detail', '/ai-helper/conversations/:id', ConversationDetailHandler, ConversationDetailHandlerPriv);
    ctx.Route('ai_helper_conversation_detail_domain', '/d/:domainId/ai-helper/conversations/:id', ConversationDetailHandler, ConversationDetailHandlerPriv);

    // GET /ai-helper/analytics - AI 使用统计页面
    ctx.Route('ai_helper_analytics', '/ai-helper/analytics', AnalyticsHandler, AnalyticsHandlerPriv);
    ctx.Route('ai_helper_analytics_domain', '/d/:domainId/ai-helper/analytics', AnalyticsHandler, AnalyticsHandlerPriv);

    // GET /ai-helper/analytics/filter-options - 筛选条件可选值（班级/题目自动补全）
    ctx.Route('ai_helper_analytics_filter_options', '/ai-helper/analytics/filter-options', AnalyticsFilterOptionsHandler, AnalyticsFilterOptionsHandlerPriv);
    ctx.Route('ai_helper_analytics_filter_options_domain', '/d/:domainId/ai-helper/analytics/filter-options', AnalyticsFilterOptionsHandler, AnalyticsFilterOptionsHandlerPriv);

    // GET /ai-helper/admin/config - AI 配置页面 & JSON API（通过 Accept 头区分）
    ctx.Route('ai_helper_admin_config', '/ai-helper/admin/config', AdminConfigHandler, AdminConfigHandlerPriv);

    // GET /ai-helper/admin/jailbreak-logs - 越狱日志独立分页端点
    ctx.Route('ai_helper_admin_jailbreak_logs', '/ai-helper/admin/jailbreak-logs', JailbreakLogsHandler, JailbreakLogsHandlerPriv);

    // POST /ai-helper/admin/jailbreak-logs/:id/review - 复核拦截记录
    ctx.Route('ai_helper_admin_jailbreak_logs_bulk_review', '/ai-helper/admin/jailbreak-logs/bulk-review', JailbreakLogBulkReviewHandler, JailbreakLogBulkReviewHandlerPriv);
    ctx.Route('ai_helper_admin_jailbreak_logs_bulk_review_domain', '/d/:domainId/ai-helper/admin/jailbreak-logs/bulk-review', JailbreakLogBulkReviewHandler, JailbreakLogBulkReviewHandlerPriv);
    ctx.Route('ai_helper_admin_jailbreak_log_review', '/ai-helper/admin/jailbreak-logs/:id/review', JailbreakLogReviewHandler, JailbreakLogReviewHandlerPriv);
    ctx.Route('ai_helper_admin_jailbreak_log_review_domain', '/d/:domainId/ai-helper/admin/jailbreak-logs/:id/review', JailbreakLogReviewHandler, JailbreakLogReviewHandlerPriv);

    // POST /ai-helper/admin/testdata-benchmark - 管理员显式确认费用后运行真实模型难题基准
    ctx.Route('ai_helper_admin_testdata_benchmark', '/ai-helper/admin/testdata-benchmark', TestdataBenchmarkHandler, TestdataBenchmarkHandlerPriv);

    // GET /ai-helper/export - 数据导出 API
    ctx.Route('ai_helper_export', '/ai-helper/export', ExportHandler, ExportHandlerPriv);
    ctx.Route('ai_helper_export_domain', '/d/:domainId/ai-helper/export', ExportHandler, ExportHandlerPriv);

    // POST /ai-helper/admin/test-connection - 测试连接
    ctx.Route('ai_helper_admin_test_connection', '/ai-helper/admin/test-connection', TestConnectionHandler, TestConnectionHandlerPriv);

    // POST /ai-helper/admin/fetch-models - 获取可用模型列表
    ctx.Route('ai_helper_admin_fetch_models', '/ai-helper/admin/fetch-models', FetchModelsHandler, FetchModelsHandlerPriv);

    // T052: GET /ai-helper/version/check - 版本检测
    ctx.Route('ai_helper_version_check', '/ai-helper/version/check', VersionCheckHandler, VersionCheckHandlerPriv);
    ctx.Route('ai_helper_version_check_domain', '/d/:domainId/ai-helper/version/check', VersionCheckHandler, VersionCheckHandlerPriv);

    // 插件更新路由
    // GET /ai-helper/admin/update/info - 获取更新信息
    ctx.Route('ai_helper_update_info', '/ai-helper/admin/update/info', UpdateInfoHandler, UpdateInfoHandlerPriv);
    // POST /ai-helper/admin/update - 执行更新
    ctx.Route('ai_helper_update', '/ai-helper/admin/update', UpdateHandler, UpdateHandlerPriv);

    // POST /ai-helper/admin/feedback - 管理员反馈提交
    ctx.Route('ai_helper_admin_feedback', '/ai-helper/admin/feedback', FeedbackHandler, FeedbackHandlerPriv);

    // GET /ai-helper/analytics/cost - 成本分析 API
    ctx.Route('ai_helper_cost_analytics', '/ai-helper/analytics/cost', CostAnalyticsHandler, CostAnalyticsHandlerPriv);
    ctx.Route('ai_helper_cost_analytics_domain', '/d/:domainId/ai-helper/analytics/cost', CostAnalyticsHandler, CostAnalyticsHandlerPriv);

    // 批量摘要路由
    // GET /ai-helper/batch-summaries/latest?contestId=xxx - 查询最新任务
    ctx.Route('ai_batch_summary_latest', '/ai-helper/batch-summaries/latest', BatchSummaryLatestHandler, PRIV.PRIV_READ_RECORD_CODE);
    ctx.Route('ai_batch_summary_latest_domain', '/d/:domainId/ai-helper/batch-summaries/latest', BatchSummaryLatestHandler, PRIV.PRIV_READ_RECORD_CODE);

    // POST /ai-helper/batch-summaries/generate - 触发批量生成
    ctx.Route('ai_batch_summary_generate', '/ai-helper/batch-summaries/generate', BatchSummaryGenerateHandler, PRIV.PRIV_READ_RECORD_CODE);
    ctx.Route('ai_batch_summary_generate_domain', '/d/:domainId/ai-helper/batch-summaries/generate', BatchSummaryGenerateHandler, PRIV.PRIV_READ_RECORD_CODE);

    // GET /ai-helper/batch-summaries/:jobId/result - 查询任务结果
    ctx.Route('ai_batch_summary_result', '/ai-helper/batch-summaries/:jobId/result', BatchSummaryResultHandler, PRIV.PRIV_READ_RECORD_CODE);
    ctx.Route('ai_batch_summary_result_domain', '/d/:domainId/ai-helper/batch-summaries/:jobId/result', BatchSummaryResultHandler, PRIV.PRIV_READ_RECORD_CODE);

    // POST /ai-helper/batch-summaries/:jobId/retry/:userId - 重试失败摘要
    ctx.Route('ai_batch_summary_retry', '/ai-helper/batch-summaries/:jobId/retry/:userId', BatchSummaryRetryHandler, PRIV.PRIV_READ_RECORD_CODE);
    ctx.Route('ai_batch_summary_retry_domain', '/d/:domainId/ai-helper/batch-summaries/:jobId/retry/:userId', BatchSummaryRetryHandler, PRIV.PRIV_READ_RECORD_CODE);

    // POST /ai-helper/batch-summaries/:jobId/publish - 发布摘要
    ctx.Route('ai_batch_summary_publish', '/ai-helper/batch-summaries/:jobId/publish', BatchSummaryPublishHandler, PRIV.PRIV_READ_RECORD_CODE);
    ctx.Route('ai_batch_summary_publish_domain', '/d/:domainId/ai-helper/batch-summaries/:jobId/publish', BatchSummaryPublishHandler, PRIV.PRIV_READ_RECORD_CODE);

    // GET /ai-helper/batch-summaries/:jobId/export - 导出 CSV
    ctx.Route('ai_batch_summary_export', '/ai-helper/batch-summaries/:jobId/export', BatchSummaryExportHandler, PRIV.PRIV_READ_RECORD_CODE);
    ctx.Route('ai_batch_summary_export_domain', '/d/:domainId/ai-helper/batch-summaries/:jobId/export', BatchSummaryExportHandler, PRIV.PRIV_READ_RECORD_CODE);

    // POST /ai-helper/batch-summaries/:jobId/edit/:userId - 编辑摘要
    ctx.Route('ai_batch_summary_edit', '/ai-helper/batch-summaries/:jobId/edit/:userId', BatchSummaryEditHandler, PRIV.PRIV_READ_RECORD_CODE);
    ctx.Route('ai_batch_summary_edit_domain', '/d/:domainId/ai-helper/batch-summaries/:jobId/edit/:userId', BatchSummaryEditHandler, PRIV.PRIV_READ_RECORD_CODE);

    // POST /ai-helper/batch-summaries/:jobId/retry-failed - 批量重试失败
    ctx.Route('ai_batch_summary_retry_failed', '/ai-helper/batch-summaries/:jobId/retry-failed', BatchSummaryRetryFailedHandler, PRIV.PRIV_READ_RECORD_CODE);
    ctx.Route('ai_batch_summary_retry_failed_domain', '/d/:domainId/ai-helper/batch-summaries/:jobId/retry-failed', BatchSummaryRetryFailedHandler, PRIV.PRIV_READ_RECORD_CODE);

    // POST /ai-helper/batch-summaries/:jobId/stop - 停止生成
    ctx.Route('ai_batch_summary_stop', '/ai-helper/batch-summaries/:jobId/stop', BatchSummaryStopHandler, PRIV.PRIV_READ_RECORD_CODE);
    ctx.Route('ai_batch_summary_stop_domain', '/d/:domainId/ai-helper/batch-summaries/:jobId/stop', BatchSummaryStopHandler, PRIV.PRIV_READ_RECORD_CODE);

    // POST /ai-helper/batch-summaries/:jobId/continue - 继续生成
    ctx.Route('ai_batch_summary_continue', '/ai-helper/batch-summaries/:jobId/continue', BatchSummaryContinueHandler, PRIV.PRIV_READ_RECORD_CODE);
    ctx.Route('ai_batch_summary_continue_domain', '/d/:domainId/ai-helper/batch-summaries/:jobId/continue', BatchSummaryContinueHandler, PRIV.PRIV_READ_RECORD_CODE);

    // GET /ai-helper/batch-summaries/my-summary?contestId=xxx - 学生查看自己的已发布总结
    ctx.Route('ai_batch_summary_my', '/ai-helper/batch-summaries/my-summary', StudentSummaryHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('ai_batch_summary_my_domain', '/d/:domainId/ai-helper/batch-summaries/my-summary', StudentSummaryHandler, PRIV.PRIV_USER_PROFILE);

    // 测试数据生成路由（教师/出题人，权限在 Handler 内校验：题目编辑权限）
    // GET /ai-helper/testdata-gen/context/:problemId - 题目上下文
    ctx.Route('ai_testdata_gen_context', '/ai-helper/testdata-gen/context/:problemId', TestdataGenContextHandler, TestdataGenHandlerPriv);
    ctx.Route('ai_testdata_gen_context_domain', '/d/:domainId/ai-helper/testdata-gen/context/:problemId', TestdataGenContextHandler, TestdataGenHandlerPriv);
    // POST /ai-helper/testdata-gen/generate - AI 生成测试数据计划（仅预览）
    ctx.Route('ai_testdata_gen_generate', '/ai-helper/testdata-gen/generate', TestdataGenGenerateHandler, TestdataGenHandlerPriv);
    ctx.Route('ai_testdata_gen_generate_domain', '/d/:domainId/ai-helper/testdata-gen/generate', TestdataGenGenerateHandler, TestdataGenHandlerPriv);
    // POST /ai-helper/testdata-gen/skeleton - 骨架模式（AI 故障降级，不调用 AI）
    ctx.Route('ai_testdata_gen_skeleton', '/ai-helper/testdata-gen/skeleton', TestdataGenSkeletonHandler, TestdataGenHandlerPriv);
    ctx.Route('ai_testdata_gen_skeleton_domain', '/d/:domainId/ai-helper/testdata-gen/skeleton', TestdataGenSkeletonHandler, TestdataGenHandlerPriv);
    // POST /ai-helper/testdata-gen/apply - 确认写入题目测试数据
    ctx.Route('ai_testdata_gen_apply', '/ai-helper/testdata-gen/apply', TestdataGenApplyHandler, TestdataGenHandlerPriv);
    ctx.Route('ai_testdata_gen_apply_domain', '/d/:domainId/ai-helper/testdata-gen/apply', TestdataGenApplyHandler, TestdataGenHandlerPriv);

    // 教学建议路由
    ctx.Route('ai_teaching_summary', '/ai-helper/teaching-summary/:contestId', TeachingSummaryHandler, TeachingSummaryHandlerPriv);
    ctx.Route('ai_teaching_summary_domain', '/d/:domainId/ai-helper/teaching-summary/:contestId', TeachingSummaryHandler, TeachingSummaryHandlerPriv);
    ctx.Route('ai_teaching_review', '/ai-helper/teaching-review', TeachingReviewHandler, TeachingSummaryHandlerPriv);
    ctx.Route('ai_teaching_review_domain', '/d/:domainId/ai-helper/teaching-review', TeachingReviewHandler, TeachingSummaryHandlerPriv);
    ctx.Route('ai_teaching_summary_feedback', '/ai-helper/teaching-summary/:summaryId/feedback', TeachingSummaryFeedbackHandler, TeachingSummaryHandlerPriv);
    ctx.Route('ai_teaching_summary_feedback_domain', '/d/:domainId/ai-helper/teaching-summary/:summaryId/feedback', TeachingSummaryFeedbackHandler, TeachingSummaryHandlerPriv);
  }
});

export const Config = configSchema;
export const apply = aiHelperPlugin.apply;
export default aiHelperPlugin;
