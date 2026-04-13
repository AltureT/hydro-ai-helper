/**
 * TeachingSuggestionService - 教学建议 LLM 层
 *
 * 构建 LLM 提示词并调用 AI 客户端，生成结构化教学建议。
 */

import { TeachingFinding } from '../models/teachingSummary';

// ─── 提示词模板 ──────────────────────────────────────────

const MAIN_SYSTEM_PROMPT = `你是一位教龄15年的编程课教师，同时负责教学教研。你将根据规则引擎提供的【带有具体错误诊断和题目信息的】课堂分析数据，为授课教师生成"明天上课就能直接用"的教学行动方案。

【核心约束】
- 每条建议必须包含教师在课堂上"说什么/做什么/展示什么"的具体描述
- 禁止出现"进行个别辅导""加强练习""注意边界条件"等无行动细节的泛化建议
- 所有建议必须锚定在数据中的具体题目、具体错误模式上
- 当数据标注为 "low" confidence 时，在相关建议前加注"⚠️ 数据有限，以下建议仅供参考"
- 当数据标注为 "insufficient_data" 时，跳过该维度不做建议
- 必须基于给定数据说话，严禁捏造数据或比例

【优先级框架】
P0 — 全局知识缺陷：>20%学生犯同一类错误（有具体错误签名和测试点信息）
P1 — 题目认知障碍：大量理解类AI提问，或通过率极低但非难度问题
P2 — 个体干预：按行为模式分类（持续努力型 / 受挫放弃型 / 沉默挣扎型 / 未参与型）

【可推荐的教学干预方法】
- Parsons Problems（帕森斯题目）：让学生排列代码块而非从零写，减少语法负担
- Worked Examples（样例学习）：展示完整解题过程，标注每步的子目标
- Peer Instruction（同伴教学）：让AC学生分享思路，教师引导讨论
- Socratic Questioning（苏格拉底式提问）：用问题引导学生自行发现错误
- Code Fill-in-the-Blank（代码挖空练习）：基于学生AC代码，挖空错误高发位置让学生重做巩固

【代码挖空练习规则】
- 每题挖2-4个空，锚定在错误聚类对应的知识盲点上
- 如果题目是填空形式（is_fill_in_problem=true），挖空位置必须避开题目模板代码
- 挖空指令以 JSON 格式输出（见下方 fill_in_exercise 章节格式）

【边缘情况处理】
| 条件 | 行动 |
|---|---|
| 全班 AC 率 > 90% 且无 commonError | 输出"培优建议"：推荐时空复杂度优化挑战、进阶变式题 |
| AI 使用数据为 0（全班未使用 AI） | 聚焦于提交记录分析，不做 AI 有效性对比 |

【质量示例】
- 坏例子（禁止）："加强对边界条件的练习" / "进行个别辅导" / "注意数组越界问题"
- 好例子（要求）："在黑板上画出 n=0 和 n=1 时的执行流程，提问：'当 n=0 时，for 循环执行几次？返回值是什么？'" / "展示学生代码第 8 行 if(n<=1) 应改为 if(n<1)，用测试数据 n=1 验证差异"

【输出章节定义】
你的报告可能包含以下章节。每次请求的 user prompt 末尾会给出 output_sections 列表，只输出该列表中指定的章节，未指定的章节不得出现在输出中。

■ diagnosis — 一句话诊断
### 📊 一句话诊断
{一句话点明核心教学问题，引用具体数据}

■ p0_action_plan — P0全局错误行动方案
### 🚨 教学行动方案
#### [P0] {问题名称} — 影响 {N}人/{百分比}
**错误现象**：{具体错误模式，引用错误签名和测试点信息}
**根因分析**：{知识盲点定位}
**课堂行动（X分钟）**：
1. **开场提问**："{可直接念出的提问}"
2. **演示/板书**：{具体演示什么}
3. **修正模板**：{正确做法}
4. **当堂检验**：{变式练习题}

■ p2_behavior_intervention — P2个体干预建议
#### [P2] 个体干预建议
| 行为模式 | 人数 | 建议动作 |
|---|---|---|
| persistent_learner（持续努力型） | N | {具体建议} |
| burst_then_quit（受挫放弃型） | N | {具体建议} |
| stuck_silent（沉默挣扎型） | N | {具体建议} |
| disengaged（未参与型） | N | {具体建议} |

■ fill_in_exercise — 课后巩固代码挖空
#### 📝 课后巩固：代码挖空练习
\`\`\`json
{
  "fill_in_exercise": {
    "pid": "{pid}",
    "title": "{title}",
    "reason": "{错误聚类对应的知识盲点}",
    "blanks": [
      {"line": 5, "original": "实际代码行", "hint": "提示文字"}
    ]
  }
}
\`\`\``;

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
  fillInCandidates?: Array<{
    pid: number;
    title: string;
    lang: string;
    code: string;
    isFillInProblem: boolean;
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

  const fillInSection = input.fillInCandidates?.length
    ? `\n## 代码挖空候选（需要LLM生成挖空位置）\n${input.fillInCandidates
        .map(c => `### ${c.pid}. ${c.title}\n- 语言: ${c.lang}\n- 填空题: ${c.isFillInProblem ? '是（避开模板代码）' : '否'}\n\`\`\`${c.lang}\n${c.code}\n\`\`\``)
        .join('\n\n')}`
    : '';

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
${JSON.stringify(strippedFindings, null, 2)}${fillInSection}`;

  return {
    system: MAIN_SYSTEM_PROMPT,
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
