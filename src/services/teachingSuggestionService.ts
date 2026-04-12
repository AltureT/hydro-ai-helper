/**
 * TeachingSuggestionService - 教学建议 LLM 层
 *
 * 构建 LLM 提示词并调用 AI 客户端，生成结构化教学建议。
 */

import { TeachingFinding } from '../models/teachingSummary';

// ─── 提示词模板 ──────────────────────────────────────────

const MAIN_SYSTEM_PROMPT = `你是一位精通形成性评价与精准教学的资深编程教研员。根据规则引擎提取的客观课堂数据，为教师生成高度结构化的学情概览。

【分析框架与优先级规则】
1. P0级（全局知识缺陷）：与本次教学目标强相关，且大面积（>20%）报错的共性问题。
2. P1级（题目认知障碍）：大面积向AI询问题意，说明题目设计可能超出了学生的最近发展区(ZPD)。
3. P2级（学习策略/高危个体）：过度依赖AI、或连续提交失败导致严重挫败感的学生。

【处理边缘情况】
- 如果发现的问题很少或通过率极高，将重点转向"培优建议"（推荐进阶挑战）和肯定教学成果。
- 必须基于给定的JSON数据说话，严禁捏造数据或比例。
- 如果"教学上下文"中标注"教学目标未提供"，则退回纯数据驱动分析：只报告客观现象和建议的教学动作，不做"是否偏离教学目标"的判断。

【输出格式要求】
请严格按照以下Markdown结构输出，不要输出多余的寒暄：

### 📊 班级学情诊断结论
（1-2句话总结本次作业整体达成情况）

### 🚨 核心教学建议 (按优先级排序)
- **[P0/P1/P2] {问题简述}** (受影响人数/比例)：
  - **教学动作**：{具体且可执行的动作}`;

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

  const userPrompt = `## 教学上下文
竞赛标题：${contestTitle}
${contextSection}

## 班级统计数据
- 总学生数：${stats.totalStudents}
- 参与学生数：${stats.participatedStudents}
- 使用AI辅助的学生数：${stats.aiUserCount}
- 题目数量：${stats.problemCount}

## 规则引擎发现（JSON）
${JSON.stringify(strippedFindings, null, 2)}`;

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
