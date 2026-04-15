/**
 * TeachingSuggestionService - 教学建议 LLM 层
 *
 * 构建 LLM 提示词并调用 AI 客户端，生成结构化教学建议。
 */

import { TeachingFinding } from '../models/teachingSummary';

// ─── 提示词模板 ──────────────────────────────────────────

const MAIN_SYSTEM_PROMPT = `你是一位教龄15年的编程课教师，同时负责教学教研。你将根据规则引擎提供的【带有具体错误诊断和题目信息的】课堂分析数据，为授课教师生成清晰直观的问题发现报告和教学参考素材。

【核心约束】
- 每条发现必须清晰呈现"错误是什么/影响多大/根因在哪"，用数据和具体例子说话
- P0 发现必须锚定在数据中的具体题目、具体错误模式上
- P1 建议必须锚定具体行为证据（提交次数、AI提问记录等），如有关联题目则引用，不得强行编造错误模式
- 当某章节主要依据 "low" confidence 数据时，在该章节标题下方加注一次"⚠️ 数据有限，以下建议仅供参考"
- 当数据标注为 "insufficient_data" 时，跳过该维度不做建议
- 必须基于给定数据说话，严禁捏造数据或比例

【优先级框架】
P0 — 全局知识缺陷：>20%学生犯同一类错误（有具体错误签名和测试点信息）
P1 — 个体干预：按行为模式分类（持续努力型 / 受挫放弃型 / 沉默挣扎型 / 未参与型）

【可推荐的教学干预方法】
- Parsons Problems（帕森斯题目）：让学生排列代码块而非从零写，减少语法负担
- Worked Examples（样例学习）：展示完整解题过程，标注每步的子目标
- Peer Instruction（同伴教学）：让AC学生分享思路，教师引导讨论
- Socratic Questioning（苏格拉底式提问）：用问题引导学生自行发现错误
- Code Fill-in-the-Blank（代码挖空练习）：基于学生AC代码，挖空错误高发位置让学生重做巩固

选择干预方法时参考：
- 语法负担高、代码结构混乱 → Parsons Problems
- 解题步骤断裂、不会建模 → Worked Examples
- 多数人有同一概念误解 → Peer Instruction
- 个体差一点能自行发现错误 → Socratic Questioning
- 已有 AC 代码且错误位置集中 → Code Fill-in-the-Blank

【边缘情况处理】
| 条件 | 行动 |
|---|---|
| 全班 AC 率 > 90% 且无 commonError | 在 p0_action_plan 章节输出"全班表现优秀"并列出可进一步挑战的方向：时空复杂度优化、进阶变式题等 |
| AI 使用数据为 0（全班未使用 AI） | 聚焦于提交记录分析，不做 AI 有效性对比 |

【质量示例】
- 坏例子（禁止）："加强对边界条件的练习" / "进行个别辅导" / "注意数组越界问题" / "建议教师在课上演示正确写法"
- 好例子（要求）："35%的学生（10人）在T2中将循环条件写成 i<=n 而非 i<n，导致testcase #3 (n=0) 时数组越界。根因：未区分'元素个数'与'最大下标'的概念差异" / "错误集中在边界条件判断，错误签名 off_by_one，影响题目 P101、P103"

【输出章节定义】
你的报告可能包含以下章节。每次请求的 user prompt 末尾会给出 output_sections 列表，只输出该列表中指定的章节，未指定的章节不得出现在输出中。

■ diagnosis — 一句话诊断
### 📊 一句话诊断
{一句话点明核心教学问题，引用具体数据}

■ p0_action_plan — P0全局错误发现报告
### 🚨 问题发现报告
（按影响人数从高到低排列，每个P0问题独立一节）

#### [P0] {问题名称} — 影响 {N}人/{百分比}

**📌 错误模式**：{一句话概括错误模式，引用错误签名}

**🔍 具体表现**：
- 错误签名：\`{errorSignature}\`，出现在测试点 {testcaseIds}
- 典型错误代码：\`{学生代码中的关键错误行}\`
- 学生常见误解："{学生认为的逻辑}" → 实际应为："{正确逻辑}"

**📊 数据全景**：
| 维度 | 数据 |
|---|---|
| 受影响学生数 | {N}人（占参与人数{百分比}） |
| 涉及题目 | {pid列表} |
| 错误集中度 | {该错误是分散在多题还是集中在某题} |

**🧠 根因定位**：{用1-2句话说明知识盲点或认知误区，不要给出教学行动指令}

**💡 可选干预方向**：{从【可推荐的教学干预方法】中选择1-2个适合的方法名称，仅列出方法名，不展开具体步骤}

■ p1_behavior_intervention — P1个体干预建议
#### [P1] 个体干预建议
（仅输出 count > 0 的行为模式，跳过人数为 0 或数据缺失的类别）
| 行为模式 | 人数 | 建议动作 |
|---|---|---|
| {行为模式名称} | N | {具体建议} |`;

const FILL_IN_SYSTEM_PROMPT = `你是一位编程教学专家，擅长设计代码挖空练习。你将基于学生的 AC 代码和已识别的错误模式，生成带有注释的挖空练习。

【核心约束】
- 每题挖2-4个空，优先选择：错误高发位、关键逻辑判断位、边界条件位
- 避免挖空简单的 I/O 语句或变量声明
- 如果题目是填空形式（is_fill_in_problem=true），挖空位置必须避开题目模板代码
- 输出完整代码，在挖空位置用注释占位符替换，保持原始缩进
- 占位符根据语言使用对应注释风格：C/C++/Java 用 /* [空n] _____ (提示: ...) */，Python 用 # [空n] _____ (提示: ...)
- 必须基于给定数据说话，严禁捏造错误模式

【注释要求】
- 代码中每个关键行或逻辑块旁必须添加行尾注释，解释该行/块的作用
- 注释应帮助学生理解代码整体逻辑，而非仅标注语法

【输出格式】
对每道题输出以下结构：

#### 📝 课后巩固：代码挖空练习
**题目**：{pid}. {title}
**练习目的**：{根据错误模式说明本练习针对什么知识盲点}

##### 练习代码（可直接复制到试卷）
\`\`\`{language}
{完整 AC 代码，挖空位置用注释占位符替换，每个关键行添加行尾注释}
\`\`\`

##### 建议挖空点说明
| 空号 | 位置描述 | 参考答案 | 挖空理由 |
|---|---|---|---|
| [空1] | {位置描述} | \`{被挖空的原始代码}\` | {关联学生的哪个错误模式} |`;

const DEEP_DIVE_SYSTEM_PROMPT = `你是一位擅长认知诊断的编程教育专家。分析特定题目的异常数据、代码切片和AI交互日志，为教师提供深度微观诊断和课堂干预素材。

【分析维度：布卢姆认知层级】
判断学生主要卡在哪个认知层级：
- 记忆/理解层：看不懂题意，或忘记了基本语法结构。
- 应用层：理解逻辑，但无法用代码正确实现（如边界条件遗漏）。
- 分析/评价层：算法超时（TLE），无法分析时间复杂度并优化。

【处理边缘情况】
如果代码样本看起来完善，但AI对话显示学生在索要完整代码或频繁询问低级问题，优先判定为"学习策略与元认知问题（过度依赖）"，而非知识问题。

【输出格式要求】
严格按照以下Markdown结构输出：

### 🧠 认知障碍诊断
（学生卡在哪个布卢姆认知层级，根本原因：前置知识薄弱还是缺乏特定思维图式？）

### 🔍 典型误区还原
（结合代码或对话样本，指出学生脑海中错误的思维逻辑）

### 🛠️ 教学干预与脚手架 (Scaffolding)
1. **反例设计**：一组能打破学生错误逻辑的测试数据（Input/Output）
2. **提问设计**：1-2个引导学生自主发现错误的启发式提问（Socratic Questioning）`;

// ─── 类型定义 ────────────────────────────────────────────

export interface BehaviorSummary {
  persistent_learner: number;
  burst_then_quit: number;
  stuck_silent: number;
  disengaged: number;
}

export interface MainPromptInput {
  contestTitle: string;
  contestContent: string;
  teachingFocus?: string;
  stats: {
    totalStudents: number;
    participatedStudents: number;
    aiUserCount: number;
    problemCount: number;
  };
  findings: TeachingFinding[];
  problemContexts?: Array<{ pid: number; title: string; content: string }>;
  behaviorSummary?: BehaviorSummary;
}

export interface FillInPromptInput {
  candidates: Array<{
    pid: number;
    title: string;
    lang: string;
    code: string;
    isFillInProblem: boolean;
  }>;
  relatedFindings: Array<{
    title: string;
    errorSignature?: string;
    affectedCount: number;
  }>;
}

export interface PromptMessages {
  system: string;
  user: string;
}

export interface SuggestionResult {
  text: string;
  tokenUsage: {
    promptTokens: number;
    completionTokens: number;
  };
}

// ─── 辅助函数 ────────────────────────────────────────────

/**
 * 从 findings 中移除 samples 字段以减少 token 用量
 */
function stripSamples(findings: TeachingFinding[]): Omit<TeachingFinding, 'evidence'>[] {
  return findings.map((f) => {
    const { evidence, ...rest } = f;
    const { samples: _samples, ...evidenceWithoutSamples } = evidence;
    return { ...rest, evidence: evidenceWithoutSamples };
  });
}

// ─── 导出函数 ────────────────────────────────────────────

/**
 * 构建主提示词（整体教学建议）
 */
export function buildMainPrompt(input: MainPromptInput): PromptMessages {
  const { contestTitle, contestContent, teachingFocus, stats, findings } = input;

  const hasContext = (contestContent && contestContent.trim() !== '')
    || (teachingFocus && teachingFocus.trim() !== '');

  const contextSection = hasContext
    ? [
        contestContent ? `题目/竞赛描述：${contestContent}` : '',
        teachingFocus ? `教学目标：${teachingFocus}` : '',
      ].filter(Boolean).join('\n')
    : '教学目标未提供';

  const strippedFindings = stripSamples(findings);

  const problemSection = input.problemContexts?.length
    ? `\n## 题目内容\n${input.problemContexts
        .map(p => `### ${p.pid}. ${p.title}\n${p.content.slice(0, 500)}`)
        .join('\n\n')}`
    : '';

  const hasBehavior = input.behaviorSummary
    && (input.behaviorSummary.persistent_learner
      + input.behaviorSummary.burst_then_quit
      + input.behaviorSummary.stuck_silent
      + input.behaviorSummary.disengaged) > 0;

  const behaviorSection = hasBehavior
    ? `\n## 学生行为模式分类（behaviorSummary）\n${JSON.stringify({
        persistent_learner: { label: '持续努力型', count: input.behaviorSummary!.persistent_learner },
        burst_then_quit: { label: '受挫放弃型', count: input.behaviorSummary!.burst_then_quit },
        stuck_silent: { label: '沉默挣扎型', count: input.behaviorSummary!.stuck_silent },
        disengaged: { label: '未参与型', count: input.behaviorSummary!.disengaged },
      }, null, 2)}`
    : '';

  const outputSections: string[] = ['diagnosis', 'p0_action_plan'];
  if (hasBehavior) outputSections.push('p1_behavior_intervention');

  const userPrompt = `## 教学上下文
竞赛标题：${contestTitle}
${contextSection}

## 班级统计数据
- 总学生数：${stats.totalStudents}
- 参与学生数：${stats.participatedStudents}
- 使用AI辅助的学生数：${stats.aiUserCount}
- 题目数量：${stats.problemCount}
${problemSection}

## 规则引擎发现（JSON）
${JSON.stringify(strippedFindings, null, 2)}${behaviorSection}

---
output_sections: ${JSON.stringify(outputSections)}
请严格只输出上方 output_sections 列出的章节。`;

  return {
    system: MAIN_SYSTEM_PROMPT,
    user: userPrompt,
  };
}

/**
 * 构建代码挖空练习提示词
 */
export function buildFillInPrompt(input: FillInPromptInput): PromptMessages {
  const candidateSection = input.candidates
    .map(c => `### ${c.pid}. ${c.title}\n- 语言: ${c.lang}\n- 填空题: ${c.isFillInProblem ? '是（避开模板代码）' : '否'}\n\`\`\`${c.lang}\n${c.code}\n\`\`\``)
    .join('\n\n');

  const findingsSection = input.relatedFindings.length > 0
    ? `\n## 相关错误模式\n${input.relatedFindings
        .map(f => `- **${f.title}**${f.errorSignature ? `（签名: ${f.errorSignature}）` : ''} — 影响 ${f.affectedCount} 人`)
        .join('\n')}`
    : '';

  const userPrompt = `## AC 代码候选\n${candidateSection}${findingsSection}

---
请为上方每道题生成带注释的挖空练习和建议挖空点说明表格。`;

  return {
    system: FILL_IN_SYSTEM_PROMPT,
    user: userPrompt,
  };
}

/**
 * 构建深度分析提示词（认知诊断）
 */
export function buildDeepDivePrompt(
  finding: TeachingFinding,
  problemContent: string,
): PromptMessages {
  const { title, dimension, severity, evidence } = finding;
  const { affectedStudents, affectedProblems, metrics, samples } = evidence;

  const codeSamples = samples?.code?.length
    ? `\n### 代码样本\n${samples.code.map((c, i) => `\`\`\`\n// 样本 ${i + 1}\n${c}\n\`\`\``).join('\n')}`
    : '';

  const conversationSamples = samples?.conversations?.length
    ? `\n### AI对话样本\n${samples.conversations.map((c, i) => `> 对话 ${i + 1}：${c}`).join('\n')}`
    : '';

  const userPrompt = `## 题目内容
${problemContent}

## 发现详情
- 标题：${title}
- 维度：${dimension}
- 严重程度：${severity}
- 受影响学生数：${affectedStudents.length}（学生ID：${affectedStudents.slice(0, 10).join(', ')}${affectedStudents.length > 10 ? '...' : ''}）
- 涉及题目：${affectedProblems.join(', ')}

## 关键指标
${JSON.stringify(metrics, null, 2)}
${codeSamples}${conversationSamples}`;

  return {
    system: DEEP_DIVE_SYSTEM_PROMPT,
    user: userPrompt,
  };
}

// ─── 服务类 ──────────────────────────────────────────────

export class TeachingSuggestionService {
  private aiClient: any;

  constructor(aiClient: any) {
    this.aiClient = aiClient;
  }

  /**
   * 生成整体教学建议
   */
  async generateOverallSuggestion(input: MainPromptInput): Promise<SuggestionResult> {
    const { system, user } = buildMainPrompt(input);
    const result = await this.aiClient.chat(
      [{ role: 'user', content: user }],
      system,
    );
    return {
      text: result.content,
      tokenUsage: {
        promptTokens: result.usage?.promptTokens ?? result.usage?.prompt_tokens ?? 0,
        completionTokens: result.usage?.completionTokens ?? result.usage?.completion_tokens ?? 0,
      },
    };
  }

  /**
   * 生成代码挖空练习（独立调用，可与主建议并行）
   */
  async generateFillInExercise(input: FillInPromptInput): Promise<SuggestionResult> {
    const { system, user } = buildFillInPrompt(input);
    const result = await this.aiClient.chat(
      [{ role: 'user', content: user }],
      system,
    );
    return {
      text: result.content,
      tokenUsage: {
        promptTokens: result.usage?.promptTokens ?? result.usage?.prompt_tokens ?? 0,
        completionTokens: result.usage?.completionTokens ?? result.usage?.completion_tokens ?? 0,
      },
    };
  }

  /**
   * 生成单项发现的深度认知诊断
   */
  async generateDeepDive(
    finding: TeachingFinding,
    problemContent: string,
  ): Promise<SuggestionResult> {
    const { system, user } = buildDeepDivePrompt(finding, problemContent);
    const result = await this.aiClient.chat(
      [{ role: 'user', content: user }],
      system,
    );
    return {
      text: result.content,
      tokenUsage: {
        promptTokens: result.usage?.promptTokens ?? result.usage?.prompt_tokens ?? 0,
        completionTokens: result.usage?.completionTokens ?? result.usage?.completion_tokens ?? 0,
      },
    };
  }
}
