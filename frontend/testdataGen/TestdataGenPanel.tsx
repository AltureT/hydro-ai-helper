/**
 * TestdataGenPanel - AI 生成测试数据面板
 *
 * 嵌入题目文件页（/p/:pid/files），面向教师/出题人：
 * 填写生成选项 → AI 根据题面生成文件计划 → 预览/编辑 → 确认写入题目测试数据。
 * 后端在写入 config.yaml 后由 HydroOJ 自动同步评测设置。
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { i18n } from '../utils/i18n';
import { buildApiUrl } from '../utils/domainUtils';
import {
  COLORS, SPACING, RADIUS, TYPOGRAPHY,
  getButtonStyle, getInputStyle, getAlertStyle, getBadgeStyle,
} from '../utils/styles';

// ─── 类型 ─────────────────────────────────────────────────────────────────────

interface ProblemContext {
  problem: {
    docId: number;
    pid: string;
    title: string;
    statementPreview: string;
    hasStatement: boolean;
    fillInDetected?: boolean;
  };
  existingFiles: string[];
  acceptedSolutions?: Array<{
    recordId: string;
    lang: string;
    submittedAt: string;
    isOwn: boolean;
  }>;
  limits: { minCases: number; maxCases: number; maxExtraRequirements: number; maxProvidedStd?: number };
  restorableJob?: BackgroundGenerationJob;
}

interface PlannedFile {
  name: string;
  content: string;
  kind: 'case-in' | 'case-out' | 'template' | 'compile' | 'config' | 'std' | 'generator' | 'brute' | 'validator';
  origin?: 'executed' | 'deterministic' | 'ai-only';
}

interface PlanVerification {
  mode: 'sandbox' | 'direct';
  oracleKind: 'provided-std' | 'accepted-record' | 'ai-solution';
  modelEscalation?: { fromModel: string; toModel: string };
  sampleCheck?: { total: number; passed: number };
  bruteCheck?: { compared: number; agreed: number; skippedTimeout: number[]; disagreed: number[] };
  stressCheck?: {
    generated: number;
    uniqueInputs?: number;
    duplicateInputs?: number;
    compared: number;
    agreed: number;
    skippedReason?: 'custom-checker';
  };
  validator?: { ran: boolean; casesChecked: number };
  templateCheck?: { lang: 'py'; total: number; passed: number; skippedTimeout: number[] };
  discrimination?: {
    targets: Array<{
      kind: 'boundary' | 'wrong-algorithm' | 'overflow-sim' | 'brute-complexity';
      description: string;
      killed: boolean;
      killedBy?: 'wa' | 'tle';
      killedByCase?: number;
      skippedReason?: 'custom-checker' | 'budget-exhausted' | 'no-targets';
    }>;
    allKilled: boolean;
  };
}

interface GenerationPlan {
  problemType: 'function' | 'traditional';
  isFillIn?: boolean;
  analysis?: string;
  notes?: string;
  files: PlannedFile[];
  caseCount: number;
  totalCaseCount?: number;
  caseCoverage?: Array<{
    caseNumber: number;
    fileNumber: number;
    dataScale: 'small' | 'medium' | 'large';
    target: string;
  }>;
  usedModel?: string;
  verification?: PlanVerification;
}

type BackgroundGenerationJobStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'interrupted';

interface BackgroundGenerationJob {
  id: string;
  problemId: string;
  problemTitle: string;
  status: BackgroundGenerationJobStatus;
  progress: GenerationProgressEvent;
  error?: {
    message: string;
    code: string;
    category?: string;
    retryable: boolean;
    recommendDeeperReasoning?: boolean;
  };
  plan?: GenerationPlan;
  createdAt: string;
  startedAt?: string | null;
  updatedAt: string;
  progressUpdatedAt: string;
  completedAt?: string | null;
}

type GenerationProgressStage =
  | 'preparing'
  | 'sandbox_check'
  | 'blueprint'
  | 'blueprint_repair'
  | 'solution_verification'
  | 'artifacts'
  | 'templates'
  | 'independent_verifier'
  | 'verifier_repair'
  | 'generating_inputs'
  | 'validating_inputs'
  | 'running_oracle'
  | 'checking_templates'
  | 'stress_testing'
  | 'pipeline_repair'
  | 'model_fallback'
  | 'model_escalation'
  | 'assembling'
  | 'complete';

interface GenerationProgressEvent {
  stage: GenerationProgressStage;
  percent: number;
  attempt: number;
}

type PanelPhase = 'form' | 'generating' | 'preview' | 'applying' | 'applied';

interface TestdataGenPanelProps {
  problemId: string;
}

const TEMPLATE_LANG_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'py', label: 'Python' },
  { value: 'java', label: 'Java' },
  { value: 'cc', label: 'C++' },
];

const KIND_BADGE_KEYS: Record<string, string> = {
  'case-in': 'ai_helper_testdata_kind_case',
  'case-out': 'ai_helper_testdata_kind_case',
  template: 'ai_helper_testdata_kind_template',
  compile: 'ai_helper_testdata_kind_compile',
  config: 'ai_helper_testdata_kind_config',
  std: 'ai_helper_testdata_kind_std',
  generator: 'ai_helper_testdata_kind_generator',
  brute: 'ai_helper_testdata_kind_generator',
  validator: 'ai_helper_testdata_kind_generator',
};

const ORIGIN_BADGE_KEYS: Record<string, string> = {
  executed: 'ai_helper_testdata_badge_executed',
  'ai-only': 'ai_helper_testdata_badge_ai_only',
  deterministic: 'ai_helper_testdata_badge_deterministic',
};

const GENERATION_STAGE_GROUPS: Array<{
  key: string;
  stages: GenerationProgressStage[];
}> = [
  {
    key: 'understand',
    stages: ['preparing', 'sandbox_check', 'blueprint', 'blueprint_repair', 'solution_verification', 'model_fallback'],
  },
  {
    key: 'components',
    stages: ['artifacts', 'templates', 'independent_verifier', 'verifier_repair'],
  },
  { key: 'inputs', stages: ['generating_inputs', 'validating_inputs'] },
  {
    key: 'verify',
    stages: ['running_oracle', 'checking_templates', 'stress_testing', 'pipeline_repair', 'model_escalation'],
  },
  { key: 'finish', stages: ['assembling', 'complete'] },
];

function getGenerationStageGroupIndex(stage: GenerationProgressStage): number {
  const index = GENERATION_STAGE_GROUPS.findIndex(group => group.stages.includes(stage));
  return index >= 0 ? index : 0;
}

const JOB_POLL_INTERVAL_MS = 2_000;

// deterministic 用中性灰：getBadgeStyle 无 neutral 变体，借 info 外形覆盖配色
const getOriginBadgeStyle = (origin: string): React.CSSProperties => {
  if (origin === 'executed') return getBadgeStyle('success');
  if (origin === 'ai-only') return getBadgeStyle('warning');
  return {
    ...getBadgeStyle('info'),
    color: COLORS.textMuted,
    backgroundColor: COLORS.bgHover,
    border: `1px solid ${COLORS.border}`,
  };
};

const MONO_FONT = "'SFMono-Regular', 'Menlo', 'Consolas', 'Liberation Mono', monospace";

interface ApiErrorDetails {
  message: string;
  recommendDeeperReasoning: boolean;
}

class TestdataRequestError extends Error {
  constructor(message: string, readonly recommendDeeperReasoning = false) {
    super(message);
    this.name = 'TestdataRequestError';
  }
}

async function parseErrorDetails(response: Response): Promise<ApiErrorDetails> {
  try {
    const data = await response.json();
    if (data?.error) {
      return {
        message: String(data.error),
        recommendDeeperReasoning: data.recommendDeeperReasoning === true,
      };
    }
  } catch { /* ignore */ }
  return { message: `HTTP ${response.status}`, recommendDeeperReasoning: false };
}

// ─── 组件 ─────────────────────────────────────────────────────────────────────

export const TestdataGenPanel: React.FC<TestdataGenPanelProps> = ({ problemId }) => {
  const [context, setContext] = useState<ProblemContext | null>(null);
  // 'denied' = 403 无权限（静默隐藏）；字符串 = 其他加载失败原因（显示错误卡，
  // 避免插件未加载/后端异常时面板"静默消失"无从排查）
  const [contextError, setContextError] = useState<'denied' | string | null>(null);
  const [contextReloadKey, setContextReloadKey] = useState(0);
  const [collapsed, setCollapsed] = useState(true);
  const [phase, setPhase] = useState<PanelPhase>('form');
  const [error, setError] = useState<string | null>(null);
  // 生成请求真正失败（AI 故障/超时）时提示骨架降级；本地校验错误不提示
  const [showFallbackHint, setShowFallbackHint] = useState(false);
  // 仅后端确认“自动修复后仍未通过解析/机器验证”时提示换用更深思考模型。
  const [showDeeperReasoningHint, setShowDeeperReasoningHint] = useState(false);
  const [generationProgress, setGenerationProgress] = useState<GenerationProgressEvent>({
    stage: 'preparing', percent: 2, attempt: 1,
  });
  const [generationElapsedSeconds, setGenerationElapsedSeconds] = useState(0);
  const [generationIdleSeconds, setGenerationIdleSeconds] = useState(0);
  const [generationHeartbeatSeconds, setGenerationHeartbeatSeconds] = useState(0);
  const [generationCanceling, setGenerationCanceling] = useState(false);
  const generationStartedAtRef = useRef(0);
  const generationLastEventAtRef = useRef(0);
  const generationHeartbeatAtRef = useRef(0);
  const [generationJobId, setGenerationJobId] = useState<string | null>(null);
  const restoreCheckedRef = useRef(false);
  const jobStorageKey = `ai-helper:testdata-generation-job:${window.location.pathname}:${problemId}`;

  // 表单状态
  const [problemKind, setProblemKind] = useState<'auto' | 'traditional' | 'function'>('auto');
  const [fillInMode, setFillInMode] = useState<'auto' | 'yes' | 'no'>('auto');
  const [caseCount, setCaseCount] = useState(10);
  const [dataScale, setDataScale] = useState<'auto' | 'small' | 'medium' | 'large'>('auto');
  const [languages, setLanguages] = useState<string[]>(['py', 'java', 'cc']);
  const [providedStd, setProvidedStd] = useState('');
  const [acceptedStdRecordId, setAcceptedStdRecordId] = useState('');
  const [extraRequirements, setExtraRequirements] = useState('');

  // 生成结果状态
  const [plan, setPlan] = useState<GenerationPlan | null>(null);
  const [fileContents, setFileContents] = useState<Record<string, string>>({});
  const [selectedFiles, setSelectedFiles] = useState<Record<string, boolean>>({});
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<{ written: string[]; failed: Array<{ name: string; error: string }> } | null>(null);

  const rememberJob = useCallback((jobId: string | null) => {
    setGenerationJobId(jobId);
    try {
      if (jobId) window.localStorage.setItem(jobStorageKey, jobId);
      else window.localStorage.removeItem(jobStorageKey);
    } catch { /* localStorage may be unavailable in strict privacy mode */ }
  }, [jobStorageKey]);

  const loadPlanIntoPreview = useCallback((newPlan: GenerationPlan) => {
    if (!newPlan || !Array.isArray(newPlan.files) || newPlan.files.length === 0) {
      throw new Error(i18n('ai_helper_testdata_err_empty_plan'));
    }
    const contents: Record<string, string> = {};
    const selected: Record<string, boolean> = {};
    for (const f of newPlan.files) {
      contents[f.name] = f.content;
      selected[f.name] = true;
    }
    setPlan(newPlan);
    setFileContents(contents);
    setSelectedFiles(selected);
    setActiveFile(newPlan.files[0].name);
    setApplyResult(null);
    setPhase('preview');
  }, []);

  // 只显示服务端真实阶段，不按等待时间伪造百分比或推测模型内部进度。
  useEffect(() => {
    if (phase !== 'generating') return undefined;
    const startedAt = generationStartedAtRef.current || Date.now();
    generationStartedAtRef.current = startedAt;
    if (!generationLastEventAtRef.current) generationLastEventAtRef.current = startedAt;
    if (!generationHeartbeatAtRef.current) generationHeartbeatAtRef.current = startedAt;
    setGenerationElapsedSeconds(0);
    setGenerationIdleSeconds(0);
    setGenerationHeartbeatSeconds(0);
    const timer = window.setInterval(() => {
      const now = Date.now();
      const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
      setGenerationElapsedSeconds(elapsed);
      setGenerationIdleSeconds(Math.max(0, Math.floor((now - generationLastEventAtRef.current) / 1000)));
      setGenerationHeartbeatSeconds(Math.max(
        0,
        Math.floor((now - generationHeartbeatAtRef.current) / 1000),
      ));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [phase]);

  // 加载题目上下文；403 → 无编辑权限静默隐藏，其他失败 → 显示错误卡
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setContextError(null);
      try {
        const response = await fetch(
          buildApiUrl(`/ai-helper/testdata-gen/context/${encodeURIComponent(problemId)}`),
          { credentials: 'include' },
        );
        if (cancelled) return;
        if (response.status === 403) {
          setContextError('denied');
          return;
        }
        if (!response.ok) {
          console.warn(`[AI-Helper] testdata-gen context 加载失败: HTTP ${response.status}（插件后端未加载最新版本时通常为 404）`);
          setContextError(`HTTP ${response.status}`);
          return;
        }
        const data = await response.json() as ProblemContext;
        setContext(data);
      } catch (err) {
        if (cancelled) return;
        console.warn('[AI-Helper] testdata-gen context 加载失败:', err);
        setContextError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [problemId, contextReloadKey]);

  // 服务端记录优先，localStorage 用于在结果刚完成但上下文尚未刷新时补充恢复。
  useEffect(() => {
    if (!context || restoreCheckedRef.current || phase !== 'form' || plan) return;
    restoreCheckedRef.current = true;
    let storedJobId = '';
    try { storedJobId = window.localStorage.getItem(jobStorageKey) || ''; } catch { /* ignore */ }
    const savedJob = context.restorableJob;
    const jobId = savedJob?.id || storedJobId;
    if (!jobId) return;

    rememberJob(jobId);
    const startedAt = Date.parse(savedJob?.startedAt || savedJob?.createdAt || '');
    const progressAt = Date.parse(savedJob?.progressUpdatedAt || '');
    const heartbeatAt = Date.parse(savedJob?.updatedAt || '');
    generationStartedAtRef.current = Number.isFinite(startedAt) ? startedAt : Date.now();
    generationLastEventAtRef.current = Number.isFinite(progressAt)
      ? progressAt
      : generationStartedAtRef.current;
    generationHeartbeatAtRef.current = Number.isFinite(heartbeatAt)
      ? heartbeatAt
      : generationStartedAtRef.current;
    if (savedJob?.progress) {
      setGenerationProgress(savedJob.progress);
    }
    setCollapsed(false);
    setPhase('generating');
  }, [context, phase, plan, jobStorageKey, rememberJob]);

  // 轮询持久任务。短暂网络故障只会让页面少一次更新，不会中断后台模型调用。
  useEffect(() => {
    if (!generationJobId || phase !== 'generating') return undefined;
    let disposed = false;
    let timer: number | undefined;

    const poll = async () => {
      let terminal = false;
      try {
        const response = await fetch(
          buildApiUrl(`/ai-helper/testdata-gen/jobs/${encodeURIComponent(generationJobId)}`),
          { credentials: 'include' },
        );
        if (!response.ok) {
          const details = await parseErrorDetails(response);
          if (response.status === 404 || response.status === 403) {
            throw new TestdataRequestError(details.message);
          }
          throw new Error(details.message);
        }
        const data = await response.json() as { job: BackgroundGenerationJob };
        if (disposed || !data.job) return;
        const job = data.job;
        const startedAt = Date.parse(job.startedAt || job.createdAt || '');
        const progressAt = Date.parse(job.progressUpdatedAt || '');
        const heartbeatAt = Date.parse(job.updatedAt || '');
        if (Number.isFinite(startedAt)) generationStartedAtRef.current = startedAt;
        if (Number.isFinite(progressAt)) generationLastEventAtRef.current = progressAt;
        if (Number.isFinite(heartbeatAt)) generationHeartbeatAtRef.current = heartbeatAt;
        if (job.progress) {
          setGenerationProgress(job.progress);
        }

        if (job.status === 'completed') {
          terminal = true;
          if (!job.plan) throw new Error(i18n('ai_helper_testdata_err_empty_plan'));
          loadPlanIntoPreview(job.plan);
        } else if (job.status === 'failed' || job.status === 'interrupted') {
          terminal = true;
          rememberJob(null);
          setError(job.error?.code === 'WORKER_INTERRUPTED'
            ? i18n('ai_helper_testdata_job_interrupted')
            : (job.error?.message || i18n('ai_helper_testdata_job_failed')));
          setShowFallbackHint(true);
          setShowDeeperReasoningHint(job.error?.recommendDeeperReasoning === true);
          setPhase('form');
        } else if (job.status === 'canceled') {
          terminal = true;
          rememberJob(null);
          setError(i18n('ai_helper_testdata_err_canceled'));
          setShowFallbackHint(false);
          setPhase('form');
        }
      } catch (err) {
        if (disposed) return;
        if (terminal || err instanceof TestdataRequestError) {
          terminal = true;
          rememberJob(null);
          setError(err instanceof Error ? err.message : String(err));
          setShowFallbackHint(true);
          setPhase('form');
        } else {
          console.warn('[AI-Helper] testdata generation job poll failed:', err);
        }
      } finally {
        if (!disposed && !terminal) {
          timer = window.setTimeout(poll, JOB_POLL_INTERVAL_MS);
        }
      }
    };

    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [generationJobId, phase, loadPlanIntoPreview, rememberJob]);

  const existingFileSet = new Set(context?.existingFiles || []);

  const toggleLanguage = (lang: string) => {
    setLanguages(prev => (prev.includes(lang) ? prev.filter(l => l !== lang) : [...prev, lang]));
  };

  // ─── 生成 ───────────────────────────────────────────────────────────────────

  const handleGenerate = useCallback(async () => {
    setError(null);
    setShowFallbackHint(false);
    setShowDeeperReasoningHint(false);
    if (problemKind !== 'traditional' && languages.length === 0) {
      setError(i18n('ai_helper_testdata_err_no_languages'));
      return;
    }
    const startedAt = Date.now();
    generationStartedAtRef.current = startedAt;
    generationLastEventAtRef.current = startedAt;
    generationHeartbeatAtRef.current = startedAt;
    setGenerationIdleSeconds(0);
    setGenerationHeartbeatSeconds(0);
    setGenerationCanceling(false);
    setGenerationProgress({ stage: 'preparing', percent: 2, attempt: 1 });
    setPhase('generating');
    try {
      const response = await fetch(buildApiUrl('/ai-helper/testdata-gen/jobs'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        credentials: 'include',
        body: JSON.stringify({
          problemId,
          problemKind,
          fillInMode,
          caseCount,
          dataScale,
          languages,
          providedStd: providedStd.trim() || undefined,
          acceptedStdRecordId: acceptedStdRecordId || undefined,
          extraRequirements: extraRequirements.trim() || undefined,
        }),
      });
      if (!response.ok) {
        const details = await parseErrorDetails(response);
        throw new TestdataRequestError(details.message, details.recommendDeeperReasoning);
      }
      const data = await response.json() as { job: BackgroundGenerationJob };
      if (!data.job?.id) throw new Error(i18n('ai_helper_testdata_job_start_failed'));
      rememberJob(data.job.id);
      const heartbeatAt = Date.parse(data.job.updatedAt || '');
      if (Number.isFinite(heartbeatAt)) generationHeartbeatAtRef.current = heartbeatAt;
      if (data.job.progress) {
        setGenerationProgress(data.job.progress);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setShowFallbackHint(true);
      setShowDeeperReasoningHint(
        err instanceof TestdataRequestError && err.recommendDeeperReasoning,
      );
      setPhase('form');
    }
  }, [
    problemId, problemKind, fillInMode, caseCount,
    dataScale, languages, providedStd, acceptedStdRecordId, extraRequirements,
    rememberJob,
  ]);

  const handleCancelGeneration = useCallback(async () => {
    if (!generationJobId || generationCanceling) return;
    setGenerationCanceling(true);
    try {
      const response = await fetch(
        buildApiUrl(`/ai-helper/testdata-gen/jobs/${encodeURIComponent(generationJobId)}/cancel`),
        {
          method: 'POST',
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
          credentials: 'include',
        },
      );
      if (!response.ok) throw new Error((await parseErrorDetails(response)).message);
      rememberJob(null);
      setError(i18n('ai_helper_testdata_err_canceled'));
      setShowFallbackHint(false);
      setPhase('form');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerationCanceling(false);
    }
  }, [generationJobId, generationCanceling, rememberJob]);

  // ─── 骨架模式（AI 故障降级） ─────────────────────────────────────────────────

  const handleSkeleton = useCallback(async () => {
    setError(null);
    setShowFallbackHint(false);
    setShowDeeperReasoningHint(false);
    if (problemKind !== 'traditional' && languages.length === 0) {
      setError(i18n('ai_helper_testdata_err_no_languages'));
      return;
    }
    setGenerationProgress({ stage: 'assembling', percent: 80, attempt: 1 });
    setPhase('generating');
    try {
      const response = await fetch(buildApiUrl('/ai-helper/testdata-gen/skeleton'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        credentials: 'include',
        body: JSON.stringify({
          problemId,
          problemKind,
          caseCount,
          dataScale,
          languages,
          providedStd: providedStd.trim() || undefined,
          acceptedStdRecordId: acceptedStdRecordId || undefined,
        }),
      });
      if (!response.ok) {
        throw new Error((await parseErrorDetails(response)).message);
      }
      const data = await response.json() as { plan: GenerationPlan };
      loadPlanIntoPreview(data.plan);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('form');
    }
  }, [
    problemId, problemKind, caseCount, dataScale, languages,
    providedStd, acceptedStdRecordId, loadPlanIntoPreview,
  ]);

  // ─── 写入 ───────────────────────────────────────────────────────────────────

  const handleApply = useCallback(async () => {
    if (!plan) return;
    setError(null);
    const files = plan.files
      .filter(f => selectedFiles[f.name])
      .map(f => ({ name: f.name, content: fileContents[f.name] ?? f.content }));
    if (files.length === 0) {
      setError(i18n('ai_helper_testdata_err_none_selected'));
      return;
    }
    const overwritten = files.filter(f => existingFileSet.has(f.name)).map(f => f.name);
    const confirmText = overwritten.length > 0
      ? i18n('ai_helper_testdata_confirm_overwrite', files.length, overwritten.join(', '))
      : i18n('ai_helper_testdata_confirm_apply', files.length);
    if (!window.confirm(confirmText)) return;

    setPhase('applying');
    try {
      const response = await fetch(buildApiUrl('/ai-helper/testdata-gen/apply'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        credentials: 'include',
        body: JSON.stringify({ problemId, jobId: generationJobId || undefined, files }),
      });
      if (!response.ok) {
        throw new Error((await parseErrorDetails(response)).message);
      }
      const data = await response.json() as { written: string[]; failed: Array<{ name: string; error: string }> };
      setApplyResult(data);
      if (data.failed.length === 0) rememberJob(null);
      setPhase('applied');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('preview');
    }
  }, [
    plan, selectedFiles, fileContents, problemId, existingFileSet,
    generationJobId, rememberJob,
  ]);

  const handleBackToForm = useCallback(async () => {
    const jobId = generationJobId;
    if (jobId) {
      try {
        await fetch(
          buildApiUrl(`/ai-helper/testdata-gen/jobs/${encodeURIComponent(jobId)}/dismiss`),
          {
            method: 'POST',
            headers: { 'X-Requested-With': 'XMLHttpRequest' },
            credentials: 'include',
          },
        );
      } catch (err) {
        console.warn('[AI-Helper] dismiss testdata generation job failed:', err);
      }
    }
    rememberJob(null);
    setPlan(null);
    setFileContents({});
    setSelectedFiles({});
    setActiveFile(null);
    setError(null);
    setPhase('form');
  }, [generationJobId, rememberJob]);

  // ─── 渲染 ───────────────────────────────────────────────────────────────────

  // 无编辑权限：静默隐藏
  if (contextError === 'denied') return null;

  // 加载失败（插件未加载/后端异常/网络问题）：显示错误卡便于排查
  if (contextError) {
    return (
      <div style={{
        background: COLORS.bgCard,
        border: `1px solid ${COLORS.border}`,
        borderRadius: RADIUS.md,
        marginTop: SPACING.base,
        padding: SPACING.base,
      }}>
        <div style={{ fontSize: '14px', fontWeight: 600, color: COLORS.textPrimary, marginBottom: SPACING.xs }}>
          🧪 {i18n('ai_helper_testdata_panel_title')}
        </div>
        <div style={{ ...getAlertStyle('warning'), marginBottom: SPACING.sm }}>
          {i18n('ai_helper_testdata_context_error', contextError)}
        </div>
        <button style={getButtonStyle('secondary')} onClick={() => setContextReloadKey(k => k + 1)}>
          {i18n('ai_helper_testdata_retry_btn')}
        </button>
      </div>
    );
  }

  // 加载中
  if (!context) return null;

  const sectionStyle: React.CSSProperties = {
    background: COLORS.bgCard,
    border: `1px solid ${COLORS.border}`,
    borderRadius: RADIUS.md,
    marginTop: SPACING.base,
    overflow: 'hidden',
  };

  const headerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: `${SPACING.md} ${SPACING.base}`,
    cursor: 'pointer',
    userSelect: 'none',
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: '13px',
    fontWeight: 600,
    color: COLORS.textSecondary,
    marginBottom: SPACING.xs,
  };

  const fieldStyle: React.CSSProperties = { marginBottom: SPACING.base };

  const renderForm = () => (
    <div>
      <div style={{ ...getAlertStyle('warning'), fontWeight: 600, marginBottom: SPACING.base }}>
        {i18n('ai_helper_testdata_strong_model_notice')}
      </div>
      {!context.problem.hasStatement && (
        <div style={{ ...getAlertStyle('warning'), marginBottom: SPACING.base }}>
          {i18n('ai_helper_testdata_warn_no_statement')}
        </div>
      )}
      <div style={fieldStyle}>
        <label style={labelStyle}>{i18n('ai_helper_testdata_kind_label')}</label>
        <select
          value={problemKind}
          onChange={e => {
            const next = e.target.value as typeof problemKind;
            setProblemKind(next);
            if (next !== 'traditional') setAcceptedStdRecordId('');
          }}
          style={{ ...getInputStyle(), maxWidth: '320px' }}
        >
          <option value="auto">{i18n('ai_helper_testdata_kind_auto')}</option>
          <option value="traditional">{i18n('ai_helper_testdata_kind_traditional')}</option>
          <option value="function">{i18n('ai_helper_testdata_kind_function')}</option>
        </select>
        <div style={{ ...TYPOGRAPHY.xs, color: COLORS.textMuted, marginTop: SPACING.xs }}>
          {i18n('ai_helper_testdata_kind_hint')}
        </div>
      </div>
      <div style={fieldStyle}>
        <label style={labelStyle}>{i18n('ai_helper_testdata_fill_in_label')}</label>
        <select
          value={fillInMode}
          onChange={e => setFillInMode(e.target.value as typeof fillInMode)}
          style={{ ...getInputStyle(), maxWidth: '320px' }}
        >
          <option value="auto">{i18n('ai_helper_testdata_fill_in_auto')}</option>
          <option value="yes">{i18n('ai_helper_testdata_fill_in_yes')}</option>
          <option value="no">{i18n('ai_helper_testdata_fill_in_no')}</option>
        </select>
        <div style={{ ...TYPOGRAPHY.xs, color: COLORS.textMuted, marginTop: SPACING.xs }}>
          {context.problem.fillInDetected
            ? i18n('ai_helper_testdata_fill_in_detected')
            : i18n('ai_helper_testdata_fill_in_hint')}
        </div>
      </div>
      <div style={{ display: 'flex', gap: SPACING.lg, flexWrap: 'wrap' }}>
        <div style={fieldStyle}>
          <label style={labelStyle}>{i18n('ai_helper_testdata_case_count_label')}</label>
          <input
            type="number"
            min={context.limits.minCases}
            max={context.limits.maxCases}
            value={caseCount}
            onChange={e => {
              const v = parseInt(e.target.value, 10);
              if (!Number.isNaN(v)) setCaseCount(v);
            }}
            style={{ ...getInputStyle(), maxWidth: '120px' }}
          />
        </div>
        <div style={fieldStyle}>
          <label style={labelStyle}>{i18n('ai_helper_testdata_scale_label')}</label>
          <select
            value={dataScale}
            onChange={e => setDataScale(e.target.value as typeof dataScale)}
            style={{ ...getInputStyle(), maxWidth: '260px' }}
          >
            <option value="auto">{i18n('ai_helper_testdata_scale_auto')}</option>
            <option value="small">{i18n('ai_helper_testdata_scale_small')}</option>
            <option value="medium">{i18n('ai_helper_testdata_scale_medium')}</option>
            <option value="large">{i18n('ai_helper_testdata_scale_large')}</option>
          </select>
        </div>
      </div>
      {dataScale === 'large' && (
        <div style={{ ...getAlertStyle('warning'), marginBottom: SPACING.base }}>
          {i18n('ai_helper_testdata_scale_large_warning')}
        </div>
      )}
      {problemKind !== 'traditional' && (
        <div style={fieldStyle}>
          <label style={labelStyle}>{i18n('ai_helper_testdata_languages_label')}</label>
          <div style={{ display: 'flex', gap: SPACING.base }}>
            {TEMPLATE_LANG_OPTIONS.map(opt => (
              <label key={opt.value} style={{ display: 'inline-flex', alignItems: 'center', gap: SPACING.xs, fontSize: '14px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={languages.includes(opt.value)}
                  onChange={() => toggleLanguage(opt.value)}
                />
                {opt.label}
              </label>
            ))}
          </div>
          <div style={{ ...TYPOGRAPHY.xs, color: COLORS.textMuted, marginTop: SPACING.xs }}>
            {i18n('ai_helper_testdata_languages_hint')}
          </div>
        </div>
      )}
      <div style={fieldStyle}>
        <label style={labelStyle}>{i18n('ai_helper_testdata_std_label')}</label>
        {(context.acceptedSolutions || []).length > 0 && (
          <>
            <select
              value={acceptedStdRecordId}
              disabled={problemKind !== 'traditional'}
              onChange={e => {
                setAcceptedStdRecordId(e.target.value);
                if (e.target.value) setProvidedStd('');
              }}
              style={{ ...getInputStyle(), marginBottom: SPACING.xs }}
            >
              <option value="">{i18n('ai_helper_testdata_std_ac_none')}</option>
              {(context.acceptedSolutions || []).map(candidate => (
                <option key={candidate.recordId} value={candidate.recordId}>
                  {candidate.lang} · {new Date(candidate.submittedAt).toLocaleString()}
                  {candidate.isOwn ? ` · ${i18n('ai_helper_testdata_std_ac_own')}` : ''}
                </option>
              ))}
            </select>
            <div style={{ ...TYPOGRAPHY.xs, color: COLORS.textMuted, marginBottom: SPACING.xs }}>
              {problemKind === 'traditional'
                ? i18n('ai_helper_testdata_std_ac_hint')
                : i18n('ai_helper_testdata_std_ac_traditional_hint')}
            </div>
          </>
        )}
        <textarea
          value={providedStd}
          disabled={!!acceptedStdRecordId}
          onChange={e => {
            setProvidedStd(e.target.value.slice(0, context.limits.maxProvidedStd ?? 10000));
            if (e.target.value) setAcceptedStdRecordId('');
          }}
          placeholder={i18n(acceptedStdRecordId
            ? 'ai_helper_testdata_std_ac_selected_placeholder'
            : 'ai_helper_testdata_std_placeholder')}
          rows={providedStd ? 8 : 3}
          spellCheck={false}
          style={{ ...getInputStyle(), resize: 'vertical', fontFamily: MONO_FONT, fontSize: '13px' }}
        />
        <div style={{ ...TYPOGRAPHY.xs, color: COLORS.textMuted, marginTop: SPACING.xs }}>
          {i18n('ai_helper_testdata_std_hint')}
        </div>
      </div>
      <div style={fieldStyle}>
        <label style={labelStyle}>{i18n('ai_helper_testdata_extra_label')}</label>
        <textarea
          value={extraRequirements}
          onChange={e => setExtraRequirements(e.target.value.slice(0, context.limits.maxExtraRequirements))}
          placeholder={i18n('ai_helper_testdata_extra_placeholder')}
          rows={3}
          style={{ ...getInputStyle(), resize: 'vertical', fontFamily: 'inherit' }}
        />
      </div>
      {error && (
        <div style={{ ...getAlertStyle('error'), marginBottom: SPACING.base }}>
          <div>{error}</div>
          {showDeeperReasoningHint && (
            <div style={{ ...TYPOGRAPHY.xs, marginTop: SPACING.xs, fontWeight: 600 }}>
              {i18n('ai_helper_testdata_deeper_reasoning_suggestion')}
            </div>
          )}
          {showFallbackHint && (
            <div style={{ ...TYPOGRAPHY.xs, marginTop: SPACING.xs }}>
              {i18n('ai_helper_testdata_fallback_suggestion')}
            </div>
          )}
        </div>
      )}
      <div style={{ display: 'flex', gap: SPACING.sm, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          style={getButtonStyle('primary')}
          onClick={handleGenerate}
          disabled={!context.problem.hasStatement}
        >
          {i18n('ai_helper_testdata_generate_btn')}
        </button>
        <button
          style={getButtonStyle('secondary')}
          onClick={handleSkeleton}
          title={i18n('ai_helper_testdata_skeleton_hint')}
        >
          {i18n('ai_helper_testdata_skeleton_btn')}
        </button>
      </div>
      <div style={{ ...TYPOGRAPHY.xs, color: COLORS.textMuted, marginTop: SPACING.xs }}>
        {i18n('ai_helper_testdata_skeleton_hint')}
      </div>
    </div>
  );

  const renderGenerating = () => {
    const elapsedMinutes = Math.floor(generationElapsedSeconds / 60);
    const elapsedSeconds = generationElapsedSeconds % 60;
    const idleMinutes = Math.floor(generationIdleSeconds / 60);
    const idleSeconds = generationIdleSeconds % 60;
    const activeGroupIndex = getGenerationStageGroupIndex(generationProgress.stage);
    const heartbeatStale = generationHeartbeatSeconds >= 75;
    const longWaitThresholdSeconds = 5 * 60;
    return (
      <div style={{ padding: SPACING.xl, color: COLORS.textSecondary }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: SPACING.sm, marginBottom: SPACING.base }}>
          <div style={{
            width: '22px', height: '22px', flex: '0 0 22px',
            border: `3px solid ${COLORS.border}`, borderTopColor: COLORS.primary,
            borderRadius: '50%', animation: 'spin 1s linear infinite',
          }} />
          <style>{'@keyframes spin { from{transform:rotate(0)} to{transform:rotate(360deg)} }'}</style>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div role="status" aria-live="polite" style={{ fontSize: '14px', fontWeight: 600, color: COLORS.textPrimary }}>
              {i18n(`ai_helper_testdata_progress_${generationProgress.stage}`)}
            </div>
            <div style={{ ...TYPOGRAPHY.xs, color: COLORS.textMuted, marginTop: '2px' }}>
              {i18n('ai_helper_testdata_progress_live')}
              {generationProgress.attempt > 1
                ? ` · ${i18n('ai_helper_testdata_progress_attempt', generationProgress.attempt)}`
                : ''}
            </div>
          </div>
          <div style={{ ...TYPOGRAPHY.sm, fontWeight: 600, color: COLORS.primary, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
            {i18n('ai_helper_testdata_progress_elapsed', elapsedMinutes, String(elapsedSeconds).padStart(2, '0'))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: SPACING.sm, flexWrap: 'wrap' }}>
          {GENERATION_STAGE_GROUPS.map((group, index) => {
            const completed = generationProgress.stage === 'complete' || index < activeGroupIndex;
            const active = !completed && index === activeGroupIndex;
            return (
              <div
                key={group.key}
                style={{
                  flex: '1 1 120px', minWidth: 0,
                  display: 'flex', alignItems: 'center', gap: SPACING.sm,
                  padding: `${SPACING.sm} ${SPACING.md}`,
                  borderRadius: RADIUS.md,
                  border: `1px solid ${active ? COLORS.borderFocus : COLORS.border}`,
                  backgroundColor: active ? COLORS.primaryLight : completed ? COLORS.successBg : COLORS.bgHover,
                  color: active ? COLORS.primary : completed ? COLORS.successText : COLORS.textMuted,
                  fontSize: '12px', fontWeight: active || completed ? 600 : 500,
                }}
              >
                <span aria-hidden="true" style={{
                  width: '20px', height: '20px', flex: '0 0 20px',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  borderRadius: RADIUS.full,
                  color: completed || active ? '#fff' : COLORS.textMuted,
                  backgroundColor: completed ? COLORS.success : active ? COLORS.primary : COLORS.border,
                  fontSize: '11px', fontWeight: 700,
                }}>
                  {completed ? '✓' : index + 1}
                </span>
                <span>{i18n(`ai_helper_testdata_step_${group.key}`)}</span>
              </div>
            );
          })}
        </div>
        <div style={{ ...TYPOGRAPHY.xs, color: COLORS.textMuted, marginTop: SPACING.sm }}>
          {i18n('ai_helper_testdata_progress_model_unobservable')}
          {' '}
          {i18n('ai_helper_testdata_generating_hint')}
        </div>
        {generationIdleSeconds >= 30 && (
          <div style={{ ...TYPOGRAPHY.xs, color: COLORS.textMuted, marginTop: SPACING.xs }}>
            {i18n(
              'ai_helper_testdata_progress_last_update',
              idleMinutes,
              String(idleSeconds).padStart(2, '0'),
            )}
          </div>
        )}
        {generationIdleSeconds >= longWaitThresholdSeconds && generationProgress.stage !== 'model_fallback' && (
          <div style={{ ...getAlertStyle('info'), marginTop: SPACING.base }}>
            {i18n('ai_helper_testdata_progress_waiting_long')}
          </div>
        )}
        <div style={{
          ...getAlertStyle(generationJobId && heartbeatStale ? 'warning' : 'success'),
          marginTop: SPACING.base,
        }}>
          {generationJobId
            ? i18n(
              heartbeatStale
                ? 'ai_helper_testdata_progress_heartbeat_stale'
                : 'ai_helper_testdata_progress_heartbeat',
              generationHeartbeatSeconds,
            )
            : i18n('ai_helper_testdata_background_starting')}
          {generationJobId && !heartbeatStale && (
            <div style={{ ...TYPOGRAPHY.xs, marginTop: SPACING.xs }}>
              {i18n('ai_helper_testdata_background_active')}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: SPACING.base }}>
          <button
            type="button"
            style={getButtonStyle('secondary')}
            onClick={handleCancelGeneration}
            disabled={generationCanceling || !generationJobId}
          >
            {i18n(generationCanceling
              ? 'ai_helper_testdata_canceling'
              : 'ai_helper_testdata_cancel')}
          </button>
        </div>
      </div>
    );
  };

  const renderPreview = () => {
    if (!plan) return null;
    const caseFiles = plan.files.filter(f => f.kind === 'case-in' || f.kind === 'case-out');
    const otherFiles = plan.files.filter(f => f.kind !== 'case-in' && f.kind !== 'case-out');
    const orderedFiles = [...otherFiles, ...caseFiles];
    const active = activeFile && plan.files.some(f => f.name === activeFile) ? activeFile : orderedFiles[0]?.name;
    const selectedCount = plan.files.filter(f => selectedFiles[f.name]).length;
    const verification = plan.verification;
    const bruteSkipped = verification?.bruteCheck?.skippedTimeout ?? [];
    const bruteDisagreed = verification?.bruteCheck?.disagreed ?? [];
    const templateSkipped = verification?.templateCheck?.skippedTimeout ?? [];
    const stressCheck = verification?.stressCheck;
    const discrimination = verification?.mode === 'sandbox'
      ? verification.discrimination
      : undefined;
    const discriminationKilled = discrimination?.targets.filter(target => target.killed).length ?? 0;
    const discriminationAllKilled = !!discrimination
      && discrimination.allKilled
      && discriminationKilled === discrimination.targets.length;
    const hasAiOnlyCases = plan.files.some(
      f => (f.kind === 'case-in' || f.kind === 'case-out') && f.origin === 'ai-only',
    );
    const stressPassed = !!stressCheck
      && !stressCheck.skippedReason
      && stressCheck.compared > 0
      && stressCheck.agreed === stressCheck.compared
      && (stressCheck.uniqueInputs === undefined
        || stressCheck.uniqueInputs >= Math.ceil(stressCheck.generated * 0.8));
    const legacyBrutePassed = !stressCheck
      && (verification?.bruteCheck?.compared ?? 0) > 0
      && bruteDisagreed.length === 0
      && bruteSkipped.length === 0;
    // 全绿门槛：优先要求内部压力对拍全量通过；旧后端回退原 BRUTE 判定。
    const verificationAllGreen = verification?.mode === 'sandbox'
      && !hasAiOnlyCases
      && (stressPassed || legacyBrutePassed)
      && templateSkipped.length === 0
      && (!discrimination || discriminationAllKilled);

    return (
      <div>
        <div style={{ ...getAlertStyle('info'), marginBottom: SPACING.md }}>
          <div style={{ fontWeight: 600, marginBottom: SPACING.xs }}>
            {i18n(plan.problemType === 'function' ? 'ai_helper_testdata_type_function' : 'ai_helper_testdata_type_traditional')}
            {plan.isFillIn ? ` · ${i18n('ai_helper_testdata_type_fill_in')}` : ''}
            {' · '}
            {i18n('ai_helper_testdata_case_count_result', plan.caseCount)}
            {plan.totalCaseCount && plan.totalCaseCount !== plan.caseCount
              ? ` · ${i18n('ai_helper_testdata_total_case_count', plan.totalCaseCount)}`
              : ''}
            {plan.usedModel ? ` · ${plan.usedModel}` : ''}
          </div>
          {plan.analysis && <div style={{ fontSize: '13px' }}>{plan.analysis}</div>}
          {plan.notes && <div style={{ fontSize: '13px', marginTop: SPACING.xs }}>{plan.notes}</div>}
        </div>
        {plan.caseCoverage && plan.caseCoverage.length > 0 && (
          <div style={{ ...getAlertStyle('info'), marginBottom: SPACING.md }}>
            <div style={{ fontWeight: 600, marginBottom: SPACING.sm }}>
              {i18n('ai_helper_testdata_coverage_title')}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: SPACING.xs }}>
              {plan.caseCoverage.map(item => (
                <div key={item.caseNumber} style={{ fontSize: '13px', display: 'flex', gap: SPACING.sm, alignItems: 'baseline' }}>
                  <code>{item.fileNumber}.in/.out</code>
                  <span style={getBadgeStyle('info')}>
                    {i18n(`ai_helper_testdata_scale_${item.dataScale}`)}
                  </span>
                  <span style={{ color: COLORS.textSecondary }}>{item.target}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {verification && (
          <div style={{ ...getAlertStyle(verificationAllGreen ? 'success' : 'warning'), marginBottom: SPACING.md }}>
            <div style={{ fontWeight: 600, marginBottom: SPACING.xs }}>
              {i18n('ai_helper_testdata_verify_title')}
            </div>
            <div style={{ fontSize: '13px' }}>
              {i18n(verification.mode === 'sandbox' ? 'ai_helper_testdata_verify_mode_sandbox' : 'ai_helper_testdata_verify_mode_direct')}
            </div>
            {verification.oracleKind === 'accepted-record' && (
              <div style={{ fontSize: '13px' }}>
                {i18n('ai_helper_testdata_verify_ac_candidate')}
              </div>
            )}
            {verification.modelEscalation && (
              <div style={{ fontSize: '13px' }}>
                {i18n(
                  'ai_helper_testdata_verify_model_escalation',
                  verification.modelEscalation.fromModel,
                  verification.modelEscalation.toModel,
                )}
              </div>
            )}
            {verification.sampleCheck && (
              <div style={{ fontSize: '13px' }}>
                {i18n('ai_helper_testdata_verify_samples')}: {verification.sampleCheck.passed}/{verification.sampleCheck.total}
              </div>
            )}
            {verification.bruteCheck && (
              <div style={{ fontSize: '13px' }}>
                {i18n('ai_helper_testdata_verify_brute')}: {verification.bruteCheck.agreed}/{verification.bruteCheck.compared}
                {bruteSkipped.length > 0 && ` · ${i18n('ai_helper_testdata_verify_brute_skipped')}: [${bruteSkipped.join(', ')}]`}
                {bruteDisagreed.length > 0 && ` · ${i18n('ai_helper_testdata_verify_brute_disagreed')}: [${bruteDisagreed.join(', ')}]`}
              </div>
            )}
            {stressCheck && (
              <div style={{ fontSize: '13px' }}>
                {i18n('ai_helper_testdata_verify_stress')}: {' '}
                {stressCheck.skippedReason === 'custom-checker'
                  ? i18n('ai_helper_testdata_verify_stress_custom_checker')
                  : `${stressCheck.agreed}/${stressCheck.compared}`}
                {` · ${i18n('ai_helper_testdata_verify_stress_generated')}: ${stressCheck.generated}`}
                {stressCheck.uniqueInputs !== undefined
                  && ` · ${i18n('ai_helper_testdata_verify_stress_unique')}: ${stressCheck.uniqueInputs}/${stressCheck.generated}`}
              </div>
            )}
            {verification.validator && (
              <div style={{ fontSize: '13px' }}>
                {i18n('ai_helper_testdata_verify_validator')}: {verification.validator.ran ? verification.validator.casesChecked : i18n('ai_helper_testdata_verify_validator_none')}
              </div>
            )}
            {verification.templateCheck && (
              <div style={{ fontSize: '13px' }}>
                {i18n('ai_helper_testdata_verify_template')}: {verification.templateCheck.passed}/{verification.templateCheck.total}
              </div>
            )}
            {discrimination && (
              <div style={{
                ...getAlertStyle(discriminationAllKilled ? 'success' : 'warning'),
                marginTop: SPACING.xs,
                padding: `${SPACING.xs} ${SPACING.sm}`,
                fontSize: '13px',
              }}>
                {i18n(
                  'ai_helper_testdata_discrimination_summary',
                  discriminationKilled,
                  discrimination.targets.length,
                )}
                {!discriminationAllKilled
                  && ` · ${i18n('ai_helper_testdata_discrimination_warning')}`}
              </div>
            )}
          </div>
        )}
        <div style={{ ...getAlertStyle('warning'), marginBottom: SPACING.md }}>
          {i18n('ai_helper_testdata_review_warning')}
        </div>
        <div style={{ display: 'flex', gap: SPACING.base, alignItems: 'stretch', flexWrap: 'wrap' }}>
          {/* 文件列表 */}
          <div style={{
            flex: '0 0 220px', maxHeight: '420px', overflowY: 'auto',
            border: `1px solid ${COLORS.border}`, borderRadius: RADIUS.md,
          }}>
            {orderedFiles.map(f => {
              const isActive = f.name === active;
              const conflict = existingFileSet.has(f.name);
              return (
                <div
                  key={f.name}
                  onClick={() => setActiveFile(f.name)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: SPACING.xs,
                    padding: `6px ${SPACING.sm}`,
                    cursor: 'pointer',
                    backgroundColor: isActive ? COLORS.primaryLight : 'transparent',
                    borderBottom: `1px solid ${COLORS.border}`,
                    fontSize: '13px',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={!!selectedFiles[f.name]}
                    onClick={e => e.stopPropagation()}
                    onChange={() => setSelectedFiles(prev => ({ ...prev, [f.name]: !prev[f.name] }))}
                  />
                  <span style={{ fontFamily: MONO_FONT, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {f.name}
                  </span>
                  {f.origin && (
                    <span style={getOriginBadgeStyle(f.origin)}>
                      {i18n(ORIGIN_BADGE_KEYS[f.origin])}
                    </span>
                  )}
                  {conflict && (
                    <span style={getBadgeStyle('warning')} title={i18n('ai_helper_testdata_overwrite_hint')}>
                      {i18n('ai_helper_testdata_overwrite_badge')}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          {/* 内容编辑区 */}
          <div style={{ flex: '1 1 320px', minWidth: '280px' }}>
            {active && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: SPACING.sm, marginBottom: SPACING.xs }}>
                  <span style={{ fontFamily: MONO_FONT, fontSize: '13px', fontWeight: 600 }}>{active}</span>
                  <span style={getBadgeStyle('info')}>
                    {i18n(KIND_BADGE_KEYS[plan.files.find(f => f.name === active)?.kind || 'config'])}
                  </span>
                </div>
                <textarea
                  value={fileContents[active] ?? ''}
                  onChange={e => setFileContents(prev => ({ ...prev, [active]: e.target.value }))}
                  spellCheck={false}
                  style={{
                    ...getInputStyle(),
                    fontFamily: MONO_FONT,
                    fontSize: '13px',
                    minHeight: '380px',
                    resize: 'vertical',
                    whiteSpace: 'pre',
                  }}
                />
              </>
            )}
          </div>
        </div>
        {error && (
          <div style={{ ...getAlertStyle('error'), marginTop: SPACING.md }}>{error}</div>
        )}
        <div style={{ display: 'flex', gap: SPACING.sm, marginTop: SPACING.base }}>
          <button style={getButtonStyle('primary')} onClick={handleApply}>
            {i18n('ai_helper_testdata_apply_btn', selectedCount)}
          </button>
          <button
            style={getButtonStyle('secondary')}
            onClick={handleBackToForm}
          >
            {i18n('ai_helper_testdata_back_btn')}
          </button>
        </div>
      </div>
    );
  };

  const renderApplying = () => (
    <div style={{ textAlign: 'center', padding: SPACING.xl, color: COLORS.textSecondary, fontSize: '14px' }}>
      {i18n('ai_helper_testdata_applying')}
    </div>
  );

  const renderApplied = () => (
    <div>
      {applyResult && applyResult.failed.length === 0 ? (
        <div style={{ ...getAlertStyle('success'), marginBottom: SPACING.base }}>
          {i18n('ai_helper_testdata_apply_success', applyResult.written.length)}
        </div>
      ) : (
        <div style={{ ...getAlertStyle('warning'), marginBottom: SPACING.base }}>
          {i18n('ai_helper_testdata_apply_partial', applyResult?.written.length ?? 0, applyResult?.failed.length ?? 0)}
          {applyResult?.failed.map(f => (
            <div key={f.name} style={{ fontFamily: MONO_FONT, fontSize: '12px', marginTop: SPACING.xs }}>
              {f.name}: {f.error}
            </div>
          ))}
        </div>
      )}
      <div style={{ ...getAlertStyle('info'), marginBottom: SPACING.base }}>
        {i18n('ai_helper_testdata_apply_next_steps')}
      </div>
      <div style={{ display: 'flex', gap: SPACING.sm }}>
        <button style={getButtonStyle('primary')} onClick={() => window.location.reload()}>
          {i18n('ai_helper_testdata_refresh_btn')}
        </button>
        <button style={getButtonStyle('secondary')} onClick={() => { setPhase('preview'); setError(null); }}>
          {i18n('ai_helper_testdata_back_to_preview_btn')}
        </button>
      </div>
    </div>
  );

  // Hydro 只会为首屏已有的 .section 自动添加 visible；动态插入的面板需自行标记。
  return (
    <div style={sectionStyle} className="section visible">
      <div style={headerStyle} onClick={() => setCollapsed(prev => !prev)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: SPACING.sm }}>
          <span style={{ fontSize: '18px' }}>🧪</span>
          <span style={{ fontSize: '16px', fontWeight: 600, color: COLORS.textPrimary }}>
            {i18n('ai_helper_testdata_panel_title')}
          </span>
          <span style={getBadgeStyle('info')}>AI</span>
        </div>
        <span style={{ color: COLORS.textMuted, fontSize: '13px' }}>
          {collapsed ? i18n('ai_helper_testdata_expand') : i18n('ai_helper_testdata_collapse')}
        </span>
      </div>
      {!collapsed && (
        <div style={{ padding: `0 ${SPACING.base} ${SPACING.base}` }}>
          <div style={{ ...TYPOGRAPHY.xs, color: COLORS.textMuted, marginBottom: SPACING.base }}>
            {i18n('ai_helper_testdata_panel_subtitle')}
          </div>
          {phase === 'form' && renderForm()}
          {phase === 'generating' && renderGenerating()}
          {phase === 'preview' && renderPreview()}
          {phase === 'applying' && renderApplying()}
          {phase === 'applied' && renderApplied()}
        </div>
      )}
    </div>
  );
};
