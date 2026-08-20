/**
 * TestdataGenService - AI 测试数据生成服务
 *
 * 面向教师/出题人：根据 Markdown 题面生成一套可直接写入 HydroOJ
 * 题目文件（测试数据）的完整文件集，包括：
 * - N.in / N.out 测试点（AI 编写输入生成器与标程，Hydro 沙箱实跑得到输出）
 * - 函数题（LeetCode 风格）所需的 template.py / template.java / template.cc
 * - compile.sh（服务端确定性生成，覆盖所选语言，非 AI 输出）
 * - config.yaml 评测配置（服务端用 js-yaml 确定性生成，写入后 Hydro
 *   会自动同步到题目的评测设置）
 * - std.py 参考标程（供教师人工校验与后续重造数据）
 *
 * 设计要点：AI 负责题目理解相关的生成器、标程与模板；AI 代码只进入 Hydro
 * go-judge 沙箱执行。结构性文件由服务端确定性拼装，兼容模式才接受 AI 直出数据。
 */

import yaml from 'js-yaml';
import type { ChatCallOptions, MultiModelClient, TokenUsage } from './openaiClient';
import {
  CHECKER_BUDGET_MS,
  DISCRIMINATION_BUDGET_MS,
  isSandboxBudgetExceededError,
  SANDBOX_TOTAL_BUDGET_MS,
} from './goJudgeSandboxService';
import { excerpt, excerptTail } from '../lib/textTruncate';
import type {
  CheckerRunCase,
  PythonRunDetail,
  PythonRunResult,
  TestdataGenerationMode,
  TestdataSandboxRunner,
} from './goJudgeSandboxService';
import {
  TestdataPipelineError,
  extractTestdataFailureMetadata,
  getUserMessageKeyForFailure,
  normalizeTestdataFailureStage,
  repairPolicyForFailure,
  toPipelineError,
  type TestdataArtifact,
  type TestdataFailureCode,
  type TestdataPipelineErrorContext,
  type TestdataRetryPolicy,
} from './testdata/failures';
import {
  assessTestdataRisk,
  getTestdataDirectFallbackEnabled,
  getTestdataReliabilityMode,
  type TestdataReliabilityMode,
  type TestdataRiskAssessment,
} from './testdata/risk';
import {
  extractStatementSamples,
  type StatementSample,
} from './testdata/statementSamples';
import {
  type ProblemSpecSummary,
  type ProblemSpecV1,
} from './testdata/problemSpec';
import {
  runProblemSpecConsensus,
  type SpecConsensusStatus,
} from './testdata/specConsensus';
import {
  findTestdataRoleIdentityConflicts,
  type TestdataModelIdentity,
  type TestdataRoleClients,
} from './testdata/modelRoles';
import type { TestdataModelRole } from '../models/aiConfig';
import {
  STATEMENT_SNAPSHOT_HARD_LIMIT,
  createStatementSnapshot,
  type StatementSnapshot,
} from './testdata/statementSnapshot';
import {
  assertProblemSpecUnchanged,
  createTestdataPipelineContext,
  hashTestdataRoleIdentity,
  TESTDATA_CHECKPOINT_SCHEMA_VERSION,
  TESTDATA_PIPELINE_PROMPT_VERSION,
  type TestdataPipelineContext,
} from './testdata/pipelineContext';
import {
  buildFrozenInputEncodingBlock,
  buildFrozenProblemSpecBlock,
  buildFrozenStatementEvidenceBlock,
} from './testdata/pipelinePrompts';
import {
  TemplateVerificationError,
  verifySelectedTemplates,
  type TemplateChecks,
  type TemplateOutputAdjudicator,
} from './testdata/templateVerifier';
import { computeOriginalFileHashes, createTestdataRunId } from './testdata/runTelemetry';

export { extractStatementSamples, type StatementSample } from './testdata/statementSamples';

function comparableFileContent(content: string): string {
  return content
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .trimEnd();
}

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

/** 题型：传统题（标准输入输出）或函数题（学生只写函数/类，LeetCode 风格） */
export type ProblemKind = 'auto' | 'traditional' | 'function';

/** 填空题（完善代码）：auto 由 AI 根据题面判断 */
export type FillInMode = 'auto' | 'yes' | 'no';

/** 测试数据规模策略：auto 自动混合覆盖，其他值用于定向生成。 */
export type DataScale = 'auto' | 'small' | 'medium' | 'large';

/** 单个测试点最终采用的规模档位。 */
export type CaseDataScale = Exclude<DataScale, 'auto'>;

export type OracleLanguage = 'python' | 'cpp';

export interface CoverageSlot {
  /** 本次生成内的测试点序号（从 1 开始，不等同于最终文件编号）。 */
  caseNumber: number;
  dataScale: CaseDataScale;
  /** 提示 AI 在该档位重点覆盖的通用目标。 */
  guidance: string;
}

/** 题面明确声明的单个子任务及其完整生效约束。 */
export interface SubtaskSpec {
  id: number;
  score: number;
  constraints: string;
}

export interface SubtaskCaseAllocation {
  /** 本次生成内的测试点序号（从 1 开始，不等同于最终文件编号）。 */
  caseNumber: number;
  subtaskId: number;
  guidance: string;
}

export interface TieredSubtaskGenerationDecision {
  enabled: boolean;
  allocations: SubtaskCaseAllocation[];
  /** 启用时固定为本轮首次解题蓝图中的规格，供提示与组装共同消费。 */
  subtasks?: SubtaskSpec[];
  warning?: string;
}

/** 支持的模板语言族（对应 HydroOJ 语言键前缀） */
export type TemplateLang = 'py' | 'java' | 'cc';

export const SUPPORTED_TEMPLATE_LANGS: readonly TemplateLang[] = ['py', 'java', 'cc'] as const;

/** 函数题各评测语言对应的学生提交形式参考解。 */
export type TemplateSolutions = Partial<Record<TemplateLang, string>>;

/** 生成选项（来自前端表单） */
export interface GenerateOptions {
  /** 题型：auto 由 AI 根据题面判断 */
  problemKind: ProblemKind;
  /** 是否为填空题（题面含待完善代码）；填空与传统/函数题正交 */
  fillInMode?: FillInMode;
  /** 期望测试点数量（1-30） */
  caseCount: number;
  /** 测试数据规模策略（默认 auto：小/中/临界混合覆盖） */
  dataScale?: DataScale;
  /** 函数题模板语言（传统题忽略） */
  languages: TemplateLang[];
  /** 教师手动标程或从 Hydro AC 记录加载的候选代码。 */
  providedStd?: string;
  /** 手动代码为教师权威；历史 AC 可能因旧数据薄弱而误 AC，必须独立验证。 */
  providedStdSource?: 'manual' | 'accepted-record';
  /** 教师补充要求（如“链表用类实现”“数据范围控制在 100 以内”） */
  extraRequirements?: string;
  /** Medium-risk direct fallback requires an explicit second confirmation. */
  confirmDirectFallback?: boolean;
}

/** AI 返回的单个测试点 */
export interface GeneratedCase {
  label?: string;
  input: string;
  output: string;
  /** 由服务端覆盖计划赋值，不信任 AI 自报档位。 */
  dataScale?: CaseDataScale;
}

export type TestCase = GeneratedCase;

/** AI 返回的 JSON 结构（解析后） */
export interface GenerationResponse {
  problemType: 'function' | 'traditional';
  /** 是否为填空题（完善代码） */
  isFillIn?: boolean;
  analysis?: string;
  /** 第一阶段从题面子任务表提取的规格；仅供沙箱分层生成路径使用。 */
  subtasks?: SubtaskSpec[];
  functionName?: string;
  templates?: Partial<Record<TemplateLang, string>>;
  stdSolution?: { language?: string; code: string };
  cases: GeneratedCase[];
  notes?: string;
  /** 说明的结构化载体；notes 仍保留原拼接文本供旧消费方使用。 */
  notesStructured?: StructuredGenerationNotes;
  /** 沙箱生成模式下用于构造输入的 Python 程序。 */
  generatorCode?: string;
  /** 沙箱生成模式下实际计算 .out 的可执行标程源码。 */
  oracleCode?: string;
  /** 沙箱标程的执行语言；缺失时保持 Python-only 兼容行为。 */
  oracleLanguage?: OracleLanguage;
  // ─ 以下为沙箱模式的验证制品载体，供 assemblePlan 决定文件写入与 origin ─
  /** 学生提交形式的解（函数题）：写入 std.py，供教师本地复验。 */
  solutions?: TemplateSolutions;
  /** Python 解的兼容别名；新函数题蓝图改从 solutions.py 读取。 */
  solutionCode?: string;
  /** 暴力解（对拍用）：写入 brute.py。 */
  bruteCode?: string;
  /** 输入校验器：写入 validator.py。 */
  validatorCode?: string;
  /** 各道机器关卡的验证结果，透传到 GenerationPlan.verification。 */
  verification?: PlanVerification;
  /** 内部字段：区分度验证与定向补刀共享的绝对截止时间，不进入最终计划。 */
  discriminationDeadlineAt?: number;
  /** 内部字段：通过题面样例烟测、可进入正式区分度与补刀阶段的错误解。 */
  discriminationKillTargets?: KillTarget[];
  /** 内部字段：补刀前正式测试点数量，用于识别并展示新增 hack 点。 */
  discriminationInitialCaseCount?: number;
}

/** AI 在沙箱模式下返回的生成蓝图；此阶段不让模型直接填写 .out。 */
export interface SandboxGenerationBlueprint {
  problemType: 'function' | 'traditional';
  isFillIn?: boolean;
  analysis?: string;
  /** 题面子任务规格；解析分节缺失或非法时为空数组，旧断点中可缺失。 */
  subtasks?: SubtaskSpec[];
  functionName?: string;
  templates?: Partial<Record<TemplateLang, string>>;
  generatorCode: string;
  oracleCode: string;        // 自包含 stdin→stdout 完整标程（Python 3 或 C++17）
  oracleLanguage?: OracleLanguage;
  solutions?: TemplateSolutions;
  /** Python 解的兼容别名；新函数题蓝图改从 solutions.py 读取。 */
  solutionCode?: string;     // 学生提交形式的解（函数题=函数/类；传统题可省略）
  /** 独立验证调用生成；兼容旧蓝图时也接受主调用中的同名分节。 */
  bruteCode?: string;        // 自包含完整程序的暴力解（读同一 stdin 编码）
  validatorCode?: string;    // 读一份 .in，合法 exit 0；非法 exit 非 0 并向 stderr 说明
  /** 仅用于内部小数据压力对拍，不写入题目文件。 */
  stressGeneratorCode?: string;
  /** 独立验证器声明：缺失时按存在复杂度差异处理，以兼容旧响应。 */
  complexityGap?: 'exists' | 'none';
  /** 独立验证调用把函数题题面样例转换为主蓝图确定的原始 stdin。 */
  functionSampleInputs?: Array<{ id: string; input: string }>;
  notes?: string;
}

/** 第一阶段只解决题目，不分散注意力去编写生成器或多语言模板。 */
export interface SandboxSolutionBlueprint {
  problemType: 'function' | 'traditional';
  isFillIn?: boolean;
  analysis?: string;
  /** 题面子任务规格；解析分节缺失或非法时为空数组，旧断点中可缺失。 */
  subtasks?: SubtaskSpec[];
  functionName?: string;
  oracleCode: string;
  oracleLanguage?: OracleLanguage;
  solutions?: TemplateSolutions;
  /** Python 解的兼容别名；新函数题蓝图改从 solutions.py 读取。 */
  solutionCode?: string;
  /** 第一阶段用于尽早回归函数题题面样例；最终仍以独立验证调用的转码为准。 */
  functionSampleInputs?: Array<{ id: string; input: string }>;
  notes?: string;
}

/** 第二阶段只生成输入与模板，必须复用第一阶段已经验证的算法与 stdin 编码。 */
export interface SandboxGenerationArtifacts {
  generatorCode: string;
  templates?: Partial<Record<TemplateLang, string>>;
  notes?: string;
}

/** 与 ORACLE 分开调用生成的验证制品，避免两份算法共享同一次推理错误。 */
export interface IndependentVerifierBlueprint {
  bruteCode: string;
  validatorCode: string;
  stressGeneratorCode: string;
  /** 独立验证器声明：该题是否存在明显更慢的朴素解法；缺失时维持现状。 */
  complexityGap?: 'exists' | 'none';
  functionSampleInputs?: Array<{ id: string; input: string }>;
}

export type KillTargetKind = 'boundary' | 'wrong-algorithm' | 'overflow-sim';

export interface KillTarget {
  kind: KillTargetKind;
  /** AI 对该错误解错误方式的一句话描述（面向教师展示）。 */
  description: string;
  /** 自包含 Python 程序，读 stdin 写 stdout，与 ORACLE 使用相同 IO 约定。 */
  code: string;
}

export interface SampleIO {
  input: string;
  output: string;
}

export interface HackCandidate {
  input: string;
  rationale: string;
}

/**
 * 文件可信来源：
 * - executed：沙箱实跑产生或被实跑的制品（最高可信）
 * - deterministic：服务端确定性生成（compile.sh/config.yaml/骨架占位）
 * - ai-only：AI 直出、未经执行验证
 */
export type PlannedFileOrigin = 'executed' | 'deterministic' | 'ai-only';

export interface DiscriminationTargetResult {
  kind: KillTargetKind | 'brute-complexity';
  description: string;
  killed: boolean;
  /** 命中方式：wa 为输出不一致或运行失败，tle 为执行超时。 */
  killedBy?: 'wa' | 'tle';
  /** 首个卡掉该靶子的正式测试点编号（从 1 开始）。 */
  killedByCase?: number;
  skippedReason?: 'custom-checker' | 'checker-infra-error' | 'budget-exhausted' | 'no-targets' | 'no-complexity-gap';
}

export interface DiscriminationCheck {
  targets: DiscriminationTargetResult[];
  /** 全部未跳过的错误解靶子与暴力复杂度检查均被卡住。 */
  allKilled: boolean;
}

/** 各道机器关卡的验证结果（前端据此渲染验证横幅与徽章）。 */
export interface PlanVerification {
  mode: 'sandbox' | 'direct';
  oracleKind: 'provided-std' | 'accepted-record' | 'ai-solution';
  /** 服务端记录的函数题所选模板语言；前端据此对缺失证据 fail closed。 */
  templateLanguages?: TemplateLang[];
  /** 服务端统一收口的权威验证结论。 */
  verified: boolean;
  /** observe 模式下表示同一证据在 enforce 中会被阻断。 */
  wouldBlock: boolean;
  /** 首选模型自动修复后仍失败，整条管线从下一配置模型重新运行并成功。 */
  modelEscalation?: { fromModel: string; toModel: string };
  sampleCheck?: { total: number; passed: number };
  bruteCheck?: { compared: number; agreed: number; skippedTimeout: number[]; disagreed: number[] };
  /** 独立 BRUTE 在内部小数据集上的强制对拍；压力阶段不允许超时跳过。 */
  stressCheck?: {
    generated: number;
    uniqueInputs: number;
    duplicateInputs: number;
    compared: number;
    agreed: number;
    droppedInvalid?: number;
    skippedReason?: 'custom-checker';
  };
  validator?: { ran: boolean; casesChecked: number };
  templateChecks?: TemplateChecks;
  checkerCheck?: CheckerVerificationCheck;
  discrimination?: DiscriminationCheck;
}

export interface StructuredGenerationNotes {
  /** 需要教师行动或注意的警告。 */
  warnings: string[];
  /** 系统验证事实。 */
  system: string[];
  /** AI 蓝图原始自述。 */
  ai?: string;
}

/** 组装后的单个待写入文件 */
export interface PlannedFile {
  name: string;
  content: string;
  /** 文件类别，前端据此分组展示 */
  kind: 'case-in' | 'case-out' | 'template' | 'compile' | 'config' | 'std' | 'generator' | 'brute' | 'validator';
  /** 文件可信来源徽章 */
  origin: PlannedFileOrigin;
}

/** 完整生成计划（返回给前端预览） */
export interface GenerationPlan {
  /** 独立于 job/problem/user 的本次质量遥测随机 UUID。 */
  runId: string;
  /** 生成提示契约的静态版本，不包含题面或模型响应。 */
  promptVersion: string;
  /** Observe-only ProblemSpec contract version. */
  specSchemaVersion?: number;
  /** Browser-safe summary; the complete spec and evidence locations are never persisted here. */
  problemSpecSummary?: ProblemSpecSummary;
  /** Browser-safe consensus outcome. Complete specs/conflicts remain request-local. */
  specConsensusStatus?: SpecConsensusStatus;
  specConflictCount?: number;
  unresolvedConflictCount?: number;
  modelRolesUsed?: TestdataModelRole[];
  /** 仅保存在 Hydro 本地，apply 时用于判断教师是否修改。 */
  originalFileHashes?: Record<string, string>;
  problemType: 'function' | 'traditional';
  /** 是否为填空题（完善代码） */
  isFillIn?: boolean;
  analysis?: string;
  notes?: string;
  /** 结构化说明；缺失时前端回退显示 legacy notes。 */
  notesStructured?: StructuredGenerationNotes;
  files: PlannedFile[];
  caseCount: number;
  /** 合并现有完整数字测试点后，config.yaml 中的总测试点数量。 */
  totalCaseCount?: number;
  /** 供教师在预览阶段检查每个测试点的覆盖目标。 */
  caseCoverage?: Array<{
    caseNumber: number;
    fileNumber: number;
    dataScale: CaseDataScale;
    subtaskId?: number;
    target: string;
  }>;
  tokenUsage?: TokenUsage;
  usedModel?: string;
  /**
   * 仅保存在 Hydro 本地，用于将模型角色与稳定本地身份转换为质量遥测。
   * 返回浏览器前必须移除；identity 只能经本地 HMAC 后离开实例。
   */
  modelTelemetry?: {
    role: 'primary' | 'fallback';
    identity: string;
  };
  /** 验证元数据；沙箱/直出模式提供，骨架模式与旧后端缺省。 */
  verification?: PlanVerification;
  /** Deterministic privacy-safe risk metadata for this generation request. */
  risk?: TestdataRiskAssessment;
  reliabilityMode?: TestdataReliabilityMode;
}

/** AI 响应解析选项；常规调用保持严格，服务层可先宽松解析再补齐缺失模板。 */
export interface ParseAiResponseOptions {
  allowMissingTemplates?: boolean;
}

// ─── 常量与校验 ───────────────────────────────────────────────────────────────

export const TESTDATA_GEN_LIMITS = {
  MIN_CASES: 1,
  MAX_CASES: 30,
  MAX_EXTRA_REQUIREMENTS: 1000,
  MAX_PROVIDED_STD: 10000,
  MAX_STATEMENT_LENGTH: STATEMENT_SNAPSHOT_HARD_LIMIT,
  /** apply 时单文件内容上限（字节） */
  MAX_FILE_SIZE: 256 * 1024,
  /** apply 时文件数量上限 */
  MAX_FILE_COUNT: 80,
  /** apply 时所有文件总大小上限（字节） */
  MAX_TOTAL_SIZE: 1024 * 1024,
  /** 沙箱生成器 stdout（JSON）上限。 */
  MAX_GENERATOR_OUTPUT_SIZE: 1024 * 1024,
  /** 独立验证器必须生成的内部小数据数量；这些数据不会写入 Hydro。 */
  STRESS_CASES: 60,
  /** 防止压力生成器用重复输入凑数；不足会进入独立验证器定向修复。 */
  STRESS_MIN_UNIQUE_RATIO: 0.8,
  /** 内部压力数据经输入校验后至少需存活的比例；不足仍进入独立验证器定向修复。 */
  STRESS_MIN_VALID_RATIO: 0.75,
} as const;

/** 把压力数据的输入校验结果分成可继续对拍与需剔除两组，并判断存活数是否足够。 */
export function partitionStressValidation(input: {
  stressResults: Array<{
    accepted: boolean;
    stderr?: string;
    error?: string;
    status?: string;
  }>;
  minValidRatio: number;
}): {
  keptIndices: number[];
  dropped: Array<{ index: number; reason: string }>;
  sufficient: boolean;
} {
  const keptIndices: number[] = [];
  const dropped: Array<{ index: number; reason: string }> = [];
  input.stressResults.forEach((result, index) => {
    if (result.accepted) {
      keptIndices.push(index);
      return;
    }
    dropped.push({
      index,
      reason: result.stderr || result.error || result.status || 'Unknown',
    });
  });
  const minimumKept = Math.ceil(input.stressResults.length * input.minValidRatio);
  return {
    keptIndices,
    dropped,
    sufficient: keptIndices.length >= minimumKept,
  };
}

/** 非关键错误解分析不得无限阻塞正确性管线。 */
const KILL_TARGET_AI_TIMEOUT_MS = 120_000;

/** 合法测试数据文件名：字母数字、点、下划线、连字符，不允许路径分隔符 */
const SAFE_FILENAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function isSafeTestdataFilename(name: string): boolean {
  if (!SAFE_FILENAME_RE.test(name)) return false;
  // 防御 "..": 虽然正则不允许 "/"，仍显式排除路径穿越形态
  if (name.includes('..')) return false;
  return true;
}

/** 校验生成选项，返回错误 key（用于 i18n）或 null */
export function validateGenerateOptions(options: GenerateOptions): string | null {
  if (!['auto', 'traditional', 'function'].includes(options.problemKind)) {
    return 'ai_helper_testdata_err_invalid_kind';
  }
  if (
    !Number.isInteger(options.caseCount)
    || options.caseCount < TESTDATA_GEN_LIMITS.MIN_CASES
    || options.caseCount > TESTDATA_GEN_LIMITS.MAX_CASES
  ) {
    return 'ai_helper_testdata_err_invalid_case_count';
  }
  if (!Array.isArray(options.languages) || options.languages.some(l => !SUPPORTED_TEMPLATE_LANGS.includes(l))) {
    return 'ai_helper_testdata_err_invalid_languages';
  }
  // auto 模式下 AI 可能判定为函数题，同样需要模板语言
  if (options.problemKind !== 'traditional' && options.languages.length === 0) {
    return 'ai_helper_testdata_err_no_languages';
  }
  if (options.fillInMode !== undefined && !['auto', 'yes', 'no'].includes(options.fillInMode)) {
    return 'ai_helper_testdata_err_invalid_fill_in';
  }
  if (options.dataScale !== undefined && !['auto', 'small', 'medium', 'large'].includes(options.dataScale)) {
    return 'ai_helper_testdata_err_invalid_scale';
  }
  if ((options.providedStd || '').length > TESTDATA_GEN_LIMITS.MAX_PROVIDED_STD) {
    return 'ai_helper_testdata_err_std_too_long';
  }
  if ((options.extraRequirements || '').length > TESTDATA_GEN_LIMITS.MAX_EXTRA_REQUIREMENTS) {
    return 'ai_helper_testdata_err_extra_too_long';
  }
  return null;
}

const COVERAGE_GUIDANCE: Record<CaseDataScale, string> = {
  small: '合法最小值、题面样例或可人工验算的简单结构；不得为了取 0/空输入而违反题面下界',
  medium: '约束范围的中间量级，并交叉变化不同约束，避免所有维度同时按同一比例缩放',
  large: '至少一个关键约束接近上下界或临界值；使用可解析结构并控制输出体积与沙箱耗时',
};

/**
 * 为一次生成建立确定性的规模计划。auto 在 caseCount>=3 时保证三个档位均出现，
 * 其余名额按 30%/40%/30% 的目标比例用最大缺口法分配。
 */
export function buildCoveragePlan(caseCount: number, strategy: DataScale = 'auto'): CoverageSlot[] {
  if (!Number.isInteger(caseCount) || caseCount <= 0) return [];
  let scales: CaseDataScale[];
  if (strategy !== 'auto') {
    scales = Array.from({ length: caseCount }, () => strategy);
  } else if (caseCount === 1) {
    scales = ['small'];
  } else if (caseCount === 2) {
    scales = ['small', 'large'];
  } else {
    const desired: Record<CaseDataScale, number> = {
      small: caseCount * 0.3,
      medium: caseCount * 0.4,
      large: caseCount * 0.3,
    };
    const counts: Record<CaseDataScale, number> = {
      small: Math.max(1, Math.floor(desired.small)),
      medium: Math.max(1, Math.floor(desired.medium)),
      large: Math.max(1, Math.floor(desired.large)),
    };
    const priority: CaseDataScale[] = ['medium', 'small', 'large'];
    while (counts.small + counts.medium + counts.large < caseCount) {
      const next = priority.reduce((best, scale) => (
        desired[scale] - counts[scale] > desired[best] - counts[best] ? scale : best
      ), priority[0]);
      counts[next]++;
    }
    while (counts.small + counts.medium + counts.large > caseCount) {
      const next = [...priority].reverse().reduce((best, scale) => (
        counts[scale] > 1 && counts[scale] - desired[scale] > counts[best] - desired[best] ? scale : best
      ), counts.large > 1 ? 'large' : counts.medium > 1 ? 'medium' : 'small' as CaseDataScale);
      counts[next]--;
    }
    scales = [
      ...Array.from({ length: counts.small }, () => 'small' as const),
      ...Array.from({ length: counts.medium }, () => 'medium' as const),
      ...Array.from({ length: counts.large }, () => 'large' as const),
    ];
  }
  return scales.map((dataScale, index) => ({
    caseNumber: index + 1,
    dataScale,
    guidance: COVERAGE_GUIDANCE[dataScale],
  }));
}

/**
 * 为题面子任务建立确定性测试点分配：每个子任务先获得一个测试点，
 * 剩余名额按分值目标使用最大缺口法分配；同缺口时保持题面 id 顺序。
 */
export function allocateCasesToSubtasks(
  caseCount: number,
  subtasks: SubtaskSpec[],
): SubtaskCaseAllocation[] {
  if (!Number.isInteger(caseCount) || caseCount < subtasks.length || subtasks.length === 0) return [];
  let previousId = 0;
  if (subtasks.some(subtask => {
    const invalid = !Number.isSafeInteger(subtask.id)
      || subtask.id <= previousId
      || !Number.isSafeInteger(subtask.score)
      || subtask.score <= 0
      || !subtask.constraints.trim();
    previousId = subtask.id;
    return invalid;
  })) return [];

  const totalScore = subtasks.reduce((sum, subtask) => sum + subtask.score, 0);
  if (!Number.isSafeInteger(totalScore) || totalScore <= 0) return [];
  const counts = subtasks.map(() => 1);
  const desiredExtras = subtasks.map(subtask => (
    (caseCount - subtasks.length) * subtask.score / totalScore
  ));
  for (let assigned = 0; assigned < caseCount - subtasks.length; assigned++) {
    const next = subtasks.reduce((best, _subtask, index) => (
      desiredExtras[index] - (counts[index] - 1)
        > desiredExtras[best] - (counts[best] - 1)
        ? index
        : best
    ), 0);
    counts[next]++;
  }

  const allocations: SubtaskCaseAllocation[] = [];
  for (let index = 0; index < subtasks.length; index++) {
    const subtask = subtasks[index];
    for (let count = 0; count < counts[index]; count++) {
      allocations.push({
        caseNumber: allocations.length + 1,
        subtaskId: subtask.id,
        guidance: `${subtask.constraints};数据必须严格满足本子任务的全部约束;应包含该档位下的边界/极端情形`,
      });
    }
  }
  return allocations;
}

/**
 * 补刀等后续阶段追加测试点时，前 N 个 case 的「构造档位 ↔ 配置归档」对应关系必须保持不变，
 * 否则按某档约束构造的输入会被归入另一档、破坏子任务约束契约。
 * 追加项一律归入最后一个子任务：这里采用 OI 题“最后一档约束最宽”的通行约定，
 * 组装阶段会同时写入人工复核警告，提示教师核对追加输入是否确实符合该档约束；
 * 原分配为空或总数反而变少时返回空数组（调用方降级为扁平配置）。
 */
export function extendTieredAllocations(
  base: SubtaskCaseAllocation[],
  totalCaseCount: number,
  subtasks: SubtaskSpec[],
): SubtaskCaseAllocation[] {
  if (totalCaseCount === base.length) return base;
  if (base.length === 0 || totalCaseCount < base.length || subtasks.length === 0) return [];
  const last = subtasks[subtasks.length - 1];
  const appended = Array.from({ length: totalCaseCount - base.length }, (_, index) => ({
    caseNumber: base.length + index + 1,
    subtaskId: last.id,
    guidance: last.constraints,
  }));
  return [...base, ...appended];
}

interface ExistingNumericCases {
  reserved: Set<number>;
  complete: number[];
}

/** 提取数字测试点状态：任一侧存在即保留编号，只有 in/out 成对才进入 config。 */
export function getExistingNumericCases(existingFiles: string[] = []): ExistingNumericCases {
  const sides = new Map<number, Set<'in' | 'out'>>();
  for (const name of existingFiles) {
    const match = name.match(/^(\d+)\.(in|out)$/i);
    if (!match) continue;
    const number = Number(match[1]);
    if (!Number.isSafeInteger(number) || number <= 0) continue;
    if (!sides.has(number)) sides.set(number, new Set());
    sides.get(number)?.add(match[2].toLowerCase() as 'in' | 'out');
  }
  const reserved = new Set(sides.keys());
  const complete = [...sides.entries()]
    .filter(([, value]) => value.has('in') && value.has('out'))
    .map(([number]) => number)
    .sort((a, b) => a - b);
  return { reserved, complete };
}

/** 分配不与任何现有 .in/.out 冲突的最小正整数编号。 */
export function allocateCaseNumbers(existingFiles: string[] = [], count: number): number[] {
  const { reserved } = getExistingNumericCases(existingFiles);
  const allocated: number[] = [];
  for (let candidate = 1; allocated.length < count; candidate++) {
    if (reserved.has(candidate)) continue;
    allocated.push(candidate);
    reserved.add(candidate);
  }
  return allocated;
}

/** 根据标准答案代码猜测 std 文件扩展名（教师多用 Python，启发式足够） */
export function detectStdFilename(code: string): string {
  if (/(?:^|\r?\n)\s*```(?:cpp|c\+\+)[ \t]*(?:\r?\n|$)/i.test(code)) return 'std.cc';
  if (/#include\s*[<"]/.test(code)) return 'std.cc';
  if (/\bpublic\s+(static\s+)?class\b|\bpublic\s+class\b|\bSystem\.out\./.test(code)) return 'std.java';
  return 'std.py';
}

// ─── 确定性文件生成（不经过 AI） ──────────────────────────────────────────────

/** HydroOJ 语言族 → config.yaml langs 白名单条目 */
const LANG_FAMILY_CODES: Record<TemplateLang, string[]> = {
  // 保留 Hydro 的通用键，同时覆盖当前主流运行时；Python 2 已在 Hydro 默认配置中禁用。
  py: ['py', 'py.py3', 'py.pypy3'],
  java: ['java'],
  // 函数题模板统一为 C++，开放仍在主流使用的 C++14/17/20 及 O2 变体。
  cc: ['cc', 'cc.cc14', 'cc.cc14o2', 'cc.cc17', 'cc.cc17o2', 'cc.cc20', 'cc.cc20o2'],
};

/** 语言族 → 模板文件名 */
export const TEMPLATE_FILENAMES: Record<TemplateLang, string> = {
  py: 'template.py',
  java: 'template.java',
  cc: 'template.cc',
};

/**
 * 生成 compile.sh
 *
 * HydroOJ 评测机制：user_extra_files 中的文件会与学生代码一起放入编译目录，
 * 若存在 compile.sh 则用 `/bin/bash compile.sh` 取代默认编译命令，
 * 环境变量 HYDRO_LANG 为语言键（如 py.py3 / java / cc.cc14o2）。
 * 各语言编译产物需与默认执行命令匹配：
 * - py*:   学生代码为 foo.py，模板追加其后，py_compile 产出 /w/foo
 * - java:  学生代码为 Main.java（类名 Solution），换名后与模板 Main 一起编译进 Main.jar
 * - cc*:   学生代码为 foo.cc，模板 template.cc 通过 #include "foo.cc" 引入，产出 foo
 */
export function buildCompileSh(languages: TemplateLang[]): string {
  if (languages.length === 0) {
    throw new Error('生成 compile.sh 至少需要一种模板语言');
  }
  const branches: string[] = [];
  if (languages.includes('py')) {
    branches.push(
      `if [[ "$HYDRO_LANG" == py* ]]; then
  cat template.py >>foo.py
  if [[ "$HYDRO_LANG" == "py.pypy3" ]]; then
    mv foo.py /w/foo
  else
    python3 -c "import py_compile; py_compile.compile('/w/foo.py', '/w/foo', doraise=True)"
  fi`,
    );
  }
  if (languages.includes('java')) {
    branches.push(
      `if [[ "$HYDRO_LANG" == java* ]]; then
  mv Main.java Solution.java
  mv template.java Main.java
  javac -d /w -encoding utf8 ./Main.java ./Solution.java
  jar cvf Main.jar *.class >/dev/null`,
    );
  }
  if (languages.includes('cc')) {
    branches.push(
      `if [[ "$HYDRO_LANG" == cc* ]]; then
  CPP_STD=c++14
  CPP_OPT=""
  case "$HYDRO_LANG" in
    cc.cc17|cc.cc17o2) CPP_STD=c++17 ;;
    cc.cc20|cc.cc20o2) CPP_STD=c++20 ;;
  esac
  if [[ "$HYDRO_LANG" == *o2 ]]; then CPP_OPT="-O2"; fi
  g++ -x c++ template.cc -o foo -lm -fno-stack-limit -std="$CPP_STD" $CPP_OPT -I/include`,
    );
  }
  // 将多个 if 块拼成 if/elif 链
  const chain = branches
    .map((b, i) => (i === 0 ? b : b.replace(/^if /, 'elif ')))
    .join('\n');
  return `#!/bin/bash

set -e
${chain}
else
  echo "Unsupported language: $HYDRO_LANG" >&2
  exit 1
fi
`;
}

export interface BuildConfigYamlOptions {
  problemType: 'function' | 'traditional';
  caseCount: number;
  languages: TemplateLang[];
  /** 指定实际文件编号；缺省时保持 1..caseCount 的旧行为。 */
  caseNumbers?: number[];
  /** 本次新分配的文件编号；用于安全并入既有显式 cases 子任务。 */
  newCaseNumbers?: number[];
  /** 现有 pdoc.config；保留 checker/time/memory 等非测试点设置。 */
  existingConfig?: string;
  /** 四项启用条件全部满足后，由题面子任务表解析得到。 */
  subtasks?: SubtaskSpec[];
  /** 本次新测试点在子任务之间的确定性分配。 */
  subtaskAllocations?: SubtaskCaseAllocation[];
}

export const TESTDATA_CONFIG_UNPARSABLE_KEY = 'ai_helper_testdata_err_config_unparsable';
const TESTDATA_CONFIG_UNPARSABLE_MESSAGE = '现有 config.yaml 无法解析,为避免覆盖丢失配置已中止;请先修复或删除该文件后重试';

function loadExistingProblemConfig(raw?: string): unknown {
  if (!raw?.trim()) return undefined;
  try {
    return yaml.load(raw);
  } catch {
    throw new TestdataGenerationError(
      TESTDATA_CONFIG_UNPARSABLE_MESSAGE,
      'config_parse',
      [],
      false,
      TESTDATA_CONFIG_UNPARSABLE_KEY,
    );
  }
}

/** 非空既有配置若无法解析必须硬失败，避免后续生成覆盖教师原配置。 */
export function assertExistingConfigParsable(raw?: string): void {
  loadExistingProblemConfig(raw);
}

function parseExistingProblemConfig(raw?: string): Record<string, unknown> {
  const parsed = loadExistingProblemConfig(raw);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

function hasConfiguredSubtasks(config: Record<string, unknown>): boolean {
  return Array.isArray(config.subtasks) && config.subtasks.length > 0;
}

/**
 * 分层生成的唯一门控：题面子任务、既有配置、规模策略与测试点数量必须同时满足。
 * 仅“测试点不足”向教师给出可操作警告，其余条件保持现状静默回退。
 */
export function resolveTieredSubtaskGeneration(input: {
  caseCount: number;
  dataScale?: DataScale;
  subtasks?: SubtaskSpec[];
  existingConfig?: string;
}): TieredSubtaskGenerationDecision {
  const subtasks = input.subtasks || [];
  if (subtasks.length === 0) return { enabled: false, allocations: [] };
  const previous = parseExistingProblemConfig(input.existingConfig);
  if (hasConfiguredSubtasks(previous)) return { enabled: false, allocations: [] };
  if ((input.dataScale || 'auto') !== 'auto') return { enabled: false, allocations: [] };
  const scoreTotal = subtasks.reduce((sum, subtask) => sum + subtask.score, 0);
  if (scoreTotal !== 100) {
    return {
      enabled: false,
      allocations: [],
      warning: `子任务分值合计为 ${scoreTotal},非 100,已按普通模式输出配置`,
    };
  }
  if (input.caseCount < subtasks.length) {
    return {
      enabled: false,
      allocations: [],
      warning: `题面含 ${subtasks.length} 个子任务但仅请求 ${input.caseCount} 个测试点,`
        + `已按普通模式生成;建议将测试点数提高到 ≥${subtasks.length} 后重新生成以获得分层数据`,
    };
  }
  const allocations = allocateCasesToSubtasks(input.caseCount, subtasks);
  return allocations.length === input.caseCount
    ? {
      enabled: true,
      allocations,
      subtasks: subtasks.map(subtask => ({ ...subtask })),
    }
    : { enabled: false, allocations: [] };
}

function cloneConfigValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(item => cloneConfigValue(item)) as T;
  }
  if (value instanceof Date) {
    return new Date(value.getTime()) as T;
  }
  if (value && typeof value === 'object') {
    const cloned: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      cloned[key] = cloneConfigValue(item);
    }
    return cloned as T;
  }
  return value;
}

export interface ConfigSubtaskMergeNote {
  kind: 'warning' | 'system';
  message: string;
}

export interface ConfigSubtaskMergeResult {
  subtasks: unknown[];
  note?: ConfigSubtaskMergeNote;
  /** 最终文件编号到既有子任务数字 id（无数字 id 时使用 1-based 位置）的映射。 */
  newCaseSubtaskIds: Record<number, number>;
}

function normalizeCaseNumbers(caseNumbers: number[]): number[] {
  return [...new Set(caseNumbers)].sort((a, b) => a - b);
}

/** 保留既有子任务；仅在全部子任务均为显式 cases 写法时安全追加新测试点。 */
export function mergeConfigSubtasks(
  existingSubtasks: unknown,
  newCaseNumbers: number[],
): ConfigSubtaskMergeResult | undefined {
  if (!Array.isArray(existingSubtasks) || existingSubtasks.length === 0) return undefined;
  const subtasks = cloneConfigValue(existingSubtasks);
  const numbers = normalizeCaseNumbers(newCaseNumbers);
  if (numbers.length === 0) return { subtasks, newCaseSubtaskIds: {} };

  const allExplicitCases = subtasks.every(subtask =>
    !!subtask
    && typeof subtask === 'object'
    && !Array.isArray(subtask)
    && Array.isArray((subtask as Record<string, unknown>).cases));
  // 生成说明一直由 service 以中文写入 plan.notes；子任务说明保持同一约定，
  // 不走 locale key，避免同一份服务端说明中中英文混杂。
  const caseLabels = numbers.map(number => `#${number}`).join('、');
  if (!allExplicitCases) {
    return {
      subtasks,
      note: {
        kind: 'warning',
        message: `该题已配置子任务;本次新增测试点 ${caseLabels} 未纳入任何子任务,评测不会使用它们,请手动调整 config.yaml。`,
      },
      newCaseSubtaskIds: {},
    };
  }

  const lastIndex = subtasks.length - 1;
  const lastSubtask = subtasks[lastIndex] as Record<string, unknown>;
  lastSubtask.cases = [
    ...(lastSubtask.cases as unknown[]),
    ...numbers.map(number => ({
      input: `${number}.in`,
      output: `${number}.out`,
    })),
  ];
  const configuredId = lastSubtask.id;
  const subtaskId = typeof configuredId === 'string' || typeof configuredId === 'number'
    ? configuredId
    : lastIndex + 1;
  const numericSubtaskId = typeof configuredId === 'number' && Number.isSafeInteger(configuredId)
    ? configuredId
    : typeof configuredId === 'string' && /^\d+$/.test(configuredId)
      ? Number(configuredId)
      : lastIndex + 1;
  return {
    subtasks,
    note: {
      kind: 'system',
      message: `新增测试点 ${caseLabels} 已并入子任务 ${subtaskId},请核对分值分配。`,
    },
    newCaseSubtaskIds: Object.fromEntries(numbers.map(number => [number, numericSubtaskId])),
  };
}

interface TieredConfigSubtasks {
  subtasks: Array<{
    id: number;
    score: number;
    type: 'sum';
    cases: Array<{ input: string; output: string }>;
  }>;
  notes: ConfigSubtaskMergeNote[];
}

function buildTieredConfigSubtasks(
  specs: SubtaskSpec[] | undefined,
  allocations: SubtaskCaseAllocation[] | undefined,
  caseNumbers: number[],
  newCaseNumbers: number[],
): TieredConfigSubtasks | undefined {
  if (
    !specs?.length
    || allocations?.length !== newCaseNumbers.length
    || allocations.length === 0
    || specs.reduce((sum, spec) => sum + spec.score, 0) !== 100
  ) return undefined;
  const byId = new Map(specs.map(spec => [
    spec.id,
    [] as Array<{ input: string; output: string }>,
  ]));
  const allocationNumbers = new Set<number>();
  for (const allocation of allocations) {
    if (
      !byId.has(allocation.subtaskId)
      || allocation.caseNumber < 1
      || allocation.caseNumber > newCaseNumbers.length
      || allocationNumbers.has(allocation.caseNumber)
    ) return undefined;
    allocationNumbers.add(allocation.caseNumber);
  }
  if (allocationNumbers.size !== newCaseNumbers.length) return undefined;

  const newNumberSet = new Set(newCaseNumbers);
  const existingNumbers = caseNumbers.filter(number => !newNumberSet.has(number));
  const firstCases = byId.get(specs[0].id);
  if (!firstCases) return undefined;
  firstCases.push(...existingNumbers.map(number => ({
    input: `${number}.in`,
    output: `${number}.out`,
  })));
  for (const allocation of allocations) {
    const number = newCaseNumbers[allocation.caseNumber - 1];
    byId.get(allocation.subtaskId)?.push({
      input: `${number}.in`,
      output: `${number}.out`,
    });
  }

  const notes: ConfigSubtaskMergeNote[] = [];
  if (existingNumbers.length > 0) {
    notes.push({
      kind: 'warning',
      message: `既有完整测试点 ${existingNumbers.map(number => `#${number}`).join('、')}`
        + ` 已并入子任务 ${specs[0].id},请人工复核其子任务归属。`,
    });
  }
  return {
    subtasks: specs.map(spec => ({
      id: spec.id,
      score: spec.score,
      type: 'sum',
      cases: byId.get(spec.id) || [],
    })),
    notes,
  };
}

interface RawYamlEntrySpan {
  start: number;
  end: number;
  text: string;
}

function findRawTopLevelYamlEntry(raw: string, key: string): RawYamlEntrySpan | undefined {
  const lines: Array<{ start: number; end: number; content: string }> = [];
  let start = 0;
  while (start < raw.length) {
    const lineFeed = raw.indexOf('\n', start);
    const end = lineFeed < 0 ? raw.length : lineFeed + 1;
    const withEnding = raw.slice(start, end);
    lines.push({
      start,
      end,
      content: withEnding.replace(/\r?\n$/, ''),
    });
    start = end;
  }
  const entryIndex = lines.findIndex(line =>
    new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`).test(line.content));
  if (entryIndex < 0) return undefined;
  let end = lines[entryIndex].end;
  for (let index = entryIndex + 1; index < lines.length; index++) {
    const line = lines[index];
    if (line.content.trim() === '' || /^[ \t]/.test(line.content)) {
      end = line.end;
      continue;
    }
    break;
  }
  return {
    start: lines[entryIndex].start,
    end,
    text: raw.slice(lines[entryIndex].start, end),
  };
}

/** 提取顶层 YAML mapping entry 原文，供保留教师注释与手写格式。 */
export function extractRawTopLevelYamlEntry(raw: string, key: string): string | undefined {
  return findRawTopLevelYamlEntry(raw, key)?.text;
}

function spliceRawTopLevelYamlEntry(
  generated: string,
  existing: string,
  key: string,
): string | undefined {
  const generatedEntry = findRawTopLevelYamlEntry(generated, key);
  const existingEntry = findRawTopLevelYamlEntry(existing, key);
  if (!generatedEntry || !existingEntry) return undefined;
  const suffix = generated.slice(generatedEntry.end);
  const rawEntry = suffix
    && !existingEntry.text.endsWith('\n')
    ? `${existingEntry.text}\n`
    : existingEntry.text;
  return generated.slice(0, generatedEntry.start)
    + rawEntry
    + suffix;
}

/** 判断现有题目是否使用非 default/strict 的自定义 checker。 */
export function hasCustomChecker(raw?: string): boolean {
  const config = parseExistingProblemConfig(raw);
  const checkerType = typeof config.checker_type === 'string' ? config.checker_type.trim().toLowerCase() : '';
  const checker = typeof config.checker === 'string' ? config.checker.trim() : '';
  return (!!checkerType && !['default', 'strict'].includes(checkerType))
    || (!!checker && !['default', 'strict'].includes(checkerType));
}

/** 仅精确支持 testlib；其他 checker 类型由风险门禁拒绝降级。 */
export function getTestlibCheckerFilename(raw?: string): string | undefined {
  const config = parseExistingProblemConfig(raw);
  const checkerType = typeof config.checker_type === 'string'
    ? config.checker_type.trim().toLowerCase()
    : '';
  const checker = typeof config.checker === 'string' ? config.checker.trim() : '';
  return checkerType === 'testlib' && checker ? checker : undefined;
}

function completeStatementForGenerationPrompt(statementMarkdown: string): string {
  return createStatementSnapshot(statementMarkdown).normalizedMarkdown;
}

/**
 * 生成 config.yaml（评测设置）
 *
 * 写入名为 config.yaml 的测试数据后，HydroOJ 会自动将其内容同步到
 * 题目的评测设置（pdoc.config），无需再手动到「评测设置」页保存。
 */
function buildConfigYamlWithMetadata(options: BuildConfigYamlOptions): {
  content: string;
  subtaskNotes: ConfigSubtaskMergeNote[];
  newCaseSubtaskIds: Record<number, number>;
} {
  const { problemType, caseCount, languages } = options;
  const previous = parseExistingProblemConfig(options.existingConfig);
  const caseNumbers = options.caseNumbers?.length
    ? normalizeCaseNumbers(options.caseNumbers)
    : Array.from({ length: caseCount }, (_, i) => i + 1);
  const newCaseNumbers = options.newCaseNumbers === undefined
    ? caseNumbers
    : normalizeCaseNumbers(options.newCaseNumbers);
  const cases = caseNumbers.map(number => ({
    input: `${number}.in`,
    output: `${number}.out`,
  }));

  // Existing top-level judge settings belong to the problem owner. Clone the
  // complete document, then overwrite only fields managed by this generator.
  const config = cloneConfigValue(previous);
  if (!config.type) config.type = 'default';

  const previousUserExtraFiles = Array.isArray(previous.user_extra_files)
    ? previous.user_extra_files.filter((item): item is string => typeof item === 'string')
    : [];

  if (problemType === 'function') {
    const userExtraFiles = languages.map(l => TEMPLATE_FILENAMES[l]);
    userExtraFiles.push('compile.sh');
    config.user_extra_files = [...new Set([...previousUserExtraFiles, ...userExtraFiles])];
  } else if (previousUserExtraFiles.length > 0) {
    config.user_extra_files = previousUserExtraFiles;
  }

  const tieredSubtasks = !hasConfiguredSubtasks(previous)
    ? buildTieredConfigSubtasks(
      options.subtasks,
      options.subtaskAllocations,
      caseNumbers,
      newCaseNumbers,
    )
    : undefined;
  const subtaskMerge = tieredSubtasks
    ? undefined
    : mergeConfigSubtasks(previous.subtasks, newCaseNumbers);
  config.subtasks = tieredSubtasks?.subtasks ?? subtaskMerge?.subtasks ?? [{
      score: 100,
      if: [],
      id: 1,
      type: 'sum',
      cases,
    }];

  if (problemType === 'function') {
    config.langs = languages.flatMap(l => LANG_FAMILY_CODES[l]);
  } else if (Array.isArray(previous.langs)) {
    config.langs = previous.langs;
  }

  let content = yaml.dump(config, { lineWidth: 120, noRefs: true });
  if (
    subtaskMerge
    && subtaskMerge.note?.kind !== 'system'
    && options.existingConfig
  ) {
    content = spliceRawTopLevelYamlEntry(
      content,
      options.existingConfig,
      'subtasks',
    ) ?? content;
  }
  return {
    content,
    subtaskNotes: tieredSubtasks?.notes
      ?? (subtaskMerge?.note ? [subtaskMerge.note] : []),
    newCaseSubtaskIds: subtaskMerge?.newCaseSubtaskIds ?? {},
  };
}

export function buildConfigYaml(options: BuildConfigYamlOptions): string {
  return buildConfigYamlWithMetadata(options).content;
}

// ─── 提示词构建 ───────────────────────────────────────────────────────────────

/** 函数题参考模板：普通函数题（Python 驱动） */
const REF_TEMPLATE_PY_FUNCTION = `
timeSeries = list(map(int, input().split()))
duration = int(input())
print(findPoisonedDuration(timeSeries, duration))
`;

/** 函数题参考模板：类实现链表题（Python 驱动） */
const REF_TEMPLATE_PY_LINKEDLIST = `
class ListNode:
    def __init__(self, val=0, next=None):
        self.val = val
        self.next = next

def build_linked_list(values):
    if not values:
        return None
    head = ListNode(values[0])
    current = head
    for val in values[1:]:
        current.next = ListNode(val)
        current = current.next
    return head

def linked_list_to_array(head):
    values = []
    current = head
    while current:
        values.append(current.val)
        current = current.next
    return values

line = input().strip()
values = list(map(int, line.split())) if line else []
head = build_linked_list(values)
result_head = reverseList(head)
print(' '.join(map(str, linked_list_to_array(result_head))))
`;

/** 函数题参考模板：Java 驱动（学生提交 class Solution） */
const REF_TEMPLATE_JAVA = `
import java.util.*;

public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        int[] timeSeries = Arrays.stream(sc.nextLine().trim().split("\\\\s+"))
                .mapToInt(Integer::parseInt).toArray();
        int duration = Integer.parseInt(sc.nextLine().trim());
        Solution sol = new Solution();
        System.out.println(sol.findPoisonedDuration(timeSeries, duration));
    }
}
`;

/** 函数题参考模板：C++ 驱动（通过 #include "foo.cc" 引入学生代码） */
const REF_TEMPLATE_CC = `
#include <bits/stdc++.h>
using namespace std;
#include "foo.cc"

int main() {
    string line;
    getline(cin, line);
    istringstream iss(line);
    vector<int> timeSeries;
    int x;
    while (iss >> x) timeSeries.push_back(x);
    int duration;
    cin >> duration;
    cout << findPoisonedDuration(timeSeries, duration) << endl;
    return 0;
}
`;

const LANG_DISPLAY: Record<TemplateLang, string> = {
  py: 'Python (template.py)',
  java: 'Java (template.java)',
  cc: 'C++ (template.cc)',
};

/**
 * 构建 System Prompt
 */
export function buildTestdataSystemPrompt(): string {
  return `你是一位资深的 OJ（在线评测系统）出题与测试数据专家，服务对象是高中信息技术教师。你的任务是根据 Markdown 题面，为 HydroOJ 生成一套完整、正确的测试数据。

【题型判定】
- traditional（传统题）：学生编写完整程序，从标准输入读取、向标准输出打印。
- function（函数题，LeetCode 风格）：题面通常包含"代码写到函数内部"或给出函数签名（如 def xxx(...)），学生只提交函数/类实现，由评测模板负责读输入、调用函数、打印结果。
若用户指定了题型则以用户为准；用户选择 auto 时由你根据题面判断。

【填空题（完善代码）判定】
填空题与传统/函数题正交：题面中给出一段待完善的代码，学生补全空缺处后提交完整代码。
- 判定特征：题面代码含下划线空位（如 ________1________）、"完善代码/补全/代码段自己写/your code here/TODO" 等标记，或标题含"完善代码/填空"。
- isFillIn 为 true 时的铁律：标程 stdSolution 必须是【将题面代码原样补全】得到的代码——保持题面代码的整体结构、变量名、读入方式与所有 print 语句的格式【完全不变】，只填补空缺处。测试点的 .out 必须与该补全代码的真实输出一致（学生按题面补全后必须能通过全部测试点）。严禁自行改写输出格式、增删打印内容、调整打印顺序。
- 填空题的题型判定看题面代码本身：是读 stdin 的完整程序 → traditional；只是函数定义、由模板调用 → function。
- 若题面代码中有注释形式的提示文字（如 print(c)  #"共有...个"），以实际代码为准（该例只输出 c 的值，注释不属于输出）。
若用户明确指定了是否填空题，以用户为准；否则由你判断并在 isFillIn 字段中给出结论。

【外部参考代码】
若用户消息中提供了代码，必须按来源标签区分：
- “教师提供的标准答案（手动）”是唯一权威：每个测试点的 .out 和输出格式都以它为准。
- “历史 AC 候选解”不是正确性证明：旧测试数据可能薄弱。可把它作为待验证 ORACLE，但必须接受题面样例和独立 BRUTE 压力对拍，禁止要求 BRUTE 迁就它。
- 系统会直接使用所提供代码；函数题模板必须与其函数签名、调用方式兼容。

【函数题评测机制（HydroOJ）】
- Python：学生代码保存为 foo.py，评测时把 template.py 追加到学生代码末尾后整体运行。因此 template.py 只包含"读输入 → 调用学生函数 → 打印结果"的驱动代码，不包含函数实现本身。
- Java：学生提交 class Solution（不含 public 修饰的文件级要求），模板 template.java 为 public class Main，负责读输入并调用 new Solution().方法(...)。
- C++：学生代码保存为 foo.cc，template.cc 以 #include "foo.cc" 引入学生代码并实现 main()。
参考模板（普通函数题，题目为"提莫攻击"，函数 findPoisonedDuration(timeSeries, duration)）：
--- template.py ---${REF_TEMPLATE_PY_FUNCTION}
--- template.java ---${REF_TEMPLATE_JAVA}
--- template.cc ---${REF_TEMPLATE_CC}
链表类函数题的 Python 模板参考（题目为"反转链表"，学生实现 reverseList(head)，链表用类实现）：
--- template.py（链表） ---${REF_TEMPLATE_PY_LINKEDLIST}
若题面或教师要求"链表用列表（数组）实现"，模板则直接以 Python 列表传参，不构建节点类。
若题面给出的是类方法签名（LeetCode 常见形式，如 class Solution: def xxx(self, s, k)），学生提交的是完整的 Solution 类：Python 模板通过 Solution().xxx(...) 调用；Java 模板本就调用 new Solution().xxx(...)；C++ 模板相应以 Solution().xxx(...) 调用。此时标程也必须写成同样的类形式。
模板中的输入解析必须与你设计的 .in 文件格式严格一致；多语言模板之间的输入解析和输出格式必须完全等价，保证同一份 .in 在三种语言下输出一致。

【.in 文件是原始标准输入，不是代码】
- CASE:IN 节必须只包含程序运行时真正从 stdin 读到的字符。严禁写变量名、赋值号、语言字面量或说明文字。
- 例如参数 s="1010101"、k=2，正确的 .in 是两行原始值：第一行 1010101，第二行 2；严禁写成 s = "1010101" / k = 2。
- 数组按模板约定写成空格分隔的元素。例如 timeSeries=[1,4]、duration=2，正确的 .in 是第一行 1 4、第二行 2；严禁保留方括号、逗号、变量名和等号。
- 字符串输入通常不带源码中的引号；只有当引号本身就是题目要求的输入字符时才保留。
- 先确定唯一、语言无关的 stdin 文本格式，再让每一种模板都解析这一格式；不得让不同语言使用不同的 .in。

【按题型确定唯一 I/O 编码】
- Hydro 测试点数量是独立的 N.in/N.out 文件对数量，不是单个输入文件首行的 T。
- ACM/传统题：每个 CASE 是一份可独立运行的完整 stdin/stdout。题面含 T 时默认每个 Hydro 测试点取 T=1，并放入恰好一组完整数据；只有教师明确要求批处理时才使用 T>1。
- LeetCode/函数题：每个 CASE 只表示一次函数调用，不额外添加 T。默认每个参数占一行；一维数组用空格分隔，字符串不用源码引号。矩阵、图、树、链表等结构先确定带尺寸/哨兵的无歧义文本编码，再让所有语言模板严格共用这一编码。
- 任何输出都必须来自标程逐组推演；一个输入文件含多组数据时，不能只输出第一组答案。

【测试数据设计原则】
1. 若题面含示例，优先覆盖示例表达的场景；仍须遵守上面的“一文件一组”默认规则。
2. 必须包含边界组，并在 label 中写明设计意图：
   - 最小规模：空输入、0、1、单元素（以题面约束允许的最小值为准）；
   - 规模上限：对应 CASE 覆盖计划允许的上限附近；
   - 特殊值：相等、重复、负数、临界值（视题意选取，如闰年 2 月 29 日、恰好越界前后）；
   - 特殊结构：全相同、已排序、逆序、对称/回文等（视题意选取）。
3. 其余测试点使用多样化的中间规模数据，避免彼此雷同。
4. 输入输出必须与题面（或标程）的格式要求严格一致；.in 是评测输入文件内容，.out 是标准输出文件内容。
5. 数据规模策略（默认 auto 自动混合）：
   - auto：严格遵守用户消息中的逐 CASE 覆盖计划，在同一次生成中同时包含小规模、中等规模和临界规模；
   - small：所有数据保持人工可快速验算的量级（数值一般 ≤ 100，单个 .in ≤ 30 行）；
   - medium：在题面约束内取中等量级（如 10^2~10^4，单个 .in ≤ 200 行），仍须保证输出可被可靠推演；
   - large：接近题面约束上限。此档必须使用【可解析构造】：用有规律的数据（全相同、等差、周期、对称等），使正确输出能由公式/推理直接得出，而不是逐条模拟；无法可靠推出输出时，宁可缩小该测试点规模，也绝不允许猜测输出。
6. 若题面存在多个独立约束，不得把所有维度一起机械放大。应交叉覆盖，例如“小规模结构 + 临界元素值”“大规模结构 + 简单/稀疏取值”“某一参数取上下界而其余参数取中间值”。
7. 若题面未给出明确范围，使用保守、可被 VALIDATOR 验证的构造，不得臆造违反题意的 0、空输入或极端值。
8. 正确性最重要：先确定标程（教师已提供则以其为准），再对每个测试点逐步推演标程的运行得到 .out。宁可数据小，绝不允许输出错误。

【输出格式（分节文本，禁止 JSON）】
代码与数据必须以原文直出，因此使用分节标记格式，不要输出 JSON、不要做任何转义、不要用代码围栏包裹任何内容。标记行独占一行、顶格书写，形如 @@@标记@@@。整体结构如下（不适用的节直接省略）：

@@@META@@@
problemType: function
isFillIn: false
functionName: countKConstraintSubstrings
@@@ANALYSIS@@@
简要说明（不超过 200 字）：题意理解、输入输出格式、数据范围
@@@NOTES@@@
给教师的注意事项（可选节，如数据范围裁剪说明、填空题输出格式依据）
@@@TEMPLATE:py@@@
template.py 原文
@@@TEMPLATE:java@@@
template.java 原文
@@@TEMPLATE:cc@@@
template.cc 原文
@@@STD@@@
标程代码原文
@@@CASE:1:IN:样例1@@@
10101
1
@@@CASE:1:OUT@@@
12
@@@CASE:2:IN:边界-最小规模@@@
0
1
@@@CASE:2:OUT@@@
1

规则：
- TEMPLATE 节必须逐一输出用户要求的全部语言，一个也不能遗漏；传统题省略全部 TEMPLATE 节与 functionName。
- 函数题的 STD 节只包含与学生提交形式一致的函数/类定义（教师可用 cat std.py template.py > check.py 本地验证）；传统题的 STD 节是完整的读写标准输入输出的程序；填空题的 STD 节是补全题面代码后的结果；教师已提供标准答案时省略 STD 节。
- CASE 编号从 1 开始连续递增，数量以用户要求的 Hydro 测试点数为准；每个编号必须同时给出 IN 与 OUT 两节；IN 标记中最后一段冒号之后是该测试点的设计意图（label，简体中文）。题目内部的 T 与 CASE 数量相互独立。
- CASE:IN 再次强调：只写原始 stdin，禁止出现 s =、k =、arr = [1, 2] 等源码赋值写法。
- 各节内容为原始文本：换行就是真实换行，引号、反斜杠等一律原样书写；除标记行外不要输出任何额外说明文字；正文行不得以 @@@ 开头。
- 所有说明性文字（ANALYSIS/NOTES/label）使用简体中文。`;
}

export interface BuildUserPromptParams {
  problemTitle: string;
  statementMarkdown: string;
  options: GenerateOptions;
  existingFiles?: string[];
  /** 分层生成门控只检查是否已有 subtasks，不向模型泄漏配置正文。 */
  existingConfig?: string;
  /** 服务端规则引擎对"题面疑似含填空代码"的初判（仅作为参考信号提供给 AI） */
  fillInDetected?: boolean;
}

const DATA_SCALE_TEXT: Record<DataScale, string> = {
  auto: 'auto（自动混合：按题面约束一次覆盖小/中/临界规模）',
  small: 'small（小规模，人工可快速验算）',
  medium: 'medium（中等规模，题面约束内取中位量级）',
  large: 'large（接近题面约束上限，必须使用可解析构造保证输出正确）',
};

function formatCoverageGuidanceLine(slot: CoverageSlot | SubtaskCaseAllocation): string {
  return 'subtaskId' in slot
    ? `- CASE ${slot.caseNumber}: 子任务 ${slot.subtaskId} — ${slot.guidance}`
    : `- CASE ${slot.caseNumber}: ${slot.dataScale} — ${slot.guidance}`;
}

function buildCoverageGuidanceBlock(
  coveragePlan: Array<CoverageSlot | SubtaskCaseAllocation> | undefined,
): string {
  if (!coveragePlan?.length) return '';
  return [
    '【逐测试点覆盖计划（必须按 CASE 编号执行，并把实际覆盖目标写进 label）】',
    ...coveragePlan.map(formatCoverageGuidanceLine),
  ].join('\n');
}

/**
 * 构建 User Prompt
 */
export function buildTestdataUserPrompt(
  params: BuildUserPromptParams,
  coverageOverride?: Array<CoverageSlot | SubtaskCaseAllocation>,
  context?: TestdataPipelineContext,
): string {
  const { problemTitle, statementMarkdown, options, existingFiles, fillInDetected } = params;
  const kindText = {
    auto: '自动判断（根据题面）',
    traditional: '传统题（标准输入输出）',
    function: '函数题（LeetCode 风格，学生只写函数）',
  }[options.problemKind];
  const fillInText = {
    auto: fillInDetected
      ? '自动判断（系统规则初判：题面疑似含待完善代码，请你复核）'
      : '自动判断（根据题面）',
    yes: '是（题面含待完善代码，标程必须是补全后的题面代码）',
    no: '否',
  }[options.fillInMode || 'auto'];
  const langText = options.languages.map(l => LANG_DISPLAY[l]).join('、') || '（无）';
  const requiredTemplateSections = options.languages.map(l => `@@@TEMPLATE:${l}@@@`).join('、');
  const coveragePlan = coverageOverride
    ?? buildCoveragePlan(options.caseCount, options.dataScale || 'auto');

  if (context) {
    const lines = [
      buildFrozenProblemSpecBlock(context),
      '',
      buildFrozenInputEncodingBlock(context),
      '',
      '【公开题面样例】',
      ...(context.statement.samples.length > 0
        ? context.statement.samples.flatMap(sample => [
          `样例 ${sample.id} 输入：${JSON.stringify(comparableFileContent(sample.input))}`,
          `样例 ${sample.id} 输出：${JSON.stringify(comparableFileContent(sample.output))}`,
        ])
        : ['题面未解析到公开样例。']),
      '',
      '【兼容直出要求】',
      `- 题型：${context.spec.problemKind}`,
      `- Hydro 测试点数量：${options.caseCount} 个独立文件对。`,
      `- 数据规模策略：${DATA_SCALE_TEXT[options.dataScale || 'auto']}`,
      `- 函数题模板语言：${options.languages.map(language => LANG_DISPLAY[language]).join('、') || '无'}`,
      '- frozen ProblemSpec 是唯一机器题意契约；不得通过 ANALYSIS、STD、CASE 或 TEMPLATE 改写它。',
      '- ANALYSIS 只面向教师说明，不得成为其他机器阶段的输入。',
      buildCoverageGuidanceBlock(coveragePlan),
    ];
    if (options.providedStd?.trim()) {
      lines.push(
        '',
        options.providedStdSource === 'accepted-record'
          ? '【历史 AC 候选解（不是权威，不得改变 Spec）】'
          : '【教师提供的标准答案（不得改变 Spec）】',
        '```',
        options.providedStd.trim(),
        '```',
      );
    }
    lines.push('', '请严格按照 System 中约定的分节标记格式输出，不要输出 JSON 外壳。');
    return lines.join('\n');
  }

  const statement = completeStatementForGenerationPrompt(statementMarkdown);

  const lines = [
    `【题目标题】${problemTitle}`,
    '',
    '【题面（Markdown）】',
    statement,
    '',
    '【生成要求】',
    `- 题型：${kindText}`,
    `- 填空题（完善代码）：${fillInText}`,
    `- Hydro 测试点数量：${options.caseCount} 个独立的 .in/.out 文件对（这不是单个输入文件首行的 T）`,
    `- 数据规模策略：${DATA_SCALE_TEXT[options.dataScale || 'auto']}`,
    `- 函数题模板语言：${langText}`,
  ];
  lines.push(
    '',
    '【逐测试点覆盖计划（必须按 CASE 编号执行，并把实际覆盖目标写进 label）】',
    ...coveragePlan.map(formatCoverageGuidanceLine),
  );
  if (options.problemKind !== 'traditional') {
    lines.push(`- 若判定/指定为函数题，必须完整输出这些模板节：${requiredTemplateSections}（不得遗漏）`);
  }
  if (options.extraRequirements?.trim()) {
    lines.push(`- 教师补充要求：${options.extraRequirements.trim()}`);
  }
  if (options.providedStd?.trim()) {
    const acceptedRecord = options.providedStdSource === 'accepted-record';
    lines.push(
      '',
      acceptedRecord
        ? '【历史 AC 候选解（不是权威；可能因旧数据薄弱而误 AC，必须通过样例与独立 BRUTE 压力验证）】'
        : '【教师提供的标准答案（手动，唯一权威；所有 .out 必须由它推演得到，输出格式以它为准）】',
      '```',
      options.providedStd.trim(),
      '```',
    );
  }
  if (existingFiles && existingFiles.length > 0) {
    lines.push('', `【题目已有文件（将可能被覆盖，仅供参考）】${existingFiles.join(', ')}`);
  }
  lines.push('', '请严格按照 System 中约定的分节标记格式（@@@标记@@@）输出，不要输出 JSON。');
  return lines.join('\n');
}

/** 第一阶段：把模型注意力集中在题意、stdin 编码和正确算法上。 */
export function buildSolutionBlueprintSystemPrompt(
  cppOracleAvailable = false,
  frozenSpec = false,
): string {
  const oracleRule = cppOracleAvailable
    ? '2. 传统题仅当约束规模使 Python 在 5 秒内明显无法完成时，ORACLE_LANG 才选 cpp，此时 ORACLE 必须是自包含、可直接编译运行的完整 C++17 程序；其余情况选 python，并输出自包含、可直接运行的 Python 3 完整程序。两种语言都读取一份 stdin 并严格输出题目答案，不得硬编码样例或答案表。函数题必须选 python，系统会忽略 cpp 声明。'
    : '2. ORACLE 必须是自包含、可直接运行的 Python 3 完整程序，读取一份 stdin 并严格输出题目答案；不得硬编码样例或答案表。';
  const oracleLanguageSection = cppOracleAvailable
    ? '=== ORACLE_LANG ===\npython 或 cpp（函数题必须为 python；缺失按 python）\n'
    : '';
  const oracleDescription = cppOracleAvailable
    ? '完整 Python 3 或 C++17 标程（与 ORACLE_LANG 一致）'
    : '完整 Python 3 标程';
  const specRule = frozenSpec
    ? '1. FROZEN_PROBLEM_SPEC 是唯一机器题意契约；只实现它，不得重新决定或修改 stdin 编码、题型、输出策略、子任务或引用关系。ANALYSIS 仅面向教师解释。'
    : '1. 先确定唯一、语言无关的原始 stdin 编码，并在 ANALYSIS 中逐行说明输入、输出、约束、算法正确性理由与复杂度。';
  return `你是一位资深 OJ 算法审核专家。本阶段只解决题目并输出可执行标程，不生成测试数据、输入生成器、暴力解、校验器或多语言模板。

核心规则：
${specRule}
${oracleRule}
3. 函数题仍要在 ORACLE 内包含完整实现与 stdin 驱动，并为用户选定的每种语言额外输出 SOLUTION:语言：与学生提交形式一致的函数或类定义，不含读输入和打印。未带语言的旧 SOLUTION 仅兼容 Python。
4. 若函数题题面包含样例，必须输出 SAMPLE_INPUTS，把每个题面展示参数转换为 ANALYSIS 确定的原始 stdin；只转换输入，id 不得遗漏或增加。
5. 教师手动标程是权威；历史 AC 仅是可能误 AC 的候选，禁止把 AC 状态当作正确性证明。
6. 仅当题面明确给出子任务/分数表时输出该分节（SUBTASKS）；约束摘要为该子任务的完整生效约束（含继承的全局约束收紧），一行一个，按 id 升序。
7. 本阶段严禁输出 GENERATOR、BRUTE、VALIDATOR 或 TEMPLATE；这些外围制品只有在 ORACLE 通过样例预验证后才会由后续阶段生成。
8. NOTES 至多 2 句，只写系统无法自动验证、需要教师人工注意的事项（如输出格式的特殊约定、多解风险）；不要复述你如何构造数据，不要罗列已由沙箱验证的内容。

输出格式：
${oracleLanguageSection}\
=== SUBTASKS ===
可选；每行格式：id | score | 约束摘要
@@@META@@@
problemType: traditional 或 function
isFillIn: false
functionName: 函数题函数名（传统题省略）
@@@ANALYSIS@@@
stdin 编码、题意、算法正确性与复杂度（不超过 500 字）
@@@ORACLE@@@
${oracleDescription}
@@@SOLUTION:py@@@
函数题 Python 学生提交形式的实现（仅在选择 Python 时输出）
@@@SOLUTION:java@@@
函数题 Java 学生提交形式的实现（仅在选择 Java 时输出）
@@@SOLUTION:cc@@@
函数题 C++ 学生提交形式的实现（仅在选择 C++ 时输出）
@@@SAMPLE_INPUTS@@@
函数题存在题面样例时输出紧凑 JSON：{"samples":[{"id":"1","input":"转换后的原始 stdin"}]}
@@@NOTES@@@
给教师的可选注意事项

各节使用原文分节，不要代码围栏、JSON 外壳或额外解释。`;
}

export function buildSolutionBlueprintUserPrompt(
  params: BuildUserPromptParams,
  context?: TestdataPipelineContext,
): string {
  const { problemTitle, statementMarkdown, options, fillInDetected } = params;
  if (context) {
    const lines = [
      buildFrozenProblemSpecBlock(context),
      '',
      buildFrozenStatementEvidenceBlock(context),
      '',
      '【本阶段解题要求】',
      '- frozen ProblemSpec 是唯一机器题意契约；不得改变题型、testCaseMode、stdin encoding、outputPolicy、subtasks 或引用关系。',
      '- ANALYSIS 仅面向教师解释，不得定义或覆盖任何机器语义。',
      `- 填空题模式：${options.fillInMode || 'auto'}${fillInDetected ? '（规则初判为疑似填空）' : ''}`,
      `- 函数题学生解语言：${options.languages.join(', ') || '无'}`,
      '- 只编写 ORACLE 与函数题学生接口实现；测试点和验证制品由隔离角色生成。',
    ];
    if (options.providedStd?.trim()) {
      lines.push(
        '',
        options.providedStdSource === 'accepted-record'
          ? '【历史 AC 候选解（必须独立验证，不得据此修改 Spec）】'
          : '【教师提供的标准答案（不得据此修改 Spec）】',
        '```',
        options.providedStd.trim(),
        '```',
      );
    }
    return lines.join('\n');
  }
  const kindText = {
    auto: '自动判断（根据题面）',
    traditional: '传统题（标准输入输出）',
    function: '函数题（LeetCode 风格，学生只写函数）',
  }[options.problemKind];
  const fillInText = {
    auto: fillInDetected
      ? '自动判断（系统规则初判：题面疑似含待完善代码，请复核）'
      : '自动判断（根据题面）',
    yes: '是（标程必须是补全后的题面代码）',
    no: '否',
  }[options.fillInMode || 'auto'];
  const statement = completeStatementForGenerationPrompt(statementMarkdown);
  const lines = [
    `【题目标题】${problemTitle}`,
    '',
    '【题面（Markdown）】',
    statement,
    '',
    '【本阶段解题要求】',
    `- 题型：${kindText}`,
    `- 填空题（完善代码）：${fillInText}`,
    '- 只分析题意、证明算法并编写可执行 ORACLE；测试点数量与覆盖计划留给后续阶段。',
  ];
  if (options.extraRequirements?.trim()) {
    lines.push(`- 教师补充要求：${options.extraRequirements.trim()}`);
  }
  if (options.providedStd?.trim()) {
    const acceptedRecord = options.providedStdSource === 'accepted-record';
    lines.push(
      '',
      acceptedRecord
        ? '【历史 AC 候选解（不是权威；可能因旧数据薄弱而误 AC，必须接受独立验证）】'
        : '【教师提供的标准答案（手动，唯一权威；输出格式以它为准）】',
      '```',
      options.providedStd.trim(),
      '```',
    );
  }
  if (options.problemKind !== 'traditional') {
    lines.push(`- 若判定/指定为函数题，必须为每个选定语言输出学生解分节：${options.languages.map(language => `@@@SOLUTION:${language}@@@`).join('、')}。`);
  }
  lines.push(
    '',
    '这是第一阶段：只输出 META、ANALYSIS、ORACLE，函数题需要的 SOLUTION/SAMPLE_INPUTS，以及题面明确有子任务/分数表时的 SUBTASKS；禁止输出 GENERATOR、BRUTE、VALIDATOR、TEMPLATE 或 CASE。',
  );
  return lines.join('\n');
}

/** 第二阶段：在已验证解法固定后生成输入与函数题驱动模板。 */
export function buildGenerationArtifactsSystemPrompt(frozenSpec = false): string {
  const sourceContract = frozenSpec
    ? 'FROZEN_PROBLEM_SPEC 是唯一机器题意契约；你看不到且不得请求 ORACLE、SOLUTION 或自由文本 analysis。'
    : '题目的算法、ORACLE 和 stdin 编码已经在上一阶段确定并通过题面样例预验证。';
  return `你是一位 OJ 测试数据工程师。${sourceContract}本阶段不得修改算法、ORACLE、SOLUTION 或 stdin 编码，只生成外围制品。

核心规则：
1. GENERATOR 是自包含 Python 3 程序，不读 stdin，stdout 只打印紧凑 JSON：{"cases":[{"label":"覆盖意图","input":"原始标准输入"}]}；数量必须与用户要求完全一致。编写 GENERATOR 前，先在代码注释中逐条列出题面的所有硬性保证（如“根至少有两个孩子”“保证按 DFS 序编号”），生成逻辑必须逐条满足；任何一条违反都会导致整体失败。
2. input 是程序实际读取的原始 stdin，禁止变量赋值、源码字面量说明或答案；所有生成确定性并固定随机种子。
3. 严格执行逐 CASE 覆盖计划，交叉覆盖最小、典型、边界、退化、反例与临界规模；不得全部生成相似输入。
4. 每个 input 小于 256KB，GENERATOR stdout 小于 1MB；临界数据使用可解析构造，不能可靠验证时宁可缩小。
5. 函数题输出用户要求的全部 TEMPLATE：模板只负责读取同一 stdin、调用既定 SOLUTION、打印结果，不得包含或改写算法。传统题不输出模板。
6. 不得输出 ORACLE、SOLUTION、BRUTE 或 VALIDATOR。
7. NOTES 至多 2 句，只写系统无法自动验证、需要教师人工注意的事项（如输出格式的特殊约定、多解风险）；不要复述你如何构造数据，不要罗列已由沙箱验证的内容。

输出格式：
@@@GENERATOR@@@
完整 Python 3 输入生成器
@@@TEMPLATE:py@@@
函数题 Python 驱动模板
@@@TEMPLATE:java@@@
函数题 Java 驱动模板
@@@TEMPLATE:cc@@@
函数题 C++ 驱动模板
@@@NOTES@@@
外围制品的可选说明

各节使用原文分节，不要代码围栏、JSON 外壳或额外解释。`;
}

export function buildGenerationArtifactsUserPrompt(
  params: BuildUserPromptParams,
  solution: SandboxSolutionBlueprint,
  coverageOverride?: Array<CoverageSlot | SubtaskCaseAllocation>,
  context?: TestdataPipelineContext,
): string {
  const coveragePlan = coverageOverride ?? (() => {
    const tiered = resolveTieredSubtaskGeneration({
      caseCount: params.options.caseCount,
      dataScale: params.options.dataScale,
      subtasks: solution.subtasks,
      existingConfig: params.existingConfig,
    });
    return tiered.enabled
      ? tiered.allocations
      : buildCoveragePlan(params.options.caseCount, params.options.dataScale || 'auto');
  })();
  if (context) {
    return [
      buildFrozenProblemSpecBlock(context),
      '',
      buildFrozenInputEncodingBlock(context),
      '',
      '【学生接口（只供模板调用，不包含正确解实现）】',
      `problemType: ${context.spec.problemKind}`,
      solution.functionName ? `functionName: ${solution.functionName}` : '',
      `languages: ${params.options.languages.join(', ') || '无'}`,
      `parameters: ${context.spec.inputFields.map(field => `${field.id}:${field.type}`).join(', ') || '无'}`,
      '',
      '【生成要求】',
      `- 恰好生成 ${params.options.caseCount} 个独立测试点。`,
      `- 数据规模策略：${DATA_SCALE_TEXT[params.options.dataScale || 'auto']}`,
      '- 只输出 GENERATOR 与函数题 TEMPLATE；不得输出或推断 ORACLE、SOLUTION、BRUTE、VALIDATOR。',
      '- 不得重新解释算法规范，不得改变 frozen Spec 的任何字段。',
      buildCoverageGuidanceBlock(coveragePlan),
    ].filter(Boolean).join('\n');
  }
  const solutions = solution.solutions ?? (solution.solutionCode ? { py: solution.solutionCode } : {});
  const base = buildTestdataUserPrompt(
    params,
    coveragePlan,
  ).replace(
    '请严格按照 System 中约定的分节标记格式（@@@标记@@@）输出，不要输出 JSON。',
    '这是第二阶段：只输出 GENERATOR 与函数题所需 TEMPLATE，不要重复 ORACLE、SOLUTION、BRUTE、VALIDATOR 或 CASE。',
  );
  return [
    base,
    '',
    '【第一阶段已验证且必须保持不变的解题蓝图】',
    `problemType: ${solution.problemType}`,
    solution.functionName ? `functionName: ${solution.functionName}` : '',
    'stdin 编码与算法说明：',
    solution.analysis || '严格按题面与 ORACLE 的读入方式生成原始 stdin。',
    'ORACLE（只用于对齐读入输出，禁止在响应中重复或修改）：',
    solution.oracleCode,
    ...Object.entries(solutions).map(([language, code]) =>
      `SOLUTION:${language}（对应语言模板必须调用此接口）：\n${code}`,
    ),
  ].filter(Boolean).join('\n');
}

/**
 * 兼容性/定向修复协议：初始生成已拆为解题与外围制品两阶段；当沙箱定位到
 * 具体失败节时仍可用该完整协议只替换目标分节。
 */
export function buildSandboxBlueprintSystemPrompt(
  cppOracleAvailable = false,
  frozenSpec = false,
): string {
  const oracleRule = cppOracleAvailable
    ? '5. 传统题仅当约束规模使 Python 在 5 秒内明显无法完成时，ORACLE_LANG 才选 cpp，此时 ORACLE 是自包含、可直接编译运行的完整 C++17 程序；其余情况选 python，并输出自包含、可直接运行的 Python 3 完整程序。两种语言都读取一份 input 的 stdin，严格按题面输出 stdout，不得硬编码测试用例或答案表。函数题必须选 python，系统会忽略 cpp 声明。'
    : '5. ORACLE 是自包含、可直接运行的 Python 3 完整程序：读取一份 input 的 stdin，严格按题面输出 stdout。不得硬编码测试用例或答案表。函数题也必须在 ORACLE 内包含函数实现和 stdin 驱动。';
  const oracleLanguageSection = cppOracleAvailable
    ? '=== ORACLE_LANG ===\npython 或 cpp（函数题必须为 python；缺失按 python）\n'
    : '';
  const oracleDescription = cppOracleAvailable
    ? '完整 Python 3 或 C++17 标程（stdin → stdout，与 ORACLE_LANG 一致）'
    : '完整 Python 3 标程（stdin → stdout，正解算法）';
  const frozenRule = frozenSpec
    ? '0. FROZEN_PROBLEM_SPEC 是唯一机器题意契约。以下通用默认值只在不与 Spec 冲突时适用；不得修改 problemKind、testCaseMode、stdin encoding、outputPolicy、subtasks 或引用关系，ANALYSIS 仅面向教师。\n'
    : '';
  return `你是一位资深 OJ 出题与测试数据专家。请根据题面输出一份可在 Hydro go-judge 中执行的测试数据生成蓝图。

核心规则：
${frozenRule}\
1. GENERATOR 是自包含 Python 3 程序，不读 stdin，向 stdout 只打印一个 JSON 对象：{"cases":[{"label":"设计意图","input":"原始标准输入"}]}。cases 数量必须与用户要求完全一致；不得打印日志或 Markdown。
2. GENERATOR 只生成 .in，不生成答案。input 必须是程序真实读取的原始 stdin，禁止 s = "101"、k = 2、arr = [1,2] 等源码赋值写法。
3. ACM/传统题：每个 input 是一份独立完整的输入文件。若题面首行是 T，默认每个文件固定 T=1，并紧跟恰好一组完整数据；只有教师明确要求批处理时才使用 T>1。
4. LeetCode/函数题：每个 input 只表示一次函数调用，不额外添加 T。默认每个参数占一行；一维数组用空格分隔，字符串不带源码引号。所有模板与 ORACLE 必须使用完全相同的输入编码。
${oracleRule}
6. 函数题必须为用户选定的每一种语言输出 SOLUTION:语言 节：与该语言学生提交形式完全一致的函数/类定义（只含实现，不含读输入或打印）。Python 解会与 template.py 拼接后在沙箱实跑，用于验证模板与输入编码。传统题省略 SOLUTION。
7. 数据必须严格遵守用户消息中的逐 CASE 覆盖计划，并根据题面真实约束交叉变化不同维度；所有生成过程必须确定性，固定随机种子。
8. GENERATOR 必须使用紧凑 JSON（Python json.dumps(..., ensure_ascii=False, separators=(',', ':'))），stdout 总量必须小于 1MB。每个 input 的 UTF-8 内容必须小于 256KB，并确保 ORACLE 对该 input 的 stdout 也小于 256KB；全部 .in/.out 与辅助文件合计必须小于 1MB。若临界输入会导致输出过大或超时，应使用仍能触发复杂度/边界行为的可解析构造并适当缩小，而不是打印海量数据。
9. 教师提供的标准答案（手动）是唯一权威；历史 AC 候选解可能因旧数据薄弱而误 AC，只能作为待验证 ORACLE，必须通过题面样例与独立 BRUTE 压力对拍，禁止让 BRUTE 迁就候选解。
10. 函数题必须输出用户要求的每一个 TEMPLATE 节：Python 追加到学生代码末尾；Java 为 public class Main 并调用 class Solution；C++ 用 #include "foo.cc"。传统题省略 TEMPLATE。
11. 不要输出 BRUTE 或 VALIDATOR；系统会在一次全新的、看不到 ORACLE 实现的独立调用中生成验证器，降低两份算法共享同一错误的风险。
12. 仅当题面明确给出子任务/分数表时输出该分节（SUBTASKS）；约束摘要为该子任务的完整生效约束（含继承的全局约束收紧），一行一个，按 id 升序。
13. NOTES 至多 2 句，只写系统无法自动验证、需要教师人工注意的事项（如输出格式的特殊约定、多解风险）；不要复述你如何构造数据，不要罗列已由沙箱验证的内容。

输出必须使用以下原文分节，禁止代码围栏、JSON 外壳或额外说明（不适用的可选节直接省略）：
${oracleLanguageSection}\
=== SUBTASKS ===
可选；每行格式：id | score | 约束摘要
@@@META@@@
problemType: traditional 或 function
isFillIn: false
functionName: 函数题函数名（传统题省略）
@@@ANALYSIS@@@
逐行说明唯一的原始 stdin 编码、约束与覆盖策略（不超过 300 字；后续独立验证器只依赖这里对齐输入格式）
@@@GENERATOR@@@
完整 Python 3 输入生成器
@@@ORACLE@@@
${oracleDescription}
@@@SOLUTION:py@@@
函数题：Python 学生提交形式的函数/类实现（仅在选择 Python 时输出）
@@@SOLUTION:java@@@
函数题：Java 学生提交形式的函数/类实现（仅在选择 Java 时输出）
@@@SOLUTION:cc@@@
函数题：C++ 学生提交形式的函数/类实现（仅在选择 C++ 时输出）
@@@TEMPLATE:py@@@
函数题 Python 驱动模板
@@@TEMPLATE:java@@@
函数题 Java 驱动模板
@@@TEMPLATE:cc@@@
函数题 C++ 驱动模板
@@@NOTES@@@
给教师的可选注意事项

各节内容按原文输出，正文行不得以 @@@ 开头。所有说明文字与 label 使用简体中文。`;
}

export function buildSandboxBlueprintUserPrompt(
  params: BuildUserPromptParams,
  coverageOverride?: Array<CoverageSlot | SubtaskCaseAllocation>,
): string {
  return buildTestdataUserPrompt(params, coverageOverride).replace(
    '请严格按照 System 中约定的分节标记格式（@@@标记@@@）输出，不要输出 JSON。',
    '请严格按照 System 中约定的蓝图分节格式输出 GENERATOR、ORACLE 与所需 TEMPLATE；不要直接输出 CASE 或 .out。',
  );
}

/**
 * 独立验证调用只负责编写 BRUTE、VALIDATOR 与内部小数据生成器。
 * 提示中刻意不包含 ORACLE 源码，避免“正解”和“暴力解”复制同一推理错误。
 */
export function buildIndependentVerifierSystemPrompt(
  stressCaseCount = TESTDATA_GEN_LIMITS.STRESS_CASES,
  frozenSpec = false,
): string {
  const sourceContract = frozenSpec
    ? '你只根据 FROZEN_PROBLEM_SPEC 编写与正解实现隔离的验证制品。Spec 是唯一机器题意契约，不得从自由文本 analysis 推断或改写语义。'
    : '你只根据题面与已经确定的 stdin 编码，编写与正解实现隔离的验证制品。';
  return `你是一位独立的 OJ 题目验证专家。${sourceContract}你看不到 ORACLE 源码，也不得猜测、复述或要求它。

核心规则：
1. BRUTE 必须是自包含 Python 3 完整程序，读取一份原始 stdin 并输出题目答案。使用最朴素、最容易审查的枚举/模拟算法，不追求大规模性能，不得省略任何输出格式细节。
2. STRESS_GENERATOR 必须是自包含 Python 3 程序，不读 stdin，stdout 只打印紧凑 JSON：{"cases":[{"label":"覆盖意图","input":"原始标准输入"}]}。编写 STRESS_GENERATOR 前，先在代码注释中逐条列出题面的所有硬性保证（如“根至少有两个孩子”“保证按 DFS 序编号”），生成逻辑必须逐条满足；任何一条违反都会导致整体失败。
3. STRESS_GENERATOR 必须恰好生成 ${stressCaseCount} 组小数据，至少 ${Math.ceil(stressCaseCount * TESTDATA_GEN_LIMITS.STRESS_MIN_UNIQUE_RATIO)} 组 input 互不相同，禁止复制输入凑数；全部能让 BRUTE 在 5 秒内独立完成。混合穷举边界、固定种子随机、重复值、退化结构和容易触发错误算法的反例。不得复制正式测试点，也不得生成大规模性能数据。
4. VALIDATOR 必须是自包含 Python 3 程序，读取一份 input，严格校验格式和题面约束；合法时静默 exit 0，非法时向 stderr 说明并 exit 1。合法输入必须接受，非法输入必须拒绝；题面中每一条“保证/约定”都必须成为一条显式校验，但不得添加题面没有的额外限制。不得无条件成功。
5. 三个程序必须使用题目已经确定的同一份原始 stdin 编码。函数题每份 input 只对应一次调用；传统题若有 T，沿用题面和编码说明中的约定。
6. 所有生成过程必须确定性并固定随机种子。每个 input 小于 256KB，STRESS_GENERATOR stdout 小于 1MB，不打印日志。
7. 若用户消息列出函数题题面样例，额外输出 SAMPLE_INPUTS，将每个题面参数展示转换成上述 stdin 编码。只转换输入，不填写或改写期望输出；样例 id 必须逐一对应，不能遗漏或增加。
8. 判断题目是否存在明显的复杂度差异：如果这道题不存在时间复杂度明显劣于标程、且学生现实中可能写出的朴素解法（例如 O(1) 公式题、纯输入输出模拟题），COMPLEXITY_GAP 输出 none；否则输出 exists，且 BRUTE 必须实现那个更慢的朴素解法。

只输出以下四个必需分节；函数题存在题面样例时再输出 SAMPLE_INPUTS 分节。不要 META、ANALYSIS、ORACLE、SOLUTION、TEMPLATE、代码围栏或解释文字：
=== COMPLEXITY_GAP ===
exists 或 none
@@@BRUTE@@@
完整 Python 3 暴力解
@@@STRESS_GENERATOR@@@
完整 Python 3 小数据生成器
@@@VALIDATOR@@@
完整 Python 3 输入校验器
@@@SAMPLE_INPUTS@@@
函数题有题面样例时输出紧凑 JSON：{"samples":[{"id":"1","input":"转换后的原始 stdin"}]}`;
}

export function buildIndependentVerifierUserPrompt(
  params: BuildUserPromptParams,
  blueprint: Pick<SandboxGenerationBlueprint, 'problemType' | 'functionName' | 'analysis'>,
  context?: TestdataPipelineContext,
): string {
  if (context) {
    const functionSamples = context.spec.problemKind === 'function'
      ? context.statement.samples
      : [];
    return [
      buildFrozenProblemSpecBlock(context),
      '',
      buildFrozenInputEncodingBlock(context),
      blueprint.functionName ? `【学生函数名】${blueprint.functionName}` : '',
      '',
      functionSamples.length > 0 ? '【公开题面样例】' : '',
      ...functionSamples.flatMap(sample => [
        `样例 ${sample.id} 展示输入：${JSON.stringify(comparableFileContent(sample.input))}`,
        `样例 ${sample.id} 公开输出：${JSON.stringify(comparableFileContent(sample.output))}`,
      ]),
      '',
      '只依据 frozen ProblemSpec 生成独立 BRUTE、STRESS_GENERATOR 与 VALIDATOR。',
      '不得要求或推断 ORACLE 源码、ORACLE analysis 或正确解推理过程。',
      `请生成恰好 ${TESTDATA_GEN_LIMITS.STRESS_CASES} 组内部小数据，并严格按要求输出验证分节。`,
    ].filter(Boolean).join('\n');
  }
  const statement = completeStatementForGenerationPrompt(params.statementMarkdown);
  const functionSamples = blueprint.problemType === 'function'
    ? extractStatementSamples(params.statementMarkdown)
    : [];
  const sampleTask = functionSamples.length > 0
    ? [
      '【函数题题面样例转码】',
      ...functionSamples.map(sample => `样例 ${sample.id} 展示输入：${JSON.stringify(comparableFileContent(sample.input))}`),
      `请额外输出 @@@SAMPLE_INPUTS@@@，恰好包含上述 ${functionSamples.length} 个 id；只把展示输入转换为主蓝图的原始 stdin，不要自行填写输出。`,
      '',
    ]
    : [];
  return [
    `【题目标题】${params.problemTitle}`,
    `【已确定题型】${blueprint.problemType}`,
    blueprint.functionName ? `【函数名】${blueprint.functionName}` : '',
    '',
    '【题面（Markdown）】',
    statement,
    '',
    '【主蓝图确定的 stdin 编码与约束说明】',
    blueprint.analysis || '主蓝图未提供额外说明；请严格从题面推导唯一的原始 stdin 编码。',
    '',
    ...sampleTask,
    params.options.extraRequirements?.trim()
      ? `【教师补充要求】${params.options.extraRequirements.trim()}`
      : '',
    `请生成恰好 ${TESTDATA_GEN_LIMITS.STRESS_CASES} 组内部小数据，并严格按要求输出验证分节。`,
  ].filter(line => line !== '').join('\n');
}

/** 错误解靶子调用与主蓝图隔离，不接收 ORACLE 或前轮对话。 */
export function buildKillTargetsSystemPrompt(frozenSpec = false): string {
  const sourceContract = frozenSpec
    ? '请只根据 FROZEN_PROBLEM_SPEC 与公开样例'
    : '请根据题面与既有解法分析';
  return `你是一位 OJ 错误解分析专家。${sourceContract}，构造最可能出现在学生提交中的典型错误解，用于检验测试数据能否区分正确与错误程序。

从以下菜单中挑选最多 2 种现实中学生确实可能犯的不同错误模式，每种输出一个完整错误解；如果题目过于简单、不存在有区分价值的现实错误模式，允许只输出 1 个甚至 0 个分节，不要硬凑：
- boundary：边界或退化情形处理错误，例如 n=1、全相等、空结构。
- wrong-algorithm：看似合理但不正确的贪心、DP、公式或状态转移。
- overflow-sim：整数溢出错误。Python 整数原生不会溢出，必须显式使用 % (1 << 31)、% (1 << 32)、有符号位转换等方式模拟题目语言中的 32/64 位溢出。

硬性要求：
1. 每个错误解必须是自包含 Python 3 完整程序，读取一份原始 stdin 并写出 stdout，与题面 IO 约定一致。
2. 错误解必须能正常运行、不崩溃，并且在给出的全部题面样例上输出正确；样例都过不了的显然错误没有区分度价值。
3. 错误必须来自所选模式，不得硬编码样例答案，不得输出日志或解释。
4. 仅输出 0 至 2 个 KILL_TARGET 分节；没有合适靶子时保持响应为空，不要用说明文字填充。不要 META、ORACLE、正确解、对话历史或额外说明。每节格式严格如下：
=== KILL_TARGET:<kind> ===
DESC: 一句话说明该错误解会在哪类输入上出错
\`\`\`python
完整 Python 3 程序
\`\`\``;
}

export function buildKillTargetsUserPrompt(input: {
  statement: string;
  analysis: string;
  samples: SampleIO[];
  context?: TestdataPipelineContext;
  correctSolutionCode?: string;
}): string {
  if (input.context) {
    const samples = input.samples.slice(0, 3);
    return [
      buildFrozenProblemSpecBlock(input.context),
      '',
      '【公开题面样例（最多 3 组，错误解必须全部通过）】',
      ...(samples.length > 0
        ? samples.flatMap((sample, index) => [
          `样例 ${index + 1} 输入：${JSON.stringify(comparableFileContent(sample.input).slice(0, 1000))}`,
          `样例 ${index + 1} 输出：${JSON.stringify(comparableFileContent(sample.output).slice(0, 1000))}`,
        ])
        : ['题面未解析到公开样例。']),
      '',
      '只依据 frozen ProblemSpec 与公开样例选择最多 2 个典型错误模式；不得请求或推断正确解源码。',
    ].join('\n');
  }
  const statement = completeStatementForGenerationPrompt(input.statement);
  const analysis = input.analysis.slice(0, 2000);
  const samples = input.samples.slice(0, 3);
  return [
    '【既有解法分析】',
    analysis || '未提供额外分析，请从题面推导常见错误模式。',
    '',
    '【完整规范化题面】',
    statement,
    '',
    '【题面样例（最多 3 组，错误解必须全部通过）】',
    ...(samples.length > 0
      ? samples.flatMap((sample, index) => [
        `样例 ${index + 1} 输入：${JSON.stringify(comparableFileContent(sample.input).slice(0, 1000))}`,
        `样例 ${index + 1} 输出：${JSON.stringify(comparableFileContent(sample.output).slice(0, 1000))}`,
      ])
      : ['题面未解析到样例。']),
    '',
    '请选择最多 2 个最可能的不同错误模式；没有合适靶子可输出 0 个。请严格按分节格式输出。',
  ].join('\n');
}

/** 函数题错误解提示必须复用已通过第一阶段验证的原始 stdin 转码。 */
export function buildKillTargetPromptSamples(
  solution: Pick<SandboxSolutionBlueprint, 'problemType' | 'functionSampleInputs'>,
  statementSamples: StatementSample[],
  context?: TestdataPipelineContext,
): SampleIO[] {
  if (context) {
    return statementSamples.map(sample => ({ input: sample.input, output: sample.output }));
  }
  if (solution.problemType !== 'function') {
    return statementSamples.map(sample => ({ input: sample.input, output: sample.output }));
  }
  const convertedById = new Map(
    (solution.functionSampleInputs || []).map(sample => [sample.id, sample.input]),
  );
  return statementSamples.flatMap(sample => {
    const converted = convertedById.get(sample.id);
    return converted === undefined
      ? []
      : [{ input: normalizeFileContent(converted), output: sample.output }];
  });
}

/** 定向补刀调用只针对一个幸存错误解，不携带前轮对话或 ORACLE 源码。 */
export function buildHackCasesSystemPrompt(): string {
  return `你是一位 OJ 反例构造专家。一个典型错误解已经通过全部现有测试数据，请针对它的具体错误模式构造 2 至 3 个小规模合法反例输入。

硬性要求：
1. 每个输入必须符合既定 stdin 编码与题面约束，且不超过 2000 字符。
2. 只构造容易人工复核的小规模输入，不生成大规模性能数据，不填写或猜测输出。
3. 优先构造能直接触发所述错误模式的最小反例、边界组合与退化结构。
4. 只输出以下分节，可重复 2 至 3 次，不要代码、答案、对话历史或额外说明：
=== HACK_CASE ===
RATIONALE: 一句话说明该输入为何可能卡掉错误解
\`\`\`text
原始 stdin
\`\`\``;
}

export function buildHackCasesUserPrompt(input: {
  analysis: string;
  target: KillTarget;
  context?: TestdataPipelineContext;
}): string {
  if (input.context) {
    return [
      buildFrozenProblemSpecBlock(input.context),
      '',
      buildFrozenInputEncodingBlock(input.context),
      '',
      '【幸存错误模式】',
      input.target.description,
      '',
      '【幸存错误解（最多 6000 字符）】',
      input.target.code.slice(0, 6000),
      '',
      '该错误解通过了全部现有数据。只依据 frozen ProblemSpec 构造 2 至 3 个小规模定向补刀输入。',
    ].join('\n');
  }
  return [
    '【既有解法与 stdin 编码分析】',
    input.analysis.slice(0, 3000) || '未提供额外分析，请依据错误模式构造合法小规模输入。',
    '',
    '【幸存错误模式】',
    input.target.description,
    '',
    '【幸存错误解（最多 6000 字符）】',
    input.target.code.slice(0, 6000),
    '',
    '该错误解通过了全部现有数据。请构造 2 至 3 个小规模定向补刀输入。',
  ].join('\n');
}

// ─── AI 响应解析 ──────────────────────────────────────────────────────────────

/**
 * 从 AI 返回文本中提取 JSON（容忍 <think> 标签、代码围栏、前后缀说明文字）
 */
export function extractJsonObject(raw: string): string {
  let text = raw;
  // 去除 openaiClient 注入的思考占位标签
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  // 去除代码围栏
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('AI 响应中未找到 JSON 对象');
  }
  return text.slice(start, end + 1);
}

/** 规范化文本文件内容：统一 LF，保证以单个换行结尾 */
export function normalizeFileContent(content: string): string {
  const lf = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (lf === '') return '\n';
  return lf.endsWith('\n') ? lf : `${lf}\n`;
}

/**
 * 规范化 AI 返回的可执行代码节。
 *
 * 模型偶尔会无视“不要代码围栏”，在每个 @@@ 节内部再次输出
 * ```python ... ```。分节解析器只会移除包裹整个响应的围栏，因此这里
 * 仅剥离完整包裹该代码节的单层围栏；普通数据文件仍走 normalizeFileContent，
 * 不会误删合法输入中的反引号。
 */
export function normalizeExecutableContent(content: string): string {
  const lf = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  const fenced = lf.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  return normalizeFileContent(fenced ? fenced[1] : lf);
}

/**
 * 校验并规范化「已解析为对象」的生成结果（JSON 与分节文本两条解析路径共用）
 * @throws Error 结构非法时抛出（消息为中文，直接展示给教师）
 */
export function normalizeGenerationObject(
  obj: Record<string, unknown>,
  options: GenerateOptions,
  parseOptions: ParseAiResponseOptions = {},
): GenerationResponse {
  const problemType = obj.problemType === 'function' ? 'function'
    : obj.problemType === 'traditional' ? 'traditional'
      : null;
  if (!problemType) throw new Error('AI 返回的 problemType 非法（应为 function 或 traditional）');
  if (options.problemKind !== 'auto' && problemType !== options.problemKind) {
    // 用户显式指定题型时以用户为准（AI 偶尔忽略指令）
    console.warn(`[TestdataGen] AI 返回题型 ${problemType} 与指定 ${options.problemKind} 不符，以指定为准`);
  }
  const effectiveType = options.problemKind === 'auto' ? problemType : options.problemKind;

  if (!Array.isArray(obj.cases) || obj.cases.length === 0) {
    throw new Error('AI 未返回任何测试点（cases 为空）');
  }
  const cases: GeneratedCase[] = (obj.cases as unknown[]).map((c, i) => {
    const cc = c as Record<string, unknown>;
    if (typeof cc.input !== 'string' || typeof cc.output !== 'string') {
      throw new Error(`第 ${i + 1} 个测试点缺少 input/output 字符串`);
    }
    return {
      label: typeof cc.label === 'string' ? cc.label : undefined,
      input: normalizeFileContent(cc.input),
      output: normalizeFileContent(cc.output),
    };
  });

  let templates: Partial<Record<TemplateLang, string>> | undefined;
  if (effectiveType === 'function') {
    const rawTemplates = (obj.templates || {}) as Record<string, unknown>;
    templates = {};
    for (const lang of options.languages) {
      const t = rawTemplates[lang];
      if (typeof t !== 'string' || !t.trim()) {
        if (!parseOptions.allowMissingTemplates) {
          throw new Error(`AI 未返回 ${LANG_DISPLAY[lang]} 的评测模板`);
        }
        continue;
      }
      templates[lang] = normalizeExecutableContent(t);
    }
  }

  let stdSolution: { language?: string; code: string } | undefined;
  const rawStd = obj.stdSolution as Record<string, unknown> | undefined;
  if (rawStd && typeof rawStd.code === 'string' && rawStd.code.trim()) {
    stdSolution = {
      language: typeof rawStd.language === 'string' ? rawStd.language : 'python',
      code: normalizeExecutableContent(rawStd.code),
    };
  }

  // 填空题判定：用户显式指定时以用户为准，auto 时采纳 AI 结论
  const fillInMode = options.fillInMode || 'auto';
  const isFillIn = fillInMode === 'yes' ? true
    : fillInMode === 'no' ? false
      : obj.isFillIn === true;

  return {
    problemType: effectiveType,
    isFillIn,
    analysis: typeof obj.analysis === 'string' ? obj.analysis : undefined,
    functionName: typeof obj.functionName === 'string' ? obj.functionName : undefined,
    templates,
    stdSolution,
    cases,
    notes: typeof obj.notes === 'string' ? obj.notes : undefined,
  };
}

/**
 * JSON 解析路径（旧契约，作为分节文本失败时的回退保留）
 * @throws Error 结构非法时抛出
 */
export function parseGenerationResponse(
  raw: string,
  options: GenerateOptions,
  parseOptions: ParseAiResponseOptions = {},
): GenerationResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(raw));
  } catch (err) {
    throw new Error(
      `AI 返回内容不是有效的 JSON：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return normalizeGenerationObject(parsed as Record<string, unknown>, options, parseOptions);
}

// ─── 分节文本解析（当前主契约） ──────────────────────────────────────────────

/** 分节标记：独占一行、顶格，形如 @@@META@@@ / @@@CASE:1:IN:标签@@@ */
const SECTION_MARKER_RE = /^\s*@@@(.+?)@@@\s*$/;

interface ParsedSection {
  header: string;
  content: string[];
}

/** 去除段落首尾的空行（保留内部空行），供代码/数据节使用 */
function trimBlankEdges(lines: string[]): string {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start++;
  while (end > start && lines[end - 1].trim() === '') end--;
  return lines.slice(start, end).join('\n');
}

function splitDelimitedSections(raw: string): ParsedSection[] {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/g, '');
  const fenced = text.match(/^\s*```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n```\s*$/);
  if (fenced) text = fenced[1];

  const sections: ParsedSection[] = [];
  let current: ParsedSection | null = null;
  for (const line of text.split(/\r?\n/)) {
    const marker = line.match(SECTION_MARKER_RE);
    if (marker) {
      current = { header: marker[1].trim(), content: [] };
      sections.push(current);
    } else if (current) {
      if (line.trimStart().startsWith('@@@')) {
        throw new Error(`AI 返回中存在疑似损坏的分节标记行：${line.trim().slice(0, 50)}，请重试`);
      }
      current.content.push(line);
    }
  }
  return sections;
}

/** 解析学生提交形式的解；未限定语言的旧 SOLUTION 仅兼容为 Python。 */
function parseTemplateSolutions(sections: ParsedSection[]): TemplateSolutions {
  const solutions: TemplateSolutions = {};
  for (const section of sections) {
    const [rawKind, rawLanguage] = section.header.split(':');
    if (rawKind.trim().toUpperCase() !== 'SOLUTION') continue;
    const content = normalizeExecutableContent(trimBlankEdges(section.content));
    const language = rawLanguage?.trim().toLowerCase() as TemplateLang | undefined;
    if (!language && !solutions.py) solutions.py = content;
    else if (language && SUPPORTED_TEMPLATE_LANGS.includes(language)) solutions[language] = content;
  }
  return solutions;
}

/** 将旧的 Python solutionCode 与新 solutions map 收敛为同一个兼容视图。 */
function normalizeTemplateSolutions(
  blueprint: Pick<SandboxSolutionBlueprint, 'solutions' | 'solutionCode'>,
): TemplateSolutions {
  return {
    ...(blueprint.solutionCode?.trim() ? { py: blueprint.solutionCode } : {}),
    ...blueprint.solutions,
  };
}

function normalizeSolutionBlueprintCompatibility(
  blueprint: SandboxSolutionBlueprint,
): SandboxSolutionBlueprint {
  const solutions = normalizeTemplateSolutions(blueprint);
  if (Object.keys(solutions).length === 0) return blueprint;
  return { ...blueprint, solutions, solutionCode: solutions.py };
}

/** 旧 checkpoint 缺失本轮函数题语言解时，必须整链重跑，不能混用下游制品。 */
function normalizeReusableCheckpoint(
  checkpoint: TestdataGenerationCheckpointPayload | undefined,
  options: GenerateOptions,
): TestdataGenerationCheckpointPayload | undefined {
  if (!checkpoint?.solution) return checkpoint;
  const solution = normalizeSolutionBlueprintCompatibility(checkpoint.solution);
  if (
    solution.problemType === 'function'
    && options.languages.some(language => !solution.solutions?.[language]?.trim())
  ) return undefined;
  return { ...checkpoint, solution };
}

function reusableCheckpointForContext(
  checkpoint: TestdataGenerationCheckpointPayload | undefined,
  options: GenerateOptions,
  reliabilityMode: TestdataReliabilityMode,
  context?: TestdataPipelineContext,
): TestdataGenerationCheckpointPayload | undefined {
  if (reliabilityMode === 'legacy') return normalizeReusableCheckpoint(checkpoint, options);
  if (!checkpoint || !context
    || checkpoint.checkpointSchemaVersion !== TESTDATA_CHECKPOINT_SCHEMA_VERSION
    || checkpoint.promptVersion !== context.promptVersion
    || checkpoint.statementHash !== context.statement.statementHash
    || checkpoint.specHash !== context.specHash) {
    return undefined;
  }
  const dependencies = checkpoint.roleDependencies || {};
  if (Object.values(dependencies).some(value => !/^[a-f0-9]{64}$/.test(value || ''))
    || (checkpoint.solution && !dependencies.oracle)
    || (checkpoint.artifacts && !dependencies.artifacts)
    || ((checkpoint.verifier || checkpoint.killTargets) && !dependencies.verifier)) {
    return undefined;
  }
  if ((context.risk.tier === 'high' || context.risk.tier === 'blocked')
    && (!dependencies.oracle
      || !dependencies.verifier
      || dependencies.oracle === dependencies.verifier)) {
    return undefined;
  }
  return normalizeReusableCheckpoint(checkpoint, options);
}

function assertSelectedTemplateSolutions(
  problemType: SandboxSolutionBlueprint['problemType'],
  solutions: TemplateSolutions,
  options: GenerateOptions,
  owner: string,
): void {
  if (problemType !== 'function') return;
  const missing = options.languages.filter(language => !solutions[language]?.trim());
  if (missing.length > 0) {
    throw new Error(`${owner}未返回已选语言的 SOLUTION：${missing.join('、')}`);
  }
}

/** 解析独立错误解靶子；单节损坏时丢弃，不影响其余靶子。 */
export function parseKillTargetsResponse(raw: string): KillTarget[] {
  const allowedKinds = new Set<KillTargetKind>(['boundary', 'wrong-algorithm', 'overflow-sim']);
  const markerRe = /^\s*===\s*KILL_TARGET:([a-z-]+)\s*===\s*$/i;
  const sections: Array<{ kind: string; lines: string[] }> = [];
  let current: { kind: string; lines: string[] } | null = null;
  const text = raw.replace(/<think>[\s\S]*?<\/think>/g, '');

  for (const line of text.split(/\r?\n/)) {
    const marker = line.match(markerRe);
    if (marker) {
      current = { kind: marker[1].toLowerCase(), lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }

  return sections.flatMap(section => {
    if (!allowedKinds.has(section.kind as KillTargetKind)) return [];
    const content = section.lines.join('\n');
    const description = section.lines
      .map(line => line.match(/^\s*DESC:\s*(.*?)\s*$/i))
      .find((match): match is RegExpMatchArray => Boolean(match))?.[1] || '';
    const fenced = content.match(
      /(?:^|\r?\n)```(?:python|py)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*(?=\r?\n|$)/i,
    );
    const hasFenceMarker = section.lines.some(line => /^\s*```/.test(line));
    if (hasFenceMarker && !fenced) return [];
    const rawCode = fenced
      ? fenced[1]
      : trimBlankEdges(section.lines.filter(line => !/^\s*DESC:/i.test(line)));
    if (!rawCode.trim()) return [];
    return [{
      kind: section.kind as KillTargetKind,
      description,
      code: normalizeExecutableContent(rawCode),
    }];
  });
}

/** 解析定向补刀候选；单节损坏、空输入或超过 2000 字符时直接丢弃。 */
export function parseHackCasesResponse(raw: string): HackCandidate[] {
  const markerRe = /^\s*===\s*HACK_CASE\s*===\s*$/i;
  const sections: string[][] = [];
  let current: string[] | null = null;
  const text = raw.replace(/<think>[\s\S]*?<\/think>/g, '');

  for (const line of text.split(/\r?\n/)) {
    if (markerRe.test(line)) {
      current = [];
      sections.push(current);
    } else if (current) {
      current.push(line);
    }
  }

  return sections.flatMap(lines => {
    const content = lines.join('\n');
    const rationale = lines
      .map(line => line.match(/^\s*RATIONALE:\s*(.*?)\s*$/i))
      .find((match): match is RegExpMatchArray => Boolean(match))?.[1] || '';
    const fenced = content.match(
      /(?:^|\r?\n)```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*(?=\r?\n|$)/,
    );
    const hasFenceMarker = lines.some(line => /^\s*```/.test(line));
    if (hasFenceMarker && !fenced) return [];
    const rawInput = fenced
      ? fenced[1]
      : trimBlankEdges(lines.filter(line => !/^\s*RATIONALE:/i.test(line)));
    if (!rawInput.trim()) return [];
    const normalizedInput = normalizeFileContent(rawInput);
    if (normalizedInput.length > 2000) return [];
    return [{ input: normalizedInput, rationale }];
  });
}

/** 将已由 ORACLE 产出答案的补刀点追加进正式 cases，并保持现有测试点不变。 */
export function mergeHackCases(
  existing: TestCase[],
  hacks: Array<{ input: string; output: string }>,
  maxCases: number,
): TestCase[] {
  const capacity = Math.max(0, Math.floor(maxCases) - existing.length);
  if (hacks.length === 0 || capacity === 0) return existing;
  const appended = hacks.slice(0, capacity).map((hack, index): TestCase => {
    const caseNumber = existing.length + index + 1;
    return {
      label: `定向补刀 #${caseNumber}`,
      input: normalizeFileContent(hack.input),
      output: normalizeFileContent(hack.output),
      dataScale: 'small',
    };
  });
  return [...existing, ...appended];
}

/**
 * ORACLE_LANG 使用独立的 === 分节，避免改变既有 @@@ 代码分节契约。
 * 缺失、损坏或未知值一律回退 Python；函数题始终忽略 cpp 声明。
 */
export function parseOracleLanguage(
  raw: string,
  problemType: SandboxGenerationBlueprint['problemType'],
): OracleLanguage {
  if (problemType === 'function') return 'python';
  const match = raw.match(
    /(?:^|\r?\n)[ \t]*===\s*ORACLE_LANG\s*===\s*\r?\n[ \t]*(python|cpp)[ \t]*(?=\r?\n|$)/i,
  );
  return match?.[1].toLowerCase() === 'cpp' ? 'cpp' : 'python';
}

/**
 * SUBTASKS 使用独立的 === 分节，不改变既有 @@@ 代码分节契约。
 * 任一行不满足严格格式时整体丢弃，后续即可无歧义地降级为扁平生成。
 */
export function parseSubtasksSection(raw: string): SubtaskSpec[] {
  const match = raw.match(
    /(?:^|\r?\n)[ \t]*===\s*SUBTASKS\s*===\s*(?:\r?\n|$)([\s\S]*?)(?=(?:\r?\n)[ \t]*(?:===\s*[A-Z][A-Z0-9_]*\s*===|@@@[^@\r\n]+@@@)|$)/i,
  );
  const content = match?.[1].trim();
  if (!content) return [];

  const subtasks: SubtaskSpec[] = [];
  let previousId = 0;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    const parsed = line.match(/^(\d+)\s*\|\s*(\d+)\s*\|\s*(.+)$/);
    if (!parsed) return [];
    const id = Number(parsed[1]);
    const score = Number(parsed[2]);
    const constraints = parsed[3].trim();
    if (
      !Number.isSafeInteger(id)
      || id <= previousId
      || !Number.isSafeInteger(score)
      || score <= 0
      || !constraints
    ) return [];
    subtasks.push({ id, score, constraints });
    previousId = id;
  }
  return subtasks;
}

export function parseSandboxBlueprint(
  raw: string,
  options: GenerateOptions,
  parseOptions: ParseAiResponseOptions = {},
): SandboxGenerationBlueprint {
  const sections = splitDelimitedSections(raw);
  if (sections.length === 0) throw new Error('AI 未返回蓝图分节标记');

  const meta: Record<string, string> = {};
  const templates: Partial<Record<TemplateLang, string>> = {};
  let analysis: string | undefined;
  let notes: string | undefined;
  let generatorCode = '';
  let oracleCode = '';
  let bruteCode = '';
  let validatorCode = '';

  for (const section of sections) {
    const parts = section.header.split(':');
    const kind = parts[0].trim().toUpperCase();
    const content = trimBlankEdges(section.content);
    if (kind === 'META') {
      for (const line of section.content) {
        const index = line.indexOf(':');
        if (index > 0) meta[line.slice(0, index).trim()] = line.slice(index + 1).trim();
      }
    } else if (kind === 'ANALYSIS') analysis = content;
    else if (kind === 'NOTES') notes = content;
    else if (kind === 'GENERATOR') generatorCode = content;
    else if (kind === 'ORACLE') oracleCode = content;
    else if (kind === 'BRUTE') bruteCode = content;
    else if (kind === 'VALIDATOR') validatorCode = content;
    else if (kind === 'TEMPLATE') {
      const lang = (parts[1] || '').trim().toLowerCase() as TemplateLang;
      if (SUPPORTED_TEMPLATE_LANGS.includes(lang) && content.trim()) {
        templates[lang] = normalizeExecutableContent(content);
      }
    }
  }

  const returnedType = meta.problemType === 'function' ? 'function'
    : meta.problemType === 'traditional' ? 'traditional'
      : null;
  if (!returnedType) throw new Error('AI 返回的 problemType 非法（应为 function 或 traditional）');
  const problemType = options.problemKind === 'auto' ? returnedType : options.problemKind;
  if (!generatorCode.trim()) throw new Error('AI 未返回可执行的 GENERATOR');
  if (!oracleCode.trim()) throw new Error('AI 未返回可执行的 ORACLE');
  const solutions = parseTemplateSolutions(sections);
  assertSelectedTemplateSolutions(problemType, solutions, options, 'AI 蓝图');

  if (problemType === 'function' && !parseOptions.allowMissingTemplates) {
    const missing = options.languages.filter(lang => !templates[lang]?.trim());
    if (missing.length > 0) {
      throw new Error(`AI 未返回 ${missing.map(lang => LANG_DISPLAY[lang]).join('、')} 的评测模板`);
    }
  }

  const fillInMode = options.fillInMode || 'auto';
  const isFillIn = fillInMode === 'yes' ? true
    : fillInMode === 'no' ? false
      : meta.isFillIn?.toLowerCase() === 'true';

  return {
    problemType,
    isFillIn,
    analysis,
    subtasks: parseSubtasksSection(raw),
    functionName: meta.functionName || undefined,
    templates: problemType === 'function' ? templates : undefined,
    generatorCode: normalizeExecutableContent(generatorCode),
    oracleCode: normalizeExecutableContent(oracleCode),
    oracleLanguage: parseOracleLanguage(raw, problemType),
    solutions: Object.keys(solutions).length > 0 ? solutions : undefined,
    solutionCode: solutions.py,
    bruteCode: bruteCode.trim() ? normalizeExecutableContent(bruteCode) : undefined,
    validatorCode: validatorCode.trim() ? normalizeExecutableContent(validatorCode) : undefined,
    notes,
  };
}

function parseFunctionSampleInputsSection(
  sections: ParsedSection[],
  expectedSamples: StatementSample[],
  owner: string,
): Array<{ id: string; input: string }> | undefined {
  if (expectedSamples.length === 0) return undefined;
  const sampleSection = sections.find(section => section.header.trim().toUpperCase() === 'SAMPLE_INPUTS');
  if (!sampleSection) throw new Error(`函数题存在题面样例，但${owner}缺少 SAMPLE_INPUTS 分节`);
  const rawSamples = trimBlankEdges(sampleSection.content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(rawSamples));
  } catch (err) {
    throw new Error(`SAMPLE_INPUTS 不是有效 JSON：${err instanceof Error ? err.message : String(err)}`);
  }
  const entries = (parsed as { samples?: unknown })?.samples;
  if (!Array.isArray(entries)) throw new Error('SAMPLE_INPUTS 必须包含 samples 数组');
  const byId = new Map<string, string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') throw new Error('SAMPLE_INPUTS 中存在非法样例项');
    const id = String((entry as { id?: unknown }).id ?? '');
    const input = (entry as { input?: unknown }).input;
    if (!id || typeof input !== 'string') throw new Error('SAMPLE_INPUTS 每项必须包含字符串 id 与 input');
    if (byId.has(id)) throw new Error(`SAMPLE_INPUTS 样例 id ${id} 重复`);
    byId.set(id, normalizeFileContent(input));
  }
  const expectedIds = new Set(expectedSamples.map(sample => sample.id));
  const unexpected = [...byId.keys()].find(id => !expectedIds.has(id));
  if (unexpected) throw new Error(`SAMPLE_INPUTS 包含题面中不存在的样例 id ${unexpected}`);
  const missing = expectedSamples.find(sample => !byId.has(sample.id));
  if (missing) throw new Error(`SAMPLE_INPUTS 缺少题面样例 id ${missing.id}`);
  const functionSampleInputs = expectedSamples.map(sample => ({
    id: sample.id,
    input: byId.get(sample.id) as string,
  }));
  const assignment = findAssignmentStyleCaseInput(
    functionSampleInputs.map(sample => ({ input: sample.input, output: '' })),
  );
  if (assignment) {
    throw new Error(`函数题样例 ${functionSampleInputs[assignment.caseNumber - 1].id} 转码后仍是源码赋值写法：${assignment.line}`);
  }
  return functionSampleInputs;
}

export function parseSolutionBlueprint(
  raw: string,
  options: GenerateOptions,
  expectedFunctionSamples: StatementSample[] = [],
): SandboxSolutionBlueprint {
  const sections = splitDelimitedSections(raw);
  if (sections.length === 0) throw new Error('AI 未返回解题蓝图分节标记');
  const forbidden = sections.find(section => {
    const kind = section.header.split(':')[0].trim().toUpperCase();
    return ['GENERATOR', 'BRUTE', 'STRESS_GENERATOR', 'VALIDATOR', 'TEMPLATE', 'CASE'].includes(kind);
  });
  if (forbidden) {
    throw new Error(`第一阶段解题蓝图包含禁止的 ${forbidden.header} 分节`);
  }
  const meta: Record<string, string> = {};
  let analysis: string | undefined;
  let notes: string | undefined;
  let oracleCode = '';
  for (const section of sections) {
    const kind = section.header.split(':')[0].trim().toUpperCase();
    const content = trimBlankEdges(section.content);
    if (kind === 'META') {
      for (const line of section.content) {
        const index = line.indexOf(':');
        if (index > 0) meta[line.slice(0, index).trim()] = line.slice(index + 1).trim();
      }
    } else if (kind === 'ANALYSIS') analysis = content;
    else if (kind === 'NOTES') notes = content;
    else if (kind === 'ORACLE') oracleCode = content;
  }
  const returnedType = meta.problemType === 'function' ? 'function'
    : meta.problemType === 'traditional' ? 'traditional'
      : null;
  if (!returnedType) throw new Error('AI 解题蓝图的 problemType 非法（应为 function 或 traditional）');
  const problemType = options.problemKind === 'auto' ? returnedType : options.problemKind;
  if (!oracleCode.trim()) throw new Error('AI 解题蓝图未返回可执行的 ORACLE');
  const solutions = parseTemplateSolutions(sections);
  assertSelectedTemplateSolutions(problemType, solutions, options, 'AI 解题蓝图');
  const fillInMode = options.fillInMode || 'auto';
  return {
    problemType,
    isFillIn: fillInMode === 'yes' ? true
      : fillInMode === 'no' ? false
        : meta.isFillIn?.toLowerCase() === 'true',
    analysis,
    subtasks: parseSubtasksSection(raw),
    functionName: meta.functionName || undefined,
    oracleCode: normalizeExecutableContent(oracleCode),
    oracleLanguage: parseOracleLanguage(raw, problemType),
    solutions: Object.keys(solutions).length > 0 ? solutions : undefined,
    solutionCode: solutions.py,
    functionSampleInputs: problemType === 'function'
      ? parseFunctionSampleInputsSection(sections, expectedFunctionSamples, '解题蓝图')
      : undefined,
    notes,
  };
}

export function parseGenerationArtifacts(
  raw: string,
  problemType: SandboxSolutionBlueprint['problemType'],
  languages: TemplateLang[],
  parseOptions: ParseAiResponseOptions = {},
): SandboxGenerationArtifacts {
  const sections = splitDelimitedSections(raw);
  if (sections.length === 0) throw new Error('AI 未返回外围制品分节标记');
  const forbidden = sections.find(section => {
    const kind = section.header.split(':')[0].trim().toUpperCase();
    return ['ORACLE', 'SOLUTION', 'BRUTE', 'STRESS_GENERATOR', 'VALIDATOR', 'CASE'].includes(kind);
  });
  if (forbidden) {
    throw new Error(`第二阶段外围制品包含禁止的 ${forbidden.header} 分节`);
  }
  const templates: Partial<Record<TemplateLang, string>> = {};
  let generatorCode = '';
  let notes: string | undefined;
  for (const section of sections) {
    const parts = section.header.split(':');
    const kind = parts[0].trim().toUpperCase();
    const content = trimBlankEdges(section.content);
    if (kind === 'GENERATOR') generatorCode = content;
    else if (kind === 'NOTES') notes = content;
    else if (kind === 'TEMPLATE') {
      const lang = (parts[1] || '').trim().toLowerCase() as TemplateLang;
      if (SUPPORTED_TEMPLATE_LANGS.includes(lang) && content.trim()) {
        templates[lang] = normalizeExecutableContent(content);
      }
    }
  }
  if (!generatorCode.trim()) throw new Error('AI 外围制品未返回可执行的 GENERATOR');
  if (problemType === 'function' && !parseOptions.allowMissingTemplates) {
    const missing = languages.filter(lang => !templates[lang]?.trim());
    if (missing.length > 0) throw new Error(`AI 外围制品未返回 ${missing.map(lang => LANG_DISPLAY[lang]).join('、')} 模板`);
  }
  return {
    generatorCode: normalizeExecutableContent(generatorCode),
    templates: problemType === 'function' ? templates : undefined,
    notes,
  };
}

/** 解析独立验证调用的三个强制分节，以及函数题样例的 stdin 转码。 */
export function parseIndependentVerifierBlueprint(
  raw: string,
  expectedFunctionSamples: StatementSample[] = [],
): IndependentVerifierBlueprint {
  const lines = raw.replace(/<think>[\s\S]*?<\/think>/g, '').split(/\r?\n/);
  const complexityGapMarker = lines.findIndex(line =>
    /^[ \t]*===\s*COMPLEXITY_GAP\s*===\s*$/i.test(line));
  let complexityGap: IndependentVerifierBlueprint['complexityGap'];
  if (complexityGapMarker >= 0) {
    const nextLine = lines[complexityGapMarker + 1];
    const hasValueLine = nextLine !== undefined && !SECTION_MARKER_RE.test(nextLine);
    const value = hasValueLine ? nextLine.trim().toLowerCase() : undefined;
    if (value === 'exists' || value === 'none') complexityGap = value;
    lines.splice(complexityGapMarker, hasValueLine ? 2 : 1);
  }
  const sections = splitDelimitedSections(lines.join('\n'));
  if (sections.length === 0) throw new Error('AI 未返回独立验证器分节标记');
  const bruteCode = repairSectionContent(sections, 'BRUTE');
  const stressGeneratorCode = repairSectionContent(sections, 'STRESS_GENERATOR');
  const validatorCode = repairSectionContent(sections, 'VALIDATOR');
  const missing = [
    !bruteCode ? 'BRUTE' : '',
    !stressGeneratorCode ? 'STRESS_GENERATOR' : '',
    !validatorCode ? 'VALIDATOR' : '',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`AI 独立验证器缺少必需分节：${missing.join('、')}`);
  }
  const functionSampleInputs = parseFunctionSampleInputsSection(
    sections,
    expectedFunctionSamples,
    '独立验证器',
  );
  return {
    bruteCode: bruteCode as string,
    stressGeneratorCode: stressGeneratorCode as string,
    validatorCode: validatorCode as string,
    complexityGap,
    functionSampleInputs,
  };
}

/**
 * 解析分节标记文本。未发现任何标记时返回 null（调用方回退到 JSON 解析）。
 *
 * 采用分节文本而非 JSON 的原因：AI 需要输出多段含引号/反斜杠/换行的代码，
 * 嵌入 JSON 字符串时转义极易出错（实测出现过 Expected ',' or '}' 一类的
 * 解析失败）；分节原文直出从根上消除了转义问题。
 * @throws Error 标记存在但结构非法时抛出（消息为中文，直接展示给教师）
 */
export function parseDelimitedResponse(
  raw: string,
  options: GenerateOptions,
  parseOptions: ParseAiResponseOptions = {},
): GenerationResponse | null {
  const sections = splitDelimitedSections(raw);
  if (sections.length === 0) return null;

  const obj: Record<string, unknown> = {};
  const templates: Record<string, string> = {};
  const caseMap = new Map<number, { input?: string; output?: string; label?: string }>();

  for (const section of sections) {
    const parts = section.header.split(':');
    const kind = parts[0].trim().toUpperCase();
    if (kind === 'META') {
      for (const line of section.content) {
        const idx = line.indexOf(':');
        if (idx <= 0) continue;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        if (key === 'problemType') obj.problemType = value;
        else if (key === 'isFillIn') obj.isFillIn = value.toLowerCase() === 'true';
        else if (key === 'functionName') obj.functionName = value;
      }
    } else if (kind === 'ANALYSIS') {
      obj.analysis = trimBlankEdges(section.content);
    } else if (kind === 'NOTES') {
      obj.notes = trimBlankEdges(section.content);
    } else if (kind === 'TEMPLATE') {
      const lang = (parts[1] || '').trim().toLowerCase();
      if (lang) templates[lang] = trimBlankEdges(section.content);
    } else if (kind === 'STD') {
      const code = trimBlankEdges(section.content);
      if (code) obj.stdSolution = { language: 'python', code };
    } else if (kind === 'CASE') {
      const num = parseInt((parts[1] || '').trim(), 10);
      const direction = (parts[2] || '').trim().toUpperCase();
      if (!Number.isInteger(num) || num < 1 || (direction !== 'IN' && direction !== 'OUT')) {
        throw new Error(`AI 返回中存在无法识别的 CASE 标记：@@@${section.header}@@@`);
      }
      const entry = caseMap.get(num) || {};
      if (direction === 'IN') {
        entry.input = trimBlankEdges(section.content);
        const label = parts.slice(3).join(':').trim();
        if (label) entry.label = label;
      } else {
        entry.output = trimBlankEdges(section.content);
      }
      caseMap.set(num, entry);
    }
    // 未知节名：忽略（向前兼容）
  }

  const caseNumbers = [...caseMap.keys()].sort((a, b) => a - b);
  const cases: Array<{ label?: string; input: string; output: string }> = [];
  for (const num of caseNumbers) {
    const entry = caseMap.get(num);
    if (!entry) continue;
    if (entry.input === undefined || entry.output === undefined) {
      throw new Error(`第 ${num} 个测试点缺少 ${entry.input === undefined ? 'IN' : 'OUT'} 节，请重试`);
    }
    cases.push({ label: entry.label, input: entry.input, output: entry.output });
  }
  obj.cases = cases;
  if (Object.keys(templates).length > 0) obj.templates = templates;

  return normalizeGenerationObject(obj, options, parseOptions);
}

/**
 * 解析 AI 响应：优先分节文本（当前契约），无标记时回退 JSON（兼容旧契约/
 * 忽略格式指令的模型）。两者都失败时抛出合并后的可读错误。
 */
export function parseAiResponse(
  raw: string,
  options: GenerateOptions,
  parseOptions: ParseAiResponseOptions = {},
): GenerationResponse {
  const delimited = parseDelimitedResponse(raw, options, parseOptions);
  if (delimited) return delimited;
  try {
    return parseGenerationResponse(raw, options, parseOptions);
  } catch (err) {
    throw new Error(
      `AI 返回格式无法解析（未找到分节标记，回退 JSON 也失败）。请重试一次；若持续失败，可减少测试点数量，或改用「生成骨架文件」手动填写。技术细节：${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** 返回函数题仍缺少的模板语言。 */
export function getMissingTemplateLanguages(
  response: GenerationResponse,
  options: GenerateOptions,
): TemplateLang[] {
  if (response.problemType !== 'function') return [];
  return options.languages.filter(lang => !response.templates?.[lang]?.trim());
}

export interface AssignmentStyleCaseInput {
  caseNumber: number;
  line: string;
}

/**
 * 检测把函数参数写成源码赋值语句的伪 stdin，例如 `s = "101"`。
 * 要求等号至少一侧有空白，避免把题目本来就允许的原始字符串 `a=1`
 * 误判为赋值语句。
 */
const ASSIGNMENT_STYLE_INPUT_RE = /^\s*(?:(?:const|let|var)\s+)?[A-Za-z_][A-Za-z0-9_]*(?:\s*:\s*[^=]+)?(?:\s+=\s*|\s*=\s+).+?;?\s*$/;

export function findAssignmentStyleCaseInput(cases: GeneratedCase[]): AssignmentStyleCaseInput | null {
  for (let i = 0; i < cases.length; i++) {
    for (const line of cases[i].input.split(/\r?\n/)) {
      if (ASSIGNMENT_STYLE_INPUT_RE.test(line)) {
        return { caseNumber: i + 1, line: line.trim() };
      }
    }
  }
  return null;
}

export type CheckerExecutionVerdict = 'accept' | 'reject' | 'infra-error';

export interface CheckerVerificationCheck {
  configured: boolean;
  read: boolean;
  compiled: boolean;
  executed: boolean;
  total: number;
  passed: number;
  infraFailures: number;
  failureKind?: 'unavailable' | 'compile' | 'infra' | 'budget' | 'reject';
}

const TESTLIB_PARTICIPANT_REJECT_EXIT_STATUSES = new Set([1, 2, 4, 7, 8]);

/** 将 checker 沙箱结果归约为业务三态；基础设施异常永远不能被当成 WA。 */
export function reduceCheckerExecution(
  detail?: Pick<PythonRunDetail, 'status' | 'accepted' | 'timedOut' | 'exitStatus'>,
  infrastructureError = false,
): CheckerExecutionVerdict {
  if (
    infrastructureError
    || !detail
    || detail.timedOut
  ) return 'infra-error';
  if (detail.status === 'Accepted' && detail.accepted && detail.exitStatus === 0) return 'accept';
  if (
    detail.status === 'Nonzero Exit Status'
    && !detail.accepted
    && typeof detail.exitStatus === 'number'
    && TESTLIB_PARTICIPANT_REJECT_EXIT_STATUSES.has(detail.exitStatus)
  ) return 'reject';
  return 'infra-error';
}

/** best-effort 阶段耗时从主正确性预算中剔除；系统时钟回拨时不缩短截止时间。 */
export function extendDeadlineByBestEffortElapsed(
  deadlineAt: number,
  phaseStartedAt: number,
  phaseFinishedAt: number,
): number {
  return deadlineAt + Math.max(0, phaseFinishedAt - phaseStartedAt);
}

export interface CheckerExecutor {
  readonly status: 'ready' | 'unavailable' | 'compile-failed';
  readonly compileError?: string;
  readonly runtimeSkipped: number;
  readonly check: CheckerVerificationCheck;
  runBatch(
    cases: CheckerRunCase[],
    opts?: { signal?: AbortSignal; deadlineAt?: number },
  ): Promise<CheckerExecutionVerdict[]>;
  runChecker(
    input: string,
    output: string,
    answer: string,
    opts?: { signal?: AbortSignal; deadlineAt?: number },
  ): Promise<CheckerExecutionVerdict>;
  dispose(): Promise<void>;
}

function unavailableCheckerExecutor(
  status: 'unavailable' | 'compile-failed',
  check: CheckerVerificationCheck,
  compileError?: string,
): CheckerExecutor {
  return {
    status,
    compileError,
    runtimeSkipped: 0,
    get check() { return { ...check }; },
    runBatch: async cases => cases.map(() => 'infra-error'),
    runChecker: async () => 'infra-error',
    dispose: async () => {},
  };
}

function checkerPreparationFailure(
  check: CheckerVerificationCheck,
  reliabilityMode: TestdataReliabilityMode,
  failureKind: 'compile' | 'infra' | 'budget',
  safeMessage: string,
): CheckerExecutor {
  check.failureKind = failureKind;
  const code = failureKind === 'compile'
    ? 'CHECKER_COMPILE_FAILED'
    : 'CHECKER_RUNTIME_FAILED';
  if (reliabilityMode === 'enforce') {
    throw checkerPipelineError(code, failureKind, safeMessage);
  }
  return unavailableCheckerExecutor('compile-failed', check, safeMessage);
}

function checkerPipelineError(
  code: 'CHECKER_REQUIRED_UNAVAILABLE' | 'CHECKER_COMPILE_FAILED' | 'CHECKER_RUNTIME_FAILED',
  failureKind: CheckerArtifactFailureKind | CheckerVerificationCheck['failureKind'],
  message: string,
): TestdataPipelineError {
  return toPipelineError(new Error(message), {
    code,
    stage: 'checker',
    artifact: 'checker',
    retryPolicy: 'manual-review',
    safeDetails: failureKind ? { failureKind } : undefined,
  });
}

function freshCheckerCheck(artifacts?: TestlibCheckerArtifacts): CheckerVerificationCheck {
  return {
    configured: artifacts?.configured ?? false,
    read: artifacts?.read ?? false,
    compiled: false,
    executed: false,
    total: 0,
    passed: 0,
    infraFailures: 0,
    ...((artifacts?.configured && !artifacts.read) ? { failureKind: 'unavailable' as const } : {}),
  };
}

async function createCheckerExecutor(input: {
  artifacts?: TestlibCheckerArtifacts;
  runner: TestdataSandboxRunner;
  signal?: AbortSignal;
  reliabilityMode: TestdataReliabilityMode;
}): Promise<CheckerExecutor> {
  const check = freshCheckerCheck(input.artifacts);
  const source = input.artifacts?.checkerSource;
  if (!source?.trim()) {
    check.failureKind = 'unavailable';
    if (input.reliabilityMode === 'enforce' && check.configured) {
      throw checkerPipelineError(
        'CHECKER_REQUIRED_UNAVAILABLE',
        input.artifacts?.failureKind || 'unavailable',
        '已配置的 checker 制品不可用，无法完成语义验证',
      );
    }
    return unavailableCheckerExecutor('unavailable', check);
  }
  if (!input.runner.compileCpp || !input.runner.runCheckerBatchDetailed) {
    const message = '当前 Hydro 沙箱不支持 checker 编译或执行';
    return checkerPreparationFailure(check, input.reliabilityMode, 'infra', message);
  }

  let checkerBudgetRemainingMs = CHECKER_BUDGET_MS;
  const compileStartedAt = Date.now();
  const compileDeadlineAt = compileStartedAt + checkerBudgetRemainingMs;
  let compiled;
  try {
    compiled = await input.runner.compileCpp(source, {
      extraFiles: input.artifacts?.checkerHeaders,
      signal: input.signal,
      deadlineAt: compileDeadlineAt,
    });
  } catch (err) {
    if (input.signal?.aborted) throw input.signal.reason ?? err;
    if (isCancellation(err)) throw err;
    const failureKind = isSandboxBudgetExceededError(err) ? 'budget' : 'infra';
    const message = failureKind === 'budget'
      ? 'checker 编译阶段超出执行预算'
      : 'checker 编译基础设施未返回可信结果';
    return checkerPreparationFailure(check, input.reliabilityMode, failureKind, message);
  } finally {
    checkerBudgetRemainingMs = Math.max(
      0,
      checkerBudgetRemainingMs - Math.max(0, Date.now() - compileStartedAt),
    );
  }
  if (input.signal?.aborted) {
    const reason = input.signal.reason
      ?? Object.assign(new Error('canceled'), { name: 'AbortError' });
    if (compiled.ok === true) {
      try {
        await input.runner.deleteCachedFile?.(compiled.fileId);
      } catch {
        // Preserve the caller's cancellation even when best-effort cleanup fails.
      }
    }
    throw reason;
  }
  if (compiled.ok === false) {
    const failureKind = compiled.kind === 'compile' ? 'compile' : 'infra';
    const message = failureKind === 'compile'
      ? 'checker 源码未通过编译'
      : 'checker 编译基础设施未返回可信结果';
    return checkerPreparationFailure(check, input.reliabilityMode, failureKind, message);
  }
  check.compiled = true;
  delete check.failureKind;

  let runtimeSkipped = 0;
  const executor: CheckerExecutor = {
    status: 'ready',
    get runtimeSkipped() {
      return runtimeSkipped;
    },
    get check() {
      return { ...check };
    },
    runBatch: async (cases, opts = {}) => {
      if (opts.signal?.aborted) {
        throw opts.signal.reason ?? Object.assign(new Error('canceled'), { name: 'AbortError' });
      }
      if (input.signal?.aborted) {
        throw input.signal.reason ?? Object.assign(new Error('canceled'), { name: 'AbortError' });
      }
      check.total += cases.length;
      if (checkerBudgetRemainingMs <= 0) {
        runtimeSkipped += cases.length;
        check.infraFailures += cases.length;
        check.failureKind = 'budget';
        if (input.reliabilityMode === 'enforce') {
          throw checkerPipelineError(
            'CHECKER_RUNTIME_FAILED', 'budget', 'checker 执行总预算已耗尽',
          );
        }
        return cases.map(() => 'infra-error');
      }
      const runStartedAt = Date.now();
      const checkerBudgetDeadlineAt = runStartedAt + checkerBudgetRemainingMs;
      const checkerDeadlineAt = opts.deadlineAt === undefined
        ? checkerBudgetDeadlineAt
        : Math.min(opts.deadlineAt, checkerBudgetDeadlineAt);
      try {
        const details = await (input.runner.runCheckerBatchDetailed as NonNullable<
          TestdataSandboxRunner['runCheckerBatchDetailed']
        >)(compiled.fileId, cases, {
          ...opts,
          deadlineAt: checkerDeadlineAt,
        });
        check.executed = true;
        const verdicts = cases.map((_, index) => reduceCheckerExecution(details[index]));
        const infraFailures = verdicts.filter(verdict => verdict === 'infra-error').length;
        runtimeSkipped += infraFailures;
        check.infraFailures += infraFailures;
        check.passed += verdicts.length - infraFailures;
        if (infraFailures > 0) {
          const timedOut = cases.some((_, index) => details[index]?.timedOut);
          check.failureKind = timedOut ? 'budget' : 'infra';
          if (input.reliabilityMode === 'enforce') {
            throw checkerPipelineError(
              'CHECKER_RUNTIME_FAILED', check.failureKind, 'checker 沙箱执行未返回可信判定',
            );
          }
        } else if (check.infraFailures === 0) delete check.failureKind;
        return verdicts;
      } catch (err) {
        if (opts.signal?.aborted) throw opts.signal.reason ?? err;
        if (input.signal?.aborted) throw input.signal.reason ?? err;
        if (isCancellation(err)) throw err;
        if (err instanceof TestdataPipelineError) throw err;
        check.executed = true;
        runtimeSkipped += cases.length;
        check.infraFailures += cases.length;
        check.failureKind = isSandboxBudgetExceededError(err) ? 'budget' : 'infra';
        if (input.reliabilityMode === 'enforce') {
          throw checkerPipelineError(
            'CHECKER_RUNTIME_FAILED', check.failureKind, 'checker 沙箱执行失败',
          );
        }
        return cases.map(() => 'infra-error');
      } finally {
        checkerBudgetRemainingMs = Math.max(
          0,
          checkerBudgetRemainingMs - Math.max(0, Date.now() - runStartedAt),
        );
      }
    },
    runChecker: async (checkerInput, output, answer, opts = {}) => {
      const [verdict] = await executor.runBatch([{
        input: checkerInput,
        output,
        answer,
      }], opts);
      return verdict;
    },
    dispose: async () => {
      try {
        await input.runner.deleteCachedFile?.(compiled.fileId);
      } catch {
        // checker 仅是尽力增强；缓存清理失败不能覆盖主流程结果。
      }
    },
  };
  return executor;
}

function appendCheckerExecutionNotes(
  response: GenerationResponse,
  customChecker: boolean,
  checkerExecutor: CheckerExecutor,
): void {
  if (!customChecker) return;
  if (response.verification) {
    const check = checkerExecutor.check;
    response.verification.checkerCheck = check;
    const checkerVerified = check.compiled && check.executed && check.infraFailures === 0;
    response.verification.verified = checkerVerified;
    response.verification.wouldBlock = !checkerVerified;
  }
  const notes: Array<{ kind: 'warning' | 'system'; text: string }> = [];
  if (checkerExecutor.status === 'ready') {
    notes.push({
      kind: 'system',
      text: '题目 testlib checker 已编译并实跑，用于样例回归、压力对拍、区分度与定向补刀判定。',
    });
  } else if (checkerExecutor.status === 'compile-failed') {
    const failureKind = checkerExecutor.check.failureKind;
    const failureLabel = failureKind === 'compile'
      ? 'checker 编译失败'
      : failureKind === 'budget'
        ? 'checker 准备阶段预算耗尽'
        : 'checker 准备基础设施失败';
    notes.push({
      kind: 'warning',
      text: `${failureLabel}，已记录为不可验证，本计划不得视为已验证。`,
    });
  }
  if (checkerExecutor.runtimeSkipped > 0) {
    notes.push({
      kind: 'warning',
      text: `题目 checker 有 ${checkerExecutor.runtimeSkipped} 次判定因沙箱超时或基础设施错误未完成；这些结果计为基础设施失败且不计验证通过。`,
    });
  }
  for (const note of notes) {
    response.notes = [response.notes, note.text].filter(Boolean).join('\n');
    if (response.notesStructured) {
      response.notesStructured[note.kind === 'warning' ? 'warnings' : 'system'].push(note.text);
    }
  }
}

type TargetExecutionDetail = {
  accepted: boolean;
  timedOut: boolean;
  status?: string;
  exitStatus?: number;
};

type TargetExecutionVerdict = 'accepted' | 'timeout' | 'runtime-failure' | 'infra-error';

function reduceTargetExecution(detail: TargetExecutionDetail): TargetExecutionVerdict {
  if (detail.timedOut || detail.status === 'Time Limit Exceeded') return 'timeout';
  if (detail.accepted) return 'accepted';
  if (detail.status === 'Nonzero Exit Status') return 'runtime-failure';
  return 'infra-error';
}

/** 根据沙箱逐点结果判定正式数据是否能够卡掉错误解靶子。 */
export function evaluateDiscrimination(inputs: {
  targetRuns: Array<{
    kind: DiscriminationTargetResult['kind'];
    description: string;
    perCase: Array<{
      accepted: boolean;
      timedOut: boolean;
      stdout: string;
      status?: string;
      exitStatus?: number;
      checkerVerdict?: CheckerExecutionVerdict;
    }>;
  }>;
  oracleOutputs: string[];
  customChecker: boolean;
  checkerAvailable?: boolean;
}): DiscriminationCheck {
  const targets = inputs.targetRuns.map((target): DiscriminationTargetResult => {
    if (
      inputs.customChecker
      && target.kind !== 'brute-complexity'
      && !inputs.checkerAvailable
      && !target.perCase.some(detail => detail.checkerVerdict !== undefined)
    ) {
      return {
        kind: target.kind,
        description: target.description,
        killed: false,
        skippedReason: 'checker-infra-error',
      };
    }

    let checkerInfraError = false;
    let executionInfraError = false;
    for (let index = 0; index < target.perCase.length; index++) {
      const detail = target.perCase[index];
      const executionVerdict = reduceTargetExecution(detail);
      if (executionVerdict === 'timeout') {
        return {
          kind: target.kind,
          description: target.description,
          killed: true,
          killedBy: 'tle',
          killedByCase: index + 1,
        };
      }
      if (executionVerdict === 'infra-error') {
        executionInfraError = true;
        continue;
      }
      if (executionVerdict === 'runtime-failure' && target.kind !== 'brute-complexity') {
        return {
          kind: target.kind,
          description: `${target.description}(运行失败)`,
          killed: true,
          killedBy: 'wa',
          killedByCase: index + 1,
        };
      }
      if (target.kind !== 'brute-complexity' && inputs.customChecker) {
        if (detail.checkerVerdict === 'reject') {
          return {
            kind: target.kind,
            description: target.description,
            killed: true,
            killedBy: 'wa',
            killedByCase: index + 1,
          };
        }
        if (detail.checkerVerdict === 'infra-error') checkerInfraError = true;
      } else if (
        target.kind !== 'brute-complexity'
        && comparableFileContent(detail.stdout)
          !== comparableFileContent(inputs.oracleOutputs[index] ?? '')
      ) {
        return {
          kind: target.kind,
          description: target.description,
          killed: true,
          killedBy: 'wa',
          killedByCase: index + 1,
        };
      }
    }
    if (checkerInfraError || executionInfraError) {
      return {
        kind: target.kind,
        description: target.description,
        killed: false,
        skippedReason: 'checker-infra-error',
      };
    }
    return {
      kind: target.kind,
      description: target.description,
      killed: false,
    };
  });
  return {
    targets,
    allKilled: areAllApplicableDiscriminationTargetsKilled(targets),
  };
}

/** 只有明确不适用的复杂度靶子可排除；未裁决状态必须阻断聚合通过。 */
function areAllApplicableDiscriminationTargetsKilled(
  targets: DiscriminationTargetResult[],
): boolean {
  const applicableTargets = targets.filter(
    target => target.skippedReason !== 'no-complexity-gap',
  );
  return applicableTargets.length > 0
    && applicableTargets.every(target => target.killed);
}

/** 将响应内部的从 1 开始本地序号映射为最终分配的测试点文件编号。 */
export function remapDiscriminationCaseNumbers(
  discrimination: DiscriminationCheck | undefined,
  allocatedCaseNumbers: number[],
): DiscriminationCheck | undefined {
  if (!discrimination) return undefined;
  return {
    ...discrimination,
    targets: discrimination.targets.map(target => {
      if (target.killedByCase === undefined) return { ...target };
      return {
        ...target,
        killedByCase: allocatedCaseNumbers[target.killedByCase - 1] ?? target.killedByCase,
      };
    }),
  };
}

/** 将最终区分度结果转换为面向教师的生成说明。 */
export function buildDiscriminationNotes(
  discrimination: DiscriminationCheck | undefined,
  initialCaseCount: number,
  allocatedCaseNumbers?: number[],
): string[] {
  if (!discrimination) return [];
  const checkedWrongTargets = discrimination.targets.filter(
    target => target.kind !== 'brute-complexity' && !target.skippedReason,
  );
  const bruteTarget = discrimination.targets.find(
    target => target.kind === 'brute-complexity' && !target.skippedReason,
  );
  const complexityGapSkipped = discrimination.targets.some(
    target => target.kind === 'brute-complexity'
      && target.skippedReason === 'no-complexity-gap',
  );
  const notes: string[] = [];

  if (complexityGapSkipped) {
    notes.push('该题不存在明显更慢的朴素解法，已跳过暴力复杂度检查。');
  }
  if (
    discrimination.allKilled
    && checkedWrongTargets.length > 0
    && bruteTarget?.killed
  ) {
    notes.push(`区分度验证:${checkedWrongTargets.length} 个错误解靶子与暴力复杂度检查均被现有数据卡住。`);
  }
  if (bruteTarget && !bruteTarget.killed) {
    notes.push('警告:独立暴力解在全部测试点均于 5 秒内通过,数据规模可能不足以区分复杂度,建议人工加大规模档位。');
  }
  for (const target of checkedWrongTargets) {
    if (!target.killed) {
      notes.push(`警告:一个「${target.description}」类错误解通过了全部数据与定向补刀,建议教师针对该错误模式人工补充测试点。`);
    } else if (
      target.killedByCase !== undefined
      && target.killedByCase > initialCaseCount
    ) {
      const caseNumber = allocatedCaseNumbers?.[target.killedByCase - 1]
        ?? target.killedByCase;
      notes.push(`已为「${target.description}」错误解定向补充 hack 测试点 #${caseNumber}。`);
    }
  }
  return notes;
}

interface GeneratedInputCase {
  label?: string;
  input: string;
}

/** 解析沙箱中 GENERATOR 的 stdout，只接受固定、简单的 JSON 契约。 */
export function parseGeneratorOutput(stdout: string, expectedCount: number): GeneratedInputCase[] {
  if (Buffer.byteLength(stdout, 'utf8') > TESTDATA_GEN_LIMITS.MAX_GENERATOR_OUTPUT_SIZE) {
    throw toPipelineError(new Error('GENERATOR 输出超过 1MB 上限'), {
      code: 'GENERATOR_OUTPUT_TOO_LARGE',
      stage: 'generator',
      artifact: 'generator',
      safeDetails: {
        actualBytes: Buffer.byteLength(stdout, 'utf8'),
        maxBytes: TESTDATA_GEN_LIMITS.MAX_GENERATOR_OUTPUT_SIZE,
      },
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch (err) {
    throw toPipelineError(err, {
      code: 'GENERATOR_INVALID_JSON',
      stage: 'generator',
      artifact: 'generator',
      message: `GENERATOR stdout 不是有效 JSON：${err instanceof Error ? err.message : String(err)}`,
    });
  }
  const rawCases = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object' ? (parsed as { cases?: unknown }).cases : undefined);
  if (!Array.isArray(rawCases)) {
    throw toPipelineError(new Error('GENERATOR JSON 缺少 cases 数组'), {
      code: 'GENERATOR_INVALID_JSON',
      stage: 'generator',
      artifact: 'generator',
    });
  }
  if (rawCases.length !== expectedCount) {
    throw toPipelineError(
      new Error(`GENERATOR 生成 ${rawCases.length} 个测试点，期望 ${expectedCount} 个`),
      {
        code: 'GENERATOR_WRONG_CASE_COUNT',
        stage: 'generator',
        artifact: 'generator',
        safeDetails: { actualCount: rawCases.length, expectedCount },
      },
    );
  }

  return rawCases.map((item, index) => {
    if (!item || typeof item !== 'object' || typeof (item as { input?: unknown }).input !== 'string') {
      throw toPipelineError(new Error(`GENERATOR 的第 ${index + 1} 个测试点缺少 input 字符串`), {
        code: 'GENERATOR_INVALID_INPUT',
        stage: 'generator',
        artifact: 'generator',
        safeDetails: { caseIndex: index + 1 },
      });
    }
    const input = normalizeFileContent((item as { input: string }).input);
    if (Buffer.byteLength(input, 'utf8') > TESTDATA_GEN_LIMITS.MAX_FILE_SIZE) {
      throw toPipelineError(new Error(`GENERATOR 的第 ${index + 1} 个 .in 超过 256KB 上限`), {
        code: 'GENERATOR_OUTPUT_TOO_LARGE',
        stage: 'generator',
        artifact: 'generator',
        safeDetails: {
          caseIndex: index + 1,
          actualBytes: Buffer.byteLength(input, 'utf8'),
          maxBytes: TESTDATA_GEN_LIMITS.MAX_FILE_SIZE,
        },
      });
    }
    const label = (item as { label?: unknown }).label;
    return {
      input,
      label: typeof label === 'string' ? label.slice(0, 200) : undefined,
    };
  });
}

/**
 * 用户中止/请求取消类错误：必须原样上抛，包装成阶段失败会误导修复回路重试。
 * 覆盖 DOM/axios 取消形态与 openaiClient 的 AIServiceError(category='aborted')。
 */
export function isCancellation(err: unknown): boolean {
  const e = err as { name?: string; code?: string; category?: string } | null;
  return !!e && (
    e.name === 'AbortError' || e.name === 'CanceledError'
    || e.code === 'ERR_CANCELED' || e.category === 'aborted'
  );
}

function toSandboxExecutionPipelineError(
  error: unknown,
  fallback: TestdataPipelineErrorContext,
): TestdataPipelineError {
  if (isSandboxBudgetExceededError(error)) {
    return toPipelineError(error, {
      code: 'PIPELINE_BUDGET_EXHAUSTED',
      stage: 'sandbox_budget',
      artifact: 'pipeline',
      retryPolicy: 'no-retry',
    });
  }
  return toPipelineError(error, fallback);
}

/**
 * 为一段可重试/可 fallback 的异步工作创建绝对截止时间 signal，同时把用户取消
 * 级联进去。调用方通过 deadlineTriggered 区分“预算耗尽，可静默降级”和“用户取消，
 * 必须继续上抛”，并在 finally 中清理计时器与监听器。
 */
function createDeadlineAbortScope(
  userSignal: AbortSignal | undefined,
  deadlineAt: number,
): {
  signal: AbortSignal;
  deadlineTriggered: () => boolean;
  dispose: () => void;
} {
  const controller = new AbortController();
  let triggeredByDeadline = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const onUserAbort = () => controller.abort(userSignal?.reason);

  if (userSignal?.aborted) {
    controller.abort(userSignal.reason);
  } else {
    userSignal?.addEventListener('abort', onUserAbort, { once: true });
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      triggeredByDeadline = true;
      controller.abort();
    } else {
      deadlineTimer = setTimeout(() => {
        if (controller.signal.aborted) return;
        triggeredByDeadline = true;
        controller.abort();
      }, remainingMs);
    }
  }

  return {
    signal: controller.signal,
    deadlineTriggered: () => triggeredByDeadline,
    dispose: () => {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      userSignal?.removeEventListener('abort', onUserAbort);
    },
  };
}

/**
 * 正式区分度前先用题面样例筛掉不可运行或连样例都答错的靶子，避免把语法错误
 * 等低质量程序误记为被正式数据卡住。无样例时无法烟测，保留原靶子。
 */
export async function smokeTestKillTargets(input: {
  killTargets: KillTarget[];
  samples: SampleIO[];
  runner: TestdataSandboxRunner;
  signal?: AbortSignal;
  customChecker: boolean;
  checkerExecutor?: CheckerExecutor;
  deadlineAt: number;
}): Promise<KillTarget[]> {
  if (input.killTargets.length === 0 || input.samples.length === 0) {
    return input.killTargets;
  }
  const validTargets: KillTarget[] = [];
  for (const target of input.killTargets) {
    if (Date.now() >= input.deadlineAt) break;
    try {
      const details = await input.runner.runPythonBatchDetailed(
        target.code,
        input.samples.map(sample => sample.input),
        { signal: input.signal, deadlineAt: input.deadlineAt },
      );
      if (details.length !== input.samples.length) continue;
      if (details.some(detail => !detail.accepted || detail.timedOut)) continue;
      if (input.customChecker && input.checkerExecutor?.status !== 'ready') {
        validTargets.push(target);
        continue;
      }
      let checkerVerdicts: CheckerExecutionVerdict[] | undefined;
      if (input.customChecker && input.checkerExecutor?.status === 'ready') {
        checkerVerdicts = await input.checkerExecutor.runBatch(
          input.samples.map((sample, index) => ({
            input: sample.input,
            output: details[index]?.stdout || '',
            answer: sample.output,
          })),
          { signal: input.signal, deadlineAt: input.deadlineAt },
        );
      }
      const passed = details.every((detail, index) => {
        if (checkerVerdicts) return checkerVerdicts[index] === 'accept';
        return comparableFileContent(detail.stdout)
          === comparableFileContent(input.samples[index].output);
      });
      if (passed) validTargets.push(target);
    } catch (err) {
      if (input.signal?.aborted) throw input.signal.reason ?? err;
      if (isCancellation(err)) throw err;
      // 单个靶子烟测失败仅丢弃该靶子，不影响正确性管线和其余靶子。
    }
  }
  return validTargets;
}

interface OracleExecutor {
  readonly language: OracleLanguage;
  runBatchDetailed(
    inputs: string[],
    opts?: { signal?: AbortSignal; deadlineAt?: number; chunkConcurrency?: number },
  ): Promise<PythonRunDetail[]>;
  dispose(): Promise<void>;
}

function isProvidedCppOracle(
  blueprint: Pick<SandboxSolutionBlueprint, 'problemType'>,
  options: GenerateOptions,
): boolean {
  const provided = options.providedStd?.trim();
  return blueprint.problemType === 'traditional'
    && !!provided
    && detectStdFilename(provided) === 'std.cc';
}

async function createOracleExecutor(input: {
  blueprint: Pick<SandboxSolutionBlueprint, 'problemType' | 'oracleCode' | 'oracleLanguage'>;
  options: GenerateOptions;
  runner: TestdataSandboxRunner;
  cppOracleAvailable: boolean;
  signal?: AbortSignal;
  deadlineAt?: number;
  /** 补刀属于非关键增强：主流程已编译成功后，二次编译失败只应降级跳过。 */
  hardProvidedStdFailure?: boolean;
}): Promise<OracleExecutor> {
  const providedCpp = isProvidedCppOracle(input.blueprint, input.options);
  const language: OracleLanguage = input.blueprint.problemType === 'function'
    ? 'python'
    : providedCpp ? 'cpp' : input.blueprint.oracleLanguage || 'python';
  const source = providedCpp
    ? normalizeExecutableContent(input.options.providedStd as string)
    : input.blueprint.oracleCode;

  if (language === 'python') {
    return {
      language,
      runBatchDetailed: (inputs, opts = {}) =>
        input.runner.runPythonBatchDetailed(source, inputs, opts),
      dispose: async () => {},
    };
  }

  const hardProvidedStdFailure = providedCpp && input.hardProvidedStdFailure !== false;
  if (
    !input.cppOracleAvailable
    || !input.runner.compileCpp
    || !input.runner.runCompiledBatchDetailed
  ) {
    const detail = '当前 Hydro 沙箱未通过 C++17 编译能力探测';
    if (hardProvidedStdFailure) {
      throw new TestdataGenerationError(
        `当前沙箱无 C++ 编译能力，无法执行教师提供的标准答案。${detail}`,
        'provided_cpp_oracle',
        [],
        false,
        CPP_ORACLE_UNAVAILABLE_KEY,
        detail,
        {
          code: 'ORACLE_COMPILE_FAILED', artifact: 'oracle', retryPolicy: 'manual-review',
          safeDetails: { failureKind: 'infra', oracleLanguage: 'cpp' },
        },
      );
    }
    throw toPipelineError(new Error(`ORACLE_LANG=cpp 的 C++17 ORACLE 编译能力不可用：${detail}`), {
      code: 'ORACLE_COMPILE_FAILED',
      stage: 'oracle',
      artifact: 'oracle',
      retryPolicy: 'repair-artifact',
      safeDetails: { failureKind: 'infra', oracleLanguage: 'cpp' },
    });
  }

  const compiled = await input.runner.compileCpp(source, {
    signal: input.signal,
    deadlineAt: input.deadlineAt,
  });
  if (compiled.ok === false) {
    const detail = excerptTail(compiled.error, 2000);
    if (compiled.kind === 'infra') {
      if (hardProvidedStdFailure) {
        throw new TestdataGenerationError(
          `C++ 编译基础设施暂时不可用，无法执行教师提供的标准答案：${detail}`,
          'provided_cpp_oracle_infra',
          [],
          false,
          CPP_ORACLE_INFRA_FAILURE_KEY,
          detail,
          {
            code: 'ORACLE_COMPILE_FAILED', artifact: 'oracle', retryPolicy: 'manual-review',
            safeDetails: { failureKind: 'infra', oracleLanguage: 'cpp' },
          },
        );
      }
      throw toPipelineError(new Error(`ORACLE_CPP_INFRA：C++ 编译基础设施不可用：${detail}；请改用 Python ORACLE`), {
        code: 'ORACLE_COMPILE_FAILED',
        stage: 'oracle',
        artifact: 'oracle',
        retryPolicy: 'repair-artifact',
        safeDetails: { failureKind: 'infra', oracleLanguage: 'cpp' },
      });
    }
    if (hardProvidedStdFailure) {
      throw new TestdataGenerationError(
        `教师提供的 C++ 标准答案编译失败：${detail}`,
        'provided_cpp_oracle',
        [],
        false,
        CPP_PROVIDED_STD_COMPILE_FAILED_KEY,
        detail,
        {
          code: 'ORACLE_COMPILE_FAILED', artifact: 'oracle', retryPolicy: 'manual-review',
          safeDetails: { failureKind: 'compile', oracleLanguage: 'cpp' },
        },
      );
    }
    throw toPipelineError(new Error(`ORACLE_LANG=cpp 的 C++17 ORACLE 编译失败：${detail}`), {
      code: 'ORACLE_COMPILE_FAILED',
      stage: 'oracle',
      artifact: 'oracle',
      safeDetails: { failureKind: 'compile', oracleLanguage: 'cpp' },
    });
  }

  return {
    language,
    runBatchDetailed: (inputs, opts = {}) =>
      (input.runner.runCompiledBatchDetailed as NonNullable<
        TestdataSandboxRunner['runCompiledBatchDetailed']
      >)(compiled.fileId, inputs, opts),
    dispose: async () => {
      try {
        await input.runner.deleteCachedFile?.(compiled.fileId);
      } catch {
        // go-judge 缓存最终会按 TTL 回收；清理失败不得覆盖验证结果。
      }
    },
  };
}

/**
 * 第一阶段硬闸门：在生成器、模板和独立验证器消耗更多 AI/沙箱预算前，
 * 先确认 ORACLE 至少能够执行并通过题面中可解析的样例。
 */
export async function verifySolutionBlueprintSamples(
  solution: SandboxSolutionBlueprint,
  options: GenerateOptions,
  statementMarkdown: string,
  runner: TestdataSandboxRunner,
  signal?: AbortSignal,
  customChecker = false,
  cppOracleAvailable = false,
  checkerExecutor?: CheckerExecutor,
): Promise<{ total: number; passed: number }> {
  const statementSamples = extractStatementSamples(statementMarkdown);
  if (statementSamples.length === 0) return { total: 0, passed: 0 };
  let samples = statementSamples;
  if (solution.problemType === 'function') {
    const converted = new Map((solution.functionSampleInputs || []).map(sample => [sample.id, sample.input]));
    const missing = statementSamples.find(sample => !converted.has(sample.id));
    if (missing) {
      throw toPipelineError(new Error(`解题蓝图缺少函数题样例 ${missing.id} 的 stdin 转码`), {
        code: 'SPEC_PARSE_FAILED',
        stage: 'solution_blueprint',
        artifact: 'spec',
      });
    }
    samples = statementSamples.map(sample => ({
      ...sample,
      input: normalizeFileContent(converted.get(sample.id) as string),
    }));
  }
  let executor: OracleExecutor | undefined;
  let results: PythonRunDetail[];
  try {
    executor = await createOracleExecutor({
      blueprint: solution,
      options,
      runner,
      cppOracleAvailable,
      signal,
    });
    results = await executor.runBatchDetailed(
      samples.map(sample => sample.input),
      { signal },
    );
  } catch (err) {
    if (isCancellation(err)) throw err;
    if (err instanceof TestdataGenerationError && err.userMessageKey) throw err;
    throw toSandboxExecutionPipelineError(err, {
      code: 'ORACLE_RUNTIME_FAILED',
      stage: 'solution_verification',
      artifact: 'oracle',
      message: `ORACLE 样例预验证执行失败：${err instanceof Error ? err.message : String(err)}`,
    });
  } finally {
    await executor?.dispose();
  }
  if (results.length !== samples.length) {
    throw toPipelineError(
      new Error(`ORACLE 样例预验证返回 ${results.length} 个结果，期望 ${samples.length} 个`),
      {
        code: 'ORACLE_RUNTIME_FAILED',
        stage: 'solution_verification',
        artifact: 'oracle',
        safeDetails: { actualCount: results.length, expectedCount: samples.length },
      },
    );
  }
  const acceptedRecord = options.providedStdSource === 'accepted-record';
  for (let i = 0; i < results.length; i++) {
    const detail = results[i];
    if (detail.accepted) continue;
    const prefix = acceptedRecord ? 'AC 候选标程' : 'ORACLE';
    throw toPipelineError(
      new Error(
        `${prefix}未通过第一阶段题面样例 ${samples[i].id} 的执行预验证（${detail.status || 'Unknown'}）\n`
        + `输入：${excerpt(samples[i].input, 300)}\n`
        + `错误：${excerptTail(detail.stderr || detail.error || '', 1000)}`,
      ),
      {
        code: 'ORACLE_RUNTIME_FAILED',
        stage: 'solution_verification',
        artifact: 'oracle',
        safeDetails: { caseIndex: i + 1, candidate: acceptedRecord },
      },
    );
  }
  const checkerVerdicts = customChecker && checkerExecutor?.status === 'ready'
    ? await checkerExecutor.runBatch(samples.map((sample, index) => ({
      input: sample.input,
      output: results[index]?.stdout || '',
      answer: sample.output,
    })), { signal })
    : undefined;
  for (let i = 0; i < results.length; i++) {
    const detail = results[i];
    const prefix = acceptedRecord ? 'AC 候选标程' : 'ORACLE';
    if (checkerVerdicts?.[i] === 'reject') {
      throw toPipelineError(
        new Error(`${prefix}未通过第一阶段题面样例 ${samples[i].id} 的题目 checker 验证`),
        {
          code: 'ORACLE_SAMPLE_MISMATCH',
          stage: 'solution_verification',
          artifact: 'oracle',
          safeDetails: { caseIndex: i + 1, checkerUsed: true, candidate: acceptedRecord },
        },
      );
    }
    if (
      !customChecker
      && comparableFileContent(detail.stdout) !== comparableFileContent(samples[i].output)
    ) {
      throw toPipelineError(
        new Error(
          `${prefix}未通过第一阶段题面样例 ${samples[i].id}`
          + `：期望 ${JSON.stringify(comparableFileContent(samples[i].output))}`
          + `，实际 ${JSON.stringify(comparableFileContent(detail.stdout))}`,
        ),
        {
          code: 'ORACLE_SAMPLE_MISMATCH',
          stage: 'solution_verification',
          artifact: 'oracle',
          safeDetails: { caseIndex: i + 1, checkerUsed: false, candidate: acceptedRecord },
        },
      );
    }
  }
  return {
    total: samples.length,
    passed: customChecker
      ? (checkerVerdicts?.filter(verdict => verdict === 'accept').length ?? 0)
      : samples.length,
  };
}

/**
 * 在正确性验证通过后，以独立预算运行错误解靶子与正式大数据 BRUTE 复杂度检查。
 * HTTP、协议与预算异常只会把尚未运行的靶子标为跳过，不得推翻已验证的产物。
 */
export async function runDiscriminationPhase(input: {
  killTargets: KillTarget[];
  bruteCode?: string;
  complexityGap?: 'exists' | 'none';
  cases: Array<{ input: string; output: string; dataScale?: CaseDataScale }>;
  runner: TestdataSandboxRunner;
  signal?: AbortSignal;
  customChecker: boolean;
  checkerExecutor?: CheckerExecutor;
  deadlineAt?: number;
}): Promise<DiscriminationCheck> {
  const deadlineAt = input.deadlineAt ?? Date.now() + DISCRIMINATION_BUDGET_MS;
  const results: DiscriminationTargetResult[] = [];
  const pending: Array<{
    kind: DiscriminationTargetResult['kind'];
    description: string;
    code: string;
    caseIndices: number[];
    skippedReason?: DiscriminationTargetResult['skippedReason'];
  }> = input.killTargets.map(target => ({
    kind: target.kind as DiscriminationTargetResult['kind'],
    description: target.description,
    code: target.code,
    caseIndices: input.cases.map((_, index) => index),
  }));
  if (input.bruteCode?.trim()) {
    const largeCaseIndices = input.cases.flatMap((item, index) =>
      item.dataScale === 'large' ? [index] : []);
    pending.push({
      kind: 'brute-complexity',
      description: '独立暴力解复杂度检查',
      code: input.bruteCode,
      caseIndices: largeCaseIndices.length > 0
        ? largeCaseIndices
        : input.cases.map((_, index) => index),
      skippedReason: input.complexityGap === 'none'
        ? 'no-complexity-gap'
        : undefined,
    });
  }

  for (let targetIndex = 0; targetIndex < pending.length; targetIndex++) {
    const target = pending[targetIndex];
    if (target.skippedReason) {
      results.push({
        kind: target.kind,
        description: target.description,
        killed: false,
        skippedReason: target.skippedReason,
      });
      continue;
    }
    try {
      if (Date.now() >= deadlineAt) throw new Error('区分度验证预算已耗尽');
      const selectedCases = target.caseIndices.map(index => input.cases[index]);
      const details = await input.runner.runPythonBatchDetailed(
        target.code,
        selectedCases.map(item => item.input),
        { signal: input.signal, deadlineAt },
      );
      if (details.length !== selectedCases.length) {
        throw new Error(`区分度验证返回 ${details.length} 个结果，期望 ${selectedCases.length} 个`);
      }
      let checkerVerdicts: Array<CheckerExecutionVerdict | undefined> | undefined;
      if (
        input.customChecker
        && target.kind !== 'brute-complexity'
        && input.checkerExecutor?.status === 'ready'
      ) {
        const mappedVerdicts: Array<CheckerExecutionVerdict | undefined> = new Array(
          selectedCases.length,
        );
        checkerVerdicts = mappedVerdicts;
        const acceptedIndices = details.flatMap((detail, index) =>
          detail.accepted && !detail.timedOut ? [index] : []);
        const verdicts = await input.checkerExecutor.runBatch(
          acceptedIndices.map(index => ({
            input: selectedCases[index].input,
            output: details[index].stdout,
            answer: selectedCases[index].output,
          })),
          { signal: input.signal, deadlineAt },
        );
        acceptedIndices.forEach((caseIndex, verdictIndex) => {
          mappedVerdicts[caseIndex] = verdicts[verdictIndex];
        });
      }
      const evaluated = evaluateDiscrimination({
        targetRuns: [{
          kind: target.kind,
          description: target.description,
          perCase: details.map((detail, index) => ({
            ...detail,
            checkerVerdict: checkerVerdicts?.[index],
          })),
        }],
        oracleOutputs: selectedCases.map(item => item.output),
        customChecker: input.customChecker,
        checkerAvailable: input.checkerExecutor?.status === 'ready',
      }).targets[0];
      if (evaluated?.killedByCase) {
        evaluated.killedByCase = target.caseIndices[evaluated.killedByCase - 1] + 1;
      }
      if (evaluated) results.push(evaluated);
    } catch (err) {
      if (input.signal?.aborted) throw input.signal.reason ?? err;
      if (isCancellation(err)) throw err;
      for (let index = targetIndex; index < pending.length; index++) {
        results.push({
          kind: pending[index].kind,
          description: pending[index].description,
          killed: false,
          skippedReason: 'budget-exhausted',
        });
      }
      break;
    }
  }

  if (input.killTargets.length === 0) {
    results.unshift({
      kind: 'boundary',
      description: '未生成可用的错误解靶子',
      killed: false,
      skippedReason: 'no-targets',
    });
  }
  return {
    targets: results,
    allKilled: areAllApplicableDiscriminationTargetsKilled(results),
  };
}

export type MaterializationPhase =
  | 'generator'
  | 'stress-generator'
  | 'validator'
  | 'oracle'
  | 'template'
  | 'brute';

export interface ReuseSet {
  formalInputs: boolean;
  stressInputs: boolean;
  validationResults: boolean;
  oracleOutputs: boolean;
}

export interface MaterializationResume {
  phase: MaterializationPhase;
  reuse: ReuseSet;
}

const NO_MATERIALIZATION_REUSE: ReuseSet = {
  formalInputs: false,
  stressInputs: false,
  validationResults: false,
  oracleOutputs: false,
};

/**
 * 单一产物修复映射到最早受影响阶段；组合或未知产物无法安全证明依赖关系，
 * 一律回到 GENERATOR 全量重跑。
 */
export function resolveMaterializationResume(
  changedArtifacts: string[],
): MaterializationResume {
  if (changedArtifacts.length !== 1) {
    return { phase: 'generator', reuse: { ...NO_MATERIALIZATION_REUSE } };
  }
  const [artifact] = changedArtifacts;
  if (artifact === 'STRESS_GENERATOR') {
    return {
      phase: 'stress-generator',
      reuse: { ...NO_MATERIALIZATION_REUSE, formalInputs: true },
    };
  }
  if (artifact === 'VALIDATOR') {
    return {
      phase: 'validator',
      reuse: {
        ...NO_MATERIALIZATION_REUSE,
        formalInputs: true,
        stressInputs: true,
      },
    };
  }
  if (artifact === 'ORACLE' || artifact === 'SOLUTION') {
    return {
      phase: 'oracle',
      reuse: {
        ...NO_MATERIALIZATION_REUSE,
        formalInputs: true,
        stressInputs: true,
        validationResults: true,
      },
    };
  }
  if (artifact === 'BRUTE') {
    return {
      phase: 'brute',
      reuse: {
        formalInputs: true,
        stressInputs: true,
        validationResults: true,
        oracleOutputs: true,
      },
    };
  }
  if (artifact === 'template.py') {
    return {
      phase: 'template',
      reuse: {
        formalInputs: true,
        stressInputs: true,
        validationResults: true,
        oracleOutputs: true,
      },
    };
  }
  return { phase: 'generator', reuse: { ...NO_MATERIALIZATION_REUSE } };
}

interface CachedStressInputs {
  generated: GeneratedInputCase[];
  generatedCount: number;
  uniqueInputs: number;
  duplicateInputs: number;
}

interface CachedValidationState {
  keptStressIndices: number[];
  droppedInvalid: number;
  validatorRan: boolean;
}

interface CachedOracleState {
  language: OracleLanguage;
  results: PythonRunDetail[];
  cases: GeneratedCase[];
  sampleCheckerVerdicts?: CheckerExecutionVerdict[];
}

export interface MaterializationCacheState {
  correctnessBudgetRemainingMs?: number;
  generatedInputs?: GeneratedInputCase[];
  stress?: CachedStressInputs;
  validation?: CachedValidationState;
  oracle?: CachedOracleState;
  templateCompleted?: boolean;
  templateChecks?: TemplateChecks;
}

export interface MaterializationRunOptions extends MaterializationResume {
  cache: MaterializationCacheState;
}

const MATERIALIZATION_PHASE_ORDER: Record<MaterializationPhase, number> = {
  generator: 0,
  'stress-generator': 1,
  validator: 2,
  oracle: 3,
  template: 4,
  brute: 5,
};

/**
 * 验证管线（独立小数据压力对拍 + 模板实跑 + 输入校验），执行序 a→g。
 * 各阶段间累计校验总时长预算，避免大批量挤兑沙箱 RAM 盘。
 */
export async function materializeSandboxBlueprint(
  blueprint: SandboxGenerationBlueprint,
  options: GenerateOptions,
  statementMarkdown: string,
  runner: TestdataSandboxRunner,
  signal?: AbortSignal,
  customChecker = false,
  onProgress?: (stage: TestdataGenerationProgressStage, percent: number) => void,
  killTargets: KillTarget[] = [],
  cppOracleAvailable = false,
  checkerExecutor?: CheckerExecutor,
  materialization?: MaterializationRunOptions,
): Promise<GenerationResponse> {
  const startedAt = Date.now();
  const cache = materialization?.cache ?? {};
  let requestedPhase = materialization?.phase ?? 'generator';
  const requestedPhaseIndex = MATERIALIZATION_PHASE_ORDER[requestedPhase];
  const cacheSupportsResume = (
    (requestedPhaseIndex <= MATERIALIZATION_PHASE_ORDER.generator || !!cache.generatedInputs)
    && (requestedPhaseIndex <= MATERIALIZATION_PHASE_ORDER['stress-generator'] || !!cache.stress)
    && (requestedPhaseIndex <= MATERIALIZATION_PHASE_ORDER.validator || !!cache.validation)
    && (requestedPhaseIndex <= MATERIALIZATION_PHASE_ORDER.oracle || !!cache.oracle)
    && (requestedPhase !== 'brute' || cache.templateCompleted === true)
  );
  if (!cacheSupportsResume) {
    requestedPhase = 'generator';
  }
  const startsAtOrBefore = (phase: MaterializationPhase) =>
    MATERIALIZATION_PHASE_ORDER[requestedPhase] <= MATERIALIZATION_PHASE_ORDER[phase];
  const correctnessBudgetMs = cache.correctnessBudgetRemainingMs ?? SANDBOX_TOTAL_BUDGET_MS;
  const materializationHardDeadlineAt = startedAt + correctnessBudgetMs + CHECKER_BUDGET_MS;
  let sandboxDeadlineAt = startedAt + correctnessBudgetMs;
  const reportProgress = (stage: TestdataGenerationProgressStage, percent: number) => {
    try { onProgress?.(stage, percent); } catch { /* progress is best-effort */ }
  };
  const providedStd = options.providedStd?.trim();
  const usingAcceptedRecordCandidate = !!providedStd
    && options.providedStdSource === 'accepted-record';
  if (usingAcceptedRecordCandidate && customChecker) {
    throw toPipelineError(
      new Error('AC 候选标程无法在自定义 checker 题中完成独立文本验证，请改用教师审核后的手动标程或取消选择'),
      {
        code: 'CHECKER_REQUIRED_UNAVAILABLE',
        stage: 'checker',
        artifact: 'checker',
        retryPolicy: 'manual-review',
      },
    );
  }
  const coveragePlan = buildCoveragePlan(options.caseCount, options.dataScale || 'auto');
  const checkBudget = () => {
    if (Date.now() >= sandboxDeadlineAt) {
      throw toPipelineError(new Error('沙箱执行总时长超出预算，请减少测试点数量后重试'), {
        code: 'PIPELINE_BUDGET_EXHAUSTED',
        stage: 'sandbox_budget',
        artifact: 'pipeline',
      });
    }
  };
  const runCheckerOutsideCorrectnessBudget = async <T>(run: () => Promise<T>): Promise<T> => {
    const checkerStartedAt = Date.now();
    try {
      return await run();
    } finally {
      sandboxDeadlineAt = extendDeadlineByBestEffortElapsed(
        sandboxDeadlineAt,
        checkerStartedAt,
        Date.now(),
      );
    }
  };
  let oracleExecutor: OracleExecutor | undefined;

  try {
  // a. GENERATOR 实跑 → 解析出全部 .in
  let generatedInputs: GeneratedInputCase[];
  if (startsAtOrBefore('generator')) {
    reportProgress('generating_inputs', 56);
    let generatorResult: PythonRunResult;
    try {
      generatorResult = await runner.runPython(blueprint.generatorCode, '', signal, sandboxDeadlineAt);
    } catch (err) {
      if (isCancellation(err)) throw err;
      throw toSandboxExecutionPipelineError(err, {
        code: 'UNKNOWN',
        stage: 'generator',
        artifact: 'generator',
        message: `GENERATOR 实跑失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
    generatedInputs = parseGeneratorOutput(generatorResult.stdout, options.caseCount);
    cache.generatedInputs = generatedInputs;
    delete cache.stress;
    delete cache.validation;
    delete cache.oracle;
    delete cache.templateCompleted;
    delete cache.templateChecks;
  } else {
    generatedInputs = cache.generatedInputs as GeneratedInputCase[];
  }
  const inputs = generatedInputs.map(item => item.input);

  // b. 函数题伪 stdin 检查（源码赋值写法拦截）
  if (blueprint.problemType === 'function') {
    const placeholderCases = generatedInputs.map(item => ({ ...item, output: '' }));
    const assignment = findAssignmentStyleCaseInput(placeholderCases);
    if (assignment) {
      throw toPipelineError(new Error(`第 ${assignment.caseNumber} 个 .in 仍是源码赋值写法：${assignment.line}`), {
        code: 'GENERATOR_INVALID_INPUT',
        stage: 'generator',
        artifact: 'generator',
        safeDetails: { caseIndex: assignment.caseNumber },
      });
    }
  }

  // c. 独立 STRESS_GENERATOR：内部小数据只用于验证，不进入最终文件计划。
  let stressInputs: string[] = [];
  let stressGenerated: GeneratedInputCase[] = [];
  let stressGeneratedCount = 0;
  let stressUniqueInputs = 0;
  let stressDuplicateInputs = 0;
  let stressDroppedInvalid = 0;
  if (startsAtOrBefore('stress-generator')) {
    if (blueprint.stressGeneratorCode) {
      reportProgress('generating_inputs', 60);
      checkBudget();
      let stressGeneratorResult: PythonRunResult;
      try {
        stressGeneratorResult = await runner.runPython(
          blueprint.stressGeneratorCode,
          '',
          signal,
          sandboxDeadlineAt,
        );
      } catch (err) {
        if (isCancellation(err)) throw err;
        throw toSandboxExecutionPipelineError(err, {
          code: 'UNKNOWN',
          stage: 'stress-generator',
          artifact: 'stress-generator',
          message: `STRESS_GENERATOR 实跑失败：${err instanceof Error ? err.message : String(err)}`,
        });
      }
      try {
        stressGenerated = parseGeneratorOutput(
          stressGeneratorResult.stdout,
          TESTDATA_GEN_LIMITS.STRESS_CASES,
        );
      } catch (err) {
        const code = err instanceof TestdataPipelineError
          && err.code === 'GENERATOR_WRONG_CASE_COUNT'
          ? 'STRESS_INSUFFICIENT_VALID_INPUTS'
          : err instanceof TestdataPipelineError ? err.code : 'GENERATOR_INVALID_JSON';
        throw new TestdataPipelineError(
          `STRESS_GENERATOR 输出无效：${err instanceof Error ? err.message : String(err)}`,
          code,
          'stress-generator',
          'stress-generator',
          repairPolicyForFailure({ code, artifact: 'stress-generator' }),
          err instanceof TestdataPipelineError ? err.safeDetails : {},
          err,
        );
      }
      stressGeneratedCount = stressGenerated.length;
      stressInputs = stressGenerated.map(item => item.input);
      stressUniqueInputs = new Set(stressInputs.map(comparableFileContent)).size;
      stressDuplicateInputs = stressInputs.length - stressUniqueInputs;
      const minimumUnique = Math.ceil(
        stressInputs.length * TESTDATA_GEN_LIMITS.STRESS_MIN_UNIQUE_RATIO,
      );
      if (stressUniqueInputs < minimumUnique) {
        throw toPipelineError(
          new Error(
            `STRESS_GENERATOR 压力数据多样性不足：${stressInputs.length} 组中仅 ${stressUniqueInputs} 组 input 唯一`
            + `，至少需要 ${minimumUnique} 组；禁止用重复输入凑数`,
          ),
          {
            code: 'STRESS_LOW_DIVERSITY',
            stage: 'stress-generator',
            artifact: 'stress-generator',
            safeDetails: {
              generatedCount: stressInputs.length,
              uniqueCount: stressUniqueInputs,
              minimumUnique,
            },
          },
        );
      }
      if (blueprint.problemType === 'function') {
        const assignment = findAssignmentStyleCaseInput(
          stressGenerated.map(item => ({ ...item, output: '' })),
        );
        if (assignment) {
          throw toPipelineError(new Error(`压力对拍第 ${assignment.caseNumber} 个 .in 仍是源码赋值写法：${assignment.line}`), {
            code: 'GENERATOR_INVALID_INPUT',
            stage: 'stress-generator',
            artifact: 'stress-generator',
            safeDetails: { caseIndex: assignment.caseNumber },
          });
        }
      }
    }
    cache.stress = {
      generated: stressGenerated,
      generatedCount: stressGeneratedCount,
      uniqueInputs: stressUniqueInputs,
      duplicateInputs: stressDuplicateInputs,
    };
    delete cache.validation;
    delete cache.oracle;
    delete cache.templateCompleted;
    delete cache.templateChecks;
  } else {
    const cachedStress = cache.stress as CachedStressInputs;
    stressGenerated = cachedStress.generated;
    stressGeneratedCount = cachedStress.generatedCount;
    stressInputs = stressGenerated.map(item => item.input);
    stressUniqueInputs = cachedStress.uniqueInputs;
    stressDuplicateInputs = cachedStress.duplicateInputs;
  }

  // 函数题的题面输入通常是 nums = [...] 之类逻辑展示，不能直接作为 stdin。
  // 仅使用独立验证调用按主蓝图编码转换后的输入；期望输出始终保留服务端从题面提取的原文。
  const statementSamples = extractStatementSamples(statementMarkdown);
  let samples: StatementSample[] = [];
  if (blueprint.problemType === 'traditional') {
    samples = statementSamples;
  } else if (blueprint.functionSampleInputs && statementSamples.length > 0) {
    const convertedById = new Map(blueprint.functionSampleInputs.map(sample => [sample.id, sample.input]));
    const missingSample = statementSamples.find(sample => !convertedById.has(sample.id));
    if (missingSample) {
      throw toPipelineError(new Error(`函数题样例 ${missingSample.id} 缺少独立 stdin 转码`), {
        code: 'GENERATOR_INVALID_INPUT',
        stage: 'function-samples',
        artifact: 'stress-generator',
      });
    }
    samples = statementSamples.map(sample => ({
      ...sample,
      input: normalizeFileContent(convertedById.get(sample.id) as string),
    }));
    const assignment = findAssignmentStyleCaseInput(
      samples.map(sample => ({ input: sample.input, output: sample.output })),
    );
    if (assignment) {
      throw toPipelineError(
        new Error(`函数题样例 ${samples[assignment.caseNumber - 1].id} 转码后仍是源码赋值写法：${assignment.line}`),
        {
          code: 'GENERATOR_INVALID_INPUT',
          stage: 'function-samples',
          artifact: 'stress-generator',
          safeDetails: { caseIndex: assignment.caseNumber },
        },
      );
    }
  }
  const sampleInputs = samples.map(sample => sample.input);

  // d. VALIDATOR：正式输入与题面样例仍逐项硬失败；压力输入允许在保底比例内剔除。
  let validatorRan = false;
  const validationInputs = [...inputs, ...sampleInputs, ...stressInputs];
  if (startsAtOrBefore('validator')) {
    let keptStressIndices = stressInputs.map((_, index) => index);
    if (blueprint.validatorCode) {
      reportProgress('validating_inputs', 66);
      checkBudget();
      let validatorResults: PythonRunDetail[];
      try {
        validatorResults = await runner.runPythonBatchDetailed(
          blueprint.validatorCode,
          validationInputs,
          { signal, deadlineAt: sandboxDeadlineAt, chunkConcurrency: 3 },
        );
      } catch (err) {
        if (isCancellation(err)) throw err;
        throw toSandboxExecutionPipelineError(err, {
          code: 'VALIDATOR_FALSE_REJECT',
          stage: 'validator',
          artifact: 'validator',
        });
      }
      if (validatorResults.length !== validationInputs.length) {
        throw toPipelineError(
          new Error(`VALIDATOR 返回 ${validatorResults.length} 个结果，期望 ${validationInputs.length} 个`),
          {
            code: 'VALIDATOR_FALSE_REJECT',
            stage: 'validator',
            artifact: 'validator',
            safeDetails: {
              actualCount: validatorResults.length,
              expectedCount: validationInputs.length,
            },
          },
        );
      }
      const formalAndSampleCount = inputs.length + samples.length;
      for (let i = 0; i < formalAndSampleCount; i++) {
        const detail = validatorResults[i];
        if (!detail.accepted) {
          const generatedInput = i < inputs.length;
          const target = generatedInput
            ? `第 ${i + 1} 个 .in `
            : `${blueprint.problemType === 'function' ? '函数题' : '题面'}样例 ${samples[i - inputs.length].id} `;
          throw toPipelineError(
            new Error(`${target}未通过输入校验：${excerpt(detail.stderr || detail.error || detail.status, 300)}`),
            {
              code: generatedInput ? 'GENERATOR_INVALID_INPUT' : 'VALIDATOR_FALSE_REJECT',
              stage: 'validator',
              artifact: generatedInput ? 'generator' : 'validator',
              safeDetails: { caseIndex: i + 1, sample: !generatedInput },
            },
          );
        }
      }
      const stressPartition = partitionStressValidation({
        stressResults: validatorResults.slice(formalAndSampleCount),
        minValidRatio: TESTDATA_GEN_LIMITS.STRESS_MIN_VALID_RATIO,
      });
      if (!stressPartition.sufficient) {
        const firstDropped = stressPartition.dropped[0];
        throw toPipelineError(
          new Error(
            `第 ${firstDropped.index + 1} 个压力 .in 未通过输入校验：`
            + excerpt(firstDropped.reason, 300),
          ),
          {
            code: 'STRESS_INSUFFICIENT_VALID_INPUTS',
            stage: 'validator',
            artifact: 'stress-generator',
            safeDetails: {
              droppedCount: stressPartition.dropped.length,
              validCount: stressPartition.keptIndices.length,
            },
          },
        );
      }
      keptStressIndices = stressPartition.keptIndices;
      stressDroppedInvalid = stressPartition.dropped.length;
      validatorRan = true;
    }
    cache.validation = {
      keptStressIndices,
      droppedInvalid: stressDroppedInvalid,
      validatorRan,
    };
    stressInputs = keptStressIndices.map(index => stressInputs[index]);
    stressGenerated = keptStressIndices.map(index => stressGenerated[index]);
    delete cache.oracle;
    delete cache.templateCompleted;
    delete cache.templateChecks;
  } else {
    const cachedValidation = cache.validation as CachedValidationState;
    stressInputs = cachedValidation.keptStressIndices.map(index => stressInputs[index]);
    stressGenerated = cachedValidation.keptStressIndices.map(index => stressGenerated[index]);
    stressDroppedInvalid = cachedValidation.droppedInvalid;
    validatorRan = cachedValidation.validatorRan;
  }

  // e. ORACLE：一次批量跑正式输入、题面样例和内部压力输入。
  const allInputs = [...inputs, ...sampleInputs, ...stressInputs];
  let oracleLanguage: OracleLanguage;
  let oracleResults: PythonRunDetail[];
  let cases: GeneratedCase[];
  let sampleCheckerVerdicts: CheckerExecutionVerdict[] | undefined;
  if (startsAtOrBefore('oracle')) {
    reportProgress('running_oracle', 72);
    checkBudget();
    try {
      oracleExecutor = await createOracleExecutor({
        blueprint,
        options,
        runner,
        cppOracleAvailable,
        signal,
        deadlineAt: sandboxDeadlineAt,
      });
      oracleLanguage = oracleExecutor.language;
      oracleResults = await oracleExecutor.runBatchDetailed(
        allInputs,
        { signal, deadlineAt: sandboxDeadlineAt, chunkConcurrency: 3 },
      );
    } catch (err) {
      if (isCancellation(err)) throw err;
      if (err instanceof TestdataGenerationError && err.userMessageKey) throw err;
      throw toSandboxExecutionPipelineError(err, {
        code: 'ORACLE_RUNTIME_FAILED',
        stage: 'oracle',
        artifact: 'oracle',
        message: `ORACLE（标程）实跑失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
    if (oracleResults.length !== allInputs.length) {
      throw toPipelineError(
        new Error(`ORACLE（标程）返回 ${oracleResults.length} 个结果，期望 ${allInputs.length} 个`),
        {
          code: 'ORACLE_RUNTIME_FAILED',
          stage: 'oracle',
          artifact: 'oracle',
          safeDetails: { actualCount: oracleResults.length, expectedCount: allInputs.length },
        },
      );
    }
    for (let i = 0; i < oracleResults.length; i++) {
      const detail = oracleResults[i];
      if (detail.accepted) continue;
      // 直接点名失败位置，附输入与 traceback 尾部，供修复回路与教师定位。
      const target = i < inputs.length
        ? `第 ${i + 1} 个测试点`
        : i < inputs.length + samples.length
          ? `题面样例 ${samples[i - inputs.length].id} `
          : `第 ${i - inputs.length - samples.length + 1} 个压力测试点`;
      throw toPipelineError(
        new Error(
          `${usingAcceptedRecordCandidate ? 'AC 候选标程' : 'ORACLE（标程）'}在${target}上执行失败（${detail.status || 'Unknown'}）\n`
          + `输入：${excerpt(allInputs[i] ?? '', 300) || '（空）'}\n`
          + `错误：${excerptTail(detail.stderr || detail.error || `exitStatus=${detail.exitStatus ?? 'unknown'}`, 1000)}`,
        ),
        {
          code: 'ORACLE_RUNTIME_FAILED',
          stage: 'oracle',
          artifact: 'oracle',
          safeDetails: { caseIndex: i + 1, candidate: usingAcceptedRecordCandidate },
        },
      );
    }

    cases = generatedInputs.map((item, index) => {
      const output = normalizeFileContent(oracleResults[index].stdout);
      if (Buffer.byteLength(output, 'utf8') > TESTDATA_GEN_LIMITS.MAX_FILE_SIZE) {
        throw toPipelineError(new Error(`ORACLE 为第 ${index + 1} 个测试点生成的 .out 超过 256KB 上限`), {
          code: 'ORACLE_RUNTIME_FAILED',
          stage: 'oracle',
          artifact: 'oracle',
          safeDetails: {
            caseIndex: index + 1,
            actualBytes: Buffer.byteLength(output, 'utf8'),
            maxBytes: TESTDATA_GEN_LIMITS.MAX_FILE_SIZE,
          },
        });
      }
      return { ...item, output, dataScale: coveragePlan[index]?.dataScale };
    });
    sampleCheckerVerdicts = customChecker && samples.length > 0
      && checkerExecutor?.status === 'ready'
      ? await runCheckerOutsideCorrectnessBudget(() => checkerExecutor.runBatch(
        samples.map((sample, index) => ({
          input: sample.input,
          output: oracleResults[inputs.length + index]?.stdout || '',
          answer: sample.output,
        })),
        { signal },
      ))
      : customChecker ? samples.map(() => 'infra-error' as const) : undefined;
    for (let i = 0; i < samples.length; i++) {
      const actual = oracleResults[inputs.length + i]?.stdout || '';
      const checkerRejected = sampleCheckerVerdicts?.[i] === 'reject';
      const textRejected = !customChecker
        && comparableFileContent(actual) !== comparableFileContent(samples[i].output);
      if (checkerRejected || textRejected) {
        throw toPipelineError(
          new Error(
            `${usingAcceptedRecordCandidate ? 'AC 候选标程' : 'ORACLE'}未通过${blueprint.problemType === 'function' ? '函数题' : '题面'}样例 ${samples[i].id}`
            + `（stdin：${JSON.stringify(comparableFileContent(samples[i].input))}）`
            + (checkerRejected
              ? '的题目 checker 验证'
              : `：期望 ${JSON.stringify(comparableFileContent(samples[i].output))}`
                + `，实际 ${JSON.stringify(comparableFileContent(actual))}`),
          ),
          {
            code: 'ORACLE_SAMPLE_MISMATCH',
            stage: 'oracle',
            artifact: 'oracle',
            safeDetails: {
              caseIndex: i + 1,
              checkerUsed: checkerRejected,
              candidate: usingAcceptedRecordCandidate,
            },
          },
        );
      }
    }
    cache.oracle = {
      language: oracleLanguage,
      results: oracleResults,
      cases,
      sampleCheckerVerdicts,
    };
    delete cache.templateCompleted;
    delete cache.templateChecks;
  } else {
    const cachedOracle = cache.oracle as CachedOracleState;
    oracleLanguage = cachedOracle.language;
    oracleResults = cachedOracle.results;
    cases = cachedOracle.cases;
    sampleCheckerVerdicts = cachedOracle.sampleCheckerVerdicts;
  }

  // f. 函数题：所有所选语言在每个正式点与题面样例上统一验证。
  let templateChecks: TemplateChecks | undefined;
  if (startsAtOrBefore('template')) {
    if (blueprint.problemType === 'function') {
      reportProgress('checking_templates', 79);
      checkBudget();
      const verificationCases = [
        ...inputs.map((input, index) => ({ input, answer: cases[index]?.output || '' })),
        ...sampleInputs.map((input, index) => ({
          input,
          answer: oracleResults[inputs.length + index]?.stdout || '',
        })),
      ];
      const adjudicator: TemplateOutputAdjudicator = {
        customChecker,
        adjudicate: async (adjudicationCases, controls = {}) => {
          if (!customChecker || checkerExecutor?.status !== 'ready') {
            return adjudicationCases.map(() => 'infra-error' as const);
          }
          return runCheckerOutsideCorrectnessBudget(() => checkerExecutor.runBatch(
            adjudicationCases,
            controls,
          ));
        },
      };
      try {
        templateChecks = await verifySelectedTemplates({
          languages: options.languages,
          solutions: {
            ...(blueprint.solutionCode ? { py: blueprint.solutionCode } : {}),
            ...blueprint.solutions,
          },
          templates: blueprint.templates || {},
          cases: verificationCases,
          runner,
          adjudicator,
          signal,
          deadlineAt: materializationHardDeadlineAt,
          deadlineAtProvider: () => sandboxDeadlineAt,
          allowCheckerInfraResult: true,
        });
      } catch (err) {
        if (isCancellation(err)) throw err;
        if (!(err instanceof TemplateVerificationError)) throw err;
        const safeDetails = {
          ...(err.caseIndex !== undefined ? { caseIndex: err.caseIndex + 1 } : {}),
          failureKind: err.kind,
        };
        if (err.kind === 'checker-infra') {
          const checkerFailureKind = checkerExecutor?.check.failureKind === 'budget'
            ? 'budget'
            : 'infra';
          throw checkerPipelineError(
            'CHECKER_RUNTIME_FAILED',
            checkerFailureKind,
            '模板输出未能完成可信 checker 裁决',
          );
        }
        if (err.kind === 'budget') {
          throw toPipelineError(err, {
            code: 'PIPELINE_BUDGET_EXHAUSTED',
            stage: 'sandbox_budget',
            artifact: 'pipeline',
            retryPolicy: 'no-retry',
            safeDetails,
          });
        }
        const code: TestdataFailureCode = err.kind === 'compile'
          ? 'TEMPLATE_COMPILE_FAILED'
          : err.kind === 'runtime' ? 'TEMPLATE_RUNTIME_FAILED' : 'TEMPLATE_OUTPUT_MISMATCH';
        throw toPipelineError(err, {
          code,
          stage: 'template',
          artifact: artifactForTemplateLanguage(err.language),
          safeDetails,
        });
      }
    }
    cache.templateCompleted = true;
    cache.templateChecks = templateChecks;
  } else {
    templateChecks = cache.templateChecks;
  }

  // g. 独立 BRUTE 优先跑内部小数据；兼容旧蓝图时回退到正式测试点。
  const oracleMatchesProvidedStd = !!(
    providedStd
    && blueprint.problemType === 'traditional'
    && (
      detectStdFilename(providedStd) === 'std.py'
      || detectStdFilename(providedStd) === 'std.cc'
    )
    && comparableFileContent(blueprint.oracleCode) === comparableFileContent(normalizeExecutableContent(providedStd))
  );
  const oracleIsAcceptedRecord = oracleMatchesProvidedStd
    && options.providedStdSource === 'accepted-record';
  const oracleIsManualStd = oracleMatchesProvidedStd && !oracleIsAcceptedRecord;
  let bruteCheck: PlanVerification['bruteCheck'];
  let stressCheck: PlanVerification['stressCheck'];
  const runBruteBatch = async (code: string, bruteInputs: string[]): Promise<PythonRunDetail[]> => {
    try {
      return await runner.runPythonBatchDetailed(
        code,
        bruteInputs,
        { signal, deadlineAt: sandboxDeadlineAt },
      );
    } catch (err) {
      if (isCancellation(err)) throw err;
      throw toSandboxExecutionPipelineError(err, {
        code: 'BRUTE_RUNTIME_FAILED',
        stage: 'stress_testing',
        artifact: 'brute',
        message: `BRUTE 实跑失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };
  if (oracleIsAcceptedRecord && (!blueprint.bruteCode || stressInputs.length === 0)) {
    throw toPipelineError(new Error('AC 候选标程缺少独立 BRUTE 小数据压力验证，不能作为本次 .out 的依据'), {
      code: 'COVERAGE_REQUIREMENT_MISSING',
      stage: 'stress_testing',
      artifact: 'brute',
      retryPolicy: 'manual-review',
    });
  }
  if (blueprint.bruteCode && stressInputs.length > 0) {
    reportProgress('stress_testing', 84);
    if (customChecker && checkerExecutor?.status !== 'ready') {
      checkBudget();
      const bruteResults = await runBruteBatch(blueprint.bruteCode, stressInputs);
      if (bruteResults.length !== stressInputs.length) {
        throw toPipelineError(
          new Error(`压力对拍 BRUTE 返回 ${bruteResults.length} 个结果，期望 ${stressInputs.length} 个`),
          {
            code: 'BRUTE_RUNTIME_FAILED', stage: 'stress_testing', artifact: 'brute',
            safeDetails: { actualCount: bruteResults.length, expectedCount: stressInputs.length },
          },
        );
      }
      for (let i = 0; i < bruteResults.length; i++) {
        const detail = bruteResults[i];
        if (detail.timedOut) {
          throw toPipelineError(new Error(`压力对拍 BRUTE 在第 ${i + 1} 组小数据超时；压力阶段不允许跳过`), {
            code: 'BRUTE_TIMEOUT', stage: 'stress_testing', artifact: 'brute',
            safeDetails: { caseIndex: i + 1 },
          });
        }
        if (!detail.accepted) {
          throw toPipelineError(
            new Error(`压力对拍 BRUTE 在第 ${i + 1} 组小数据执行失败：${excerpt(detail.stderr || detail.error || detail.status, 300)}`),
            {
              code: 'BRUTE_RUNTIME_FAILED', stage: 'stress_testing', artifact: 'brute',
              safeDetails: { caseIndex: i + 1 },
            },
          );
        }
      }
      stressCheck = {
        generated: stressGeneratedCount,
        uniqueInputs: stressUniqueInputs,
        duplicateInputs: stressDuplicateInputs,
        compared: 0,
        agreed: 0,
        ...(stressDroppedInvalid > 0 ? { droppedInvalid: stressDroppedInvalid } : {}),
      };
    } else {
      checkBudget();
      const bruteResults = await runBruteBatch(blueprint.bruteCode, stressInputs);
      if (bruteResults.length !== stressInputs.length) {
        throw toPipelineError(
          new Error(`压力对拍 BRUTE 返回 ${bruteResults.length} 个结果，期望 ${stressInputs.length} 个`),
          {
            code: 'BRUTE_RUNTIME_FAILED', stage: 'stress_testing', artifact: 'brute',
            safeDetails: { actualCount: bruteResults.length, expectedCount: stressInputs.length },
          },
        );
      }
      for (let i = 0; i < bruteResults.length; i++) {
        const detail = bruteResults[i];
        const caseNo = i + 1;
        if (detail.timedOut) {
          throw toPipelineError(new Error(`压力对拍 BRUTE 在第 ${caseNo} 组小数据超时；压力阶段不允许跳过`), {
            code: 'BRUTE_TIMEOUT', stage: 'stress_testing', artifact: 'brute',
            safeDetails: { caseIndex: caseNo },
          });
        }
        if (!detail.accepted) {
          throw toPipelineError(
            new Error(`压力对拍 BRUTE 在第 ${caseNo} 组小数据执行失败：${excerpt(detail.stderr || detail.error || detail.status, 300)}`),
            {
              code: 'BRUTE_RUNTIME_FAILED', stage: 'stress_testing', artifact: 'brute',
              safeDetails: { caseIndex: caseNo },
            },
          );
        }
      }
      const stressOracleOffset = inputs.length + samples.length;
      const checkerVerdicts = customChecker && checkerExecutor?.status === 'ready'
        ? await runCheckerOutsideCorrectnessBudget(() => checkerExecutor.runBatch(
          stressInputs.map((input, index) => ({
            input,
            output: bruteResults[index]?.stdout || '',
            answer: oracleResults[stressOracleOffset + index]?.stdout || '',
          })),
          { signal },
        ))
        : undefined;
      let compared = 0;
      let agreed = 0;
      for (let i = 0; i < bruteResults.length; i++) {
        const detail = bruteResults[i];
        const caseNo = i + 1;
        const oracleOutput = oracleResults[stressOracleOffset + i]?.stdout || '';
        if (checkerVerdicts?.[i] === 'infra-error') continue;
        compared++;
        const disagreed = checkerVerdicts
          ? checkerVerdicts[i] === 'reject'
          : comparableFileContent(detail.stdout) !== comparableFileContent(oracleOutput);
        if (disagreed) {
          if (oracleIsAcceptedRecord) {
            throw toPipelineError(
              new Error(
                `AC 候选标程与独立 BRUTE 在第 ${caseNo} 组小数据不一致（${stressGenerated[i]?.label || ''}）\n`
                + `输入：${excerpt(stressInputs[i], 300)}\n`
                + `AC 候选输出：${excerpt(oracleOutput, 300)}\n`
                + `独立 BRUTE 输出：${excerpt(detail.stdout, 300)}\n`
                + '该历史 AC 可能由旧测试数据误判，已拒绝使用；系统不会修复 BRUTE 来迁就它。',
              ),
              {
                code: 'TRUSTED_SOLUTIONS_DIVERGED', stage: 'stress_testing', artifact: 'oracle',
                safeDetails: { caseIndex: caseNo, candidate: true },
              },
            );
          }
          throw toPipelineError(
            new Error(
              `压力对拍 BRUTE 与 ORACLE 在第 ${caseNo} 组小数据不一致（${stressGenerated[i]?.label || ''}）\n`
              + `输入：${excerpt(stressInputs[i], 300)}\n`
              + `ORACLE 输出：${excerpt(oracleOutput, 300)}\n`
              + `BRUTE 输出：${excerpt(detail.stdout, 300)}`,
            ),
            {
              code: 'ORACLE_BRUTE_DIVERGENCE', stage: 'stress_testing', artifact: 'brute',
              safeDetails: { caseIndex: caseNo },
            },
          );
        }
        agreed++;
      }
      stressCheck = {
        generated: stressGeneratedCount,
        uniqueInputs: stressUniqueInputs,
        duplicateInputs: stressDuplicateInputs,
        compared,
        agreed,
        ...(stressDroppedInvalid > 0 ? { droppedInvalid: stressDroppedInvalid } : {}),
      };
    }
  } else if (blueprint.bruteCode) {
    reportProgress('stress_testing', 84);
    checkBudget();
    const bruteResults = await runBruteBatch(blueprint.bruteCode, inputs);
    if (bruteResults.length !== inputs.length) {
      throw toPipelineError(new Error(`暴力解返回 ${bruteResults.length} 个结果，期望 ${inputs.length} 个`), {
        code: 'BRUTE_RUNTIME_FAILED', stage: 'stress_testing', artifact: 'brute',
        safeDetails: { actualCount: bruteResults.length, expectedCount: inputs.length },
      });
    }
    let compared = 0;
    let agreed = 0;
    const skippedTimeout: number[] = [];
    const disagreed: number[] = [];
    for (let i = 0; i < bruteResults.length; i++) {
      const detail = bruteResults[i];
      const caseNo = i + 1;
      if (detail.timedOut) {
        skippedTimeout.push(caseNo);
        continue;
      }
      if (!detail.accepted) {
        throw toPipelineError(
          new Error(`暴力解在第 ${caseNo} 个测试点执行失败：${excerpt(detail.stderr || detail.error || detail.status, 300)}`),
          {
            code: 'BRUTE_RUNTIME_FAILED', stage: 'stress_testing', artifact: 'brute',
            safeDetails: { caseIndex: caseNo },
          },
        );
      }
      let outputsAgree: boolean;
      if (customChecker) {
        if (checkerExecutor?.status !== 'ready') continue;
        const verdict = await checkerExecutor.runChecker(
          inputs[i], detail.stdout, cases[i].output, { signal, deadlineAt: sandboxDeadlineAt },
        );
        if (verdict === 'infra-error') continue;
        outputsAgree = verdict === 'accept';
      } else {
        outputsAgree = comparableFileContent(detail.stdout) === comparableFileContent(cases[i].output);
      }
      compared++;
      if (outputsAgree) {
        agreed++;
        continue;
      }
      if (oracleIsAcceptedRecord) {
        throw toPipelineError(
          new Error(`AC 候选标程与独立暴力解在第 ${caseNo} 个测试点不一致，已拒绝使用该历史 AC`),
          {
            code: 'TRUSTED_SOLUTIONS_DIVERGED', stage: 'stress_testing', artifact: 'oracle',
            safeDetails: { caseIndex: caseNo, candidate: true },
          },
        );
      }
      // 教师手动 std 是权威：文本不一致只记录复核，不误判为生成失败。
      if (oracleIsManualStd) {
        disagreed.push(caseNo);
        continue;
      }
      throw toPipelineError(
        new Error(
          `暴力解与标程在第 ${caseNo} 个测试点不一致（${generatedInputs[i].label || ''}）\n`
          + `输入：${excerpt(inputs[i], 300)}\n`
          + `标程输出：${excerpt(cases[i].output, 300)}\n`
          + `暴力输出：${excerpt(detail.stdout, 300)}`,
        ),
        {
          code: 'ORACLE_BRUTE_DIVERGENCE', stage: 'stress_testing', artifact: 'brute',
          safeDetails: { caseIndex: caseNo },
        },
      );
    }
    bruteCheck = { compared, agreed, skippedTimeout, disagreed };
  }

  reportProgress('discrimination_testing', 90);
  const discriminationDeadlineAt = Date.now() + DISCRIMINATION_BUDGET_MS;
  const discriminationKillTargets = await smokeTestKillTargets({
    killTargets,
    samples: samples.map(sample => ({ input: sample.input, output: sample.output })),
    runner,
    signal,
    customChecker,
    checkerExecutor,
    deadlineAt: discriminationDeadlineAt,
  });
  const discrimination = await runDiscriminationPhase({
    killTargets: discriminationKillTargets,
    bruteCode: blueprint.bruteCode,
    complexityGap: blueprint.complexityGap,
    cases,
    runner,
    signal,
    customChecker,
    checkerExecutor,
    deadlineAt: discriminationDeadlineAt,
  });

  const verification: PlanVerification = {
    mode: 'sandbox',
    oracleKind: oracleIsAcceptedRecord
      ? 'accepted-record'
      : oracleIsManualStd ? 'provided-std' : 'ai-solution',
    verified: false,
    wouldBlock: false,
    validator: { ran: validatorRan, casesChecked: validatorRan ? validationInputs.length : 0 },
  };
  if (blueprint.problemType === 'traditional' || samples.length > 0) {
    verification.sampleCheck = {
      total: samples.length,
      passed: customChecker
        ? (sampleCheckerVerdicts?.filter(verdict => verdict === 'accept').length ?? 0)
        : samples.length,
    };
  }
  if (bruteCheck) verification.bruteCheck = bruteCheck;
  if (stressCheck) verification.stressCheck = stressCheck;
  if (templateChecks) verification.templateChecks = templateChecks;
  verification.discrimination = discrimination;

  const noteParts: Array<string | undefined> = [blueprint.notes];
  const noteWarnings: string[] = [];
  const noteSystem: string[] = [];
  const appendNote = (kind: 'warning' | 'system', note: string) => {
    noteParts.push(note);
    (kind === 'warning' ? noteWarnings : noteSystem).push(note);
  };
  appendNote(
    'system',
    `测试输入由生成器产生，所有 .out 已在 Hydro 沙箱中实际运行 ${oracleLanguage === 'cpp' ? 'C++17' : 'Python'} 标程生成。`,
  );
  if (blueprint.problemType === 'function' && samples.length > 0) {
    appendNote('system', `已由独立验证调用将 ${samples.length} 个函数题题面样例转换为原始 stdin，并回归 ORACLE${templateChecks ? ' 与全部所选语言模板' : ''}。`);
  }
  if (oracleIsAcceptedRecord) {
    appendNote('warning', samples.length > 0
      ? `所选历史 AC 仅作为候选解；本次已通过 ${samples.length} 个题面样例与独立 BRUTE 小数据压力验证，但这不等于正确性证明，仍建议教师人工复核关键边界。`
      : '所选历史 AC 仅作为候选解；题面未解析到可回归样例，本次仅通过独立 BRUTE 小数据压力验证。这不等于正确性证明，仍建议教师人工复核关键边界。');
  }
  if (bruteCheck && bruteCheck.disagreed.length > 0) {
    appendNote('warning', customChecker
      ? `题目使用自定义 checker；暴力解与标程在测试点 ${bruteCheck.disagreed.join('、')} 的文本输出不同，已保留并请人工复核 checker 语义。`
      : `暴力解与教师标准答案在测试点 ${bruteCheck.disagreed.join('、')} 不一致，已按教师 std 输出为准，请人工复核。`);
  }
  if (stressCheck?.droppedInvalid) {
    appendNote(
      'system',
      `已剔除 ${stressCheck.droppedInvalid} 组未通过输入校验的内部压力数据(仅用于内部对拍,不影响正式测试点)。`,
    );
  }
  if (stressCheck && stressCheck.compared > 0) {
    appendNote(
      'system',
      `${customChecker && checkerExecutor?.status === 'ready'
        ? '已使用独立生成的 BRUTE 和题目 checker 在'
        : '已使用独立生成的 BRUTE 在'}`
      + ` ${stressCheck.compared} 组内部小数据上完成压力对拍，全部一致；`
      + `其中 ${stressCheck.uniqueInputs} 组 input 唯一，重复 ${stressCheck.duplicateInputs} 组。`,
    );
  }
  if (bruteCheck && bruteCheck.skippedTimeout.length > 0) {
    appendNote('warning', `暴力解在测试点 ${bruteCheck.skippedTimeout.join('、')} 超时，已跳过对拍。`);
  }
  return {
    problemType: blueprint.problemType,
    isFillIn: blueprint.isFillIn,
    analysis: blueprint.analysis,
    subtasks: blueprint.subtasks,
    functionName: blueprint.functionName,
    templates: blueprint.templates,
    stdSolution: { language: oracleLanguage, code: blueprint.oracleCode },
    generatorCode: blueprint.generatorCode,
    oracleCode: blueprint.oracleCode,
    oracleLanguage,
    solutions: blueprint.solutions,
    solutionCode: blueprint.solutionCode,
    bruteCode: blueprint.bruteCode,
    validatorCode: blueprint.validatorCode,
    verification,
    discriminationDeadlineAt,
    discriminationKillTargets,
    cases,
    notes: noteParts.filter(Boolean).join('\n'),
    notesStructured: {
      warnings: noteWarnings,
      system: noteSystem,
      ...(blueprint.notes ? { ai: blueprint.notes } : {}),
    },
  };
  } finally {
    // AI 修复等待不属于沙箱执行时间；在本轮结束时冻结剩余预算，下一轮从
    // 该余额继续，而不是重置为完整预算或让模型响应耗时吃掉余额。
    cache.correctnessBudgetRemainingMs = Math.max(0, sandboxDeadlineAt - Date.now());
    // 编译缓存清理属于资源回收，不参与正确性预算，也不得把已通过的生成判为超时。
    await oracleExecutor?.dispose();
  }
}

/**
 * 解析“仅补模板”的 AI 响应。该响应无需重复 META/CASE，避免因完整重生成
 * 再次截断而丢失 Java 等排在后面的模板。
 */
export function parseTemplateSections(raw: string): Partial<Record<TemplateLang, string>> {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/g, '');
  const fenced = text.match(/^\s*```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n```\s*$/);
  if (fenced) text = fenced[1];

  const templates: Partial<Record<TemplateLang, string>> = {};
  let currentLang: TemplateLang | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (!currentLang) return;
    const content = trimBlankEdges(currentLines);
    if (content.trim()) templates[currentLang] = normalizeExecutableContent(content);
  };

  for (const line of text.split(/\r?\n/)) {
    const marker = line.match(SECTION_MARKER_RE);
    if (marker) {
      flush();
      const match = marker[1].trim().match(/^TEMPLATE:(py|java|cc)$/i);
      currentLang = match ? match[1].toLowerCase() as TemplateLang : null;
      currentLines = [];
    } else if (currentLang) {
      currentLines.push(line);
    }
  }
  flush();
  return templates;
}

function artifactForTemplateLanguage(language: TemplateLang): TestdataArtifact {
  if (language === 'java') return 'template-java';
  if (language === 'cc') return 'template-cc';
  return 'template-py';
}

// ─── 计划组装 ─────────────────────────────────────────────────────────────────

/**
 * 将解析后的 AI 响应组装为完整的文件计划
 */
/**
 * 将解析后的 AI 响应组装为完整的文件计划。
 * context.mode 决定各文件的 origin 徽章：sandbox（实跑）/ direct（AI 直出）；
 * 缺省视为 direct（保持旧 2 参调用行为不变）。
 */
/**
 * AI 生成代码文件的首行用途注释（.py 用 #，.cc/.java 用 //），供教师快速识别文件职责。
 * 外部提供的代码原样写入不加注释：教师手动 std 是权威，历史 AC 仅是候选。
 */
function prependPurposeComment(name: string, content: string, purpose: string): string {
  const marker = /\.(cc|cpp|java)$/i.test(name) ? '//' : '#';
  return `${marker} ${purpose}\n${content}`;
}

const FILE_PURPOSES = {
  generator: '数据生成器（AI 生成）：运行后向 stdout 输出 JSON，cases[].input 即各测试点 .in，可重跑重造数据',
  brute: '暴力对拍解（AI 生成）：与标程相互独立的第二实现，用于与 .out 交叉验证',
  validator: '输入校验器（AI 生成）：从 stdin 读取单个 .in 校验题面约束，不合法时非零退出',
  oracle: '完整标程 ORACLE（AI 生成）：读取 .in 输出 .out，本次测试数据的输出由它实跑产出',
  stdSolutionForm: '参考解（学生提交形式，AI 生成）：可与 template.* 组合后本地运行复验',
  stdProgram: '参考标程（AI 生成）：读取 stdin 输出答案，用于人工复验与重造数据',
  template: '函数题评测模板（AI 生成）：读取 stdin、调用学生实现并输出结果，学生代码与本文件组合评测',
} as const;

export function assemblePlan(
  response: GenerationResponse,
  options: GenerateOptions,
  context: {
    mode?: 'sandbox' | 'direct';
    existingFiles?: string[];
    existingConfig?: string;
    /** 沙箱生成已冻结的门控结果；避免修复/补刀后重新推导发生漂移。 */
    tieredDecision?: TieredSubtaskGenerationDecision;
  } = {},
): GenerationPlan {
  const sandbox = context.mode === 'sandbox';
  const dataOrigin: PlannedFileOrigin = sandbox ? 'executed' : 'ai-only';
  const files: PlannedFile[] = [];
  const caseCount = response.cases.length;
  const coveragePlan = buildCoveragePlan(caseCount, options.dataScale || 'auto');
  const tieredDecision = context.tieredDecision ?? resolveTieredSubtaskGeneration({
    caseCount: options.caseCount,
    dataScale: options.dataScale,
    subtasks: response.subtasks,
    existingConfig: context.existingConfig,
  });
  const tieredSubtasks = tieredDecision.subtasks ?? response.subtasks ?? [];
  const subtaskAllocations = tieredDecision.enabled
    ? extendTieredAllocations(tieredDecision.allocations, caseCount, tieredSubtasks)
    : [];
  const tieredApplied = tieredDecision.enabled && subtaskAllocations.length === caseCount;
  const newCaseNumbers = allocateCaseNumbers(context.existingFiles, caseCount);
  const existingComplete = getExistingNumericCases(context.existingFiles).complete;
  const configCaseNumbers = [...new Set([...existingComplete, ...newCaseNumbers])].sort((a, b) => a - b);
  const configBuild = buildConfigYamlWithMetadata({
    problemType: response.problemType,
    caseCount: configCaseNumbers.length,
    languages: options.languages,
    caseNumbers: configCaseNumbers,
    newCaseNumbers,
    existingConfig: context.existingConfig,
    subtasks: tieredApplied ? tieredSubtasks : undefined,
    subtaskAllocations: tieredApplied ? subtaskAllocations : undefined,
  });
  const tieredNotes: ConfigSubtaskMergeNote[] = [
    ...configBuild.subtaskNotes,
    ...(tieredDecision.warning ? [{
      kind: 'warning' as const,
      message: tieredDecision.warning,
    }] : []),
    ...(tieredApplied ? [{
      kind: 'system' as const,
      message: `已按题面子任务表生成 ${tieredSubtasks.length} 档分层数据;`
        + 'VALIDATOR 仅机器校验全局约束,各子任务档位约束由生成器构造保证,'
        + '建议抽查各档 .in 是否符合对应约束',
    }] : []),
    ...(tieredApplied && caseCount > tieredDecision.allocations.length ? [{
      kind: 'warning' as const,
      message: `补刀新增测试点 ${
        newCaseNumbers.slice(tieredDecision.allocations.length).map(n => `#${n}`).join('、')
      } 已归入子任务 ${tieredSubtasks[tieredSubtasks.length - 1]?.id ?? ''}(约束最宽档);`
        + '其输入仅经全局校验,请人工核对是否符合该档约束',
    }] : []),
  ];
  const discriminationNotes = buildDiscriminationNotes(
    response.verification?.discrimination,
    response.discriminationInitialCaseCount ?? response.cases.length,
    newCaseNumbers,
  );
  const notes = [
    response.notes,
    ...discriminationNotes,
    ...tieredNotes.map(note => note.message),
  ].filter(Boolean).join('\n') || undefined;
  const sourceNotesStructured = response.notesStructured ?? {
    warnings: [],
    system: [],
    ...(response.notes ? { ai: response.notes } : {}),
  };
  const notesStructured: StructuredGenerationNotes = {
    warnings: [
      ...sourceNotesStructured.warnings,
      ...discriminationNotes.filter(note => note.startsWith('警告:')),
      ...tieredNotes.filter(note => note.kind === 'warning').map(note => note.message),
    ],
    system: [
      ...sourceNotesStructured.system,
      ...discriminationNotes.filter(note => !note.startsWith('警告:')),
      ...tieredNotes.filter(note => note.kind === 'system').map(note => note.message),
    ],
    ...(sourceNotesStructured.ai ? { ai: sourceNotesStructured.ai } : {}),
  };
  const verification = response.verification
    ? {
      ...response.verification,
      ...(response.verification.discrimination ? {
        discrimination: remapDiscriminationCaseNumbers(
          response.verification.discrimination,
          newCaseNumbers,
        ),
      } : {}),
    }
    : undefined;
  /** AI 生成代码文件统一入口：文件名只写一处，注释符由文件名推导。 */
  const pushCode = (
    name: string, code: string, kind: PlannedFile['kind'], origin: PlannedFileOrigin, purpose: string,
  ) => files.push({ name, content: prependPurposeComment(name, code, purpose), kind, origin });

  response.cases.forEach((c, i) => {
    const fileNumber = newCaseNumbers[i];
    files.push({ name: `${fileNumber}.in`, content: c.input, kind: 'case-in', origin: dataOrigin });
    files.push({ name: `${fileNumber}.out`, content: c.output, kind: 'case-out', origin: dataOrigin });
  });

  if (response.problemType === 'function') {
    for (const lang of options.languages) {
      const content = response.templates?.[lang];
      if (content) {
        const check = response.verification?.templateChecks?.[lang];
        const origin: PlannedFileOrigin = sandbox
          && check?.compiled === true
          && check.executed === true
          && check.total > 0
          && check.passed === check.total
          ? 'executed'
          : 'ai-only';
        pushCode(TEMPLATE_FILENAMES[lang], content, 'template', origin, FILE_PURPOSES.template);
      }
    }
    files.push({ name: 'compile.sh', content: buildCompileSh(options.languages), kind: 'compile', origin: 'deterministic' });
  }

  if (response.generatorCode?.trim()) {
    pushCode(
      'generator.py',
      response.generatorCode,
      'generator',
      sandbox ? 'executed' : 'ai-only',
      FILE_PURPOSES.generator,
    );
  }
  if (sandbox && response.bruteCode?.trim()) {
    pushCode('brute.py', response.bruteCode, 'brute', 'executed', FILE_PURPOSES.brute);
  }
  if (sandbox && response.validatorCode?.trim()) {
    pushCode('validator.py', response.validatorCode, 'validator', 'executed', FILE_PURPOSES.validator);
  }

  // 外部代码原样写入；历史 AC 只有在沙箱验证通过后才标记为 executed。
  const providedStd = options.providedStd?.trim();
  if (providedStd) {
    const normalizedProvidedStd = normalizeExecutableContent(providedStd);
    files.push({
      name: detectStdFilename(providedStd),
      content: normalizedProvidedStd,
      kind: 'std',
      origin: sandbox && (
        options.providedStdSource === 'accepted-record'
        || (detectStdFilename(providedStd) === 'std.cc' && response.oracleLanguage === 'cpp')
      ) ? 'executed' : 'deterministic',
    });
    if (
      response.oracleCode?.trim()
      && normalizeExecutableContent(response.oracleCode) !== normalizedProvidedStd
    ) {
      pushCode('oracle.py', response.oracleCode, 'std', sandbox ? 'executed' : 'ai-only', FILE_PURPOSES.oracle);
    }
  } else {
    // 函数题沙箱模式：std.py 用学生提交形式（solutionCode），完整 ORACLE 另存 oracle.py 以闭环重造
    const useSolutionForm = sandbox && response.problemType === 'function' && response.solutionCode?.trim();
    const stdContent = useSolutionForm ? response.solutionCode : response.stdSolution?.code;
    if (stdContent) {
      const stdFilename = response.problemType === 'traditional' && response.oracleLanguage === 'cpp'
        ? 'std.cc'
        : 'std.py';
      pushCode(
        stdFilename, stdContent, 'std', sandbox ? 'executed' : 'ai-only',
        useSolutionForm ? FILE_PURPOSES.stdSolutionForm : FILE_PURPOSES.stdProgram,
      );
      if (
        sandbox
        && response.oracleCode?.trim()
        && normalizeExecutableContent(response.oracleCode) !== normalizeExecutableContent(stdContent)
      ) {
        pushCode('oracle.py', response.oracleCode, 'std', 'executed', FILE_PURPOSES.oracle);
      }
    }
  }

  files.push({
    name: 'config.yaml',
    content: configBuild.content,
    kind: 'config',
    origin: 'deterministic',
  });

  return {
    runId: createTestdataRunId(),
    promptVersion: TESTDATA_PIPELINE_PROMPT_VERSION,
    originalFileHashes: computeOriginalFileHashes(files.map(file => ({
      name: file.name,
      content: normalizeFileContent(file.content),
    }))),
    problemType: response.problemType,
    isFillIn: response.isFillIn,
    analysis: response.analysis,
    notes,
    notesStructured,
    files,
    caseCount,
    totalCaseCount: configCaseNumbers.length,
    caseCoverage: response.cases.map((item, index) => ({
      caseNumber: index + 1,
      fileNumber: newCaseNumbers[index],
      dataScale: item.dataScale || coveragePlan[index]?.dataScale || 'small',
      ...(subtaskAllocations[index] || configBuild.newCaseSubtaskIds[newCaseNumbers[index]] !== undefined
        ? {
          subtaskId: subtaskAllocations[index]?.subtaskId
            ?? configBuild.newCaseSubtaskIds[newCaseNumbers[index]],
        }
        : {}),
      target: item.label
        || subtaskAllocations[index]?.guidance
        || coveragePlan[index]?.guidance
        || '',
    })),
    ...(verification ? { verification } : {}),
  };
}

// ─── 服务端权威验证结论 ─────────────────────────────────────────────────────

function isTemplateVerificationGreen(check: TemplateChecks[TemplateLang] | undefined): boolean {
  return check?.compiled === true
    && check.executed === true
    && check.total > 0
    && check.passed === check.total;
}

/** 只依据服务端已产生的完整证据计算计划的权威验证结论。 */
export function finalizePlanVerification(
  plan: GenerationPlan,
  selectedLanguages: TemplateLang[],
  customChecker: boolean,
  reliabilityMode: TestdataReliabilityMode,
): GenerationPlan {
  const verification = plan.verification;
  if (!verification) return plan;

  if (plan.problemType === 'function') {
    verification.templateLanguages = SUPPORTED_TEMPLATE_LANGS.filter(language => (
      selectedLanguages.includes(language)
    ));
  }

  const sampleGreen = !verification.sampleCheck
    || verification.sampleCheck.passed === verification.sampleCheck.total;
  const stress = verification.stressCheck;
  const stressGreen = !!stress
    && !stress.skippedReason
    && stress.compared > 0
    && stress.agreed === stress.compared
    && (stress.uniqueInputs === undefined
      || stress.uniqueInputs >= Math.ceil(stress.generated * TESTDATA_GEN_LIMITS.STRESS_MIN_UNIQUE_RATIO));
  const brute = verification.bruteCheck;
  const legacyBruteGreen = !stress
    && !!brute
    && brute.compared > 0
    && brute.agreed === brute.compared
    && brute.disagreed.length === 0
    && brute.skippedTimeout.length === 0;
  const discriminationGreen = !verification.discrimination
    || (verification.discrimination.allKilled
      && areAllApplicableDiscriminationTargetsKilled(verification.discrimination.targets));
  const templatesGreen = plan.problemType !== 'function'
    || selectedLanguages.every(language => (
      isTemplateVerificationGreen(verification.templateChecks?.[language])
    ));
  const checker = verification.checkerCheck;
  const checkerGreen = !customChecker || (
    !!checker
    && checker.configured
    && checker.read
    && checker.compiled
    && checker.executed
    && checker.total > 0
    && checker.passed === checker.total
    && checker.infraFailures === 0
  );
  const selectedTemplateNames = new Set(selectedLanguages.map(language => TEMPLATE_FILENAMES[language]));
  const hasAiOnlyCriticalFile = plan.files.some(file => file.origin === 'ai-only' && (
    file.kind === 'case-in'
    || file.kind === 'case-out'
    || file.kind === 'std'
    || file.kind === 'generator'
    || file.kind === 'brute'
    || file.kind === 'validator'
    || (file.kind === 'template' && selectedTemplateNames.has(file.name))
  ));

  const verified = reliabilityMode !== 'legacy'
    && verification.mode === 'sandbox'
    && sampleGreen
    && (stressGreen || legacyBruteGreen)
    && discriminationGreen
    && templatesGreen
    && checkerGreen
    && !hasAiOnlyCriticalFile;
  verification.verified = verified;
  verification.wouldBlock = reliabilityMode === 'observe' && !verified;
  return plan;
}

// ─── 骨架模式（AI 故障降级，不调用 AI） ──────────────────────────────────────

/** 骨架模板：可直接编译/运行，教师按 TODO 补全输入输出部分 */
const SKELETON_TEMPLATES: Record<TemplateLang, string> = {
  py: `# 评测模板（骨架）：请按题目输入格式补全本文件。
# 评测时本文件会被追加到学生代码末尾：读取输入 → 调用学生函数 → 打印结果。
# 示例（提莫攻击）：
# timeSeries = list(map(int, input().split()))
# duration = int(input())
# print(findPoisonedDuration(timeSeries, duration))
`,
  java: `import java.util.*;

// 评测模板（骨架）：请按题目输入格式补全 main 方法。
// 学生提交 class Solution；在 main 中读取输入、调用 new Solution().方法(...) 并打印结果。
public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        // TODO: 例如：
        // int[] arr = Arrays.stream(sc.nextLine().trim().split("\\\\s+"))
        //         .mapToInt(Integer::parseInt).toArray();
        // System.out.println(new Solution().yourMethod(arr));
    }
}
`,
  cc: `#include <bits/stdc++.h>
using namespace std;
#include "foo.cc"

// 评测模板（骨架）：请按题目输入格式补全 main 函数。
// 学生代码通过上方 #include "foo.cc" 引入。
int main() {
    // TODO: 例如：
    // int x; cin >> x;
    // cout << yourFunction(x) << endl;
    return 0;
}
  `,
};

/** 骨架模式不调用 AI，仅用高置信题面标记判断是否为函数题。 */
export function isLikelyFunctionProblem(statementMarkdown: string): boolean {
  return /代码写到函数内部|LeetCode\s*(?:风格|style)|class\s+Solution\b[\s\S]{0,1000}\b(?:def|public|private|protected)\b/i
    .test(statementMarkdown);
}

/**
 * 构建骨架计划：不调用 AI，确定性生成结构性文件与空白测试点。
 * 用作 AI 故障时的降级方案——保住最容易出错的 compile.sh / config.yaml /
 * 模板机制部分，测试数据内容由教师在预览中手动填写。
 */
export function buildSkeletonPlan(
  options: GenerateOptions,
  statementMarkdown = '',
  existingFiles: string[] = [],
  existingConfig?: string,
): GenerationPlan {
  assertExistingConfigParsable(existingConfig);
  const autoDetectedFunction = options.problemKind === 'auto' && isLikelyFunctionProblem(statementMarkdown);
  const problemType: 'function' | 'traditional' = options.problemKind === 'function' || autoDetectedFunction
    ? 'function'
    : 'traditional';
  const files: PlannedFile[] = [];
  const caseNumbers = allocateCaseNumbers(existingFiles, options.caseCount);
  const existingComplete = getExistingNumericCases(existingFiles).complete;
  const configCaseNumbers = [...new Set([...existingComplete, ...caseNumbers])].sort((a, b) => a - b);
  const coveragePlan = buildCoveragePlan(options.caseCount, options.dataScale || 'auto');
  const configBuild = buildConfigYamlWithMetadata({
    problemType,
    caseCount: configCaseNumbers.length,
    languages: options.languages,
    caseNumbers: configCaseNumbers,
    newCaseNumbers: caseNumbers,
    existingConfig,
  });

  // 骨架模式全部为确定性生成/空占位，无沙箱实跑制品
  for (const number of caseNumbers) {
    files.push({ name: `${number}.in`, content: '\n', kind: 'case-in', origin: 'deterministic' });
    files.push({ name: `${number}.out`, content: '\n', kind: 'case-out', origin: 'deterministic' });
  }

  if (problemType === 'function') {
    for (const lang of options.languages) {
      files.push({ name: TEMPLATE_FILENAMES[lang], content: SKELETON_TEMPLATES[lang], kind: 'template', origin: 'deterministic' });
    }
    files.push({ name: 'compile.sh', content: buildCompileSh(options.languages), kind: 'compile', origin: 'deterministic' });
  }

  const providedStd = options.providedStd?.trim();
  if (providedStd) {
    files.push({
      name: detectStdFilename(providedStd),
      content: normalizeExecutableContent(providedStd),
      kind: 'std',
      origin: 'deterministic',
    });
  }

  files.push({
    name: 'config.yaml',
    content: configBuild.content,
    kind: 'config',
    origin: 'deterministic',
  });

  const noteParts = [
    '骨架模式（未调用 AI）：请在预览中逐个填写各 N.in / N.out 的内容后再写入。',
  ];
  if (problemType === 'function') {
    noteParts.push('请按题目输入格式补全各语言评测模板中的 TODO 部分。');
    if (autoDetectedFunction) noteParts.push('已根据题面中的函数题标记自动生成函数题骨架。');
  } else if (options.problemKind === 'auto') {
    noteParts.push('题型未指定，已按传统题生成；如需函数题骨架（模板 + compile.sh），请将题目类型选为"函数题"后重新生成。');
  }
  const legacyNotes = noteParts.join('');
  const subtaskNotes = configBuild.subtaskNotes;

  return {
    runId: createTestdataRunId(),
    promptVersion: TESTDATA_PIPELINE_PROMPT_VERSION,
    originalFileHashes: computeOriginalFileHashes(files.map(file => ({
      name: file.name,
      content: normalizeFileContent(file.content),
    }))),
    problemType,
    analysis: '骨架模式：仅生成结构性文件（评测配置、编译脚本、模板骨架）与空白测试点，不含 AI 生成的数据。',
    notes: subtaskNotes.length > 0
      ? `${legacyNotes}\n${subtaskNotes.map(note => note.message).join('\n')}`
      : legacyNotes,
    ...(subtaskNotes.length > 0 ? {
      notesStructured: {
        warnings: subtaskNotes
          .filter(note => note.kind === 'warning')
          .map(note => note.message),
        system: [
          ...noteParts,
          ...subtaskNotes
            .filter(note => note.kind === 'system')
            .map(note => note.message),
        ],
      },
    } : {}),
    files,
    caseCount: options.caseCount,
    totalCaseCount: configCaseNumbers.length,
    caseCoverage: coveragePlan.map((slot, index) => ({
      caseNumber: slot.caseNumber,
      fileNumber: caseNumbers[index],
      dataScale: slot.dataScale,
      target: slot.guidance,
    })),
  };
}

function buildCaseInputRepairPrompt(
  issue: AssignmentStyleCaseInput,
  options: GenerateOptions,
): string {
  const requiredTemplates = options.languages.map(lang => `@@@TEMPLATE:${lang}@@@`).join('、');
  return `你上一条结果中的第 ${issue.caseNumber} 个 CASE:IN 含有源码赋值写法：${issue.line}
这不是合法的评测输入文件。请重新输出【完整的分节结果】，并修正所有测试点及模板：
1. 每个 CASE:IN 只保留程序从 stdin 实际读取的原始值，禁止变量名、等号、方括号/逗号等语言字面量包装和说明文字。
2. 例如 s="1010101"、k=2 必须写成两行 1010101 和 2；数组 [1,4] 必须按模板写成 1 4。
3. 同步修改所有语言模板，使其解析修正后的同一份原始 stdin。
4. 函数题必须包含全部所选模板节：${requiredTemplates}，一个也不能遗漏。
5. 仍使用 @@@ 标记格式，不要输出 JSON 或代码围栏。`;
}

function buildTemplateRepairPrompt(missing: TemplateLang[]): string {
  const sections = missing.map(lang => `@@@TEMPLATE:${lang}@@@`).join('、');
  return `你上一条函数题结果缺少这些必需模板节：${sections}。
请只补充上述缺失模板，不要重复 META、GENERATOR、ORACLE、STD、CASE 或其他模板。要求：
1. 每个模板节都必须出现且包含完整可编译/可运行的驱动代码。
2. 模板必须读取你上一条结果中 GENERATOR 定义的原始 stdin 格式，调用题面要求的学生函数/类，并打印与 ORACLE 一致的结果。
3. Java 模板必须是 public class Main，并调用学生提交的 class Solution；C++ 模板通过 #include "foo.cc" 引入学生代码；Python 模板只含驱动代码。
4. 只使用 @@@TEMPLATE:语言@@@ 标记和源码原文，不要输出 JSON、代码围栏或解释文字。`;
}

export type SandboxRepairScope =
  | 'generator' | 'stress-generator' | 'function-samples' | 'accepted-std'
  | 'validator' | 'oracle' | 'brute'
  | 'template-py' | 'template-java' | 'template-cc' | 'full';

type ChatResult = Awaited<ReturnType<MultiModelClient['chat']>>;

function modelIdentity(result: ChatResult): string {
  return `${result.usedModel.endpointId}/${result.usedModel.modelName}`;
}

type LocalModelTelemetry = NonNullable<GenerationPlan['modelTelemetry']>;

const FAILURE_MODEL_TELEMETRY = new WeakMap<object, LocalModelTelemetry>();

function rememberFailureModelTelemetry(
  error: unknown,
  telemetry: LocalModelTelemetry | undefined,
): void {
  if ((!error || (typeof error !== 'object' && typeof error !== 'function')) || !telemetry) return;
  const key = error as object;
  const existing = FAILURE_MODEL_TELEMETRY.get(key);
  FAILURE_MODEL_TELEMETRY.set(key, existing ? {
    role: existing.role === 'fallback' || telemetry.role === 'fallback' ? 'fallback' : 'primary',
    identity: existing.identity || telemetry.identity,
  } : telemetry);
}

function inferModelTelemetry(results: readonly ChatResult[]): GenerationPlan['modelTelemetry'] {
  const finalResult = results[results.length - 1];
  if (!finalResult) return undefined;
  const identities = results.map(modelIdentity);
  const firstIdentity = identities[0];
  const usedFallback = identities.some(identity => identity !== firstIdentity)
    || results.some(result => result.fallbackErrors?.some(attempt => (
      attempt.endpoint !== result.usedModel.endpointId
      || attempt.model !== result.usedModel.modelName
    )));
  return {
    role: usedFallback ? 'fallback' : 'primary',
    identity: modelIdentity(finalResult),
  };
}

export const CPP_ORACLE_UNAVAILABLE_KEY = 'ai_helper_testdata_err_cpp_oracle_unavailable';
export const CPP_PROVIDED_STD_COMPILE_FAILED_KEY = 'ai_helper_testdata_err_cpp_std_compile_failed';
export const CPP_ORACLE_INFRA_FAILURE_KEY = 'ai_helper_testdata_err_cpp_oracle_infra';

/** 携带匿名模型/阶段信息的业务错误，供遥测判断失败是否与模型相关。 */
function legacyFailureContract(failureStage: string): {
  code: TestdataFailureCode;
  artifact: TestdataArtifact;
  retryPolicy?: TestdataRetryPolicy;
} {
  if (failureStage === 'sandbox_budget') {
    return { code: 'PIPELINE_BUDGET_EXHAUSTED', artifact: 'pipeline' };
  }
  if (failureStage === 'accepted_std_verification') {
    return { code: 'TRUSTED_SOLUTIONS_DIVERGED', artifact: 'oracle' };
  }
  if (failureStage === 'config_parse') {
    return { code: 'SPEC_PARSE_FAILED', artifact: 'spec', retryPolicy: 'no-retry' };
  }
  if (failureStage.startsWith('provided_cpp_oracle')) {
    return { code: 'ORACLE_COMPILE_FAILED', artifact: 'oracle' };
  }
  if (failureStage === 'solution_blueprint') {
    return { code: 'SPEC_PARSE_FAILED', artifact: 'spec' };
  }
  if (failureStage === 'independent_verifier_parse') {
    return {
      code: 'COVERAGE_REQUIREMENT_MISSING',
      artifact: 'coverage',
      retryPolicy: 'switch-model',
    };
  }
  if (failureStage === 'template_missing' || failureStage === 'template-py') {
    return { code: 'TEMPLATE_COMPILE_FAILED', artifact: 'template-py' };
  }
  if (failureStage === 'artifacts_parse') {
    return { code: 'GENERATOR_INVALID_JSON', artifact: 'generator' };
  }
  if (failureStage === 'generator') {
    return { code: 'GENERATOR_INVALID_INPUT', artifact: 'generator' };
  }
  if (failureStage === 'stress-generator') {
    return { code: 'STRESS_INSUFFICIENT_VALID_INPUTS', artifact: 'stress-generator' };
  }
  if (failureStage === 'function-samples') {
    return { code: 'GENERATOR_INVALID_INPUT', artifact: 'stress-generator' };
  }
  if (failureStage === 'validator') {
    return { code: 'VALIDATOR_FALSE_REJECT', artifact: 'validator' };
  }
  if (failureStage === 'oracle') {
    return { code: 'ORACLE_RUNTIME_FAILED', artifact: 'oracle' };
  }
  if (failureStage === 'brute') {
    return { code: 'BRUTE_RUNTIME_FAILED', artifact: 'brute' };
  }
  return { code: 'UNKNOWN', artifact: 'pipeline' };
}

export class TestdataGenerationError extends TestdataPipelineError {
  readonly telemetryMetadata: Record<string, unknown>;
  readonly recommendDeeperReasoning: boolean;
  readonly chatResults: readonly ChatResult[];
  readonly userMessageKey?: string;
  readonly userMessageDetail?: string;
  readonly failedModelRole?: Extract<TestdataModelRole, 'oracle' | 'artifacts' | 'verifier'>;
  readonly requiresIsolatedRegeneration: boolean;

  constructor(
    message: string,
    failureStage: string,
    results: ChatResult[] = [],
    recommendDeeperReasoning = false,
    userMessageKey?: string,
    userMessageDetail?: string,
    pipelineContext?: Omit<TestdataPipelineErrorContext, 'stage'> & {
      failedModelRole?: Extract<TestdataModelRole, 'oracle' | 'artifacts' | 'verifier'>;
      requiresIsolatedRegeneration?: boolean;
    },
  ) {
    const legacyContract = legacyFailureContract(failureStage);
    const contract = pipelineContext || legacyContract;
    const canonicalStage = normalizeTestdataFailureStage(failureStage);
    super(
      message,
      contract.code,
      canonicalStage,
      contract.artifact,
      pipelineContext?.retryPolicy || contract.retryPolicy || repairPolicyForFailure(contract),
      pipelineContext?.safeDetails,
    );
    this.name = 'TestdataGenerationError';
    this.recommendDeeperReasoning = recommendDeeperReasoning;
    this.chatResults = [...results];
    this.userMessageKey = userMessageKey;
    this.userMessageDetail = userMessageDetail;
    this.failedModelRole = pipelineContext?.failedModelRole;
    this.requiresIsolatedRegeneration = pipelineContext?.requiresIsolatedRegeneration === true;
    const usedModels = [...new Set(results.map(result =>
      `${result.usedModel.endpointName}/${result.usedModel.modelName}`))];
    const lastModel = results[results.length - 1]?.usedModel;
    const modelTelemetry = inferModelTelemetry(results);
    this.telemetryMetadata = {
      failureStage: canonicalStage,
      ...(lastModel ? {
        endpointName: lastModel.endpointName,
        modelName: lastModel.modelName,
      } : {}),
      ...(usedModels.length > 0 ? { usedModels } : {}),
      ...(modelTelemetry ? {
        modelTelemetryRole: modelTelemetry.role,
        modelTelemetryIdentity: modelTelemetry.identity,
      } : {}),
      aiAttemptCount: results.length,
      recommendDeeperReasoning,
    };
  }
}

function wrapHistoricalCandidateFailure(
  error: TestdataPipelineError,
  message: string,
  results: ChatResult[],
): TestdataGenerationError {
  const original = error instanceof TestdataGenerationError ? error : undefined;
  return new TestdataGenerationError(
    message,
    error.stage,
    results,
    false,
    original?.userMessageKey,
    original?.userMessageDetail,
    {
      code: error.code,
      artifact: error.artifact,
      retryPolicy: error.retryPolicy,
      safeDetails: { ...error.safeDetails, candidate: true },
    },
  );
}

export function extractTestdataErrorMetadata(err: unknown): Record<string, unknown> | undefined {
  const failureMetadata = extractTestdataFailureMetadata(err);
  const localModel = err && (typeof err === 'object' || typeof err === 'function')
    ? FAILURE_MODEL_TELEMETRY.get(err as object)
    : undefined;
  const localModelMetadata = localModel ? {
    modelTelemetryRole: localModel.role,
    modelTelemetryIdentity: localModel.identity,
  } : {};
  if (err instanceof TestdataGenerationError) {
    return { ...err.telemetryMetadata, ...localModelMetadata, ...failureMetadata };
  }
  return failureMetadata || localModel
    ? { ...localModelMetadata, ...failureMetadata }
    : undefined;
}

export function extractTestdataUserMessageKey(err: unknown): string | undefined {
  if (err instanceof TestdataGenerationError && err.userMessageKey) return err.userMessageKey;
  return err instanceof TestdataPipelineError
    ? getUserMessageKeyForFailure(err.code)
    : undefined;
}

export function extractTestdataUserMessageDetail(err: unknown): string | undefined {
  return err instanceof TestdataGenerationError ? err.userMessageDetail : undefined;
}

/** 仅在模型已经自动修复、但产物仍未通过解析/机器验证时建议换用更深思考模型。 */
export function shouldRecommendDeeperReasoning(err: unknown): boolean {
  return err instanceof TestdataGenerationError && err.recommendDeeperReasoning;
}

export function classifySandboxRepairScope(error: unknown): SandboxRepairScope {
  const detail = error instanceof Error ? error.message : String(error);
  if (/AC 候选标程/.test(detail)) return 'accepted-std';
  if (/SAMPLE_INPUTS|函数题样例 .*?(?:转码|缺少|未通过输入校验)/.test(detail)) return 'function-samples';
  if (/STRESS_GENERATOR|压力对拍第/.test(detail)) return 'stress-generator';
  if (/压力 \.in 未通过输入校验|\bVALIDATOR\b/.test(detail)) return 'validator';
  // 正式输入被独立 validator 拒绝时优先修正主 GENERATOR，避免让验证器放宽约束来迁就坏数据。
  if (/第\s*\d+\s*个 \.in 未通过输入校验/.test(detail)) return 'generator';
  if (/GENERATOR|\.in 超过|生成\s*\d+\s*个测试点/.test(detail)) return 'generator';
  if (/压力对拍 BRUTE/.test(detail)) return 'brute';
  if (/ORACLE|题面样例/.test(detail)) return 'oracle';
  if (/暴力解|\bBRUTE\b/.test(detail)) return 'brute';
  if (/template\.java|template-java/.test(detail)) return 'template-java';
  if (/template\.cc|template-cc/.test(detail)) return 'template-cc';
  if (/template\.py|模板输出|SOLUTION/.test(detail)) return 'template-py';
  return 'full';
}

function repairScopeForPipelineFailure(error: TestdataPipelineError): SandboxRepairScope {
  if (error.stage === 'function-samples') return 'function-samples';
  if (error.stage === 'stress-generator') return 'stress-generator';
  switch (error.artifact) {
    case 'generator': return 'generator';
    case 'stress-generator': return 'stress-generator';
    case 'validator': return 'validator';
    case 'oracle': return 'oracle';
    case 'brute': return 'brute';
    case 'template-py': return 'template-py';
    case 'template-java': return 'template-java';
    case 'template-cc': return 'template-cc';
    default: return 'full';
  }
}

export function buildSandboxRepairPrompt(
  error: unknown,
  options: GenerateOptions,
  scope: SandboxRepairScope = error instanceof TestdataPipelineError
    ? repairScopeForPipelineFailure(error)
    : 'full',
  coveragePlan?: Array<CoverageSlot | SubtaskCaseAllocation>,
  context?: TestdataPipelineContext,
): string {
  if (context) {
    return [
      buildFrozenProblemSpecBlock(context),
      '',
      buildFrozenInputEncodingBlock(context),
      '',
      '【冻结修复门禁】',
      '- 本次只修复失败制品；不得修改或重新解释 frozen ProblemSpec。',
      '- problemKind、testCaseMode、stdin encoding、outputPolicy、subtasks 与约束/不变量引用关系必须保持不变。',
      '- 如果失败只能通过修改 Spec 解决，停止输出制品并报告需要回到 Spec 共识阶段。',
      '',
      buildSandboxRepairPrompt(error, options, scope, coveragePlan),
    ].join('\n');
  }
  const templates = options.languages.map(lang => `@@@TEMPLATE:${lang}@@@`).join('、') || '（传统题无需模板）';
  const detail = (error instanceof Error ? error.message : String(error)).slice(0, 1600);
  const coverage = buildCoverageGuidanceBlock(coveragePlan);
  if (scope === 'generator') {
    return `你上一条蓝图的输入生成阶段未通过 Hydro 沙箱验证：
${detail}
${coverage ? `\n${coverage}\n` : ''}

请只输出修复后的 @@@GENERATOR@@@。不要重复 META、ORACLE、SOLUTION、TEMPLATE 或说明文字。要求：
1. stdout 只能是包含恰好 ${options.caseCount} 个 cases 的紧凑 JSON，使用 json.dumps(..., ensure_ascii=False, separators=(',', ':'))。
2. stdout 必须小于 1MB，每个 input 的 UTF-8 内容必须小于 256KB，且全部 .in/.out 与辅助文件合计必须小于 1MB；程序必须在 5 秒内结束，不要打印日志，不要构造超长字符串或无界循环。
3. 每个 input 必须合法且符合逐 CASE 覆盖计划；若临界数据过大，使用能保留边界/复杂度特征的可解析构造。
4. 只使用请求的分节标记和源码原文，不要代码围栏。`;
  }
  if (scope === 'validator') {
    return `你上一条蓝图的输入校验阶段未通过 Hydro 沙箱验证：
${detail}

请只输出修复后的 @@@VALIDATOR@@@。GENERATOR 与 frozen ProblemSpec 已验证并保持不变；不得通过放弃题面约束、删除校验器或让校验器无条件成功来迁就现有输入。不要输出其他分节、代码围栏或说明文字。`;
  }
  if (scope === 'stress-generator') {
    return `独立验证器的 STRESS_GENERATOR 未通过沙箱验证：
${detail}

请重新输出完整的 @@@BRUTE@@@、@@@STRESS_GENERATOR@@@、@@@VALIDATOR@@@ 三个分节。STRESS_GENERATOR 必须恰好生成 ${TESTDATA_GEN_LIMITS.STRESS_CASES} 组合法小数据，其中至少 ${Math.ceil(TESTDATA_GEN_LIMITS.STRESS_CASES * TESTDATA_GEN_LIMITS.STRESS_MIN_UNIQUE_RATIO)} 组 input 互不相同，禁止复制输入凑数；stdout 只能是紧凑 JSON，且所有数据都必须让 BRUTE 在 5 秒内完成。不要输出 ORACLE、模板、代码围栏或解释。`;
  }
  if (scope === 'function-samples') {
    return `独立验证器的函数题样例 stdin 转码未通过验证：
${detail}

请重新输出完整的 @@@BRUTE@@@、@@@STRESS_GENERATOR@@@、@@@VALIDATOR@@@、@@@SAMPLE_INPUTS@@@ 四个分节。SAMPLE_INPUTS 只能把题面展示参数转换成已经确定的原始 stdin，id 必须与题面样例完全一致，不得填写或篡改期望输出。不要输出 ORACLE、模板、代码围栏或解释。`;
  }
  if (scope === 'oracle') {
    const typedOracleFailure = error instanceof TestdataPipelineError && error.artifact === 'oracle'
      ? error.safeDetails
      : {};
    const oracleLanguage = typedOracleFailure.oracleLanguage === 'cpp' ? 'C++17' : 'Python 3';
    if (typedOracleFailure.failureKind === 'infra' && typedOracleFailure.oracleLanguage === 'cpp') {
      return `你上一条蓝图选择的 C++ ORACLE 因沙箱编译基础设施暂时不可用而无法验证：
${detail}

请只输出改用 Python 3 的 @@@ORACLE@@@，不要重复 META、GENERATOR、SOLUTION、TEMPLATE 或说明文字。ORACLE 必须通过题面样例、处理所有合法边界且在 5 秒内结束，每个测试点的 stdout UTF-8 内容必须小于 256KB；独立 BRUTE 将由另一调用继续验证。`;
    }
    return `你上一条蓝图的标程阶段未通过 Hydro 沙箱验证：
${detail}

当前 ORACLE 语言为 ${oracleLanguage}。请只输出修复后的 @@@ORACLE@@@，保持该语言不变；若为 C++，必须给出完整可编译的 C++17 程序并修复上面的编译错误。不要重复 META、GENERATOR、SOLUTION、TEMPLATE 或说明文字。ORACLE 必须通过题面样例、处理所有合法边界且在 5 秒内结束，每个测试点的 stdout UTF-8 内容必须小于 256KB；独立 BRUTE 将由另一调用继续验证。`;
  }
  if (scope === 'brute') {
    return `你上一条蓝图的暴力对拍阶段未通过验证：
${detail}

请只输出修复后的 @@@BRUTE@@@。它必须读取原有 GENERATOR 的同一 stdin 编码，独立实现题意，不得调用或复制 ORACLE 的核心函数。不要输出其他分节或代码围栏。`;
  }
  const templateLanguage = scope === 'template-py' ? 'py'
    : scope === 'template-java' ? 'java'
      : scope === 'template-cc' ? 'cc'
        : undefined;
  if (templateLanguage) {
    const display = LANG_DISPLAY[templateLanguage];
    return `你上一条蓝图的 ${display} 模板组合未通过验证：
${detail}

请只输出修复后的 @@@TEMPLATE:${templateLanguage}@@@。已验证学生解与 frozen stdin encoding 必须保持不变；模板只负责解析输入、调用既有学生接口并打印结果。不要输出 SOLUTION、其他分节或代码围栏。`;
  }
  return `你上一条生成蓝图未通过 Hydro 沙箱验证：
${detail}
${coverage ? `\n${coverage}\n` : ''}

请重新输出【完整蓝图】（所有节，不得省略上次已有的节），并针对上述失败修正：
1. GENERATOR stdout 必须只有合法 JSON，cases 恰好 ${options.caseCount} 个；每个 input 是原始 stdin、UTF-8 内容小于 256KB，全部 .in/.out 与辅助文件合计小于 1MB。
2. ACM 题若题面有 T，默认每个 input 使用 T=1 并包含恰好一组完整数据；函数题每个 input 只对应一次调用。
3. ORACLE 必须与原 ORACLE_LANG 保持一致，是可直接运行的 Python 3 或完整可编译的 C++17 程序，不得硬编码用例答案，并应通过题面样例；每个测试点的 stdout UTF-8 内容必须小于 256KB。
4. 函数题必须完整包含每个已选语言的学生解 ${options.languages.map(lang => `@@@SOLUTION:${lang}@@@`).join('、')} 与全部模板：${templates}。
5. 不要输出 BRUTE、STRESS_GENERATOR 或 VALIDATOR；它们由隔离的独立验证调用生成。
6. 使用 @@@META@@@、@@@GENERATOR@@@、@@@ORACLE@@@、@@@SOLUTION:语言@@@、@@@TEMPLATE:语言@@@ 分节原文，不要代码围栏。
7. 若输出 @@@NOTES@@@，NOTES 至多 2 句，只写系统无法自动验证、需要教师人工注意的事项（如输出格式的特殊约定、多解风险）；不要复述你如何构造数据，不要罗列已由沙箱验证的内容。`;
}

export function buildIndependentVerifierRepairPrompt(
  error: unknown,
  expectedFunctionSamples: StatementSample[] = [],
  context?: TestdataPipelineContext,
): string {
  if (context) {
    return [
      buildFrozenProblemSpecBlock(context),
      '',
      buildFrozenInputEncodingBlock(context),
      '',
      '只修复独立验证制品；不得从 ORACLE、analysis 或正确解推理中推断语义，不得修改 frozen Spec。',
      '',
      buildIndependentVerifierRepairPrompt(error, expectedFunctionSamples),
    ].join('\n');
  }
  const detail = (error instanceof Error ? error.message : String(error)).slice(0, 1600);
  const sampleRequirement = expectedFunctionSamples.length > 0
    ? `\n5. 必须额外输出 @@@SAMPLE_INPUTS@@@，恰好包含题面样例 id：${expectedFunctionSamples.map(sample => sample.id).join('、')}；只转换 input，不填写 output。`
    : '';
  return `独立验证制品未通过解析或 Hydro 沙箱验证：
${detail}

请重新输出完整的 === COMPLEXITY_GAP ===、@@@BRUTE@@@、@@@STRESS_GENERATOR@@@、@@@VALIDATOR@@@${expectedFunctionSamples.length > 0 ? '、@@@SAMPLE_INPUTS@@@' : ''} 分节，并修正失败原因：
1. BRUTE 必须是与 ORACLE 隔离的朴素正确实现，不能通过删除逻辑或硬编码答案绕过对拍。
2. STRESS_GENERATOR 必须恰好生成 ${TESTDATA_GEN_LIMITS.STRESS_CASES} 组合法小数据，至少 ${Math.ceil(TESTDATA_GEN_LIMITS.STRESS_CASES * TESTDATA_GEN_LIMITS.STRESS_MIN_UNIQUE_RATIO)} 组 input 互不相同，禁止复制输入凑数；固定随机种子，所有数据均能让 BRUTE 在 5 秒内完成。
3. VALIDATOR 必须严格检查题面格式与约束，不得无条件成功。
4. 所有验证制品必须沿用已经确定的同一原始 stdin 编码；不要输出 ORACLE、模板、代码围栏或解释。${sampleRequirement}`;
}

function isIndependentVerifierScope(scope: SandboxRepairScope): boolean {
  return scope === 'stress-generator' || scope === 'function-samples' || scope === 'validator' || scope === 'brute';
}

function repairSectionContent(sections: ParsedSection[], header: string): string | undefined {
  const section = sections.find(item => item.header.trim().toUpperCase() === header.toUpperCase());
  if (!section) return undefined;
  const content = trimBlankEdges(section.content);
  return content.trim() ? normalizeExecutableContent(content) : undefined;
}

/** 将定向修复结果合并进已解析蓝图；缺少必需节时抛错并由调用方回退完整修复。 */
export function mergeSandboxBlueprintRepair(
  original: SandboxGenerationBlueprint,
  raw: string,
  scope: Exclude<SandboxRepairScope, 'full' | 'stress-generator' | 'function-samples' | 'accepted-std'>,
): SandboxGenerationBlueprint {
  const sections = splitDelimitedSections(raw);
  if (sections.length === 0) throw new Error('AI 定向修复未返回分节标记');
  const solutions = normalizeTemplateSolutions(original);
  const merged: SandboxGenerationBlueprint = {
    ...original,
    ...(Object.keys(solutions).length > 0 ? { solutions, solutionCode: solutions.py } : {}),
    templates: original.templates ? { ...original.templates } : undefined,
  };
  if (scope === 'generator') {
    const generatorCode = repairSectionContent(sections, 'GENERATOR');
    if (!generatorCode) throw new Error('AI 定向修复未返回 GENERATOR');
    merged.generatorCode = generatorCode;
  } else if (scope === 'validator') {
    const validatorCode = repairSectionContent(sections, 'VALIDATOR');
    if (!validatorCode) throw new Error('AI 输入校验修复未返回 VALIDATOR');
    merged.validatorCode = validatorCode;
  } else if (scope === 'oracle') {
    const oracleCode = repairSectionContent(sections, 'ORACLE');
    if (!oracleCode) throw new Error('AI 定向修复未返回 ORACLE');
    merged.oracleCode = oracleCode;
  } else if (scope === 'brute') {
    const bruteCode = repairSectionContent(sections, 'BRUTE');
    if (!bruteCode) throw new Error('AI 定向修复未返回 BRUTE');
    merged.bruteCode = bruteCode;
  } else {
    const language: TemplateLang = scope === 'template-java' ? 'java'
      : scope === 'template-cc' ? 'cc'
        : 'py';
    const templateCode = repairSectionContent(sections, `TEMPLATE:${language}`);
    if (!templateCode) {
      throw new Error(`AI 定向修复必须返回 TEMPLATE:${language}`);
    }
    merged.templates = { ...merged.templates, [language]: templateCode };
  }
  return merged;
}

function sameMaterializationValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function findChangedMaterializationArtifacts(
  before: SandboxGenerationBlueprint,
  after: SandboxGenerationBlueprint,
): string[] {
  const changed: string[] = [];
  if (before.generatorCode !== after.generatorCode) changed.push('GENERATOR');
  if (before.stressGeneratorCode !== after.stressGeneratorCode) changed.push('STRESS_GENERATOR');
  if (before.validatorCode !== after.validatorCode) changed.push('VALIDATOR');
  if (
    before.oracleCode !== after.oracleCode
    || before.oracleLanguage !== after.oracleLanguage
  ) changed.push('ORACLE');
  if (!sameMaterializationValue(before.solutions, after.solutions)) changed.push('SOLUTION');
  if (before.bruteCode !== after.bruteCode) changed.push('BRUTE');
  if (before.templates?.py !== after.templates?.py) changed.push('template.py');
  if (before.templates?.java !== after.templates?.java) changed.push('template.java');
  if (before.templates?.cc !== after.templates?.cc) changed.push('template.cc');
  if (before.complexityGap !== after.complexityGap) changed.push('COMPLEXITY_GAP');
  if (
    before.problemType !== after.problemType
    || before.functionName !== after.functionName
    || !sameMaterializationValue(before.functionSampleInputs, after.functionSampleInputs)
  ) changed.push('full');
  return [...new Set(changed)];
}

function mergeTokenUsage(usages: Array<TokenUsage | undefined>): TokenUsage | undefined {
  const present = usages.filter((usage): usage is TokenUsage => Boolean(usage));
  if (present.length === 0) return undefined;
  return present.reduce<TokenUsage>((sum, usage) => ({
    promptTokens: sum.promptTokens + usage.promptTokens,
    completionTokens: sum.completionTokens + usage.completionTokens,
    totalTokens: sum.totalTokens + usage.totalTokens,
  }), { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
}

// ─── 服务入口 ─────────────────────────────────────────────────────────────────

export type TestdataGenerationProgressStage =
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
  | 'discrimination_testing'
  | 'pipeline_repair'
  | 'model_fallback'
  | 'model_escalation'
  | 'assembling'
  | 'complete';

export interface TestdataGenerationProgress {
  stage: TestdataGenerationProgressStage;
  /** 0-100 的阶段权重估算，不表示 AI token 的精确完成比例。 */
  percent: number;
  /** 首选模型为 1；语义升级后的完整重跑为 2。 */
  attempt: number;
}

export type CheckerArtifactFailureKind = 'invalid-path' | 'missing' | 'read';

export interface TestlibCheckerArtifacts {
  configured: boolean;
  read: boolean;
  failureKind?: CheckerArtifactFailureKind;
  checkerSource?: string;
  checkerHeaders?: Record<string, string>;
}

export interface GenerateTestdataParams {
  /** Handler/job 创建的独立质量遥测 UUID；旧调用缺省时由 service 安全生成。 */
  runId?: string;
  problemTitle: string;
  statementMarkdown: string;
  options: GenerateOptions;
  existingFiles?: string[];
  /** 当前题目的 pdoc.config，用于保留 checker/time/memory 等评测设置。 */
  existingConfig?: string;
  /** testlib checker 配置与读取制品的显式状态。 */
  checkerArtifacts?: TestlibCheckerArtifacts;
  /** 服务端规则引擎的填空题初判信号 */
  fillInDetected?: boolean;
  signal?: AbortSignal;
  /** 页面进度事件；回调异常不得影响生成主流程。 */
  onProgress?: (progress: TestdataGenerationProgress) => void;
  /** 仅传递封闭计数，供同次运行的专用质量遥测记录 observe 结果。 */
  onProblemSpecObservation?: (observation: {
    schemaVersion: 1;
    succeeded: boolean;
    constraintCount?: number;
    invariantCount?: number;
    uncertaintyCount?: number;
    consensusStatus?: SpecConsensusStatus;
    conflictCount?: number;
    unresolvedConflictCount?: number;
    rolesUsed?: TestdataModelRole[];
  }) => void;
  /** 已通过 handler 作用域与 hash 校验的解析后断点制品。 */
  checkpoint?: TestdataGenerationCheckpointPayload;
  /** 每个 AI 阶段成功后的异步落盘钩子；失败不得影响生成。 */
  onCheckpoint?: (update: TestdataGenerationCheckpointPayload | null) => void | Promise<void>;
}

export interface TestdataGenerationCheckpointPayload {
  checkpointSchemaVersion?: typeof TESTDATA_CHECKPOINT_SCHEMA_VERSION;
  promptVersion?: string;
  statementHash?: string;
  specHash?: string;
  roleDependencies?: Partial<Record<TestdataModelRole, string>>;
  solution?: SandboxSolutionBlueprint;
  artifacts?: SandboxGenerationArtifacts;
  verifier?: IndependentVerifierBlueprint;
  killTargets?: KillTarget[];
}

export interface TestdataGenServiceOptions {
  sandboxRunner?: TestdataSandboxRunner;
  mode?: TestdataGenerationMode;
  /** Handler 对固定 C++17 探针程序的单次编译结果。 */
  cppOracleAvailable?: boolean;
  /** 内部开关：语义失败后最多从下一配置模型重跑一次，防止递归升级。 */
  semanticModelFallback?: boolean;
  /** Injectable only to keep deterministic reliability-mode tests independent of process env. */
  reliabilityMode?: TestdataReliabilityMode;
  /** Task 6 role-scoped clients; omitted for compatibility and ignored in legacy mode. */
  roleClients?: TestdataRoleClients;
}

interface IndependentVerifierCallState {
  verifier: IndependentVerifierBlueprint;
  systemPrompt: string;
  userPrompt: string;
  sourceContent: string;
  expectedFunctionSamples: StatementSample[];
}

interface GenerationArtifactsCallState {
  artifacts: SandboxGenerationArtifacts;
  sourceContent: string;
}

interface ProblemSpecObservation {
  schemaVersion: 1;
  /** Request-local final consensus only; never attached to plan, telemetry, or Job metadata. */
  resolvedSpec?: ProblemSpecV1;
  summary?: ProblemSpecSummary;
  failureCode?: Extract<TestdataFailureCode,
    'SPEC_PARSE_FAILED' | 'SPEC_EVIDENCE_NOT_FOUND' | 'SPEC_CONSENSUS_REQUIRED'>;
  results: ChatResult[];
  status: SpecConsensusStatus;
  conflictCount: number;
  unresolvedConflictCount: number;
  rolesUsed: TestdataModelRole[];
  roleIdentities: Partial<Record<TestdataModelRole, TestdataModelIdentity>>;
  identityWarningCodes: string[];
  wouldBlock: boolean;
}

function frozenSubtasks(context: TestdataPipelineContext): SubtaskSpec[] {
  const constraints = new Map(context.spec.constraints.map(constraint => [
    constraint.id,
    constraint.expression,
  ]));
  return context.spec.subtasks.map(subtask => ({
    id: subtask.id,
    score: subtask.score,
    constraints: subtask.constraintIds
      .map(constraintId => constraints.get(constraintId) || constraintId)
      .join('; '),
  }));
}

export function bindBlueprintToFrozenProblemSpec<
  T extends Pick<SandboxSolutionBlueprint, 'problemType' | 'subtasks'>,
>(blueprint: T, context?: TestdataPipelineContext): T {
  if (!context) return blueprint;
  assertProblemSpecUnchanged(context);
  if (blueprint.problemType !== context.spec.problemKind) {
    throw new TestdataPipelineError(
      '生成制品试图改变 frozen ProblemSpec 的 problemKind。',
      'SPEC_PARSE_FAILED',
      'spec_consensus',
      'spec',
      'rerun-spec',
    );
  }
  return {
    ...blueprint,
    subtasks: frozenSubtasks(context),
  };
}

function assertDirectResponseMatchesFrozenProblemSpec(
  response: Pick<GenerationResponse, 'problemType'>,
  context?: TestdataPipelineContext,
): void {
  if (!context) return;
  assertProblemSpecUnchanged(context);
  if (response.problemType !== context.spec.problemKind) {
    throw new TestdataPipelineError(
      '直出响应试图改变 frozen ProblemSpec 的 problemKind。',
      'SPEC_PARSE_FAILED',
      'spec_consensus',
      'spec',
      'rerun-spec',
    );
  }
}

function checkpointSolutionFromBlueprint(
  blueprint: SandboxSolutionBlueprint,
): SandboxSolutionBlueprint {
  return {
    problemType: blueprint.problemType,
    isFillIn: blueprint.isFillIn,
    analysis: blueprint.analysis,
    subtasks: blueprint.subtasks,
    functionName: blueprint.functionName,
    oracleCode: blueprint.oracleCode,
    oracleLanguage: blueprint.oracleLanguage,
    solutions: blueprint.solutions,
    solutionCode: blueprint.solutionCode,
    functionSampleInputs: blueprint.functionSampleInputs,
    notes: blueprint.notes,
  };
}

function checkpointArtifactsFromBlueprint(
  blueprint: SandboxGenerationBlueprint,
): SandboxGenerationArtifacts {
  return {
    generatorCode: blueprint.generatorCode,
    templates: blueprint.templates,
    notes: blueprint.notes,
  };
}

function checkpointVerifierFromBlueprint(
  blueprint: SandboxGenerationBlueprint,
): IndependentVerifierBlueprint {
  return {
    bruteCode: blueprint.bruteCode || '',
    validatorCode: blueprint.validatorCode || '',
    stressGeneratorCode: blueprint.stressGeneratorCode || '',
    complexityGap: blueprint.complexityGap,
    functionSampleInputs: blueprint.functionSampleInputs,
  };
}

export class TestdataGenService {
  private readonly sandboxRunner?: TestdataSandboxRunner;
  private readonly mode: TestdataGenerationMode;
  private readonly cppOracleAvailable: boolean;
  private readonly semanticModelFallback: boolean;
  private readonly reliabilityMode: TestdataReliabilityMode;
  private readonly roleClients?: TestdataRoleClients;
  private activeModelTelemetry?: LocalModelTelemetry;
  private activeRoleIdentities: Partial<Record<TestdataModelRole, TestdataModelIdentity>> = {};
  private activePipelineContext?: TestdataPipelineContext;

  constructor(private aiClient: MultiModelClient, serviceOptions: TestdataGenServiceOptions = {}) {
    this.sandboxRunner = serviceOptions.sandboxRunner;
    this.mode = serviceOptions.mode || (serviceOptions.sandboxRunner ? 'auto' : 'direct');
    this.cppOracleAvailable = serviceOptions.cppOracleAvailable === true;
    this.semanticModelFallback = serviceOptions.semanticModelFallback !== false;
    this.reliabilityMode = serviceOptions.reliabilityMode || getTestdataReliabilityMode();
    this.roleClients = this.reliabilityMode === 'legacy' ? undefined : serviceOptions.roleClients;
  }

  private assessRisk(params: GenerateTestdataParams, specConflict = false): TestdataRiskAssessment {
    const customChecker = hasCustomChecker(params.existingConfig);
    return assessTestdataRisk({
      statement: params.statementMarkdown,
      hasCustomChecker: customChecker,
      unsupportedCustomChecker: customChecker && !getTestlibCheckerFilename(params.existingConfig),
      statementTruncated: false,
      directFallbackEnabled: getTestdataDirectFallbackEnabled(),
      confirmDirectFallback: params.options.confirmDirectFallback,
      reliabilityMode: this.reliabilityMode,
      specConflict,
    });
  }

  private attachRisk(plan: GenerationPlan, risk: TestdataRiskAssessment): GenerationPlan {
    plan.risk = risk;
    plan.reliabilityMode = this.reliabilityMode;
    return plan;
  }

  private async observeProblemSpec(
    params: GenerateTestdataParams,
    snapshot: StatementSnapshot,
  ): Promise<ProblemSpecObservation | undefined> {
    if (this.reliabilityMode === 'legacy') return undefined;
    const role = (name: Extract<TestdataModelRole,
      'specPrimary' | 'specCritic' | 'adjudicator'>) => ({
      role: name,
      client: this.roleClients?.[name]?.client || this.aiClient,
      identity: this.roleClients?.[name]?.identity,
    });
    const consensus = await runProblemSpecConsensus({
      snapshot,
      requestedProblemKind: params.options.problemKind,
      hasCustomChecker: hasCustomChecker(params.existingConfig),
      primary: role('specPrimary'),
      critic: role('specCritic'),
      adjudicator: role('adjudicator'),
      callOptions: this.getCallOptions(params),
    });
    Object.assign(this.activeRoleIdentities, consensus.roleIdentities);
    const identityConflicts = findTestdataRoleIdentityConflicts(consensus.roleIdentities)
      .filter(conflict => conflict.pair === 'spec');
    return {
      schemaVersion: 1,
      resolvedSpec: consensus.resolvedSpec,
      summary: consensus.safeSummary ? {
        statementHash: consensus.safeSummary.statementHash,
        constraintCount: consensus.safeSummary.constraintCount,
        invariantCount: consensus.safeSummary.invariantCount,
        unresolvedUncertainties: consensus.safeSummary.unresolvedUncertainties,
      } : undefined,
      failureCode: consensus.failureCode,
      results: consensus.results,
      status: consensus.status,
      conflictCount: consensus.conflictCount,
      unresolvedConflictCount: consensus.unresolvedConflictCount,
      rolesUsed: consensus.rolesUsed,
      roleIdentities: consensus.roleIdentities,
      identityWarningCodes: identityConflicts.map(() => 'SPEC_ROLE_IDENTITY_CONFLICT'),
      wouldBlock: identityConflicts.length > 0 || consensus.unresolvedConflictCount > 0,
    };
  }

  private attachProblemSpecObservation(
    plan: GenerationPlan,
    observation: ProblemSpecObservation | undefined,
    risk?: TestdataRiskAssessment,
  ): GenerationPlan {
    if (!observation) return plan;
    plan.specSchemaVersion = observation.schemaVersion;
    if (observation.summary) plan.problemSpecSummary = observation.summary;
    plan.specConsensusStatus = observation.status;
    plan.specConflictCount = observation.conflictCount;
    plan.unresolvedConflictCount = observation.unresolvedConflictCount;
    plan.modelRolesUsed = observation.rolesUsed;
    if (observation.results.length > 0) {
      plan.tokenUsage = mergeTokenUsage([
        ...observation.results.map(result => result.usage), plan.tokenUsage,
      ]);
      const specModels = observation.results.map(result => (
        `${result.usedModel.endpointName}/${result.usedModel.modelName}`
      ));
      plan.usedModel = [...new Set([...specModels, ...(plan.usedModel || '').split(' → ').filter(Boolean)])]
        .join(' → ');
    }
    const runtimeIdentityConflicts = findTestdataRoleIdentityConflicts(this.activeRoleIdentities);
    const runtimeIdentityWarnings = runtimeIdentityConflicts.map(conflict => (
      conflict.pair === 'spec'
        ? 'SPEC_ROLE_IDENTITY_CONFLICT'
        : 'ORACLE_VERIFIER_IDENTITY_CONFLICT'
    ));
    const exposeIdentityWarnings = this.reliabilityMode === 'observe'
      || risk?.tier === 'high'
      || risk?.tier === 'blocked';
    const warningCodes = [...new Set([
      ...(observation.failureCode ? [observation.failureCode] : []),
      ...(exposeIdentityWarnings ? observation.identityWarningCodes : []),
      ...(exposeIdentityWarnings ? runtimeIdentityWarnings : []),
    ])];
    for (const warningCode of warningCodes) {
      const warning = `题意规范观察未通过（${warningCode}）；旧生成流程已继续，请人工复核题意。`;
      if (!plan.notesStructured) {
        plan.notesStructured = {
          warnings: [],
          system: [],
          ...(plan.notes ? { ai: plan.notes } : {}),
        };
      }
      if (!plan.notesStructured.warnings.includes(warning)) {
        plan.notesStructured.warnings.push(warning);
      }
      plan.notes = [plan.notes, warning].filter(Boolean).join('\n');
    }
    const wouldBlock = observation.unresolvedConflictCount > 0
      || (exposeIdentityWarnings && runtimeIdentityConflicts.length > 0);
    if (wouldBlock && plan.verification) {
      plan.verification.verified = false;
      plan.verification.wouldBlock = true;
    }
    return plan;
  }

  private notifyProblemSpecObservation(
    params: GenerateTestdataParams,
    observation: ProblemSpecObservation | undefined,
  ): void {
    if (!observation || !params.onProblemSpecObservation) return;
    try {
      params.onProblemSpecObservation({
        schemaVersion: observation.schemaVersion,
        succeeded: !!observation.summary,
        ...(observation.summary ? {
          constraintCount: observation.summary.constraintCount,
          invariantCount: observation.summary.invariantCount,
          uncertaintyCount: observation.summary.unresolvedUncertainties,
        } : {}),
        consensusStatus: observation.status,
        conflictCount: observation.conflictCount,
        unresolvedConflictCount: observation.unresolvedConflictCount,
        rolesUsed: observation.rolesUsed,
      });
    } catch {
      // Quality telemetry is best-effort and cannot change generation behavior.
    }
  }

  private clientForRole(role: Extract<TestdataModelRole,
    'oracle' | 'artifacts' | 'verifier'>): MultiModelClient {
    const client = this.roleClients?.[role]?.client || this.aiClient;
    return {
      chat: async (...args: Parameters<MultiModelClient['chat']>) => {
        const result = await client.chat(...args);
        this.activeRoleIdentities[role] = { ...result.usedModel };
        return result;
      },
    } as MultiModelClient;
  }

  private async chatForCombinedRepair(
    ...args: Parameters<MultiModelClient['chat']>
  ): Promise<ChatResult> {
    const result = await this.aiClient.chat(...args);
    // The combined repair protocol may replace the ORACLE-bearing solution as well as
    // artifacts, so its successful model is the new Oracle identity for independence.
    this.activeRoleIdentities.oracle = { ...result.usedModel };
    return result;
  }

  private assertIndependentRoleIdentities(risk: TestdataRiskAssessment): void {
    if (this.reliabilityMode !== 'enforce'
      || (risk.tier !== 'high' && risk.tier !== 'blocked')) return;
    const conflicts = findTestdataRoleIdentityConflicts(this.activeRoleIdentities);
    if (conflicts.length === 0) return;
    throw new TestdataPipelineError(
      '高风险题目的独立模型角色实际使用了相同模型。',
      'SPEC_CONSENSUS_REQUIRED',
      'spec_consensus',
      'spec',
      'manual-review',
      { identityConflictCount: conflicts.length },
    );
  }

  private assertCheckpointRoleIndependence(
    risk: TestdataRiskAssessment,
    checkpoint?: TestdataGenerationCheckpointPayload,
  ): void {
    if (this.reliabilityMode !== 'enforce'
      || (risk.tier !== 'high' && risk.tier !== 'blocked')
      || !checkpoint?.roleDependencies) return;
    const dependencyHash = (role: 'oracle' | 'verifier') => {
      const identity = this.activeRoleIdentities[role];
      return identity
        ? hashTestdataRoleIdentity(`${identity.endpointId}\0${identity.modelName}`)
        : undefined;
    };
    const restoredOracle = checkpoint.roleDependencies.oracle;
    const restoredVerifier = checkpoint.roleDependencies.verifier;
    const freshOracle = dependencyHash('oracle');
    const freshVerifier = dependencyHash('verifier');
    if ((restoredOracle && freshVerifier && restoredOracle === freshVerifier)
      || (restoredVerifier && freshOracle && restoredVerifier === freshOracle)) {
      throw new TestdataPipelineError(
        '高风险题目的恢复制品与新生成独立角色实际使用了相同模型。',
        'SPEC_CONSENSUS_REQUIRED',
        'spec_consensus',
        'spec',
        'manual-review',
        { identityConflictCount: 1 },
      );
    }
  }

  private attachRunMetadata(plan: GenerationPlan, params: GenerateTestdataParams): GenerationPlan {
    plan.runId = params.runId || plan.runId || createTestdataRunId();
    plan.promptVersion = TESTDATA_PIPELINE_PROMPT_VERSION;
    plan.originalFileHashes = computeOriginalFileHashes(plan.files.map(file => ({
      name: file.name,
      content: normalizeFileContent(file.content),
    })));
    return plan;
  }

  private throwDirectFallbackBlocked(risk: TestdataRiskAssessment): never {
    if (risk.tier === 'medium'
      && getTestdataDirectFallbackEnabled()
      && !risk.allowsDirectFallback) {
      throw toPipelineError(new Error('中风险题目需要教师再次确认，才可使用未经沙箱验证的直出模式。'), {
        code: 'DIRECT_FALLBACK_CONFIRMATION_REQUIRED',
        stage: 'sandbox_check',
        artifact: 'pipeline',
        retryPolicy: 'no-retry',
      });
    }
    throw toPipelineError(new Error('当前风险策略不允许未经 Hydro 沙箱验证的直出模式。'), {
      code: 'SANDBOX_REQUIRED',
      stage: 'sandbox_check',
      artifact: 'pipeline',
      retryPolicy: 'no-retry',
    });
  }

  private emitProgress(
    params: Pick<GenerateTestdataParams, 'onProgress'>,
    stage: TestdataGenerationProgressStage,
    percent: number,
    attempt = 1,
  ): void {
    try {
      params.onProgress?.({
        stage,
        percent: Math.max(0, Math.min(100, Math.round(percent))),
        attempt,
      });
    } catch {
      // 进度属于可观测性，不得因连接写入失败中断生成主流程。
    }
  }

  private progressForAttempt(percent: number, attempt: number): number {
    return attempt > 1 ? 60 + (percent * 0.39) : percent;
  }

  private emitCheckpoint(
    params: Pick<GenerateTestdataParams, 'onCheckpoint'>,
    update: TestdataGenerationCheckpointPayload | null,
  ): Promise<void> {
    try {
      const context = this.activePipelineContext;
      const roleDependencies = context ? Object.fromEntries([
        ...Object.entries(context.roleIdentities),
        ...Object.entries(this.activeRoleIdentities).map(([role, identity]) => [
          role,
          identity ? `${identity.endpointId}\0${identity.modelName}` : undefined,
        ]),
      ].flatMap(([role, identity]) => (
        typeof identity === 'string' && identity
          ? [[role, hashTestdataRoleIdentity(identity)]]
          : []
      ))) : undefined;
      const checkpointUpdate = update && context ? {
        checkpointSchemaVersion: TESTDATA_CHECKPOINT_SCHEMA_VERSION,
        promptVersion: context.promptVersion,
        statementHash: context.statement.statementHash,
        specHash: context.specHash,
        roleDependencies,
        ...update,
      } : update;
      const pending = params.onCheckpoint?.(checkpointUpdate);
      return Promise.resolve(pending).catch(() => undefined);
    } catch {
      // 断点只用于降低中断重试成本，持久化失败不能改变生成结果。
      return Promise.resolve();
    }
  }

  async generate(params: GenerateTestdataParams): Promise<GenerationPlan> {
    this.activeModelTelemetry = undefined;
    this.activeRoleIdentities = {};
    this.activePipelineContext = undefined;
    try {
      const snapshot = createStatementSnapshot(params.statementMarkdown);
      return await this.generateInternal({
        ...params,
        runId: params.runId || createTestdataRunId(),
        statementMarkdown: snapshot.normalizedMarkdown,
      }, snapshot);
    } catch (error) {
      rememberFailureModelTelemetry(error, this.activeModelTelemetry);
      throw error;
    }
  }

  private async generateInternal(
    params: GenerateTestdataParams,
    snapshot: StatementSnapshot,
  ): Promise<GenerationPlan> {
    assertExistingConfigParsable(params.existingConfig);
    this.emitProgress(params, 'preparing', 2);
    const initialRisk = this.assessRisk(params);
    const problemSpecObservation = await this.observeProblemSpec(params, snapshot);
    this.notifyProblemSpecObservation(params, problemSpecObservation);
    const risk = this.assessRisk(params, (problemSpecObservation?.conflictCount || 0) > 0);
    if (this.reliabilityMode === 'enforce' && !problemSpecObservation?.resolvedSpec) {
      throw new TestdataPipelineError(
        'enforce 模式缺少有效 frozen ProblemSpec，已安全停止生成。',
        problemSpecObservation?.failureCode || 'SPEC_PARSE_FAILED',
        'spec_consensus',
        'spec',
        problemSpecObservation?.failureCode === 'SPEC_CONSENSUS_REQUIRED'
          ? 'manual-review'
          : 'rerun-spec',
        {
          conflictCount: problemSpecObservation?.conflictCount || 0,
          unresolvedConflictCount: problemSpecObservation?.unresolvedConflictCount || 0,
        },
      );
    }
    const pipelineContext = problemSpecObservation?.resolvedSpec
      ? createTestdataPipelineContext({
        runId: params.runId || createTestdataRunId(),
        promptVersion: TESTDATA_PIPELINE_PROMPT_VERSION,
        statement: snapshot,
        spec: problemSpecObservation.resolvedSpec,
        risk,
        roleIdentities: Object.fromEntries(Object.entries(problemSpecObservation.roleIdentities)
          .map(([role, identity]) => [
            role,
            identity ? `${identity.endpointId}\0${identity.modelName}` : undefined,
          ])),
        specValidation: {
          hasCustomChecker: hasCustomChecker(params.existingConfig),
          ...(params.options.problemKind === 'auto'
            ? {}
            : { expectedProblemKind: params.options.problemKind }),
        },
      })
      : undefined;
    this.activePipelineContext = pipelineContext;
    this.assertIndependentRoleIdentities(risk);
    if (this.reliabilityMode === 'enforce'
      && (risk.tier === 'high' || risk.tier === 'blocked')
      && (problemSpecObservation?.unresolvedConflictCount || 0) > 0) {
      throw new TestdataPipelineError(
        '高风险题目的题意冲突未完成裁决。',
        'SPEC_CONSENSUS_REQUIRED',
        'spec_consensus',
        'spec',
        'manual-review',
        {
          conflictCount: problemSpecObservation?.conflictCount || 0,
          unresolvedConflictCount: problemSpecObservation?.unresolvedConflictCount || 0,
        },
      );
    }
    const customChecker = hasCustomChecker(params.existingConfig);
    if (
      customChecker
      && this.reliabilityMode === 'enforce'
      && (!params.checkerArtifacts?.configured || !params.checkerArtifacts.read)
    ) {
      throw checkerPipelineError(
        'CHECKER_REQUIRED_UNAVAILABLE',
        params.checkerArtifacts?.failureKind || 'unavailable',
        '已配置的 checker 制品未能读取，无法完成语义验证',
      );
    }
    const requiresProvidedCppOracle = params.options.problemKind !== 'function'
      && !!params.options.providedStd?.trim()
      && detectStdFilename(params.options.providedStd) === 'std.cc';
    if (requiresProvidedCppOracle && (this.mode === 'direct' || !this.sandboxRunner)) {
      const detail = '当前生成模式未配置可执行 C++17 的 Hydro 沙箱';
      throw new TestdataGenerationError(
        `当前沙箱无 C++ 编译能力，无法执行教师提供的标准答案。${detail}`,
        'provided_cpp_oracle',
        [],
        false,
        CPP_ORACLE_UNAVAILABLE_KEY,
        detail,
      );
    }
    const requiresAcceptedRecordVerification = !!params.options.providedStd?.trim()
      && params.options.providedStdSource === 'accepted-record';
    if (requiresAcceptedRecordVerification && hasCustomChecker(params.existingConfig)) {
      throw toPipelineError(
        new Error('自定义 checker 题暂时无法对历史 AC 候选解做可靠的独立文本验证，已拒绝使用。请改用教师审核后的手动标程或取消选择。'),
        {
          code: 'CHECKER_REQUIRED_UNAVAILABLE',
          stage: 'checker',
          artifact: 'checker',
          retryPolicy: 'manual-review',
        },
      );
    }
    if (this.mode !== 'direct' && this.sandboxRunner) {
      this.emitProgress(params, 'sandbox_check', 5);
      const available = await this.sandboxRunner.isAvailable(params.signal);
      if (available) {
        const plan = await this.generateSandboxWithSemanticFallback(
          params,
          this.sandboxRunner,
          risk,
          pipelineContext,
        );
        this.emitProgress(params, 'complete', 100, plan.verification?.modelEscalation ? 2 : 1);
        return this.attachRunMetadata(
          this.attachRisk(this.attachProblemSpecObservation(plan, problemSpecObservation, risk), risk),
          params,
        );
      }
      if (requiresProvidedCppOracle) {
        const detail = 'Hydro 沙箱当前不可达，无法探测或使用 C++17 编译器';
        throw new TestdataGenerationError(
          `当前沙箱无 C++ 编译能力，无法执行教师提供的标准答案。${detail}`,
          'provided_cpp_oracle',
          [],
          false,
          CPP_ORACLE_UNAVAILABLE_KEY,
          detail,
        );
      }
      if (requiresAcceptedRecordVerification) {
        throw toPipelineError(
          new Error('Hydro 沙箱不可用，无法验证所选历史 AC 候选解；已拒绝降级生成 .out。请恢复沙箱、改用教师审核后的手动标程，或取消选择。'),
          {
            code: this.reliabilityMode === 'enforce' ? 'SANDBOX_REQUIRED' : 'SANDBOX_UNAVAILABLE',
            stage: 'sandbox_check', artifact: 'pipeline',
          },
        );
      }
      if (this.mode === 'sandbox') {
        throw toPipelineError(
          new Error('Hydro 沙箱不可用，无法安全执行 AI 生成器。请检查 hydrojudge.sandbox_host 或改用骨架模式。'),
          {
            code: this.reliabilityMode === 'enforce' ? 'SANDBOX_REQUIRED' : 'SANDBOX_UNAVAILABLE',
            stage: 'sandbox_check', artifact: 'pipeline',
          },
        );
      }
    } else if (this.mode === 'sandbox') {
      throw toPipelineError(new Error('未配置 Hydro 沙箱执行器，无法安全执行 AI 生成器。'), {
        code: 'SANDBOX_REQUIRED',
        stage: 'sandbox_check',
        artifact: 'pipeline',
      });
    }

    if (requiresAcceptedRecordVerification) {
      throw toPipelineError(
        new Error('历史 AC 候选解必须在 Hydro 沙箱中通过题面样例与独立 BRUTE 压力验证，不能用于未经验证的直出模式。'),
        { code: 'SANDBOX_REQUIRED', stage: 'sandbox_check', artifact: 'pipeline' },
      );
    }

    const fallbackRisk = this.reliabilityMode === 'observe' ? initialRisk : risk;
    if (!fallbackRisk.allowsDirectFallback) {
      this.throwDirectFallbackBlocked(fallbackRisk);
    }
    if (customChecker && this.reliabilityMode === 'enforce') {
      throw checkerPipelineError(
        'CHECKER_REQUIRED_UNAVAILABLE',
        'unavailable',
        '直出模式不能编译或执行题目 checker',
      );
    }

    const plan = await this.generateDirect(params, pipelineContext);
    if (this.mode === 'auto') {
      const fallbackWarning = 'Hydro 沙箱当前不可达，本次使用兼容直出模式；写入前请重点核对 .out。';
      plan.notes = [
        plan.notes,
        fallbackWarning,
      ].filter(Boolean).join('\n');
      plan.notesStructured?.warnings.push(fallbackWarning);
    }
    this.emitProgress(params, 'complete', 100);
    return this.attachRunMetadata(
      this.attachRisk(this.attachProblemSpecObservation(plan, problemSpecObservation, risk), risk),
      params,
    );
  }

  private getCallOptions(
    params: Pick<GenerateTestdataParams, 'signal' | 'onProgress'>,
    attempt = 1,
  ): ChatCallOptions {
    return {
      signal: params.signal,
      maxTokens: null,
      // 测试数据生成以正确性优先：不由插件设置模型截止时间。调用只会在
      // 上游明确失败、服务进程中断或用户主动取消时结束。
      timeoutMs: null,
      // 上游明确报告超时时不在同一模型上盲等第二轮；其他短暂错误仍有限重试。
      retryTimeouts: false,
      onAttempt: event => {
        this.activeModelTelemetry = {
          role: this.activeModelTelemetry?.role === 'fallback' || event.type === 'fallback'
            ? 'fallback'
            : 'primary',
          identity: `${event.endpointId}/${event.modelName}`,
        };
        if (event.type === 'fallback') {
          this.emitProgress(params, 'model_fallback', attempt > 1 ? 72 : 30, attempt);
        }
      },
    };
  }

  /**
   * 解析/沙箱失败已经历一轮定向修复后，才从场景链的下一模型完整重跑一次。
   * 这是语义级 fallback：首选模型正常返回但产物不正确，普通网络 fallback 不会触发。
   */
  private async generateSandboxWithSemanticFallback(
    params: GenerateTestdataParams,
    runner: TestdataSandboxRunner,
    risk = this.assessRisk(params),
    context?: TestdataPipelineContext,
  ): Promise<GenerationPlan> {
    try {
      if (context) assertProblemSpecUnchanged(context);
      return await this.generateWithSandbox(params, runner, 1, risk, context);
    } catch (firstError) {
      if (isCancellation(firstError)
        || !this.semanticModelFallback
        || !(firstError instanceof TestdataGenerationError)
        || !firstError.recommendDeeperReasoning) {
        throw firstError;
      }

      const failedRole = this.reliabilityMode === 'legacy'
        ? undefined
        : firstError.failedModelRole;
      const failedIdentity = failedRole ? this.activeRoleIdentities[failedRole] : undefined;
      const configuredRoleIdentities = failedRole
        ? this.roleClients?.[failedRole]?.identities || []
        : [];
      const matchesFailedRole = (result: ChatResult) => (
        [failedIdentity, ...configuredRoleIdentities].some(identity => identity
          && identity.endpointId === result.usedModel.endpointId
          && identity.modelName === result.usedModel.modelName)
      );
      const lastResult = failedRole
        ? [...firstError.chatResults].reverse().find(matchesFailedRole)
        : firstError.chatResults[firstError.chatResults.length - 1];
      const failedClient = failedRole
        ? this.roleClients?.[failedRole]?.client || this.aiClient
        : this.aiClient;
      const createFallback = failedClient.createClientStartingAfter;
      const fallbackClient = lastResult && typeof createFallback === 'function'
        ? createFallback.call(failedClient, lastResult.usedModel)
        : undefined;
      if (!fallbackClient && !firstError.requiresIsolatedRegeneration) throw firstError;

      let fallbackRoleClients = this.roleClients;
      if (failedRole && fallbackClient && lastResult) {
        const previousRole = this.roleClients?.[failedRole];
        const previousIdentities = previousRole?.identities || [];
        const usedIndex = previousIdentities.findIndex(identity => (
          identity.endpointId === lastResult.usedModel.endpointId
          && identity.modelName === lastResult.usedModel.modelName
        ));
        const fallbackIdentities = usedIndex >= 0
          ? previousIdentities.slice(usedIndex + 1)
          : [];
        const fallbackIdentity = fallbackIdentities[0] || { ...lastResult.usedModel };
        fallbackRoleClients = {
          ...this.roleClients,
          [failedRole]: {
            role: failedRole,
            source: previousRole?.source || 'global',
            chain: fallbackIdentities,
            identities: fallbackIdentities,
            identity: fallbackIdentity,
            client: fallbackClient,
          },
        };
      }

      const fromModel = lastResult
        ? `${lastResult.usedModel.endpointName}/${lastResult.usedModel.modelName}`
        : 'restored checkpoint';
      const fallbackService = new TestdataGenService(
        failedRole ? this.aiClient : fallbackClient || this.aiClient,
        {
          sandboxRunner: runner,
          mode: 'sandbox',
          cppOracleAvailable: this.cppOracleAvailable,
          semanticModelFallback: false,
          reliabilityMode: this.reliabilityMode,
          roleClients: fallbackRoleClients,
        },
      );
      try {
        this.emitProgress(params, 'model_escalation', 60, 2);
        if (context) assertProblemSpecUnchanged(context);
        // 先原子清空已持久化的首轮制品；升级轮仍保留回调以保存自己的全新制品。
        await this.emitCheckpoint(params, null);
        const plan = await fallbackService.generateWithSandbox(
          { ...params, checkpoint: undefined },
          runner,
          2,
          risk,
          context,
        );
        if (context) assertProblemSpecUnchanged(context);
        const fallbackModels = plan.usedModel ? plan.usedModel.split(' → ').filter(Boolean) : [];
        const toModel = fallbackModels[0] || 'next configured model';
        const firstModels = firstError.chatResults.map(result =>
          `${result.usedModel.endpointName}/${result.usedModel.modelName}`);
        plan.usedModel = [...new Set([...firstModels, ...fallbackModels])].join(' → ');
        plan.tokenUsage = mergeTokenUsage([
          mergeTokenUsage(firstError.chatResults.map(result => result.usage)),
          plan.tokenUsage,
        ]);
        if (plan.modelTelemetry) plan.modelTelemetry.role = 'fallback';
        if (plan.verification && fallbackClient) {
          plan.verification.modelEscalation = { fromModel, toModel };
        }
        this.activeRoleIdentities = {
          ...this.activeRoleIdentities,
          ...fallbackService.activeRoleIdentities,
        };
        const escalationNote = fallbackClient
          ? `首选模型在自动修复后仍未通过机器验证，已从下一配置模型（${toModel}）完整重跑并通过。`
          : '恢复制品在物化时未通过机器验证，已清空断点并在同一 frozen ProblemSpec 下重跑隔离角色。';
        plan.notes = [
          plan.notes,
          escalationNote,
        ].filter(Boolean).join('\n');
        plan.notesStructured?.system.push(escalationNote);
        return plan;
      } catch (fallbackError) {
        if (isCancellation(fallbackError)) throw fallbackError;
        if (fallbackService.activeModelTelemetry) {
          rememberFailureModelTelemetry(fallbackError, {
            ...fallbackService.activeModelTelemetry,
            role: 'fallback',
          });
        }
        if (fallbackError instanceof TestdataGenerationError) {
          const combinedResults = [
            ...firstError.chatResults,
            ...fallbackError.chatResults,
          ] as ChatResult[];
          const finalPolicy = fallbackError.retryPolicy;
          throw new TestdataGenerationError(
            `首选模型自动修复失败，切换下一配置模型后仍未通过机器验证。技术细节：${fallbackError.message}`,
            `semantic_fallback:${String(fallbackError.telemetryMetadata.failureStage || 'unknown')}`,
            combinedResults,
            finalPolicy === 'repair-artifact' || finalPolicy === 'switch-model',
            undefined,
            undefined,
            {
              code: fallbackError.code,
              artifact: fallbackError.artifact,
              retryPolicy: finalPolicy,
              safeDetails: fallbackError.safeDetails,
              failedModelRole: fallbackError.failedModelRole,
            },
          );
        }
        throw fallbackError;
      }
    }
  }

  private applyResultMetadata(
    plan: GenerationPlan,
    results: Array<Awaited<ReturnType<MultiModelClient['chat']>>>,
  ): GenerationPlan {
    plan.tokenUsage = mergeTokenUsage(results.map(result => result.usage));
    plan.usedModel = [...new Set(results.map(result =>
      `${result.usedModel.endpointName}/${result.usedModel.modelName}`))].join(' → ');
    plan.modelTelemetry = this.activeModelTelemetry || inferModelTelemetry(results);
    return plan;
  }

  private useProvidedOracle<
    T extends Pick<SandboxSolutionBlueprint, 'problemType' | 'oracleCode' | 'oracleLanguage'>,
  >(
    blueprint: T,
    options: GenerateOptions,
  ): T {
    const provided = options.providedStd?.trim();
    if (blueprint.problemType === 'traditional' && provided) {
      const filename = detectStdFilename(provided);
      if (filename === 'std.py' || filename === 'std.cc') {
        return {
          ...blueprint,
          oracleCode: normalizeExecutableContent(provided),
          oracleLanguage: filename === 'std.cc' ? 'cpp' : 'python',
        };
      }
    }
    return blueprint;
  }

  private async generateDirect(
    params: GenerateTestdataParams,
    context?: TestdataPipelineContext,
  ): Promise<GenerationPlan> {
    const systemPrompt = buildTestdataSystemPrompt();
    const userPrompt = buildTestdataUserPrompt(params, undefined, context);
    const callOptions = this.getCallOptions(params);

    this.emitProgress(params, 'blueprint', 12);
    // Task 6 只路由已拆分的 sandbox stages。直出协议仍是同时生成解法、ORACLE
    // 与外围制品的兼容单体 prompt，Task 7 拆分前必须继续使用场景/base client。
    const directClient = this.aiClient;
    const initialResult = await directClient.chat(
      [{ role: 'user', content: userPrompt }],
      systemPrompt,
      callOptions,
    );
    const results = [initialResult];
    this.emitProgress(params, 'blueprint', 48);

    let response: GenerationResponse;
    try {
      response = parseAiResponse(initialResult.content, params.options, { allowMissingTemplates: true });
      assertDirectResponseMatchesFrozenProblemSpec(response, context);
    } catch (err) {
      if (err instanceof TestdataPipelineError) throw err;
      throw toPipelineError(err, {
        code: 'GENERATOR_INVALID_JSON',
        stage: 'direct_parse',
        artifact: 'generator',
      });
    }
    const assignmentIssue = response.problemType === 'function'
      ? findAssignmentStyleCaseInput(response.cases)
      : null;

    if (assignmentIssue) {
      this.emitProgress(params, 'pipeline_repair', 62);
      let repairResult;
      try {
        repairResult = await directClient.chat(
          [
            { role: 'user', content: userPrompt },
            { role: 'assistant', content: initialResult.content },
            { role: 'user', content: buildCaseInputRepairPrompt(assignmentIssue, params.options) },
          ],
          systemPrompt,
          callOptions,
        );
      } catch (err) {
        throw toPipelineError(err, {
          code: 'GENERATOR_INVALID_INPUT',
          stage: 'direct_repair',
          artifact: 'generator',
          message: 'AI 生成的 .in 使用了“变量名 = 值”的错误格式，自动修复请求又失败了。'
            + `请重试；若 AI 服务持续不可用，可用「生成骨架文件（不调用 AI）」手动填写。技术细节：${err instanceof Error ? err.message : String(err)}`,
        });
      }
      results.push(repairResult);
      try {
        response = parseAiResponse(repairResult.content, params.options);
        assertDirectResponseMatchesFrozenProblemSpec(response, context);
        const remainingIssue = response.problemType === 'function'
          ? findAssignmentStyleCaseInput(response.cases)
          : null;
        if (remainingIssue) {
          throw new Error(`第 ${remainingIssue.caseNumber} 个 .in 仍含错误写法：${remainingIssue.line}`);
        }
      } catch (err) {
        if (err instanceof TestdataPipelineError) throw err;
        throw toPipelineError(err, {
          code: 'GENERATOR_INVALID_INPUT',
          stage: 'direct_repair',
          artifact: 'generator',
          message: `AI 自动修复 .in 格式后仍未返回可用的完整文件计划。请重试；若持续失败，可用「生成骨架文件（不调用 AI）」手动填写。技术细节：${err instanceof Error ? err.message : String(err)}`,
        });
      }
    } else {
      const missingTemplates = getMissingTemplateLanguages(response, params.options);
      if (missingTemplates.length > 0) {
        this.emitProgress(params, 'templates', 62);
        let repairResult;
        try {
          repairResult = await directClient.chat(
            [
              { role: 'user', content: userPrompt },
              { role: 'assistant', content: initialResult.content },
              { role: 'user', content: buildTemplateRepairPrompt(missingTemplates) },
            ],
            systemPrompt,
            callOptions,
          );
        } catch (err) {
          throw toPipelineError(err, {
            code: 'TEMPLATE_COMPILE_FAILED',
            stage: 'template_missing',
            artifact: artifactForTemplateLanguage(missingTemplates[0]),
            message: `AI 未返回 ${missingTemplates.map(lang => LANG_DISPLAY[lang]).join('、')}，自动补全请求又失败了。`
              + `请重试；若 AI 服务持续不可用，可用「生成骨架文件（不调用 AI）」手动填写。技术细节：${err instanceof Error ? err.message : String(err)}`,
          });
        }
        results.push(repairResult);
        const repairedTemplates = parseTemplateSections(repairResult.content);
        response.templates = { ...response.templates };
        for (const lang of missingTemplates) {
          if (repairedTemplates[lang]) response.templates[lang] = repairedTemplates[lang];
        }
        const stillMissing = getMissingTemplateLanguages(response, params.options);
        if (stillMissing.length > 0) {
          throw toPipelineError(
            new Error(
              `AI 补全后仍缺少 ${stillMissing.map(lang => LANG_DISPLAY[lang]).join('、')}。`
              + '请重试；若持续失败，可用「生成骨架文件（不调用 AI）」手动填写。',
            ),
            {
              code: 'TEMPLATE_COMPILE_FAILED',
              stage: 'template_missing',
              artifact: artifactForTemplateLanguage(stillMissing[0]),
            },
          );
        }
      }
    }

    this.emitProgress(params, 'assembling', 92);
    const plan = assemblePlan(response, params.options, {
      mode: 'direct',
      existingFiles: params.existingFiles,
      existingConfig: params.existingConfig,
    });
    // 直出模式未经沙箱验证：给出 direct 验证元数据，前端据此渲染「未验证」提示
    plan.verification = {
      mode: 'direct',
      oracleKind: params.options.providedStd?.trim()
        ? params.options.providedStdSource === 'accepted-record' ? 'accepted-record' : 'provided-std'
        : 'ai-solution',
      verified: false,
      wouldBlock: false,
    };
    if (hasCustomChecker(params.existingConfig)) {
      const checkerArtifacts = params.checkerArtifacts
        || { configured: true, read: false, failureKind: 'missing' as const };
      plan.verification.checkerCheck = {
        ...freshCheckerCheck(checkerArtifacts),
        failureKind: 'unavailable',
      };
      plan.verification.verified = false;
      plan.verification.wouldBlock = true;
    }
    return this.applyResultMetadata(finalizePlanVerification(
      plan,
      params.options.languages,
      hasCustomChecker(params.existingConfig),
      this.reliabilityMode,
    ), results);
  }

  private async generateGenerationArtifacts(
    params: GenerateTestdataParams,
    solution: SandboxSolutionBlueprint,
    coveragePlan: Array<CoverageSlot | SubtaskCaseAllocation>,
    callOptions: ChatCallOptions,
    results: ChatResult[],
    context?: TestdataPipelineContext,
  ): Promise<GenerationArtifactsCallState> {
    const artifactsClient = this.clientForRole('artifacts');
    const systemPrompt = buildGenerationArtifactsSystemPrompt(!!context);
    const userPrompt = buildGenerationArtifactsUserPrompt(
      params,
      solution,
      coveragePlan,
      context,
    );
    const initialResult = await artifactsClient.chat(
      [{ role: 'user', content: userPrompt }],
      systemPrompt,
      callOptions,
    );
    results.push(initialResult);
    try {
      return {
        artifacts: parseGenerationArtifacts(
          initialResult.content,
          solution.problemType,
          params.options.languages,
          { allowMissingTemplates: true },
        ),
        sourceContent: initialResult.content,
      };
    } catch (parseError) {
      if (isCancellation(parseError)) throw parseError;
      const repairResult = await artifactsClient.chat(
        [
          { role: 'user', content: userPrompt },
          { role: 'assistant', content: initialResult.content },
          {
            role: 'user',
            content: `外围制品无法解析：${parseError instanceof Error ? parseError.message : String(parseError)}\n`
              + '请重新完整输出 @@@GENERATOR@@@ 与函数题所需的全部 @@@TEMPLATE:语言@@@ 分节；不要输出 ORACLE、SOLUTION、BRUTE、VALIDATOR、代码围栏或解释。',
          },
        ],
        systemPrompt,
        callOptions,
      );
      results.push(repairResult);
      try {
        return {
          artifacts: parseGenerationArtifacts(
            repairResult.content,
            solution.problemType,
            params.options.languages,
            { allowMissingTemplates: true },
          ),
          sourceContent: repairResult.content,
        };
      } catch (repairParseError) {
        throw new TestdataGenerationError(
          `AI 自动修复外围制品后仍无法解析：${repairParseError instanceof Error ? repairParseError.message : String(repairParseError)}`,
          'artifacts_parse',
          results,
          true,
          undefined,
          undefined,
          {
            code: 'GENERATOR_INVALID_JSON',
            artifact: 'generator',
            retryPolicy: 'repair-artifact',
            failedModelRole: 'artifacts',
          },
        );
      }
    }
  }

  private async generateIndependentVerifier(
    params: GenerateTestdataParams,
    blueprint: Pick<SandboxSolutionBlueprint, 'problemType' | 'functionName' | 'analysis'>,
    callOptions: ChatCallOptions,
    results: ChatResult[],
    attempt = 1,
    context?: TestdataPipelineContext,
  ): Promise<IndependentVerifierCallState> {
    const verifierClient = this.clientForRole('verifier');
    const systemPrompt = buildIndependentVerifierSystemPrompt(
      TESTDATA_GEN_LIMITS.STRESS_CASES,
      !!context,
    );
    const userPrompt = buildIndependentVerifierUserPrompt(params, blueprint, context);
    const expectedFunctionSamples = (context?.spec.problemKind || blueprint.problemType) === 'function'
      ? context?.statement.samples || extractStatementSamples(params.statementMarkdown)
      : [];
    const initialResult = await verifierClient.chat(
      [{ role: 'user', content: userPrompt }],
      systemPrompt,
      callOptions,
    );
    results.push(initialResult);
    try {
      return {
        verifier: parseIndependentVerifierBlueprint(initialResult.content, expectedFunctionSamples),
        systemPrompt,
        userPrompt,
        sourceContent: initialResult.content,
        expectedFunctionSamples,
      };
    } catch (parseError) {
      if (isCancellation(parseError)) throw parseError;
      this.emitProgress(
        params,
        'verifier_repair',
        this.progressForAttempt(52, attempt),
        attempt,
      );
      let repairResult: ChatResult;
      try {
        repairResult = await verifierClient.chat(
          [
            { role: 'user', content: userPrompt },
            { role: 'assistant', content: initialResult.content },
            {
              role: 'user',
              content: buildIndependentVerifierRepairPrompt(
                parseError,
                expectedFunctionSamples,
                context,
              ),
            },
          ],
          systemPrompt,
          callOptions,
        );
      } catch (err) {
        if (isCancellation(err)) throw err;
        throw new TestdataGenerationError(
          `AI 独立验证器格式无法解析，自动修复请求又失败了。技术细节：${err instanceof Error ? err.message : String(err)}`,
          'independent_verifier_parse',
          results,
          false,
          undefined,
          undefined,
          {
            code: 'COVERAGE_REQUIREMENT_MISSING',
            artifact: 'coverage',
            retryPolicy: 'switch-model',
            failedModelRole: 'verifier',
          },
        );
      }
      results.push(repairResult);
      try {
        return {
          verifier: parseIndependentVerifierBlueprint(repairResult.content, expectedFunctionSamples),
          systemPrompt,
          userPrompt,
          sourceContent: repairResult.content,
          expectedFunctionSamples,
        };
      } catch (repairParseError) {
        throw new TestdataGenerationError(
          `AI 自动修复独立验证器后仍无法解析：${repairParseError instanceof Error ? repairParseError.message : String(repairParseError)}`,
          'independent_verifier_parse',
          results,
          true,
          undefined,
          undefined,
          {
            code: 'COVERAGE_REQUIREMENT_MISSING',
            artifact: 'coverage',
            retryPolicy: 'switch-model',
            failedModelRole: 'verifier',
          },
        );
      }
    }
  }

  async generateKillTargets(input: {
    statement: string;
    analysis: string;
    samples: SampleIO[];
    signal?: AbortSignal;
    context?: TestdataPipelineContext;
  }, results?: ChatResult[]): Promise<KillTarget[]> {
    const result = await this.clientForRole('verifier').chat(
      [{ role: 'user', content: buildKillTargetsUserPrompt(input) }],
      buildKillTargetsSystemPrompt(!!input.context),
      {
        ...this.getCallOptions({ signal: input.signal }),
        timeoutMs: KILL_TARGET_AI_TIMEOUT_MS,
      },
    );
    results?.push(result);
    return parseKillTargetsResponse(result.content);
  }

  private async generateHackCandidates(
    params: GenerateTestdataParams,
    analysis: string,
    target: KillTarget,
    timeoutMs: number,
    signal: AbortSignal,
    results: ChatResult[],
    context?: TestdataPipelineContext,
  ): Promise<HackCandidate[]> {
    const result = await this.clientForRole('verifier').chat(
      [{ role: 'user', content: buildHackCasesUserPrompt({ analysis, target, context }) }],
      buildHackCasesSystemPrompt(),
      {
        ...this.getCallOptions({ signal, onProgress: params.onProgress }),
        timeoutMs,
      },
    );
    results.push(result);
    return parseHackCasesResponse(result.content).slice(0, 3);
  }

  /**
   * 仅为正式数据未卡住的 WA 靶子尝试小规模补刀。所有候选必须依次通过
   * VALIDATOR、ORACLE 与该错误解本身的沙箱复跑，任一基础设施失败均静默停下。
   */
  private async repairSurvivingKillTargets(
    params: GenerateTestdataParams,
    blueprint: SandboxGenerationBlueprint,
    response: GenerationResponse,
    killTargets: KillTarget[],
    runner: TestdataSandboxRunner,
    results: ChatResult[],
    checkerExecutor?: CheckerExecutor,
    context?: TestdataPipelineContext,
  ): Promise<GenerationResponse> {
    const discrimination = response.verification?.discrimination;
    const deadlineAt = response.discriminationDeadlineAt;
    if (!discrimination || deadlineAt === undefined || killTargets.length === 0) return response;
    let cases: TestCase[] = response.cases;
    const initialCaseCount = cases.length;

    const finish = () => {
      response.cases = cases;
      discrimination.allKilled = areAllApplicableDiscriminationTargetsKilled(
        discrimination.targets,
      );
      return response;
    };

    let oracleExecutor: OracleExecutor;
    try {
      oracleExecutor = await createOracleExecutor({
        blueprint,
        options: params.options,
        runner,
        cppOracleAvailable: this.cppOracleAvailable,
        signal: params.signal,
        deadlineAt,
        hardProvidedStdFailure: false,
      });
    } catch (err) {
      if (params.signal?.aborted) throw params.signal.reason ?? err;
      if (isCancellation(err)) throw err;
      // 定向补刀是非关键增强；主流程 ORACLE 已验证成功，二次编译失败只跳过补刀。
      return finish();
    }

    try {
    targetLoop:
    for (let targetIndex = 0; targetIndex < killTargets.length; targetIndex++) {
      const target = killTargets[targetIndex];
      const targetResult = discrimination.targets[targetIndex];
      if (
        !targetResult
        || targetResult.kind === 'brute-complexity'
        || targetResult.killed
        || targetResult.skippedReason
      ) continue;

      for (let round = 0; round < 2; round++) {
        if (
          Date.now() >= deadlineAt
          || cases.length >= TESTDATA_GEN_LIMITS.MAX_CASES
        ) break targetLoop;
        let candidates: HackCandidate[];
        const deadlineScope = createDeadlineAbortScope(params.signal, deadlineAt);
        try {
          const remainingBudgetMs = deadlineAt - Date.now();
          if (remainingBudgetMs <= 0) break targetLoop;
          candidates = await this.generateHackCandidates(
            params,
            context ? '' : blueprint.analysis || '',
            target,
            remainingBudgetMs,
            deadlineScope.signal,
            results,
            context,
          );
        } catch (err) {
          if (params.signal?.aborted) throw params.signal.reason ?? err;
          if (deadlineScope.deadlineTriggered()) break targetLoop;
          if (isCancellation(err)) throw err;
          continue;
        } finally {
          deadlineScope.dispose();
        }
        if (Date.now() >= deadlineAt) break targetLoop;

        for (const candidate of candidates) {
          if (cases.length >= TESTDATA_GEN_LIMITS.MAX_CASES) break targetLoop;
          if (cases.some(item =>
            comparableFileContent(item.input) === comparableFileContent(candidate.input))) {
            continue;
          }
          try {
            if (blueprint.validatorCode) {
              const validation = await runner.runPythonBatchDetailed(
                blueprint.validatorCode,
                [candidate.input],
                { signal: params.signal, deadlineAt },
              );
              if (validation.length !== 1) throw new Error('定向补刀 VALIDATOR 未返回单条结果');
              if (!validation[0].accepted) continue;
            }

            const oracle = await oracleExecutor.runBatchDetailed(
              [candidate.input],
              { signal: params.signal, deadlineAt },
            );
            if (oracle.length !== 1) throw new Error('定向补刀 ORACLE 未返回单条结果');
            if (!oracle[0].accepted) continue;
            const output = normalizeFileContent(oracle[0].stdout);
            if (Buffer.byteLength(output, 'utf8') > TESTDATA_GEN_LIMITS.MAX_FILE_SIZE) continue;

            const targetRun = await runner.runPythonBatchDetailed(
              target.code,
              [candidate.input],
              { signal: params.signal, deadlineAt },
            );
            if (targetRun.length !== 1) throw new Error('定向补刀错误解未返回单条结果');
            const detail = targetRun[0];
            const executionVerdict = reduceTargetExecution(detail);
            let killedBy: DiscriminationTargetResult['killedBy'];
            if (executionVerdict === 'timeout') killedBy = 'tle';
            else if (executionVerdict === 'runtime-failure') killedBy = 'wa';
            else if (executionVerdict === 'infra-error') {
              targetResult.skippedReason = 'checker-infra-error';
              continue targetLoop;
            } else if (checkerExecutor?.status === 'ready') {
              const verdict = await checkerExecutor.runChecker(
                candidate.input,
                detail.stdout,
                output,
                { signal: params.signal, deadlineAt },
              );
              if (verdict === 'infra-error') {
                targetResult.skippedReason = 'checker-infra-error';
                continue targetLoop;
              }
              if (verdict === 'reject') killedBy = 'wa';
            } else if (hasCustomChecker(params.existingConfig)) {
              targetResult.skippedReason = 'checker-infra-error';
              continue targetLoop;
            } else if (comparableFileContent(detail.stdout) !== comparableFileContent(output)) {
              killedBy = 'wa';
            }
            if (!killedBy) continue;

            const merged = mergeHackCases(
              cases,
              [{ input: candidate.input, output }],
              TESTDATA_GEN_LIMITS.MAX_CASES,
            );
            if (merged.length === cases.length) break targetLoop;
            cases = merged;
            targetResult.killed = true;
            targetResult.killedBy = killedBy;
            targetResult.killedByCase = cases.length;
            if (executionVerdict === 'runtime-failure') {
              targetResult.description = `${targetResult.description}(运行失败)`;
            }
            continue targetLoop;
          } catch (err) {
            if (params.signal?.aborted) throw params.signal.reason ?? err;
            if (isCancellation(err)) throw err;
            break targetLoop;
          }
        }
      }
    }

    // 一个靶子的定向反例也可能顺带卡掉其他错误模式；只复跑本轮新追加的点，
    // 避免重复消耗正式数据的沙箱预算。
    const appendedCases = cases.slice(initialCaseCount);
    if (appendedCases.length > 0) {
      for (let targetIndex = 0; targetIndex < killTargets.length; targetIndex++) {
        if (Date.now() >= deadlineAt) break;
        const target = killTargets[targetIndex];
        const targetResult = discrimination.targets[targetIndex];
        if (!targetResult || targetResult.killed || targetResult.skippedReason) continue;
        try {
          const details = await runner.runPythonBatchDetailed(
            target.code,
            appendedCases.map(item => item.input),
            { signal: params.signal, deadlineAt },
          );
          if (details.length !== appendedCases.length) break;
          let checkerVerdicts: Array<CheckerExecutionVerdict | undefined> | undefined;
          if (checkerExecutor?.status === 'ready') {
            const mappedVerdicts: Array<CheckerExecutionVerdict | undefined> = new Array(
              appendedCases.length,
            );
            checkerVerdicts = mappedVerdicts;
            const acceptedIndices = details.flatMap((detail, index) =>
              detail.accepted && !detail.timedOut ? [index] : []);
            const verdicts = await checkerExecutor.runBatch(
              acceptedIndices.map(index => ({
                input: appendedCases[index].input,
                output: details[index].stdout,
                answer: appendedCases[index].output,
              })),
              { signal: params.signal, deadlineAt },
            );
            acceptedIndices.forEach((caseIndex, verdictIndex) => {
              mappedVerdicts[caseIndex] = verdicts[verdictIndex];
            });
          }
          const evaluated = evaluateDiscrimination({
            targetRuns: [{
              kind: target.kind,
              description: targetResult.description,
              perCase: details.map((detail, index) => ({
                ...detail,
                checkerVerdict: checkerVerdicts?.[index],
              })),
            }],
            oracleOutputs: appendedCases.map(item => item.output),
            customChecker: hasCustomChecker(params.existingConfig),
            checkerAvailable: checkerExecutor?.status === 'ready',
          }).targets[0];
          if (!evaluated?.killed || evaluated.killedByCase === undefined) continue;
          targetResult.description = evaluated.description;
          targetResult.killed = true;
          targetResult.killedBy = evaluated.killedBy;
          targetResult.killedByCase = initialCaseCount + evaluated.killedByCase;
        } catch (err) {
          if (params.signal?.aborted) throw params.signal.reason ?? err;
          if (isCancellation(err)) throw err;
          break;
        }
      }
    }
      return finish();
    } finally {
      await oracleExecutor.dispose();
    }
  }

  private async generateWithSandbox(
    params: GenerateTestdataParams,
    runner: TestdataSandboxRunner,
    attempt = 1,
    risk = this.assessRisk(params),
    context?: TestdataPipelineContext,
  ): Promise<GenerationPlan> {
    if (context) this.activePipelineContext = context;
    const report = (stage: TestdataGenerationProgressStage, percent: number) => {
      this.emitProgress(params, stage, this.progressForAttempt(percent, attempt), attempt);
    };
    const customChecker = hasCustomChecker(params.existingConfig);
    const checkerExecutor = await createCheckerExecutor({
      artifacts: params.checkerArtifacts || (customChecker
        ? { configured: true, read: false, failureKind: 'missing' }
        : { configured: false, read: false }),
      runner,
      signal: params.signal,
      reliabilityMode: this.reliabilityMode,
    });
    try {
    // 完整协议只用于后续按失败节定向修复；正常成功路径严格分成两个阶段。
    let cppOracleAvailableForAttempt = this.cppOracleAvailable;
    let systemPrompt = buildSandboxBlueprintSystemPrompt(cppOracleAvailableForAttempt, !!context);
    let solutionSystemPrompt = buildSolutionBlueprintSystemPrompt(
      cppOracleAvailableForAttempt,
      !!context,
    );
    const solutionUserPrompt = buildSolutionBlueprintUserPrompt(params, context);
    const oracleClient = this.clientForRole('oracle');
    const artifactsClient = this.clientForRole('artifacts');
    const verifierClient = this.clientForRole('verifier');
    const callOptions = this.getCallOptions(params, attempt);
    report('blueprint', 10);
    const results: ChatResult[] = [];
    let finalOracleIdentity: TestdataModelIdentity | undefined;
    let finalVerifierIdentity: TestdataModelIdentity | undefined;
    const expectedFunctionSamples = extractStatementSamples(params.statementMarkdown);
    const checkpoint = reusableCheckpointForContext(
      params.checkpoint,
      params.options,
      this.reliabilityMode,
      context,
    );
    let solutionSourceContent = checkpoint?.solution
      ? JSON.stringify(checkpoint.solution)
      : '';
    let solution: SandboxSolutionBlueprint;
    let originalParsedSubtasks: SubtaskSpec[] | undefined;
    try {
      if (context) assertProblemSpecUnchanged(context);
      if (checkpoint?.solution) {
        solution = bindBlueprintToFrozenProblemSpec(
          this.useProvidedOracle(checkpoint.solution, params.options),
          context,
        );
      } else {
        const initialResult = await oracleClient.chat(
          [{ role: 'user', content: solutionUserPrompt }],
          solutionSystemPrompt,
          callOptions,
        );
        results.push(initialResult);
        solutionSourceContent = initialResult.content;
        solution = bindBlueprintToFrozenProblemSpec(
          this.useProvidedOracle(
            parseSolutionBlueprint(initialResult.content, params.options, expectedFunctionSamples),
            params.options,
          ),
          context,
        );
      }
      if (solution.subtasks?.length) originalParsedSubtasks = solution.subtasks;
      void this.emitCheckpoint(params, { solution });
      report('blueprint', 24);
      report('solution_verification', 28);
      await verifySolutionBlueprintSamples(
        solution,
        params.options,
        params.statementMarkdown,
        runner,
        params.signal,
        customChecker,
        cppOracleAvailableForAttempt,
        checkerExecutor,
      );
    } catch (solutionError) {
      if (params.signal?.aborted) throw params.signal.reason ?? solutionError;
      if (isCancellation(solutionError)) throw solutionError;
      const typedSolutionError = solutionError instanceof TestdataPipelineError
        ? solutionError
        : toPipelineError(solutionError, {
          code: 'SPEC_PARSE_FAILED',
          stage: 'solution_blueprint',
          artifact: 'spec',
        });
      if (typedSolutionError.artifact === 'checker') throw typedSolutionError;
      if (
        params.options.providedStdSource === 'accepted-record'
        && typedSolutionError.artifact === 'oracle'
      ) {
        throw wrapHistoricalCandidateFailure(
          typedSolutionError,
          `所选历史 AC 候选解未通过第一阶段题面样例验证，已拒绝使用。技术细节：${solutionError instanceof Error ? solutionError.message : String(solutionError)}`,
          results,
        );
      }
      if (solutionError instanceof TestdataGenerationError && solutionError.userMessageKey) {
        throw solutionError;
      }
      const cppInfraFailure = typedSolutionError.code === 'ORACLE_COMPILE_FAILED'
        && typedSolutionError.safeDetails.failureKind === 'infra';
      if (cppInfraFailure) {
        cppOracleAvailableForAttempt = false;
        systemPrompt = buildSandboxBlueprintSystemPrompt(false, !!context);
        solutionSystemPrompt = buildSolutionBlueprintSystemPrompt(false, !!context);
      }
      report('blueprint_repair', 30);
      const repairResult = await oracleClient.chat(
        [
          { role: 'user', content: solutionUserPrompt },
          { role: 'assistant', content: solutionSourceContent },
          {
            role: 'user',
            content: `第一阶段解题蓝图未通过解析或样例预验证：${solutionError instanceof Error ? solutionError.message : String(solutionError)}\n`
              + (cppInfraFailure
                ? 'C++ 编译基础设施暂时不可用，请把 ORACLE 改写为 Python 3。'
                : '')
              + '请重新完整输出 META、ANALYSIS、ORACLE，以及函数题需要的 SOLUTION/SAMPLE_INPUTS；禁止输出 GENERATOR、BRUTE、VALIDATOR、TEMPLATE、CASE、代码围栏或解释。',
          },
        ],
        solutionSystemPrompt,
        callOptions,
      );
      results.push(repairResult);
      solutionSourceContent = repairResult.content;
      try {
        const repairedSolution = parseSolutionBlueprint(
          repairResult.content,
          params.options,
          expectedFunctionSamples,
        );
        if (
          !/^[ \t]*===\s*SUBTASKS\s*===\s*$/im.test(repairResult.content)
          && originalParsedSubtasks?.length
        ) {
          repairedSolution.subtasks = originalParsedSubtasks;
        }
        solution = bindBlueprintToFrozenProblemSpec(
          this.useProvidedOracle(repairedSolution, params.options),
          context,
        );
        if (context) assertProblemSpecUnchanged(context);
        void this.emitCheckpoint(params, { solution });
        report('solution_verification', 32);
        await verifySolutionBlueprintSamples(
          solution,
          params.options,
          params.statementMarkdown,
          runner,
          params.signal,
          customChecker,
          cppOracleAvailableForAttempt,
          checkerExecutor,
        );
      } catch (repairParseError) {
        if (isCancellation(repairParseError)) throw repairParseError;
        const typedRepairError = repairParseError instanceof TestdataPipelineError
          ? repairParseError
          : toPipelineError(repairParseError, {
            code: 'SPEC_PARSE_FAILED',
            stage: 'solution_blueprint',
            artifact: 'spec',
          });
        throw new TestdataGenerationError(
          `AI 自动修复解题蓝图后仍未通过解析或样例预验证：${repairParseError instanceof Error ? repairParseError.message : String(repairParseError)}`,
          'solution_blueprint',
          results,
          true,
          undefined,
          undefined,
          {
            code: typedRepairError.code,
            artifact: typedRepairError.artifact,
            retryPolicy: typedRepairError.retryPolicy,
            safeDetails: typedRepairError.safeDetails,
            failedModelRole: 'oracle',
          },
        );
      }
    }

    // 本轮只在最终解题蓝图确定后计算一次门控与分配。后续外围制品、修复提示、
    // 补刀扩展和最终配置均消费同一个对象，避免不同阶段重新推导产生档位漂移。
    const tieredDecision = resolveTieredSubtaskGeneration({
      caseCount: params.options.caseCount,
      dataScale: params.options.dataScale,
      subtasks: solution.subtasks,
      existingConfig: params.existingConfig,
    });
    const generationCoverage: Array<CoverageSlot | SubtaskCaseAllocation> = tieredDecision.enabled
      ? tieredDecision.allocations
      : buildCoveragePlan(params.options.caseCount, params.options.dataScale || 'auto');
    const legacyCombinedUserPrompt = buildSandboxBlueprintUserPrompt(params, generationCoverage);
    const artifactsUserPrompt = buildGenerationArtifactsUserPrompt(
      params,
      solution,
      generationCoverage,
      context,
    );
    const artifactsSystemPrompt = buildGenerationArtifactsSystemPrompt(!!context);
    const userPrompt = context ? artifactsUserPrompt : legacyCombinedUserPrompt;
    const solutionRepairSourceContent = context
      ? JSON.stringify({ ...checkpointSolutionFromBlueprint(solution), analysis: undefined })
      : solutionSourceContent;

    // 解题蓝图过硬闸门后，三个互不依赖的 AI 阶段并行生成；独立验证器
    // 看不到 ORACLE 源码，错误解靶子调用失败则独立降级为空，不影响正确性管线。
    report('artifacts', 36);
    const killTargetSamples = buildKillTargetPromptSamples(
      solution,
      expectedFunctionSamples,
      context,
    );
    const optionalDiscriminationResults: ChatResult[] = [];
    // 并发完成顺序不可作为因果顺序：两个必需阶段各自持有稳定的失败上下文，
    // 成功后再按“外围制品 → 独立验证器”的固定顺序合并；可选补刀模型单独归档。
    const artifactsResults: ChatResult[] = [...results];
    const verifierResults: ChatResult[] = [...results];
    const [killTargets, artifactsState, initialVerifierState] = await Promise.all([
      Array.isArray(checkpoint?.killTargets)
        ? Promise.resolve(checkpoint.killTargets)
        : this.generateKillTargets({
          statement: context ? '' : params.statementMarkdown,
          analysis: context ? '' : solution.analysis || '',
          samples: killTargetSamples,
          signal: params.signal,
          context,
        }, optionalDiscriminationResults)
          .then(targets => {
            void this.emitCheckpoint(params, { killTargets: targets });
            return targets;
          })
          .catch((err): KillTarget[] => {
            if (isCancellation(err)) throw err;
            return [];
          }),
      checkpoint?.artifacts
        ? Promise.resolve({
          artifacts: checkpoint.artifacts,
          sourceContent: JSON.stringify(checkpoint.artifacts),
        })
        : this.generateGenerationArtifacts(
          params,
          context ? {
            ...solution,
            analysis: undefined,
            oracleCode: '',
            solutionCode: undefined,
            solutions: undefined,
          } : solution,
          generationCoverage,
          callOptions,
          artifactsResults,
          context,
        )
          .then(state => {
            void this.emitCheckpoint(params, { artifacts: state.artifacts });
            return state;
          }),
      checkpoint?.verifier
        ? Promise.resolve({
          verifier: checkpoint.verifier,
          systemPrompt: buildIndependentVerifierSystemPrompt(
            TESTDATA_GEN_LIMITS.STRESS_CASES,
            !!context,
          ),
          userPrompt: buildIndependentVerifierUserPrompt(params, solution, context),
          sourceContent: JSON.stringify(checkpoint.verifier),
          expectedFunctionSamples: solution.problemType === 'function'
            ? expectedFunctionSamples
            : [],
        })
        : this.generateIndependentVerifier(
          params,
          context ? {
            problemType: solution.problemType,
            functionName: solution.functionName,
          } : solution,
          callOptions,
          verifierResults,
          attempt,
          context,
        ).then(state => {
          void this.emitCheckpoint(params, { verifier: state.verifier });
          return state;
        }),
    ]);
    // 可选 kill-target 与独立 verifier 并发完成，不能让完成顺序决定角色身份。
    // 独立性门控固定采用最终 Oracle 蓝图调用和独立 verifier 调用的实际模型。
    if (!checkpoint?.solution && results.length > 0) {
      finalOracleIdentity = { ...results[results.length - 1].usedModel };
      this.activeRoleIdentities.oracle = finalOracleIdentity;
    }
    if (!checkpoint?.verifier && verifierResults.length > results.length) {
      finalVerifierIdentity = { ...verifierResults[verifierResults.length - 1].usedModel };
      this.activeRoleIdentities.verifier = finalVerifierIdentity;
    }
    this.assertCheckpointRoleIndependence(risk, checkpoint);
    this.assertIndependentRoleIdentities(risk);
    if (checkpoint) {
      // 恢复任务会创建新 job；把命中的旧制品复制到新断点，保证再次中断仍可续跑。
      void this.emitCheckpoint(params, {
        solution,
        artifacts: artifactsState.artifacts,
        verifier: initialVerifierState.verifier,
        killTargets,
      });
    }
    results.push(
      ...artifactsResults.slice(results.length),
      ...verifierResults.slice(results.length),
    );
    report('independent_verifier', 54);
    let verifierState = initialVerifierState;
    let blueprintSourceContent = `${solutionRepairSourceContent}\n${artifactsState.sourceContent}`;
    let blueprint: SandboxGenerationBlueprint = {
      ...solution,
      ...artifactsState.artifacts,
      ...verifierState.verifier,
      notes: [solution.notes, artifactsState.artifacts.notes].filter(Boolean).join('\n') || undefined,
    };
    blueprint = bindBlueprintToFrozenProblemSpec(blueprint, context);

    if (blueprint.problemType === 'function') {
      const missing = params.options.languages.filter(lang => !blueprint.templates?.[lang]?.trim());
      if (missing.length > 0) {
        report('templates', 58);
        const repairResult = await artifactsClient.chat(
          [
            { role: 'user', content: userPrompt },
            {
              role: 'assistant',
              content: context ? artifactsState.sourceContent : blueprintSourceContent,
            },
            { role: 'user', content: buildTemplateRepairPrompt(missing) },
          ],
          artifactsSystemPrompt,
          callOptions,
        );
        results.push(repairResult);
        const repairedTemplates = parseTemplateSections(repairResult.content);
        blueprint.templates = { ...blueprint.templates, ...repairedTemplates };
        blueprintSourceContent = `${blueprintSourceContent}\n${repairResult.content}`;
        const stillMissing = params.options.languages.filter(lang => !blueprint.templates?.[lang]?.trim());
        if (stillMissing.length > 0) {
          throw new TestdataGenerationError(
            `AI 补全后仍缺少 ${stillMissing.map(lang => LANG_DISPLAY[lang]).join('、')}。`,
            'template_missing',
            results,
            true,
            undefined,
            undefined,
            {
              code: 'TEMPLATE_COMPILE_FAILED',
              artifact: artifactForTemplateLanguage(stillMissing[0]),
              failedModelRole: 'artifacts',
            },
          );
        }
        void this.emitCheckpoint(params, {
          artifacts: {
            ...artifactsState.artifacts,
            templates: blueprint.templates,
          },
        });
      }
    }

    const materializationCache: MaterializationCacheState = {};
    const initialMaterialization = resolveMaterializationResume(['GENERATOR']);
    let response: GenerationResponse;
    try {
      response = await materializeSandboxBlueprint(
        blueprint, params.options, params.statementMarkdown, runner, params.signal,
        customChecker,
        report,
        killTargets,
        cppOracleAvailableForAttempt,
        checkerExecutor,
        { ...initialMaterialization, cache: materializationCache },
      );
    } catch (firstError) {
      if (params.signal?.aborted) throw params.signal.reason ?? firstError;
      if (isCancellation(firstError)) throw firstError;
      if (firstError instanceof TestdataGenerationError && firstError.userMessageKey) {
        throw firstError;
      }
      const typedFirstError = firstError instanceof TestdataPipelineError
        ? firstError
        : toPipelineError(firstError, {
          code: 'UNKNOWN',
          stage: 'pipeline',
          artifact: 'pipeline',
          retryPolicy: 'repair-artifact',
        });
      const blueprintBeforeRepair = blueprint;
      const cppInfraFailure = typedFirstError.code === 'ORACLE_COMPILE_FAILED'
        && typedFirstError.safeDetails.failureKind === 'infra';
      if (cppInfraFailure) {
        cppOracleAvailableForAttempt = false;
        systemPrompt = buildSandboxBlueprintSystemPrompt(false, !!context);
        blueprint = { ...blueprint, oracleLanguage: 'python' };
      }
      if (typedFirstError.code === 'PIPELINE_BUDGET_EXHAUSTED') {
        throw new TestdataGenerationError(
          '沙箱验证已达到总时长上限，系统已停止后续修复与模型升级。请减少测试点数量、降低数据规模，或检查 BRUTE 是否能在小数据上及时结束。',
          'sandbox_budget',
          results,
          false,
          undefined,
          undefined,
          {
            code: 'PIPELINE_BUDGET_EXHAUSTED',
            artifact: 'pipeline',
            retryPolicy: 'no-retry',
          },
        );
      }
      const repairPolicy = typedFirstError.retryPolicy;
      if (
        params.options.providedStdSource === 'accepted-record'
        && typedFirstError.artifact === 'oracle'
      ) {
        throw wrapHistoricalCandidateFailure(
          typedFirstError,
          `所选历史 AC 候选解未通过独立机器验证，已拒绝使用。请改选其他 AC、粘贴教师审核后的标程，或留空让系统生成。技术细节：${firstError instanceof Error ? firstError.message : String(firstError)}`,
          results,
        );
      }
      if (repairPolicy === 'adjudicate' || repairPolicy === 'manual-review' || repairPolicy === 'no-retry') {
        throw new TestdataGenerationError(
          typedFirstError.message,
          typedFirstError.stage,
          results,
          false,
          undefined,
          undefined,
          {
            code: typedFirstError.code,
            artifact: typedFirstError.artifact,
            retryPolicy: repairPolicy,
            safeDetails: typedFirstError.safeDetails,
          },
        );
      }
      const repairScope = repairScopeForPipelineFailure(typedFirstError);
      let failedModelRole: Extract<TestdataModelRole, 'oracle' | 'artifacts' | 'verifier'> | undefined =
        isIndependentVerifierScope(repairScope)
          ? 'verifier'
          : repairScope === 'oracle'
            ? 'oracle'
            : repairScope === 'full'
              ? undefined
              : 'artifacts';
      let usedFullRepair = repairScope === 'full';
      report(isIndependentVerifierScope(repairScope) ? 'verifier_repair' : 'pipeline_repair', 87);
      const isolatedFullRegenerationError = (
        detail: string,
        role = failedModelRole || 'artifacts',
      ) => new TestdataGenerationError(
        `frozen ProblemSpec 流程不允许 combined full repair；必须在同一 Spec 下重跑隔离角色。${detail}`,
        'pipeline_repair',
        results,
        true,
        undefined,
        undefined,
        {
          code: typedFirstError.code,
          artifact: typedFirstError.artifact,
          retryPolicy: 'switch-model',
          safeDetails: typedFirstError.safeDetails,
          failedModelRole: role,
          requiresIsolatedRegeneration: true,
        },
      );
      if (context && repairScope === 'full') {
        assertProblemSpecUnchanged(context);
        throw isolatedFullRegenerationError('');
      }
      let repairResult;
      try {
        if (isIndependentVerifierScope(repairScope)) {
          repairResult = await verifierClient.chat(
            [
              { role: 'user', content: verifierState.userPrompt },
              { role: 'assistant', content: verifierState.sourceContent },
              {
                role: 'user',
                content: buildIndependentVerifierRepairPrompt(
                  firstError,
                  verifierState.expectedFunctionSamples,
                  context,
                ),
              },
            ],
            verifierState.systemPrompt,
            callOptions,
          );
          finalVerifierIdentity = { ...repairResult.usedModel };
        } else if (repairScope === 'full') {
          if (context) assertProblemSpecUnchanged(context);
          repairResult = await this.chatForCombinedRepair(
            [
              { role: 'user', content: userPrompt },
              { role: 'assistant', content: blueprintSourceContent },
              {
                role: 'user',
                content: buildSandboxRepairPrompt(
                  firstError,
                  params.options,
                  repairScope,
                  generationCoverage,
                  context,
                ),
              },
            ],
            systemPrompt,
            callOptions,
          );
          finalOracleIdentity = { ...repairResult.usedModel };
        } else {
          const repairUserPrompt = repairScope === 'oracle' ? solutionUserPrompt : userPrompt;
          const repairSourceContent = repairScope === 'oracle'
            ? solutionRepairSourceContent
            : context
              ? artifactsState.sourceContent
              : blueprintSourceContent;
          repairResult = await (repairScope === 'oracle' ? oracleClient : artifactsClient).chat(
            [
              { role: 'user', content: repairUserPrompt },
              { role: 'assistant', content: repairSourceContent },
              {
                role: 'user',
                content: buildSandboxRepairPrompt(
                  firstError,
                  params.options,
                  repairScope,
                  generationCoverage,
                  context,
                ),
              },
            ],
            repairScope === 'oracle' ? solutionSystemPrompt : artifactsSystemPrompt,
            callOptions,
          );
          if (repairScope === 'oracle') {
            finalOracleIdentity = { ...repairResult.usedModel };
          }
        }
      } catch (err) {
        if (isCancellation(err)) throw err;
        throw new TestdataGenerationError(
          `AI 生成蓝图未通过 Hydro 沙箱验证，自动修复请求又失败了。技术细节：${err instanceof Error ? err.message : String(err)}`,
          typedFirstError.stage,
          results,
          false,
          undefined,
          undefined,
          {
            code: typedFirstError.code,
            artifact: typedFirstError.artifact,
            retryPolicy: typedFirstError.retryPolicy,
            safeDetails: typedFirstError.safeDetails,
            failedModelRole,
          },
        );
      }
      results.push(repairResult);
      let pendingIsolatedFullRegeneration: TestdataGenerationError | undefined;
      try {
        try {
          if (isIndependentVerifierScope(repairScope)) {
            verifierState = {
              ...verifierState,
              verifier: parseIndependentVerifierBlueprint(
                repairResult.content,
                verifierState.expectedFunctionSamples,
              ),
              sourceContent: repairResult.content,
            };
            blueprint = { ...blueprint, ...verifierState.verifier };
          } else if (repairScope === 'full') {
            const repairedMain = parseSandboxBlueprint(repairResult.content, params.options);
            blueprint = { ...repairedMain, ...verifierState.verifier };
            blueprintSourceContent = repairResult.content;
          } else {
            blueprint = mergeSandboxBlueprintRepair(
              blueprint,
              repairResult.content,
              repairScope as Exclude<SandboxRepairScope, 'full' | 'stress-generator' | 'function-samples' | 'accepted-std'>,
            );
          }
        } catch (targetedParseError) {
          if (repairScope === 'full' || isIndependentVerifierScope(repairScope)) throw targetedParseError;
          usedFullRepair = true;
          failedModelRole = context ? undefined : 'oracle';
          if (context) {
            assertProblemSpecUnchanged(context);
            pendingIsolatedFullRegeneration = isolatedFullRegenerationError(
              `定向修复结果不可用：${targetedParseError instanceof Error ? targetedParseError.message : String(targetedParseError)}`,
              repairScope === 'oracle' ? 'oracle' : 'artifacts',
            );
            throw pendingIsolatedFullRegeneration;
          }
          const fullRepairMessages = [
              { role: 'user', content: userPrompt },
              { role: 'assistant', content: blueprintSourceContent },
              {
                role: 'user',
                content: buildSandboxRepairPrompt(
                  new Error(`定向修复结果不可用：${targetedParseError instanceof Error ? targetedParseError.message : String(targetedParseError)}`),
                  params.options,
                  'full',
                  generationCoverage,
                  context,
                ),
              },
            ] as Parameters<MultiModelClient['chat']>[0];
          const fullRepairResult = await oracleClient.chat(
            fullRepairMessages,
            systemPrompt,
            callOptions,
          );
          finalOracleIdentity = { ...fullRepairResult.usedModel };
          results.push(fullRepairResult);
          blueprint = {
            ...parseSandboxBlueprint(fullRepairResult.content, params.options),
            ...verifierState.verifier,
          };
          blueprintSourceContent = fullRepairResult.content;
        }
        if (tieredDecision.enabled) blueprint.subtasks = tieredDecision.subtasks;
        blueprint = bindBlueprintToFrozenProblemSpec(
          this.useProvidedOracle(blueprint, params.options),
          context,
        );
        if (context) assertProblemSpecUnchanged(context);
        const repairedSolutionCheckpoint = checkpointSolutionFromBlueprint(blueprint);
        const repairedArtifactsCheckpoint = checkpointArtifactsFromBlueprint(blueprint);
        if (usedFullRepair) {
          // 完整修复的 NOTES 只归入解题蓝图，避免恢复后拼接两次。
          repairedArtifactsCheckpoint.notes = undefined;
        } else {
          // 定向修复不改 NOTES 契约，继续保留两个阶段原先各自的说明。
          repairedSolutionCheckpoint.notes = solution.notes;
          repairedArtifactsCheckpoint.notes = artifactsState.artifacts.notes;
        }
        void this.emitCheckpoint(params, {
          solution: repairedSolutionCheckpoint,
          artifacts: repairedArtifactsCheckpoint,
          verifier: checkpointVerifierFromBlueprint(blueprint),
        });
        const changedArtifacts = usedFullRepair
          ? ['full']
          : findChangedMaterializationArtifacts(blueprintBeforeRepair, blueprint);
        const materializationResume = resolveMaterializationResume(changedArtifacts);
        response = await materializeSandboxBlueprint(
          blueprint, params.options, params.statementMarkdown, runner, params.signal,
          customChecker,
          report,
          killTargets,
          cppOracleAvailableForAttempt,
          checkerExecutor,
          { ...materializationResume, cache: materializationCache },
        );
      } catch (err) {
        if (params.signal?.aborted) throw params.signal.reason ?? err;
        if (isCancellation(err)) throw err;
        if (err === pendingIsolatedFullRegeneration) throw err;
        if (err instanceof TestdataGenerationError && err.userMessageKey) throw err;
        const typedRepairError = err instanceof TestdataPipelineError
          ? err
          : toPipelineError(err, {
            code: 'UNKNOWN',
            stage: 'pipeline_repair',
            artifact: 'pipeline',
            retryPolicy: 'switch-model',
          });
        const finalPolicy = typedRepairError.retryPolicy;
        throw new TestdataGenerationError(
          `AI 自动修复后仍未通过 Hydro 沙箱验证。请重试或使用骨架模式。技术细节：${err instanceof Error ? err.message : String(err)}`,
          typedRepairError.stage,
          results,
          finalPolicy === 'repair-artifact' || finalPolicy === 'switch-model',
          undefined,
          undefined,
          {
            code: typedRepairError.code,
            artifact: typedRepairError.artifact,
            retryPolicy: finalPolicy,
            safeDetails: typedRepairError.safeDetails,
            failedModelRole,
          },
        );
      }
    }

    const initialCaseCount = response.cases.length;
    response.discriminationInitialCaseCount = initialCaseCount;
    response = await this.repairSurvivingKillTargets(
      params,
      blueprint,
      response,
      response.discriminationKillTargets || [],
      runner,
      optionalDiscriminationResults,
      checkerExecutor,
      context,
    );
    appendCheckerExecutionNotes(response, customChecker, checkerExecutor);
    if (customChecker && this.reliabilityMode === 'enforce') {
      const check = checkerExecutor.check;
      if (!check.compiled) {
        throw checkerPipelineError(
          'CHECKER_COMPILE_FAILED', 'compile', 'checker 未成功编译',
        );
      }
      if (!check.executed || check.infraFailures > 0) {
        throw checkerPipelineError(
          'CHECKER_RUNTIME_FAILED',
          check.failureKind === 'budget' ? 'budget' : 'infra',
          'checker 未完成可信语义执行',
        );
      }
    }
    if (finalOracleIdentity) this.activeRoleIdentities.oracle = finalOracleIdentity;
    if (finalVerifierIdentity) this.activeRoleIdentities.verifier = finalVerifierIdentity;
    this.assertCheckpointRoleIndependence(risk, checkpoint);
    this.assertIndependentRoleIdentities(risk);
    report('assembling', 96);
    const plan = assemblePlan(response, params.options, {
      mode: 'sandbox',
      existingFiles: params.existingFiles,
      existingConfig: params.existingConfig,
      tieredDecision,
    });
    return this.applyResultMetadata(finalizePlanVerification(
      plan,
      params.options.languages,
      customChecker,
      this.reliabilityMode,
    ), [...results, ...optionalDiscriminationResults]);
    } finally {
      await checkerExecutor.dispose();
    }
  }
}
