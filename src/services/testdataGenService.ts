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
  DISCRIMINATION_BUDGET_MS,
  SANDBOX_TOTAL_BUDGET_MS,
} from './goJudgeSandboxService';
import { excerpt, excerptTail } from '../lib/textTruncate';
import type {
  PythonRunDetail,
  PythonRunResult,
  TestdataGenerationMode,
  TestdataSandboxRunner,
} from './goJudgeSandboxService';

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

/** 题型：传统题（标准输入输出）或函数题（学生只写函数/类，LeetCode 风格） */
export type ProblemKind = 'auto' | 'traditional' | 'function';

/** 填空题（完善代码）：auto 由 AI 根据题面判断 */
export type FillInMode = 'auto' | 'yes' | 'no';

/** 测试数据规模策略：auto 自动混合覆盖，其他值用于定向生成。 */
export type DataScale = 'auto' | 'small' | 'medium' | 'large';

/** 单个测试点最终采用的规模档位。 */
export type CaseDataScale = Exclude<DataScale, 'auto'>;

export interface CoverageSlot {
  /** 本次生成内的测试点序号（从 1 开始，不等同于最终文件编号）。 */
  caseNumber: number;
  dataScale: CaseDataScale;
  /** 提示 AI 在该档位重点覆盖的通用目标。 */
  guidance: string;
}

/** 支持的模板语言族（对应 HydroOJ 语言键前缀） */
export type TemplateLang = 'py' | 'java' | 'cc';

export const SUPPORTED_TEMPLATE_LANGS: readonly TemplateLang[] = ['py', 'java', 'cc'] as const;

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
  functionName?: string;
  templates?: Partial<Record<TemplateLang, string>>;
  stdSolution?: { language?: string; code: string };
  cases: GeneratedCase[];
  notes?: string;
  /** 说明的结构化载体；notes 仍保留原拼接文本供旧消费方使用。 */
  notesStructured?: StructuredGenerationNotes;
  /** 沙箱生成模式下用于构造输入的 Python 程序。 */
  generatorCode?: string;
  /** 沙箱生成模式下实际计算 .out 的可执行 Python 标程。 */
  oracleCode?: string;
  // ─ 以下为沙箱模式的验证制品载体，供 assemblePlan 决定文件写入与 origin ─
  /** 学生提交形式的解（函数题）：写入 std.py，供教师本地复验。 */
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
  /** 函数题是否真正跑过 solution+template.py 组合（决定 template.py 的 origin）。 */
  pyTemplateExecuted?: boolean;
}

/** AI 在沙箱模式下返回的生成蓝图；此阶段不让模型直接填写 .out。 */
export interface SandboxGenerationBlueprint {
  problemType: 'function' | 'traditional';
  isFillIn?: boolean;
  analysis?: string;
  functionName?: string;
  templates?: Partial<Record<TemplateLang, string>>;
  generatorCode: string;
  oracleCode: string;        // 语义不变：自包含 stdin→stdout 完整标程
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
  functionName?: string;
  oracleCode: string;
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
  skippedReason?: 'custom-checker' | 'budget-exhausted' | 'no-targets' | 'no-complexity-gap';
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
  templateCheck?: { lang: 'py'; total: number; passed: number; skippedTimeout: number[] };
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
    target: string;
  }>;
  tokenUsage?: TokenUsage;
  usedModel?: string;
  /** 验证元数据；沙箱/直出模式提供，骨架模式与旧后端缺省。 */
  verification?: PlanVerification;
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
  MAX_STATEMENT_LENGTH: 20000,
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
  /** 现有 pdoc.config；保留 checker/time/memory 等非测试点设置。 */
  existingConfig?: string;
}

function parseExistingProblemConfig(raw?: string): Record<string, unknown> {
  if (!raw?.trim()) return {};
  try {
    const parsed = yaml.load(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/** 判断现有题目是否使用非 default/strict 的自定义 checker。 */
export function hasCustomChecker(raw?: string): boolean {
  const config = parseExistingProblemConfig(raw);
  const checkerType = typeof config.checker_type === 'string' ? config.checker_type.trim().toLowerCase() : '';
  const checker = typeof config.checker === 'string' ? config.checker.trim() : '';
  return (!!checkerType && !['default', 'strict'].includes(checkerType))
    || (!!checker && !['default', 'strict'].includes(checkerType));
}

/**
 * 生成 config.yaml（评测设置）
 *
 * 写入名为 config.yaml 的测试数据后，HydroOJ 会自动将其内容同步到
 * 题目的评测设置（pdoc.config），无需再手动到「评测设置」页保存。
 */
export function buildConfigYaml(options: BuildConfigYamlOptions): string {
  const { problemType, caseCount, languages } = options;
  const previous = parseExistingProblemConfig(options.existingConfig);
  const caseNumbers = options.caseNumbers?.length
    ? [...new Set(options.caseNumbers)].sort((a, b) => a - b)
    : Array.from({ length: caseCount }, (_, i) => i + 1);
  const cases = caseNumbers.map(number => ({
    input: `${number}.in`,
    output: `${number}.out`,
  }));

  const config: Record<string, unknown> = {};
  const preservedKeys = [
    'type', 'subType', 'target', 'score', 'time', 'memory', 'filename',
    'checker_type', 'checker', 'interactor', 'manager', 'num_processes',
    'judge_extra_files', 'detail', 'validator', 'time_limit_rate', 'memory_limit_rate',
  ];
  for (const key of preservedKeys) {
    if (previous[key] !== undefined) config[key] = previous[key];
  }
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

  config.subtasks = [{
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

  return yaml.dump(config, { lineWidth: 120, noRefs: true });
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
  /** 服务端规则引擎对"题面疑似含填空代码"的初判（仅作为参考信号提供给 AI） */
  fillInDetected?: boolean;
}

const DATA_SCALE_TEXT: Record<DataScale, string> = {
  auto: 'auto（自动混合：按题面约束一次覆盖小/中/临界规模）',
  small: 'small（小规模，人工可快速验算）',
  medium: 'medium（中等规模，题面约束内取中位量级）',
  large: 'large（接近题面约束上限，必须使用可解析构造保证输出正确）',
};

/**
 * 构建 User Prompt
 */
export function buildTestdataUserPrompt(params: BuildUserPromptParams): string {
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
  const coveragePlan = buildCoveragePlan(options.caseCount, options.dataScale || 'auto');

  const statement = statementMarkdown.length > TESTDATA_GEN_LIMITS.MAX_STATEMENT_LENGTH
    ? `${statementMarkdown.slice(0, TESTDATA_GEN_LIMITS.MAX_STATEMENT_LENGTH)}\n...（题面过长已截断）`
    : statementMarkdown;

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
    ...coveragePlan.map(slot => `- CASE ${slot.caseNumber}: ${slot.dataScale} — ${slot.guidance}`),
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
export function buildSolutionBlueprintSystemPrompt(): string {
  return `你是一位资深 OJ 算法审核专家。本阶段只解决题目并输出可执行标程，不生成测试数据、输入生成器、暴力解、校验器或多语言模板。

核心规则：
1. 先确定唯一、语言无关的原始 stdin 编码，并在 ANALYSIS 中逐行说明输入、输出、约束、算法正确性理由与复杂度。
2. ORACLE 必须是自包含、可直接运行的 Python 3 完整程序，读取一份 stdin 并严格输出题目答案；不得硬编码样例或答案表。
3. 函数题仍要在 ORACLE 内包含完整实现与 stdin 驱动，并额外输出 SOLUTION：与学生提交形式一致的函数或类定义，不含读输入和打印。
4. 若函数题题面包含样例，必须输出 SAMPLE_INPUTS，把每个题面展示参数转换为 ANALYSIS 确定的原始 stdin；只转换输入，id 不得遗漏或增加。
5. 教师手动标程是权威；历史 AC 仅是可能误 AC 的候选，禁止把 AC 状态当作正确性证明。
6. 本阶段严禁输出 GENERATOR、BRUTE、VALIDATOR 或 TEMPLATE；这些外围制品只有在 ORACLE 通过样例预验证后才会由后续阶段生成。
7. NOTES 至多 2 句，只写系统无法自动验证、需要教师人工注意的事项（如输出格式的特殊约定、多解风险）；不要复述你如何构造数据，不要罗列已由沙箱验证的内容。

输出格式：
@@@META@@@
problemType: traditional 或 function
isFillIn: false
functionName: 函数题函数名（传统题省略）
@@@ANALYSIS@@@
stdin 编码、题意、算法正确性与复杂度（不超过 500 字）
@@@ORACLE@@@
完整 Python 3 标程
@@@SOLUTION@@@
函数题学生提交形式的实现（传统题省略）
@@@SAMPLE_INPUTS@@@
函数题存在题面样例时输出紧凑 JSON：{"samples":[{"id":"1","input":"转换后的原始 stdin"}]}
@@@NOTES@@@
给教师的可选注意事项

各节使用原文分节，不要代码围栏、JSON 外壳或额外解释。`;
}

export function buildSolutionBlueprintUserPrompt(params: BuildUserPromptParams): string {
  const { problemTitle, statementMarkdown, options, fillInDetected } = params;
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
  const statement = statementMarkdown.length > TESTDATA_GEN_LIMITS.MAX_STATEMENT_LENGTH
    ? `${statementMarkdown.slice(0, TESTDATA_GEN_LIMITS.MAX_STATEMENT_LENGTH)}\n...（题面过长已截断）`
    : statementMarkdown;
  const lines = [
    `【题目标题】${problemTitle}`,
    '',
    '【题面（Markdown）】',
    statement,
    '',
    '【本阶段解题要求】',
    `- 题型：${kindText}`,
    `- 填空题（完善代码）：${fillInText}`,
    '- 只分析题意、证明算法并编写可执行 ORACLE；测试点数量、覆盖计划和模板语言留给后续阶段。',
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
  lines.push(
    '',
    '这是第一阶段：只输出 META、ANALYSIS、ORACLE，以及函数题需要的 SOLUTION/SAMPLE_INPUTS；禁止输出 GENERATOR、BRUTE、VALIDATOR、TEMPLATE 或 CASE。',
  );
  return lines.join('\n');
}

/** 第二阶段：在已验证解法固定后生成输入与函数题驱动模板。 */
export function buildGenerationArtifactsSystemPrompt(): string {
  return `你是一位 OJ 测试数据工程师。题目的算法、ORACLE 和 stdin 编码已经在上一阶段确定并通过题面样例预验证。本阶段不得修改算法、ORACLE、SOLUTION 或 stdin 编码，只生成外围制品。

核心规则：
1. GENERATOR 是自包含 Python 3 程序，不读 stdin，stdout 只打印紧凑 JSON：{"cases":[{"label":"覆盖意图","input":"原始标准输入"}]}；数量必须与用户要求完全一致。编写 GENERATOR 前，先在代码注释中逐条列出题面的所有硬性保证（如“根至少有两个孩子”“保证按 DFS 序编号”），生成逻辑必须逐条满足；任何一条违反都会导致整体失败。
2. input 是程序实际读取的原始 stdin，禁止变量赋值、源码字面量说明或答案；所有生成确定性并固定随机种子。
3. 严格执行逐 CASE 覆盖计划，交叉覆盖最小、典型、边界、退化、反例与临界规模；不得全部生成相似输入。
4. 每个 input 小于 256KB，GENERATOR stdout 小于 1MB；临界数据使用可解析构造，不能可靠验证时宁可缩小。
5. 函数题输出用户要求的全部 TEMPLATE：模板只负责读取同一 stdin、调用既定 SOLUTION、打印结果，不得包含或改写算法。传统题不输出模板。
6. 不得输出 ORACLE、SOLUTION、BRUTE 或 VALIDATOR。

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
): string {
  const base = buildTestdataUserPrompt(params).replace(
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
    solution.solutionCode ? `SOLUTION（模板必须调用此接口）：\n${solution.solutionCode}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * 兼容性/定向修复协议：初始生成已拆为解题与外围制品两阶段；当沙箱定位到
 * 具体失败节时仍可用该完整协议只替换目标分节。
 */
export function buildSandboxBlueprintSystemPrompt(): string {
  return `你是一位资深 OJ 出题与测试数据专家。请根据题面输出一份可在 Hydro go-judge 中执行的测试数据生成蓝图。

核心规则：
1. GENERATOR 是自包含 Python 3 程序，不读 stdin，向 stdout 只打印一个 JSON 对象：{"cases":[{"label":"设计意图","input":"原始标准输入"}]}。cases 数量必须与用户要求完全一致；不得打印日志或 Markdown。
2. GENERATOR 只生成 .in，不生成答案。input 必须是程序真实读取的原始 stdin，禁止 s = "101"、k = 2、arr = [1,2] 等源码赋值写法。
3. ACM/传统题：每个 input 是一份独立完整的输入文件。若题面首行是 T，默认每个文件固定 T=1，并紧跟恰好一组完整数据；只有教师明确要求批处理时才使用 T>1。
4. LeetCode/函数题：每个 input 只表示一次函数调用，不额外添加 T。默认每个参数占一行；一维数组用空格分隔，字符串不带源码引号。所有模板与 ORACLE 必须使用完全相同的输入编码。
5. ORACLE 是自包含、可直接运行的 Python 3 完整程序：读取一份 input 的 stdin，严格按题面输出 stdout。不得硬编码测试用例或答案表。函数题也必须在 ORACLE 内包含函数实现和 stdin 驱动。
6. 函数题必须输出 SOLUTION 节：与学生提交形式完全一致的函数/类定义（只含实现，不含读输入或打印），它将与 template.py 拼接后在沙箱实跑，用于验证模板与输入编码。传统题省略 SOLUTION。
7. 数据必须严格遵守用户消息中的逐 CASE 覆盖计划，并根据题面真实约束交叉变化不同维度；所有生成过程必须确定性，固定随机种子。
8. GENERATOR 必须使用紧凑 JSON（Python json.dumps(..., ensure_ascii=False, separators=(',', ':'))），stdout 总量必须小于 1MB。每个 input 的 UTF-8 内容必须小于 256KB，并确保 ORACLE 对该 input 的 stdout 也小于 256KB；全部 .in/.out 与辅助文件合计必须小于 1MB。若临界输入会导致输出过大或超时，应使用仍能触发复杂度/边界行为的可解析构造并适当缩小，而不是打印海量数据。
9. 教师提供的标准答案（手动）是唯一权威；历史 AC 候选解可能因旧数据薄弱而误 AC，只能作为待验证 ORACLE，必须通过题面样例与独立 BRUTE 压力对拍，禁止让 BRUTE 迁就候选解。
10. 函数题必须输出用户要求的每一个 TEMPLATE 节：Python 追加到学生代码末尾；Java 为 public class Main 并调用 class Solution；C++ 用 #include "foo.cc"。传统题省略 TEMPLATE。
11. 不要输出 BRUTE 或 VALIDATOR；系统会在一次全新的、看不到 ORACLE 实现的独立调用中生成验证器，降低两份算法共享同一错误的风险。

输出必须使用以下原文分节，禁止代码围栏、JSON 外壳或额外说明（不适用的可选节直接省略）：
@@@META@@@
problemType: traditional 或 function
isFillIn: false
functionName: 函数题函数名（传统题省略）
@@@ANALYSIS@@@
逐行说明唯一的原始 stdin 编码、约束与覆盖策略（不超过 300 字；后续独立验证器只依赖这里对齐输入格式）
@@@GENERATOR@@@
完整 Python 3 输入生成器
@@@ORACLE@@@
完整 Python 3 标程（stdin → stdout，正解算法）
@@@SOLUTION@@@
函数题：学生提交形式的函数/类实现（传统题省略）
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

export function buildSandboxBlueprintUserPrompt(params: BuildUserPromptParams): string {
  return buildTestdataUserPrompt(params).replace(
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
): string {
  return `你是一位独立的 OJ 题目验证专家。你只根据题面与已经确定的 stdin 编码，编写与正解实现隔离的验证制品。你看不到 ORACLE 源码，也不得猜测、复述或要求它。

核心规则：
1. BRUTE 必须是自包含 Python 3 完整程序，读取一份原始 stdin 并输出题目答案。使用最朴素、最容易审查的枚举/模拟算法，不追求大规模性能，不得省略任何输出格式细节。
2. STRESS_GENERATOR 必须是自包含 Python 3 程序，不读 stdin，stdout 只打印紧凑 JSON：{"cases":[{"label":"覆盖意图","input":"原始标准输入"}]}。编写 STRESS_GENERATOR 前，先在代码注释中逐条列出题面的所有硬性保证（如“根至少有两个孩子”“保证按 DFS 序编号”），生成逻辑必须逐条满足；任何一条违反都会导致整体失败。
3. STRESS_GENERATOR 必须恰好生成 ${stressCaseCount} 组小数据，至少 ${Math.ceil(stressCaseCount * TESTDATA_GEN_LIMITS.STRESS_MIN_UNIQUE_RATIO)} 组 input 互不相同，禁止复制输入凑数；全部能让 BRUTE 在 5 秒内独立完成。混合穷举边界、固定种子随机、重复值、退化结构和容易触发错误算法的反例。不得复制正式测试点，也不得生成大规模性能数据。
4. VALIDATOR 必须是自包含 Python 3 程序，读取一份 input，严格校验格式和题面约束；合法时静默 exit 0，非法时向 stderr 说明并 exit 1。题面中每一条“保证/约定”都必须成为一条显式校验；宁可过严拒绝，不可放过违规输入。不得无条件成功。
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
): string {
  const statement = params.statementMarkdown.length > TESTDATA_GEN_LIMITS.MAX_STATEMENT_LENGTH
    ? `${params.statementMarkdown.slice(0, TESTDATA_GEN_LIMITS.MAX_STATEMENT_LENGTH)}\n...（题面过长已截断）`
    : params.statementMarkdown;
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
export function buildKillTargetsSystemPrompt(): string {
  return `你是一位 OJ 错误解分析专家。请根据题面与既有解法分析，构造最可能出现在学生提交中的典型错误解，用于检验测试数据能否区分正确与错误程序。

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
}): string {
  const statement = input.statement.slice(0, 6000);
  const analysis = input.analysis.slice(0, 2000);
  const samples = input.samples.slice(0, 3);
  return [
    '【既有解法分析】',
    analysis || '未提供额外分析，请从题面推导常见错误模式。',
    '',
    '【题面（最多 6000 字符）】',
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
    '请选择最可能的 2 种不同错误模式，并严格按分节格式输出。',
  ].join('\n');
}

/** 函数题错误解提示必须复用已通过第一阶段验证的原始 stdin 转码。 */
export function buildKillTargetPromptSamples(
  solution: Pick<SandboxSolutionBlueprint, 'problemType' | 'functionSampleInputs'>,
  statementSamples: StatementSample[],
): SampleIO[] {
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
}): string {
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
  let solutionCode = '';
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
    else if (kind === 'SOLUTION') solutionCode = content;
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
    functionName: meta.functionName || undefined,
    templates: problemType === 'function' ? templates : undefined,
    generatorCode: normalizeExecutableContent(generatorCode),
    oracleCode: normalizeExecutableContent(oracleCode),
    // SOLUTION/BRUTE/VALIDATOR 均可缺失（宽容）；缺失后果在 verification 中体现
    solutionCode: solutionCode.trim() ? normalizeExecutableContent(solutionCode) : undefined,
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
  let solutionCode = '';
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
    else if (kind === 'SOLUTION') solutionCode = content;
  }
  const returnedType = meta.problemType === 'function' ? 'function'
    : meta.problemType === 'traditional' ? 'traditional'
      : null;
  if (!returnedType) throw new Error('AI 解题蓝图的 problemType 非法（应为 function 或 traditional）');
  const problemType = options.problemKind === 'auto' ? returnedType : options.problemKind;
  if (!oracleCode.trim()) throw new Error('AI 解题蓝图未返回可执行的 ORACLE');
  if (problemType === 'function' && !solutionCode.trim()) {
    throw new Error('AI 解题蓝图未返回函数题学生提交形式的 SOLUTION');
  }
  const fillInMode = options.fillInMode || 'auto';
  return {
    problemType,
    isFillIn: fillInMode === 'yes' ? true
      : fillInMode === 'no' ? false
        : meta.isFillIn?.toLowerCase() === 'true',
    analysis,
    functionName: meta.functionName || undefined,
    oracleCode: normalizeExecutableContent(oracleCode),
    solutionCode: solutionCode.trim() ? normalizeExecutableContent(solutionCode) : undefined,
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

export interface StatementSample {
  id: string;
  input: string;
  output: string;
}

/**
 * 提取题面样例：优先支持 Hydro 的 inputN/outputN 围栏，同时覆盖常见的
 * LeetCode 单行“输入：... / 输出：...”展示。后者仍是逻辑参数展示，函数题
 * 必须再由独立验证调用转换为主蓝图约定的原始 stdin，不能直接写入 .in。
 */
export function extractStatementSamples(statementMarkdown: string): StatementSample[] {
  const inputs: Array<{ id: string; content: string }> = [];
  const outputs: Array<{ id: string; content: string }> = [];
  const fenceRe = /```(input|output)(\d*)[^\n]*\r?\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(statementMarkdown)) !== null) {
    let content = match[3].replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (content.endsWith('\n')) content = content.slice(0, -1);
    const entry = { id: match[2], content: normalizeFileContent(content) };
    if (match[1].toLowerCase() === 'input') inputs.push(entry);
    else outputs.push(entry);
  }

  const samples = inputs.flatMap((input, index) => {
    const output = input.id
      ? outputs.find(candidate => candidate.id === input.id)
      : outputs[index];
    return output ? [{ id: input.id || String(index + 1), input: input.content, output: output.content }] : [];
  });

  const normalized = statementMarkdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const inputLineRe = /^\s*(?:输入|Input)\s*[:：]\s*(\S[\s\S]*?)\s*$/i;
  const outputLineRe = /^\s*(?:输出|Output)\s*[:：]\s*(\S[\s\S]*?)\s*$/i;
  for (let i = 0; i < lines.length; i++) {
    const inputMatch = lines[i].match(inputLineRe);
    if (!inputMatch) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (inputLineRe.test(lines[j])) break;
      const outputMatch = lines[j].match(outputLineRe);
      if (!outputMatch) continue;
      const input = normalizeFileContent(inputMatch[1].replace(/^`([\s\S]*)`$/, '$1'));
      const output = normalizeFileContent(outputMatch[1].replace(/^`([\s\S]*)`$/, '$1'));
      const duplicate = samples.some(sample =>
        comparableFileContent(sample.input) === comparableFileContent(input)
        && comparableFileContent(sample.output) === comparableFileContent(output));
      if (!duplicate) {
        samples.push({ id: String(samples.length + 1), input, output });
      }
      i = j;
      break;
    }
  }

  return samples;
}

function comparableFileContent(content: string): string {
  return content
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .trimEnd();
}

/** 根据沙箱逐点结果判定正式数据是否能够卡掉错误解靶子。 */
export function evaluateDiscrimination(inputs: {
  targetRuns: Array<{
    kind: DiscriminationTargetResult['kind'];
    description: string;
    perCase: Array<{ accepted: boolean; timedOut: boolean; stdout: string }>;
  }>;
  oracleOutputs: string[];
  customChecker: boolean;
}): DiscriminationCheck {
  const targets = inputs.targetRuns.map((target): DiscriminationTargetResult => {
    if (inputs.customChecker && target.kind !== 'brute-complexity') {
      return {
        kind: target.kind,
        description: target.description,
        killed: false,
        skippedReason: 'custom-checker',
      };
    }

    for (let index = 0; index < target.perCase.length; index++) {
      const detail = target.perCase[index];
      if (detail.timedOut) {
        return {
          kind: target.kind,
          description: target.description,
          killed: true,
          killedBy: 'tle',
          killedByCase: index + 1,
        };
      }
      if (!detail.accepted) {
        return {
          kind: target.kind,
          description: `${target.description}(运行失败)`,
          killed: true,
          killedBy: 'wa',
          killedByCase: index + 1,
        };
      }
      if (
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
    return {
      kind: target.kind,
      description: target.description,
      killed: false,
    };
  });
  const countedTargets = targets.filter(target => !target.skippedReason);
  return {
    targets,
    allKilled: countedTargets.length > 0 && countedTargets.every(target => target.killed),
  };
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
    throw new Error('GENERATOR 输出超过 1MB 上限');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch (err) {
    throw new Error(`GENERATOR stdout 不是有效 JSON：${err instanceof Error ? err.message : String(err)}`);
  }
  const rawCases = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object' ? (parsed as { cases?: unknown }).cases : undefined);
  if (!Array.isArray(rawCases)) throw new Error('GENERATOR JSON 缺少 cases 数组');
  if (rawCases.length !== expectedCount) {
    throw new Error(`GENERATOR 生成 ${rawCases.length} 个测试点，期望 ${expectedCount} 个`);
  }

  return rawCases.map((item, index) => {
    if (!item || typeof item !== 'object' || typeof (item as { input?: unknown }).input !== 'string') {
      throw new Error(`GENERATOR 的第 ${index + 1} 个测试点缺少 input 字符串`);
    }
    const input = normalizeFileContent((item as { input: string }).input);
    if (Buffer.byteLength(input, 'utf8') > TESTDATA_GEN_LIMITS.MAX_FILE_SIZE) {
      throw new Error(`GENERATOR 的第 ${index + 1} 个 .in 超过 256KB 上限`);
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
  const onUserAbort = () => controller.abort();

  if (userSignal?.aborted) {
    controller.abort();
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
      const passed = details.every((detail, index) => (
        detail.accepted
        && !detail.timedOut
        && (
          input.customChecker
          || comparableFileContent(detail.stdout)
            === comparableFileContent(input.samples[index].output)
        )
      ));
      if (passed) validTargets.push(target);
    } catch (err) {
      if (isCancellation(err)) throw err;
      // 单个靶子烟测失败仅丢弃该靶子，不影响正确性管线和其余靶子。
    }
  }
  return validTargets;
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
): Promise<{ total: number; passed: number }> {
  const statementSamples = extractStatementSamples(statementMarkdown);
  if (statementSamples.length === 0) return { total: 0, passed: 0 };
  let samples = statementSamples;
  if (solution.problemType === 'function') {
    const converted = new Map((solution.functionSampleInputs || []).map(sample => [sample.id, sample.input]));
    const missing = statementSamples.find(sample => !converted.has(sample.id));
    if (missing) throw new Error(`解题蓝图缺少函数题样例 ${missing.id} 的 stdin 转码`);
    samples = statementSamples.map(sample => ({
      ...sample,
      input: normalizeFileContent(converted.get(sample.id) as string),
    }));
  }
  let results: PythonRunDetail[];
  try {
    results = await runner.runPythonBatchDetailed(
      solution.oracleCode,
      samples.map(sample => sample.input),
      { signal },
    );
  } catch (err) {
    if (isCancellation(err)) throw err;
    throw new Error(`ORACLE 样例预验证执行失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (results.length !== samples.length) {
    throw new Error(`ORACLE 样例预验证返回 ${results.length} 个结果，期望 ${samples.length} 个`);
  }
  const acceptedRecord = options.providedStdSource === 'accepted-record';
  for (let i = 0; i < results.length; i++) {
    const detail = results[i];
    const prefix = acceptedRecord ? 'AC 候选标程' : 'ORACLE';
    if (!detail.accepted) {
      throw new Error(
        `${prefix}未通过第一阶段题面样例 ${samples[i].id} 的执行预验证（${detail.status || 'Unknown'}）\n`
        + `输入：${excerpt(samples[i].input, 300)}\n`
        + `错误：${excerptTail(detail.stderr || detail.error || '', 1000)}`,
      );
    }
    if (!customChecker
      && comparableFileContent(detail.stdout) !== comparableFileContent(samples[i].output)) {
      throw new Error(
        `${prefix}未通过第一阶段题面样例 ${samples[i].id}`
        + `：期望 ${JSON.stringify(comparableFileContent(samples[i].output))}`
        + `，实际 ${JSON.stringify(comparableFileContent(detail.stdout))}`,
      );
    }
  }
  return { total: samples.length, passed: samples.length };
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
    if (input.customChecker && target.kind !== 'brute-complexity') {
      results.push({
        kind: target.kind,
        description: target.description,
        killed: false,
        skippedReason: 'custom-checker',
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
      const evaluated = evaluateDiscrimination({
        targetRuns: [{
          kind: target.kind,
          description: target.description,
          perCase: details,
        }],
        oracleOutputs: selectedCases.map(item => item.output),
        customChecker: input.customChecker,
      }).targets[0];
      if (evaluated?.killedByCase) {
        evaluated.killedByCase = target.caseIndices[evaluated.killedByCase - 1] + 1;
      }
      if (evaluated) results.push(evaluated);
    } catch (err) {
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
  const countedTargets = results.filter(target => !target.skippedReason);
  return {
    targets: results,
    allKilled: input.killTargets.length > 0
      && countedTargets.length > 0
      && countedTargets.every(target => target.killed),
  };
}

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
): Promise<GenerationResponse> {
  const startedAt = Date.now();
  const sandboxDeadlineAt = startedAt + SANDBOX_TOTAL_BUDGET_MS;
  const reportProgress = (stage: TestdataGenerationProgressStage, percent: number) => {
    try { onProgress?.(stage, percent); } catch { /* progress is best-effort */ }
  };
  const providedStd = options.providedStd?.trim();
  const usingAcceptedRecordCandidate = !!providedStd
    && options.providedStdSource === 'accepted-record';
  if (usingAcceptedRecordCandidate && customChecker) {
    throw new Error('AC 候选标程无法在自定义 checker 题中完成独立文本验证，请改用教师审核后的手动标程或取消选择');
  }
  const coveragePlan = buildCoveragePlan(options.caseCount, options.dataScale || 'auto');
  const checkBudget = () => {
    if (Date.now() >= sandboxDeadlineAt) {
      throw new Error('沙箱执行总时长超出预算，请减少测试点数量后重试');
    }
  };

  // a. GENERATOR 实跑 → 解析出全部 .in
  reportProgress('generating_inputs', 56);
  let generatorResult: PythonRunResult;
  try {
    generatorResult = await runner.runPython(blueprint.generatorCode, '', signal, sandboxDeadlineAt);
  } catch (err) {
    if (isCancellation(err)) throw err;
    throw new Error(`GENERATOR 实跑失败：${err instanceof Error ? err.message : String(err)}`);
  }
  const generatedInputs = parseGeneratorOutput(generatorResult.stdout, options.caseCount);
  const inputs = generatedInputs.map(item => item.input);

  // b. 函数题伪 stdin 检查（源码赋值写法拦截）
  if (blueprint.problemType === 'function') {
    const placeholderCases = generatedInputs.map(item => ({ ...item, output: '' }));
    const assignment = findAssignmentStyleCaseInput(placeholderCases);
    if (assignment) {
      throw new Error(`第 ${assignment.caseNumber} 个 .in 仍是源码赋值写法：${assignment.line}`);
    }
  }

  // c. 独立 STRESS_GENERATOR：内部小数据只用于验证，不进入最终文件计划。
  let stressInputs: string[] = [];
  let stressGenerated: GeneratedInputCase[] = [];
  let stressGeneratedCount = 0;
  let stressUniqueInputs = 0;
  let stressDuplicateInputs = 0;
  let stressDroppedInvalid = 0;
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
      throw new Error(`STRESS_GENERATOR 实跑失败：${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      stressGenerated = parseGeneratorOutput(
        stressGeneratorResult.stdout,
        TESTDATA_GEN_LIMITS.STRESS_CASES,
      );
    } catch (err) {
      throw new Error(`STRESS_GENERATOR 输出无效：${err instanceof Error ? err.message : String(err)}`);
    }
    stressGeneratedCount = stressGenerated.length;
    stressInputs = stressGenerated.map(item => item.input);
    stressUniqueInputs = new Set(stressInputs.map(comparableFileContent)).size;
    stressDuplicateInputs = stressInputs.length - stressUniqueInputs;
    const minimumUnique = Math.ceil(
      stressInputs.length * TESTDATA_GEN_LIMITS.STRESS_MIN_UNIQUE_RATIO,
    );
    if (stressUniqueInputs < minimumUnique) {
      throw new Error(
        `STRESS_GENERATOR 压力数据多样性不足：${stressInputs.length} 组中仅 ${stressUniqueInputs} 组 input 唯一`
        + `，至少需要 ${minimumUnique} 组；禁止用重复输入凑数`,
      );
    }
    if (blueprint.problemType === 'function') {
      const assignment = findAssignmentStyleCaseInput(
        stressGenerated.map(item => ({ ...item, output: '' })),
      );
      if (assignment) {
        throw new Error(`压力对拍第 ${assignment.caseNumber} 个 .in 仍是源码赋值写法：${assignment.line}`);
      }
    }
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
    if (missingSample) throw new Error(`函数题样例 ${missingSample.id} 缺少独立 stdin 转码`);
    samples = statementSamples.map(sample => ({
      ...sample,
      input: normalizeFileContent(convertedById.get(sample.id) as string),
    }));
    const assignment = findAssignmentStyleCaseInput(
      samples.map(sample => ({ input: sample.input, output: sample.output })),
    );
    if (assignment) {
      throw new Error(`函数题样例 ${samples[assignment.caseNumber - 1].id} 转码后仍是源码赋值写法：${assignment.line}`);
    }
  }
  const sampleInputs = samples.map(sample => sample.input);

  // d. VALIDATOR：正式输入与题面样例仍逐项硬失败；压力输入允许在保底比例内剔除。
  let validatorRan = false;
  const validationInputs = [...inputs, ...sampleInputs, ...stressInputs];
  if (blueprint.validatorCode) {
    reportProgress('validating_inputs', 66);
    checkBudget();
    const validatorResults = await runner.runPythonBatchDetailed(
      blueprint.validatorCode,
      validationInputs,
      { signal, deadlineAt: sandboxDeadlineAt },
    );
    if (validatorResults.length !== validationInputs.length) {
      throw new Error(`VALIDATOR 返回 ${validatorResults.length} 个结果，期望 ${validationInputs.length} 个`);
    }
    const formalAndSampleCount = inputs.length + samples.length;
    for (let i = 0; i < formalAndSampleCount; i++) {
      const detail = validatorResults[i];
      if (!detail.accepted) {
        const target = i < inputs.length
          ? `第 ${i + 1} 个 .in `
          : `${blueprint.problemType === 'function' ? '函数题' : '题面'}样例 ${samples[i - inputs.length].id} `;
        throw new Error(`${target}未通过输入校验：${excerpt(detail.stderr || detail.error || detail.status, 300)}`);
      }
    }
    const stressPartition = partitionStressValidation({
      stressResults: validatorResults.slice(formalAndSampleCount),
      minValidRatio: TESTDATA_GEN_LIMITS.STRESS_MIN_VALID_RATIO,
    });
    if (!stressPartition.sufficient) {
      const firstDropped = stressPartition.dropped[0];
      throw new Error(
        `第 ${firstDropped.index + 1} 个压力 .in 未通过输入校验：`
        + excerpt(firstDropped.reason, 300),
      );
    }
    stressDroppedInvalid = stressPartition.dropped.length;
    stressInputs = stressPartition.keptIndices.map(index => stressInputs[index]);
    stressGenerated = stressPartition.keptIndices.map(index => stressGenerated[index]);
    validatorRan = true;
  }

  // e. ORACLE：一次批量跑正式输入、题面样例和内部压力输入。
  reportProgress('running_oracle', 72);
  checkBudget();
  const allInputs = [...inputs, ...sampleInputs, ...stressInputs];
  let oracleResults: PythonRunDetail[];
  try {
    oracleResults = await runner.runPythonBatchDetailed(
      blueprint.oracleCode,
      allInputs,
      { signal, deadlineAt: sandboxDeadlineAt },
    );
  } catch (err) {
    if (isCancellation(err)) throw err;
    throw new Error(`ORACLE（标程）实跑失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (oracleResults.length !== allInputs.length) {
    throw new Error(`ORACLE（标程）返回 ${oracleResults.length} 个结果，期望 ${allInputs.length} 个`);
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
    throw new Error(
      `${usingAcceptedRecordCandidate ? 'AC 候选标程' : 'ORACLE（标程）'}在${target}上执行失败（${detail.status || 'Unknown'}）\n`
      + `输入：${excerpt(allInputs[i] ?? '', 300) || '（空）'}\n`
      + `错误：${excerptTail(detail.stderr || detail.error || `exitStatus=${detail.exitStatus ?? 'unknown'}`, 1000)}`,
    );
  }

  const cases = generatedInputs.map((item, index) => {
    const output = normalizeFileContent(oracleResults[index].stdout);
    if (Buffer.byteLength(output, 'utf8') > TESTDATA_GEN_LIMITS.MAX_FILE_SIZE) {
      throw new Error(`ORACLE 为第 ${index + 1} 个测试点生成的 .out 超过 256KB 上限`);
    }
    return { ...item, output, dataScale: coveragePlan[index]?.dataScale };
  });
  for (let i = 0; i < samples.length && !customChecker; i++) {
    const actual = oracleResults[inputs.length + i]?.stdout || '';
    if (comparableFileContent(actual) !== comparableFileContent(samples[i].output)) {
      throw new Error(
        `${usingAcceptedRecordCandidate ? 'AC 候选标程' : 'ORACLE'}未通过${blueprint.problemType === 'function' ? '函数题' : '题面'}样例 ${samples[i].id}`
        + `（stdin：${JSON.stringify(comparableFileContent(samples[i].input))}）`
        + `：期望 ${JSON.stringify(comparableFileContent(samples[i].output))}`
        + `，实际 ${JSON.stringify(comparableFileContent(actual))}`,
      );
    }
  }

  // f. 函数题：solution + template.py 组合实跑，验证模板与输入编码
  let pyTemplateExecuted = false;
  let templateCheck: PlanVerification['templateCheck'];
  if (
    blueprint.problemType === 'function'
    && options.languages.includes('py')
    && blueprint.solutionCode
    && blueprint.templates?.py
  ) {
    reportProgress('checking_templates', 79);
    checkBudget();
    const combined = `${blueprint.solutionCode}\n${blueprint.templates.py}`;
    const templateInputs = [...inputs, ...sampleInputs];
    const templateResults = await runner.runPythonBatchDetailed(
      combined,
      templateInputs,
      { signal, deadlineAt: sandboxDeadlineAt },
    );
    if (templateResults.length !== templateInputs.length) {
      throw new Error(`template.py 返回 ${templateResults.length} 个结果，期望 ${templateInputs.length} 个`);
    }
    let passed = 0;
    const skippedTimeout: number[] = [];
    for (let i = 0; i < templateResults.length; i++) {
      const detail = templateResults[i];
      const caseNo = i + 1;
      if (detail.timedOut) {
        skippedTimeout.push(caseNo);
        continue;
      }
      const expectedOutput = i < inputs.length
        ? cases[i].output
        : oracleResults[i]?.stdout || '';
      if (detail.accepted && comparableFileContent(detail.stdout) === comparableFileContent(expectedOutput)) {
        passed++;
        continue;
      }
      const target = i < inputs.length
        ? `第 ${caseNo} 个测试点`
        : `函数题样例 ${samples[i - inputs.length].id}`;
      throw new Error(
        `template.py 与标程在${target}不一致\n`
        + `输入：${excerpt(templateInputs[i], 300)}\n`
        + `模板输出：${excerpt(detail.stdout || detail.stderr || detail.status, 300)}\n`
        + `标程输出：${excerpt(expectedOutput, 300)}`,
      );
    }
    pyTemplateExecuted = true;
    templateCheck = { lang: 'py', total: templateInputs.length, passed, skippedTimeout };
  }

  // g. 独立 BRUTE 优先跑内部小数据；兼容旧蓝图时回退到正式测试点。
  const oracleMatchesProvidedStd = !!(
    providedStd
    && blueprint.problemType === 'traditional'
    && detectStdFilename(providedStd) === 'std.py'
    && comparableFileContent(blueprint.oracleCode) === comparableFileContent(normalizeExecutableContent(providedStd))
  );
  const oracleIsAcceptedRecord = oracleMatchesProvidedStd
    && options.providedStdSource === 'accepted-record';
  const oracleIsManualStd = oracleMatchesProvidedStd && !oracleIsAcceptedRecord;
  let bruteCheck: PlanVerification['bruteCheck'];
  let stressCheck: PlanVerification['stressCheck'];
  if (oracleIsAcceptedRecord && (!blueprint.bruteCode || stressInputs.length === 0)) {
    throw new Error('AC 候选标程缺少独立 BRUTE 小数据压力验证，不能作为本次 .out 的依据');
  }
  if (blueprint.bruteCode && stressInputs.length > 0) {
    reportProgress('stress_testing', 84);
    if (customChecker) {
      checkBudget();
      const bruteResults = await runner.runPythonBatchDetailed(
        blueprint.bruteCode,
        stressInputs,
        { signal, deadlineAt: sandboxDeadlineAt },
      );
      if (bruteResults.length !== stressInputs.length) {
        throw new Error(`压力对拍 BRUTE 返回 ${bruteResults.length} 个结果，期望 ${stressInputs.length} 个`);
      }
      for (let i = 0; i < bruteResults.length; i++) {
        const detail = bruteResults[i];
        if (detail.timedOut) {
          throw new Error(`压力对拍 BRUTE 在第 ${i + 1} 组小数据超时；压力阶段不允许跳过`);
        }
        if (!detail.accepted) {
          throw new Error(`压力对拍 BRUTE 在第 ${i + 1} 组小数据执行失败：${excerpt(detail.stderr || detail.error || detail.status, 300)}`);
        }
      }
      stressCheck = {
        generated: stressGeneratedCount,
        uniqueInputs: stressUniqueInputs,
        duplicateInputs: stressDuplicateInputs,
        compared: 0,
        agreed: 0,
        ...(stressDroppedInvalid > 0 ? { droppedInvalid: stressDroppedInvalid } : {}),
        skippedReason: 'custom-checker',
      };
    } else {
      checkBudget();
      const bruteResults = await runner.runPythonBatchDetailed(
        blueprint.bruteCode,
        stressInputs,
        { signal, deadlineAt: sandboxDeadlineAt },
      );
      if (bruteResults.length !== stressInputs.length) {
        throw new Error(`压力对拍 BRUTE 返回 ${bruteResults.length} 个结果，期望 ${stressInputs.length} 个`);
      }
      const stressOracleOffset = inputs.length + samples.length;
      for (let i = 0; i < bruteResults.length; i++) {
        const detail = bruteResults[i];
        const caseNo = i + 1;
        if (detail.timedOut) {
          throw new Error(`压力对拍 BRUTE 在第 ${caseNo} 组小数据超时；压力阶段不允许跳过`);
        }
        if (!detail.accepted) {
          throw new Error(`压力对拍 BRUTE 在第 ${caseNo} 组小数据执行失败：${excerpt(detail.stderr || detail.error || detail.status, 300)}`);
        }
        const oracleOutput = oracleResults[stressOracleOffset + i]?.stdout || '';
        if (comparableFileContent(detail.stdout) !== comparableFileContent(oracleOutput)) {
          if (oracleIsAcceptedRecord) {
            throw new Error(
              `AC 候选标程与独立 BRUTE 在第 ${caseNo} 组小数据不一致（${stressGenerated[i]?.label || ''}）\n`
              + `输入：${excerpt(stressInputs[i], 300)}\n`
              + `AC 候选输出：${excerpt(oracleOutput, 300)}\n`
              + `独立 BRUTE 输出：${excerpt(detail.stdout, 300)}\n`
              + '该历史 AC 可能由旧测试数据误判，已拒绝使用；系统不会修复 BRUTE 来迁就它。',
            );
          }
          throw new Error(
            `压力对拍 BRUTE 与 ORACLE 在第 ${caseNo} 组小数据不一致（${stressGenerated[i]?.label || ''}）\n`
            + `输入：${excerpt(stressInputs[i], 300)}\n`
            + `ORACLE 输出：${excerpt(oracleOutput, 300)}\n`
            + `BRUTE 输出：${excerpt(detail.stdout, 300)}`,
          );
        }
      }
      stressCheck = {
        generated: stressGeneratedCount,
        uniqueInputs: stressUniqueInputs,
        duplicateInputs: stressDuplicateInputs,
        compared: stressInputs.length,
        agreed: stressInputs.length,
        ...(stressDroppedInvalid > 0 ? { droppedInvalid: stressDroppedInvalid } : {}),
      };
    }
  } else if (blueprint.bruteCode) {
    reportProgress('stress_testing', 84);
    checkBudget();
    const bruteResults = await runner.runPythonBatchDetailed(
      blueprint.bruteCode,
      inputs,
      { signal, deadlineAt: sandboxDeadlineAt },
    );
    if (bruteResults.length !== inputs.length) {
      throw new Error(`暴力解返回 ${bruteResults.length} 个结果，期望 ${inputs.length} 个`);
    }
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
        throw new Error(`暴力解在第 ${caseNo} 个测试点执行失败：${excerpt(detail.stderr || detail.error || detail.status, 300)}`);
      }
      if (comparableFileContent(detail.stdout) === comparableFileContent(cases[i].output)) {
        agreed++;
        continue;
      }
      if (oracleIsAcceptedRecord) {
        throw new Error(
          `AC 候选标程与独立暴力解在第 ${caseNo} 个测试点不一致，已拒绝使用该历史 AC`,
        );
      }
      // 教师手动 std 或自定义 checker 是权威：文本不一致只记录复核，不误判为生成失败。
      if (oracleIsManualStd || customChecker) {
        disagreed.push(caseNo);
        continue;
      }
      throw new Error(
        `暴力解与标程在第 ${caseNo} 个测试点不一致（${generatedInputs[i].label || ''}）\n`
        + `输入：${excerpt(inputs[i], 300)}\n`
        + `标程输出：${excerpt(cases[i].output, 300)}\n`
        + `暴力输出：${excerpt(detail.stdout, 300)}`,
      );
    }
    bruteCheck = { compared: inputs.length, agreed, skippedTimeout, disagreed };
  }

  reportProgress('discrimination_testing', 90);
  const discriminationDeadlineAt = Date.now() + DISCRIMINATION_BUDGET_MS;
  const discriminationKillTargets = await smokeTestKillTargets({
    killTargets,
    samples: samples.map(sample => ({ input: sample.input, output: sample.output })),
    runner,
    signal,
    customChecker,
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
    deadlineAt: discriminationDeadlineAt,
  });

  const verification: PlanVerification = {
    mode: 'sandbox',
    oracleKind: oracleIsAcceptedRecord
      ? 'accepted-record'
      : oracleIsManualStd ? 'provided-std' : 'ai-solution',
    validator: { ran: validatorRan, casesChecked: validatorRan ? validationInputs.length : 0 },
  };
  if (!customChecker && (blueprint.problemType === 'traditional' || samples.length > 0)) {
    // 样例不一致已在上面抛出，走到这里即全部通过
    verification.sampleCheck = { total: samples.length, passed: samples.length };
  }
  if (bruteCheck) verification.bruteCheck = bruteCheck;
  if (stressCheck) verification.stressCheck = stressCheck;
  if (templateCheck) verification.templateCheck = templateCheck;
  verification.discrimination = discrimination;

  const noteParts: Array<string | undefined> = [blueprint.notes];
  const noteWarnings: string[] = [];
  const noteSystem: string[] = [];
  const appendNote = (kind: 'warning' | 'system', note: string) => {
    noteParts.push(note);
    (kind === 'warning' ? noteWarnings : noteSystem).push(note);
  };
  appendNote('system', '测试输入由生成器产生，所有 .out 已在 Hydro 沙箱中实际运行 Python 标程生成。');
  if (blueprint.problemType === 'function' && samples.length > 0) {
    appendNote('system', `已由独立验证调用将 ${samples.length} 个函数题题面样例转换为原始 stdin，并回归 ORACLE${templateCheck ? ' 与 template.py' : ''}。`);
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
  if (customChecker && samples.length > 0) {
    appendNote('system', '题目使用自定义 checker，已验证标程可运行题面样例，但跳过样例输出的纯文本相等检查。');
  }
  if (stressCheck?.droppedInvalid) {
    appendNote(
      'system',
      `已剔除 ${stressCheck.droppedInvalid} 组未通过输入校验的内部压力数据(仅用于内部对拍,不影响正式测试点)。`,
    );
  }
  if (stressCheck?.skippedReason === 'custom-checker') {
    appendNote('system', '题目使用自定义 checker，内部小数据已生成并通过输入校验，但在 checker 实跑支持完成前跳过纯文本压力对拍。');
  } else if (stressCheck && stressCheck.compared > 0) {
    appendNote(
      'system',
      `已使用独立生成的 BRUTE 在 ${stressCheck.compared} 组内部小数据上完成压力对拍，全部一致；`
      + `其中 ${stressCheck.uniqueInputs} 组 input 唯一，重复 ${stressCheck.duplicateInputs} 组。`,
    );
  }
  if (bruteCheck && bruteCheck.skippedTimeout.length > 0) {
    appendNote('warning', `暴力解在测试点 ${bruteCheck.skippedTimeout.join('、')} 超时，已跳过对拍。`);
  }
  if (templateCheck && templateCheck.skippedTimeout.length > 0) {
    appendNote('warning', `模板实跑在测试点 ${templateCheck.skippedTimeout.join('、')} 超时，已跳过。`);
  }

  return {
    problemType: blueprint.problemType,
    isFillIn: blueprint.isFillIn,
    analysis: blueprint.analysis,
    functionName: blueprint.functionName,
    templates: blueprint.templates,
    stdSolution: { language: 'python', code: blueprint.oracleCode },
    generatorCode: blueprint.generatorCode,
    oracleCode: blueprint.oracleCode,
    solutionCode: blueprint.solutionCode,
    bruteCode: blueprint.bruteCode,
    validatorCode: blueprint.validatorCode,
    verification,
    discriminationDeadlineAt,
    discriminationKillTargets,
    pyTemplateExecuted,
    cases,
    notes: noteParts.filter(Boolean).join('\n'),
    notesStructured: {
      warnings: noteWarnings,
      system: noteSystem,
      ...(blueprint.notes ? { ai: blueprint.notes } : {}),
    },
  };
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
  context: { mode?: 'sandbox' | 'direct'; existingFiles?: string[]; existingConfig?: string } = {},
): GenerationPlan {
  const sandbox = context.mode === 'sandbox';
  const dataOrigin: PlannedFileOrigin = sandbox ? 'executed' : 'ai-only';
  const files: PlannedFile[] = [];
  const caseCount = response.cases.length;
  const coveragePlan = buildCoveragePlan(caseCount, options.dataScale || 'auto');
  const newCaseNumbers = allocateCaseNumbers(context.existingFiles, caseCount);
  const existingComplete = getExistingNumericCases(context.existingFiles).complete;
  const configCaseNumbers = [...new Set([...existingComplete, ...newCaseNumbers])].sort((a, b) => a - b);
  const discriminationNotes = buildDiscriminationNotes(
    response.verification?.discrimination,
    response.discriminationInitialCaseCount ?? response.cases.length,
    newCaseNumbers,
  );
  const notes = [response.notes, ...discriminationNotes].filter(Boolean).join('\n') || undefined;
  const sourceNotesStructured = response.notesStructured ?? {
    warnings: [],
    system: [],
    ...(response.notes ? { ai: response.notes } : {}),
  };
  const notesStructured: StructuredGenerationNotes = {
    warnings: [
      ...sourceNotesStructured.warnings,
      ...discriminationNotes.filter(note => note.startsWith('警告:')),
    ],
    system: [
      ...sourceNotesStructured.system,
      ...discriminationNotes.filter(note => !note.startsWith('警告:')),
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
        // template.py 走过步骤 e（solution+模板实跑）才算 executed，其余语言维持 AI 自证
        const origin: PlannedFileOrigin = lang === 'py' && sandbox && response.pyTemplateExecuted
          ? 'executed'
          : 'ai-only';
        pushCode(TEMPLATE_FILENAMES[lang], content, 'template', origin, FILE_PURPOSES.template);
      }
    }
    files.push({ name: 'compile.sh', content: buildCompileSh(options.languages), kind: 'compile', origin: 'deterministic' });
  }

  if (response.generatorCode?.trim()) {
    pushCode('generator.py', response.generatorCode, 'generator', 'executed', FILE_PURPOSES.generator);
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
      origin: options.providedStdSource === 'accepted-record' && sandbox ? 'executed' : 'deterministic',
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
      pushCode(
        'std.py', stdContent, 'std', sandbox ? 'executed' : 'ai-only',
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
    content: buildConfigYaml({
      problemType: response.problemType,
      caseCount: configCaseNumbers.length,
      languages: options.languages,
      caseNumbers: configCaseNumbers,
      existingConfig: context.existingConfig,
    }),
    kind: 'config',
    origin: 'deterministic',
  });

  return {
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
      target: item.label || coveragePlan[index]?.guidance || '',
    })),
    ...(verification ? { verification } : {}),
  };
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
  const autoDetectedFunction = options.problemKind === 'auto' && isLikelyFunctionProblem(statementMarkdown);
  const problemType: 'function' | 'traditional' = options.problemKind === 'function' || autoDetectedFunction
    ? 'function'
    : 'traditional';
  const files: PlannedFile[] = [];
  const caseNumbers = allocateCaseNumbers(existingFiles, options.caseCount);
  const existingComplete = getExistingNumericCases(existingFiles).complete;
  const configCaseNumbers = [...new Set([...existingComplete, ...caseNumbers])].sort((a, b) => a - b);
  const coveragePlan = buildCoveragePlan(options.caseCount, options.dataScale || 'auto');

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
    content: buildConfigYaml({
      problemType,
      caseCount: configCaseNumbers.length,
      languages: options.languages,
      caseNumbers: configCaseNumbers,
      existingConfig,
    }),
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

  return {
    problemType,
    analysis: '骨架模式：仅生成结构性文件（评测配置、编译脚本、模板骨架）与空白测试点，不含 AI 生成的数据。',
    notes: noteParts.join(''),
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

export type SandboxRepairScope = 'generator' | 'stress-generator' | 'function-samples' | 'accepted-std' | 'validator' | 'oracle' | 'brute' | 'template-py' | 'full';

type ChatResult = Awaited<ReturnType<MultiModelClient['chat']>>;

/** 携带匿名模型/阶段信息的业务错误，供遥测判断失败是否与模型相关。 */
export class TestdataGenerationError extends Error {
  readonly telemetryMetadata: Record<string, unknown>;
  readonly recommendDeeperReasoning: boolean;
  readonly chatResults: readonly ChatResult[];

  constructor(
    message: string,
    failureStage: string,
    results: ChatResult[] = [],
    recommendDeeperReasoning = false,
  ) {
    super(message);
    this.name = 'TestdataGenerationError';
    this.recommendDeeperReasoning = recommendDeeperReasoning;
    this.chatResults = [...results];
    const usedModels = [...new Set(results.map(result =>
      `${result.usedModel.endpointName}/${result.usedModel.modelName}`))];
    const lastModel = results[results.length - 1]?.usedModel;
    this.telemetryMetadata = {
      failureStage,
      ...(lastModel ? {
        endpointName: lastModel.endpointName,
        modelName: lastModel.modelName,
      } : {}),
      ...(usedModels.length > 0 ? { usedModels } : {}),
      aiAttemptCount: results.length,
      recommendDeeperReasoning,
    };
  }
}

export function extractTestdataErrorMetadata(err: unknown): Record<string, unknown> | undefined {
  return err instanceof TestdataGenerationError ? err.telemetryMetadata : undefined;
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
  if (/template\.py|模板输出|SOLUTION/.test(detail)) return 'template-py';
  return 'full';
}

export function buildSandboxRepairPrompt(
  error: unknown,
  options: GenerateOptions,
  scope: SandboxRepairScope = classifySandboxRepairScope(error),
): string {
  const templates = options.languages.map(lang => `@@@TEMPLATE:${lang}@@@`).join('、') || '（传统题无需模板）';
  const detail = (error instanceof Error ? error.message : String(error)).slice(0, 1600);
  if (scope === 'generator') {
    return `你上一条蓝图的输入生成阶段未通过 Hydro 沙箱验证：
${detail}

请只输出修复后的 @@@GENERATOR@@@。不要重复 META、ORACLE、SOLUTION、TEMPLATE 或说明文字。要求：
1. stdout 只能是包含恰好 ${options.caseCount} 个 cases 的紧凑 JSON，使用 json.dumps(..., ensure_ascii=False, separators=(',', ':'))。
2. stdout 必须小于 1MB，每个 input 的 UTF-8 内容必须小于 256KB，且全部 .in/.out 与辅助文件合计必须小于 1MB；程序必须在 5 秒内结束，不要打印日志，不要构造超长字符串或无界循环。
3. 每个 input 必须合法且符合逐 CASE 覆盖计划；若临界数据过大，使用能保留边界/复杂度特征的可解析构造。
4. 只使用请求的分节标记和源码原文，不要代码围栏。`;
  }
  if (scope === 'validator') {
    return `你上一条蓝图的输入校验阶段未通过 Hydro 沙箱验证：
${detail}

请同时输出修复后的 @@@GENERATOR@@@ 与 @@@VALIDATOR@@@。先严格依据题面判断是生成输入非法，还是校验器错误地拒绝了合法输入，再修正对应实现；不要通过放弃题面约束、删除校验器或让校验器无条件成功来绕过验证。每个 input 的 UTF-8 内容必须小于 256KB，全部 .in/.out 与辅助文件合计必须小于 1MB。不要输出其他分节、代码围栏或说明文字。`;
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
    return `你上一条蓝图的标程阶段未通过 Hydro 沙箱验证：
${detail}

请只输出修复后的 @@@ORACLE@@@。不要重复 META、GENERATOR、SOLUTION、TEMPLATE 或说明文字。ORACLE 必须通过题面样例、处理所有合法边界且在 5 秒内结束，每个测试点的 stdout UTF-8 内容必须小于 256KB；独立 BRUTE 将由另一调用继续验证。`;
  }
  if (scope === 'brute') {
    return `你上一条蓝图的暴力对拍阶段未通过验证：
${detail}

请只输出修复后的 @@@BRUTE@@@。它必须读取原有 GENERATOR 的同一 stdin 编码，独立实现题意，不得调用或复制 ORACLE 的核心函数。不要输出其他分节或代码围栏。`;
  }
  if (scope === 'template-py') {
    return `你上一条蓝图的 Python 学生解与模板组合未通过验证：
${detail}

请只输出同步修复后的 @@@SOLUTION@@@ 与 @@@TEMPLATE:py@@@。两者必须沿用原有 GENERATOR 的 stdin 编码，拼接运行后的输出与 ORACLE 完全一致。不要输出其他分节或代码围栏。`;
  }
  return `你上一条生成蓝图未通过 Hydro 沙箱验证：
${detail}

请重新输出【完整蓝图】（所有节，不得省略上次已有的节），并针对上述失败修正：
1. GENERATOR stdout 必须只有合法 JSON，cases 恰好 ${options.caseCount} 个；每个 input 是原始 stdin、UTF-8 内容小于 256KB，全部 .in/.out 与辅助文件合计小于 1MB。
2. ACM 题若题面有 T，默认每个 input 使用 T=1 并包含恰好一组完整数据；函数题每个 input 只对应一次调用。
3. ORACLE 必须是可直接运行的 Python 3 完整程序，不得硬编码用例答案，并应通过题面样例；每个测试点的 stdout UTF-8 内容必须小于 256KB。
4. 函数题必须完整包含 SOLUTION（学生提交形式）与全部模板：${templates}。
5. 不要输出 BRUTE、STRESS_GENERATOR 或 VALIDATOR；它们由隔离的独立验证调用生成。
6. 使用 @@@META@@@、@@@GENERATOR@@@、@@@ORACLE@@@、@@@SOLUTION@@@、@@@TEMPLATE:语言@@@ 分节原文，不要代码围栏。`;
}

export function buildIndependentVerifierRepairPrompt(
  error: unknown,
  expectedFunctionSamples: StatementSample[] = [],
): string {
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
  const merged: SandboxGenerationBlueprint = {
    ...original,
    templates: original.templates ? { ...original.templates } : undefined,
  };
  if (scope === 'generator' || scope === 'validator') {
    const generatorCode = repairSectionContent(sections, 'GENERATOR');
    if (!generatorCode) throw new Error('AI 定向修复未返回 GENERATOR');
    merged.generatorCode = generatorCode;
    const validatorCode = repairSectionContent(sections, 'VALIDATOR');
    if (scope === 'validator' && !validatorCode) throw new Error('AI 输入校验修复未返回 VALIDATOR');
    if (validatorCode) merged.validatorCode = validatorCode;
  } else if (scope === 'oracle') {
    const oracleCode = repairSectionContent(sections, 'ORACLE');
    if (!oracleCode) throw new Error('AI 定向修复未返回 ORACLE');
    merged.oracleCode = oracleCode;
    const bruteCode = repairSectionContent(sections, 'BRUTE');
    if (bruteCode) merged.bruteCode = bruteCode;
  } else if (scope === 'brute') {
    const bruteCode = repairSectionContent(sections, 'BRUTE');
    if (!bruteCode) throw new Error('AI 定向修复未返回 BRUTE');
    merged.bruteCode = bruteCode;
  } else {
    const solutionCode = repairSectionContent(sections, 'SOLUTION');
    const templatePy = repairSectionContent(sections, 'TEMPLATE:py');
    if (!solutionCode || !templatePy) throw new Error('AI 定向修复必须同时返回 SOLUTION 与 TEMPLATE:py');
    merged.solutionCode = solutionCode;
    merged.templates = { ...merged.templates, py: templatePy };
  }
  return merged;
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

export interface GenerateTestdataParams {
  problemTitle: string;
  statementMarkdown: string;
  options: GenerateOptions;
  existingFiles?: string[];
  /** 当前题目的 pdoc.config，用于保留 checker/time/memory 等评测设置。 */
  existingConfig?: string;
  /** 服务端规则引擎的填空题初判信号 */
  fillInDetected?: boolean;
  signal?: AbortSignal;
  /** 页面进度事件；回调异常不得影响生成主流程。 */
  onProgress?: (progress: TestdataGenerationProgress) => void;
}

export interface TestdataGenServiceOptions {
  sandboxRunner?: TestdataSandboxRunner;
  mode?: TestdataGenerationMode;
  /** 内部开关：语义失败后最多从下一配置模型重跑一次，防止递归升级。 */
  semanticModelFallback?: boolean;
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

export class TestdataGenService {
  private readonly sandboxRunner?: TestdataSandboxRunner;
  private readonly mode: TestdataGenerationMode;
  private readonly semanticModelFallback: boolean;

  constructor(private aiClient: MultiModelClient, serviceOptions: TestdataGenServiceOptions = {}) {
    this.sandboxRunner = serviceOptions.sandboxRunner;
    this.mode = serviceOptions.mode || (serviceOptions.sandboxRunner ? 'auto' : 'direct');
    this.semanticModelFallback = serviceOptions.semanticModelFallback !== false;
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

  async generate(params: GenerateTestdataParams): Promise<GenerationPlan> {
    this.emitProgress(params, 'preparing', 2);
    const requiresAcceptedRecordVerification = !!params.options.providedStd?.trim()
      && params.options.providedStdSource === 'accepted-record';
    if (requiresAcceptedRecordVerification && hasCustomChecker(params.existingConfig)) {
      throw new Error('自定义 checker 题暂时无法对历史 AC 候选解做可靠的独立文本验证，已拒绝使用。请改用教师审核后的手动标程或取消选择。');
    }
    if (this.mode !== 'direct' && this.sandboxRunner) {
      this.emitProgress(params, 'sandbox_check', 5);
      const available = await this.sandboxRunner.isAvailable(params.signal);
      if (available) {
        const plan = await this.generateSandboxWithSemanticFallback(params, this.sandboxRunner);
        this.emitProgress(params, 'complete', 100, plan.verification?.modelEscalation ? 2 : 1);
        return plan;
      }
      if (requiresAcceptedRecordVerification) {
        throw new Error('Hydro 沙箱不可用，无法验证所选历史 AC 候选解；已拒绝降级生成 .out。请恢复沙箱、改用教师审核后的手动标程，或取消选择。');
      }
      if (this.mode === 'sandbox') {
        throw new Error('Hydro 沙箱不可用，无法安全执行 AI 生成器。请检查 hydrojudge.sandbox_host 或改用骨架模式。');
      }
    } else if (this.mode === 'sandbox') {
      throw new Error('未配置 Hydro 沙箱执行器，无法安全执行 AI 生成器。');
    }

    if (requiresAcceptedRecordVerification) {
      throw new Error('历史 AC 候选解必须在 Hydro 沙箱中通过题面样例与独立 BRUTE 压力验证，不能用于未经验证的直出模式。');
    }

    const plan = await this.generateDirect(params);
    if (this.mode === 'auto') {
      const fallbackWarning = 'Hydro 沙箱当前不可达，本次使用兼容直出模式；写入前请重点核对 .out。';
      plan.notes = [
        plan.notes,
        fallbackWarning,
      ].filter(Boolean).join('\n');
      plan.notesStructured?.warnings.push(fallbackWarning);
    }
    this.emitProgress(params, 'complete', 100);
    return plan;
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
  ): Promise<GenerationPlan> {
    try {
      return await this.generateWithSandbox(params, runner);
    } catch (firstError) {
      if (isCancellation(firstError)
        || !this.semanticModelFallback
        || !(firstError instanceof TestdataGenerationError)
        || !firstError.recommendDeeperReasoning) {
        throw firstError;
      }

      const lastResult = firstError.chatResults[firstError.chatResults.length - 1];
      const createFallback = this.aiClient.createClientStartingAfter;
      if (!lastResult || typeof createFallback !== 'function') throw firstError;
      const fallbackClient = createFallback.call(this.aiClient, lastResult.usedModel);
      if (!fallbackClient) throw firstError;

      const fromModel = `${lastResult.usedModel.endpointName}/${lastResult.usedModel.modelName}`;
      const fallbackService = new TestdataGenService(fallbackClient, {
        sandboxRunner: runner,
        mode: 'sandbox',
        semanticModelFallback: false,
      });
      try {
        this.emitProgress(params, 'model_escalation', 60, 2);
        const plan = await fallbackService.generateWithSandbox(params, runner, 2);
        const fallbackModels = plan.usedModel ? plan.usedModel.split(' → ').filter(Boolean) : [];
        const toModel = fallbackModels[0] || 'next configured model';
        const firstModels = firstError.chatResults.map(result =>
          `${result.usedModel.endpointName}/${result.usedModel.modelName}`);
        plan.usedModel = [...new Set([...firstModels, ...fallbackModels])].join(' → ');
        plan.tokenUsage = mergeTokenUsage([
          mergeTokenUsage(firstError.chatResults.map(result => result.usage)),
          plan.tokenUsage,
        ]);
        if (plan.verification) {
          plan.verification.modelEscalation = { fromModel, toModel };
        }
        const escalationNote = `首选模型在自动修复后仍未通过机器验证，已从下一配置模型（${toModel}）完整重跑并通过。`;
        plan.notes = [
          plan.notes,
          escalationNote,
        ].filter(Boolean).join('\n');
        plan.notesStructured?.system.push(escalationNote);
        return plan;
      } catch (fallbackError) {
        if (isCancellation(fallbackError)) throw fallbackError;
        if (fallbackError instanceof TestdataGenerationError) {
          const combinedResults = [
            ...firstError.chatResults,
            ...fallbackError.chatResults,
          ] as ChatResult[];
          throw new TestdataGenerationError(
            `首选模型自动修复失败，切换下一配置模型后仍未通过机器验证。技术细节：${fallbackError.message}`,
            `semantic_fallback:${String(fallbackError.telemetryMetadata.failureStage || 'unknown')}`,
            combinedResults,
            true,
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
    return plan;
  }

  private useProvidedPythonOracle<T extends Pick<SandboxSolutionBlueprint, 'problemType' | 'oracleCode'>>(
    blueprint: T,
    options: GenerateOptions,
  ): T {
    const provided = options.providedStd?.trim();
    if (blueprint.problemType === 'traditional' && provided && detectStdFilename(provided) === 'std.py') {
      return { ...blueprint, oracleCode: normalizeExecutableContent(provided) };
    }
    return blueprint;
  }

  private async generateDirect(params: GenerateTestdataParams): Promise<GenerationPlan> {
    const systemPrompt = buildTestdataSystemPrompt();
    const userPrompt = buildTestdataUserPrompt(params);
    const callOptions = this.getCallOptions(params);

    this.emitProgress(params, 'blueprint', 12);
    const initialResult = await this.aiClient.chat(
      [{ role: 'user', content: userPrompt }],
      systemPrompt,
      callOptions,
    );
    const results = [initialResult];
    this.emitProgress(params, 'blueprint', 48);

    let response = parseAiResponse(initialResult.content, params.options, { allowMissingTemplates: true });
    const assignmentIssue = response.problemType === 'function'
      ? findAssignmentStyleCaseInput(response.cases)
      : null;

    if (assignmentIssue) {
      this.emitProgress(params, 'pipeline_repair', 62);
      let repairResult;
      try {
        repairResult = await this.aiClient.chat(
          [
            { role: 'user', content: userPrompt },
            { role: 'assistant', content: initialResult.content },
            { role: 'user', content: buildCaseInputRepairPrompt(assignmentIssue, params.options) },
          ],
          systemPrompt,
          callOptions,
        );
      } catch (err) {
        throw new Error(
          'AI 生成的 .in 使用了“变量名 = 值”的错误格式，自动修复请求又失败了。'
          + `请重试；若 AI 服务持续不可用，可用「生成骨架文件（不调用 AI）」手动填写。技术细节：${err instanceof Error ? err.message : String(err)}`,
        );
      }
      results.push(repairResult);
      try {
        response = parseAiResponse(repairResult.content, params.options);
        const remainingIssue = response.problemType === 'function'
          ? findAssignmentStyleCaseInput(response.cases)
          : null;
        if (remainingIssue) {
          throw new Error(`第 ${remainingIssue.caseNumber} 个 .in 仍含错误写法：${remainingIssue.line}`);
        }
      } catch (err) {
        throw new Error(
          `AI 自动修复 .in 格式后仍未返回可用的完整文件计划。请重试；若持续失败，可用「生成骨架文件（不调用 AI）」手动填写。技术细节：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      const missingTemplates = getMissingTemplateLanguages(response, params.options);
      if (missingTemplates.length > 0) {
        this.emitProgress(params, 'templates', 62);
        let repairResult;
        try {
          repairResult = await this.aiClient.chat(
            [
              { role: 'user', content: userPrompt },
              { role: 'assistant', content: initialResult.content },
              { role: 'user', content: buildTemplateRepairPrompt(missingTemplates) },
            ],
            systemPrompt,
            callOptions,
          );
        } catch (err) {
          throw new Error(
            `AI 未返回 ${missingTemplates.map(lang => LANG_DISPLAY[lang]).join('、')}，自动补全请求又失败了。`
            + `请重试；若 AI 服务持续不可用，可用「生成骨架文件（不调用 AI）」手动填写。技术细节：${err instanceof Error ? err.message : String(err)}`,
          );
        }
        results.push(repairResult);
        const repairedTemplates = parseTemplateSections(repairResult.content);
        response.templates = { ...response.templates };
        for (const lang of missingTemplates) {
          if (repairedTemplates[lang]) response.templates[lang] = repairedTemplates[lang];
        }
        const stillMissing = getMissingTemplateLanguages(response, params.options);
        if (stillMissing.length > 0) {
          throw new Error(
            `AI 补全后仍缺少 ${stillMissing.map(lang => LANG_DISPLAY[lang]).join('、')}。`
            + '请重试；若持续失败，可用「生成骨架文件（不调用 AI）」手动填写。',
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
    };
    return this.applyResultMetadata(plan, results);
  }

  private async generateGenerationArtifacts(
    params: GenerateTestdataParams,
    solution: SandboxSolutionBlueprint,
    callOptions: ChatCallOptions,
    results: ChatResult[],
  ): Promise<GenerationArtifactsCallState> {
    const systemPrompt = buildGenerationArtifactsSystemPrompt();
    const userPrompt = buildGenerationArtifactsUserPrompt(params, solution);
    const initialResult = await this.aiClient.chat(
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
      const repairResult = await this.aiClient.chat(
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
  ): Promise<IndependentVerifierCallState> {
    const systemPrompt = buildIndependentVerifierSystemPrompt();
    const userPrompt = buildIndependentVerifierUserPrompt(params, blueprint);
    const expectedFunctionSamples = blueprint.problemType === 'function'
      ? extractStatementSamples(params.statementMarkdown)
      : [];
    const initialResult = await this.aiClient.chat(
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
        repairResult = await this.aiClient.chat(
          [
            { role: 'user', content: userPrompt },
            { role: 'assistant', content: initialResult.content },
            { role: 'user', content: buildIndependentVerifierRepairPrompt(parseError, expectedFunctionSamples) },
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
        );
      }
    }
  }

  async generateKillTargets(input: {
    statement: string;
    analysis: string;
    samples: SampleIO[];
    signal?: AbortSignal;
  }): Promise<KillTarget[]> {
    const result = await this.aiClient.chat(
      [{ role: 'user', content: buildKillTargetsUserPrompt(input) }],
      buildKillTargetsSystemPrompt(),
      {
        ...this.getCallOptions({ signal: input.signal }),
        timeoutMs: KILL_TARGET_AI_TIMEOUT_MS,
      },
    );
    return parseKillTargetsResponse(result.content);
  }

  private async generateHackCandidates(
    params: GenerateTestdataParams,
    analysis: string,
    target: KillTarget,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<HackCandidate[]> {
    const result = await this.aiClient.chat(
      [{ role: 'user', content: buildHackCasesUserPrompt({ analysis, target }) }],
      buildHackCasesSystemPrompt(),
      {
        ...this.getCallOptions({ signal, onProgress: params.onProgress }),
        timeoutMs,
      },
    );
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
  ): Promise<GenerationResponse> {
    const discrimination = response.verification?.discrimination;
    const deadlineAt = response.discriminationDeadlineAt;
    if (!discrimination || deadlineAt === undefined || killTargets.length === 0) return response;
    let cases: TestCase[] = response.cases;
    const initialCaseCount = cases.length;

    const finish = () => {
      response.cases = cases;
      const countedTargets = discrimination.targets.filter(target => !target.skippedReason);
      discrimination.allKilled = countedTargets.length > 0
        && countedTargets.every(target => target.killed);
      return response;
    };

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
            blueprint.analysis || '',
            target,
            remainingBudgetMs,
            deadlineScope.signal,
          );
        } catch (err) {
          if (params.signal?.aborted) throw err;
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

            const oracle = await runner.runPythonBatchDetailed(
              blueprint.oracleCode,
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
            let killedBy: DiscriminationTargetResult['killedBy'];
            if (detail.timedOut) killedBy = 'tle';
            else if (!detail.accepted
              || comparableFileContent(detail.stdout) !== comparableFileContent(output)) {
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
            if (!detail.accepted && !detail.timedOut) {
              targetResult.description = `${targetResult.description}(运行失败)`;
            }
            continue targetLoop;
          } catch (err) {
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
          const evaluated = evaluateDiscrimination({
            targetRuns: [{
              kind: target.kind,
              description: targetResult.description,
              perCase: details,
            }],
            oracleOutputs: appendedCases.map(item => item.output),
            customChecker: false,
          }).targets[0];
          if (!evaluated?.killed || evaluated.killedByCase === undefined) continue;
          targetResult.description = evaluated.description;
          targetResult.killed = true;
          targetResult.killedBy = evaluated.killedBy;
          targetResult.killedByCase = initialCaseCount + evaluated.killedByCase;
        } catch (err) {
          if (isCancellation(err)) throw err;
          break;
        }
      }
    }
    return finish();
  }

  private async generateWithSandbox(
    params: GenerateTestdataParams,
    runner: TestdataSandboxRunner,
    attempt = 1,
  ): Promise<GenerationPlan> {
    const report = (stage: TestdataGenerationProgressStage, percent: number) => {
      this.emitProgress(params, stage, this.progressForAttempt(percent, attempt), attempt);
    };
    // 完整协议只用于后续按失败节定向修复；正常成功路径严格分成两个阶段。
    const systemPrompt = buildSandboxBlueprintSystemPrompt();
    const userPrompt = buildSandboxBlueprintUserPrompt(params);
    const solutionSystemPrompt = buildSolutionBlueprintSystemPrompt();
    const solutionUserPrompt = buildSolutionBlueprintUserPrompt(params);
    const callOptions = this.getCallOptions(params, attempt);
    report('blueprint', 10);
    const initialResult = await this.aiClient.chat(
      [{ role: 'user', content: solutionUserPrompt }],
      solutionSystemPrompt,
      callOptions,
    );
    const results: ChatResult[] = [initialResult];
    const expectedFunctionSamples = extractStatementSamples(params.statementMarkdown);
    const customChecker = hasCustomChecker(params.existingConfig);
    report('blueprint', 24);
    let solutionSourceContent = initialResult.content;
    let solution: SandboxSolutionBlueprint;
    try {
      solution = this.useProvidedPythonOracle(
        parseSolutionBlueprint(initialResult.content, params.options, expectedFunctionSamples),
        params.options,
      );
      report('solution_verification', 28);
      await verifySolutionBlueprintSamples(
        solution,
        params.options,
        params.statementMarkdown,
        runner,
        params.signal,
        customChecker,
      );
    } catch (solutionError) {
      if (isCancellation(solutionError)) throw solutionError;
      if (classifySandboxRepairScope(solutionError) === 'accepted-std') {
        throw new TestdataGenerationError(
          `所选历史 AC 候选解未通过第一阶段题面样例验证，已拒绝使用。技术细节：${solutionError instanceof Error ? solutionError.message : String(solutionError)}`,
          'accepted_std_verification',
          results,
        );
      }
      report('blueprint_repair', 30);
      const repairResult = await this.aiClient.chat(
        [
          { role: 'user', content: solutionUserPrompt },
          { role: 'assistant', content: initialResult.content },
          {
            role: 'user',
            content: `第一阶段解题蓝图未通过解析或样例预验证：${solutionError instanceof Error ? solutionError.message : String(solutionError)}\n`
              + '请重新完整输出 META、ANALYSIS、ORACLE，以及函数题需要的 SOLUTION/SAMPLE_INPUTS；禁止输出 GENERATOR、BRUTE、VALIDATOR、TEMPLATE、CASE、代码围栏或解释。',
          },
        ],
        solutionSystemPrompt,
        callOptions,
      );
      results.push(repairResult);
      solutionSourceContent = repairResult.content;
      try {
        solution = this.useProvidedPythonOracle(
          parseSolutionBlueprint(repairResult.content, params.options, expectedFunctionSamples),
          params.options,
        );
        report('solution_verification', 32);
        await verifySolutionBlueprintSamples(
          solution,
          params.options,
          params.statementMarkdown,
          runner,
          params.signal,
          customChecker,
        );
      } catch (repairParseError) {
        if (isCancellation(repairParseError)) throw repairParseError;
        throw new TestdataGenerationError(
          `AI 自动修复解题蓝图后仍未通过解析或样例预验证：${repairParseError instanceof Error ? repairParseError.message : String(repairParseError)}`,
          'solution_blueprint',
          results,
          true,
        );
      }
    }

    // 解题蓝图过硬闸门后，三个互不依赖的 AI 阶段并行生成；独立验证器
    // 看不到 ORACLE 源码，错误解靶子调用失败则独立降级为空，不影响正确性管线。
    report('artifacts', 36);
    const killTargetSamples = buildKillTargetPromptSamples(solution, expectedFunctionSamples);
    const [killTargets, artifactsState, initialVerifierState] = await Promise.all([
      this.generateKillTargets({
        statement: params.statementMarkdown,
        analysis: solution.analysis || '',
        samples: killTargetSamples,
        signal: params.signal,
      }).catch((err): KillTarget[] => {
        if (isCancellation(err)) throw err;
        return [];
      }),
      this.generateGenerationArtifacts(params, solution, callOptions, results),
      this.generateIndependentVerifier(params, solution, callOptions, results, attempt),
    ]);
    report('independent_verifier', 54);
    let verifierState = initialVerifierState;
    let blueprintSourceContent = `${solutionSourceContent}\n${artifactsState.sourceContent}`;
    let blueprint: SandboxGenerationBlueprint = {
      ...solution,
      ...artifactsState.artifacts,
      ...verifierState.verifier,
      notes: [solution.notes, artifactsState.artifacts.notes].filter(Boolean).join('\n') || undefined,
    };

    if (blueprint.problemType === 'function') {
      const missing = params.options.languages.filter(lang => !blueprint.templates?.[lang]?.trim());
      if (missing.length > 0) {
        report('templates', 58);
        const repairResult = await this.aiClient.chat(
          [
            { role: 'user', content: userPrompt },
            { role: 'assistant', content: blueprintSourceContent },
            { role: 'user', content: buildTemplateRepairPrompt(missing) },
          ],
          systemPrompt,
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
          );
        }
      }
    }

    let response: GenerationResponse;
    try {
      response = await materializeSandboxBlueprint(
        blueprint, params.options, params.statementMarkdown, runner, params.signal,
        hasCustomChecker(params.existingConfig),
        report,
        killTargets,
      );
    } catch (firstError) {
      if (isCancellation(firstError)) throw firstError;
      if (/沙箱执行总时长超出预算/.test(firstError instanceof Error ? firstError.message : String(firstError))) {
        throw new TestdataGenerationError(
          '沙箱验证已达到总时长上限，系统已停止后续修复与模型升级。请减少测试点数量、降低数据规模，或检查 BRUTE 是否能在小数据上及时结束。',
          'sandbox_budget',
          results,
          false,
        );
      }
      const repairScope = classifySandboxRepairScope(firstError);
      if (repairScope === 'accepted-std') {
        throw new TestdataGenerationError(
          `所选历史 AC 候选解未通过独立机器验证，已拒绝使用。请改选其他 AC、粘贴教师审核后的标程，或留空让系统生成。技术细节：${firstError instanceof Error ? firstError.message : String(firstError)}`,
          'accepted_std_verification',
          results,
        );
      }
      report(isIndependentVerifierScope(repairScope) ? 'verifier_repair' : 'pipeline_repair', 87);
      let repairResult;
      try {
        if (isIndependentVerifierScope(repairScope)) {
          repairResult = await this.aiClient.chat(
            [
              { role: 'user', content: verifierState.userPrompt },
              { role: 'assistant', content: verifierState.sourceContent },
              {
                role: 'user',
                content: buildIndependentVerifierRepairPrompt(
                  firstError,
                  verifierState.expectedFunctionSamples,
                ),
              },
            ],
            verifierState.systemPrompt,
            callOptions,
          );
        } else {
          repairResult = await this.aiClient.chat(
            [
              { role: 'user', content: userPrompt },
              { role: 'assistant', content: blueprintSourceContent },
              { role: 'user', content: buildSandboxRepairPrompt(firstError, params.options, repairScope) },
            ],
            systemPrompt,
            callOptions,
          );
        }
      } catch (err) {
        if (isCancellation(err)) throw err;
        throw new TestdataGenerationError(
          `AI 生成蓝图未通过 Hydro 沙箱验证，自动修复请求又失败了。技术细节：${err instanceof Error ? err.message : String(err)}`,
          repairScope,
          results,
        );
      }
      results.push(repairResult);
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
          const fullRepairResult = await this.aiClient.chat(
            [
              { role: 'user', content: userPrompt },
              { role: 'assistant', content: blueprintSourceContent },
              {
                role: 'user',
                content: buildSandboxRepairPrompt(
                  new Error(`定向修复结果不可用：${targetedParseError instanceof Error ? targetedParseError.message : String(targetedParseError)}`),
                  params.options,
                  'full',
                ),
              },
            ],
            systemPrompt,
            callOptions,
          );
          results.push(fullRepairResult);
          blueprint = {
            ...parseSandboxBlueprint(fullRepairResult.content, params.options),
            ...verifierState.verifier,
          };
          blueprintSourceContent = fullRepairResult.content;
        }
        blueprint = this.useProvidedPythonOracle(blueprint, params.options);
        response = await materializeSandboxBlueprint(
          blueprint, params.options, params.statementMarkdown, runner, params.signal,
          hasCustomChecker(params.existingConfig),
          report,
          killTargets,
        );
      } catch (err) {
        if (isCancellation(err)) throw err;
        throw new TestdataGenerationError(
          `AI 自动修复后仍未通过 Hydro 沙箱验证。请重试或使用骨架模式。技术细节：${err instanceof Error ? err.message : String(err)}`,
          classifySandboxRepairScope(err),
          results,
          true,
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
    );
    report('assembling', 96);
    return this.applyResultMetadata(assemblePlan(response, params.options, {
      mode: 'sandbox',
      existingFiles: params.existingFiles,
      existingConfig: params.existingConfig,
    }), results);
  }
}
