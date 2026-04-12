# 教学建议功能设计文档

> 日期：2026-04-12
> 状态：设计完成，待实施
> 参与讨论：Claude Opus、Gemini（教育学视角）、Codex（数据工程视角）

## 1. 概述

### 1.1 目标

为教师生成基于作业（homework/contest）数据的教学建议，帮助教师从学生数据（50+人×大量提交）中发现教学问题，为精准教学服务。

### 1.2 核心价值

AI 从数据中帮老师"发现问题"——一节课通常有 50+ 学生参与，每个学生都有大量提交和 AI 对话，教师无法人工逐一审查。50 人规模下支持全量分析，无需采样。

### 1.3 与现有功能的关系

- 现有"学生学习总结"：面向学生，基于个人数据生成学习建议
- 本功能"教学建议"：面向教师，基于班级整体数据生成教学洞察

## 2. 数据边界

以一次"作业"（HydroOJ 的 homework/contest）为一节课的数据边界，复用现有的 `tdoc`（contest document）结构。

教学上下文优先从作业文档自动提取：
- `tdoc.title` — 作业标题
- `tdoc.content` — 作业介绍（含教学目标）

若 `tdoc.content` 为空或无有效教学信息，生成入口提供一个可选的单行输入框"本次教学重点（可选）"。若教师未填写且无法自动提取，LLM prompt 中标注"教学目标未提供"，退回纯数据驱动分析（只报告现象，不做目标关联诊断）。

## 3. 分析维度

所有维度均为 v1 范围。50+ 学生规模下支持全量分析，无需采样。

### 3.1 核心维度

| 维度 | 说明 | 核心信号 | 阈值建议 |
|---|---|---|---|
| A. 共性错误模式 | 大量学生在同一题犯相同类型错误（v1 按状态码 WA/TLE/RE/CE 分类，具体错误类型由深潜 LLM 从代码样本推断） | 同题同 status 学生数/总提交人数 | >30%（最少 5 人） |
| B. 题意理解障碍 | AI 对话中大量 understand/clarify 类问题 | 对话类型占比 + 前3次全 WA | 占比 >40%（最少 5 人） |
| C. 学习策略问题 | AI 使用频率偏高、jailbreak 触发 | jailbreak 次数 >0；对话后 <2min 提交 AC | 措辞用"AI 使用频率偏高"而非"过度依赖" |
| D. 高危学生预警 | 放弃率高、无进步趋势 | 连续 N 次作业 give-up 率上升 | N ≥ 2 |
| E. 题目难度异常 | 通过率远低于预期 | 通过率 z-score vs 历史同难度题（首次作业无历史数据时，仅使用绝对通过率 <20% 作为触发） | < -1.5σ |
| F. 进步趋势 | 正向信号：错误率持续下降的学生 | 连续作业错误率下降 | 纯数值指标，不含"创意解法" |
| G. 认知演进轨迹 | 从 WA 到 AC 的路径质量（有效学习闭环 vs 无脑试错） | 对话后提交改善率、提交间隔时间模式 | — |
| H. AI 辅导实效 | AI 对话对提交结果的实际帮助 | 对话后 30min 内 AC 增量率 | 与 G 共享数据管道 |

### 3.2 规则引擎通用门控

- **最小样本量：** 每条 finding 至少影响 5 名学生，否则降级为"观察"（仅在详情中展示，不计入首屏清单）
- **数据来源标注：** 基于 AI 对话的维度（B/C/G/H）需标注"基于 X 名使用 AI 助手的学生数据"，避免幸存者偏差误导
- **高一致性提醒：** 若某题出现大量完全相同的错误代码，finding 中附注"注意：高度一致的错误可能涉及代码共享"

### 3.3 v2 规划

| 功能 | 理由 |
|---|---|
| 跨作业趋势概览 | 需要先积累多次教学总结数据，首次使用时无历史数据 |

## 4. 技术架构：规则引擎 + 选择性 LLM 深潜

### 4.1 架构选择理由

经圆桌讨论，对比三种方案后选择方案 B 增强版：

- **方案 A（纯 LLM）** ❌ — LLM 会捏造数据，教师下钻核对时信任崩塌；大量学生数据撞上 context window 上限
- **方案 B+（规则引擎 + 选择性 LLM）** ✅ — Carnegie Learning、Khanmigo、Gradescope 等成熟产品均采用类似架构
- **方案 C（多层 LLM）** ❌ — 成本是方案 B 的 30 倍；多层 LLM 幻觉会累积放大

### 4.2 三层管道

```
┌─────────────────────────────────────────────┐
│ 第一层：数据采集与聚合（纯代码，确定性）           │
│                                             │
│  输入：contestId + domainId                  │
│  ├─ record 集合 → 提交记录                    │
│  ├─ ai_conversations → 对话元数据             │
│  ├─ ai_messages → 对话详情                    │
│  ├─ ai_jailbreak_logs → 违规记录              │
│  └─ ai_student_history → 历史趋势             │
│                                             │
│  输出：per-problem 和 per-student 聚合统计     │
└──────────────────────┬──────────────────────┘
                       ▼
┌─────────────────────────────────────────────┐
│ 第二层：异常检测与问题发现（代码规则引擎）          │
│                                             │
│  对每个维度运行检测规则（见 §3 阈值）             │
│  输出：findings[] — 含维度、置信度、             │
│       涉及学生列表、支撑数据、是否需要深潜         │
└──────────────────────┬──────────────────────┘
                       ▼
┌─────────────────────────────────────────────┐
│ 第三层：LLM 生成教学建议                        │
│                                             │
│  3a. 主调用（必选）：findings JSON → 教学建议    │
│  3b. 深潜调用（按需）：异常点 + 样本 → 认知诊断   │
└─────────────────────────────────────────────┘
```

### 4.3 深潜触发条件

- 某题通过率 <30%
- 检测到新的错误模式（规则库未覆盖）
- AI 对话中频繁出现相同困惑点

## 5. 数据结构

### 5.1 TeachingFinding

```typescript
interface TeachingFinding {
  id: string;
  dimension: 'commonError' | 'comprehension' | 'strategy'
    | 'atRisk' | 'difficulty' | 'progress' | 'cognitivePath' | 'aiEffectiveness';
  severity: 'high' | 'medium' | 'low';
  title: string;           // 规则引擎生成的摘要
  evidence: {
    affectedStudents: number[];   // uid 列表
    affectedProblems: number[];   // pid 列表
    metrics: Record<string, number>;
    samples?: {
      code?: string[];
      conversations?: string[];
    };
  };
  needsDeepDive: boolean;
  aiSuggestion?: string;   // LLM 生成的教学建议（3a 填充）
  aiAnalysis?: string;     // 深潜分析结果（3b 填充）
}
```

### 5.2 TeachingSummary（MongoDB: `ai_teaching_summaries`）

```typescript
interface TeachingSummary {
  _id: ObjectId;
  domainId: string;
  contestId: ObjectId;
  contestTitle: string;     // 自动从 tdoc.title 获取
  contestContent: string;   // 自动从 tdoc.content 获取
  teachingFocus?: string;   // 教师手动输入的教学重点（可选，tdoc.content 不足时补充）
  createdBy: number;
  createdAt: Date;
  dataSnapshotAt: Date;     // 数据采集截止时间戳（防止竞态：作业未截止时生成）
  status: 'pending' | 'generating' | 'completed' | 'failed';

  stats: {
    totalStudents: number;
    participatedStudents: number;
    aiUserCount: number;      // 使用 AI 助手的学生数（标注数据来源）
    problemCount: number;
  };
  findings: TeachingFinding[];

  overallSuggestion: string;
  deepDiveResults: Record<string, string>;  // findingId → 深潜分析

  feedback?: {              // 教师反馈闭环
    rating: 'up' | 'down';
    comment?: string;
  };

  tokenUsage: { promptTokens: number; completionTokens: number; };
  generationTimeMs: number;
}
```

## 6. 采样策略（token 预算）

| 数据类型 | 预算 | 说明 |
|---|---|---|
| 代码样本 | 每份 ≤1000 token，最多 8 份 | 截断过多会丢失关键错误上下文 |
| AI 对话 | 每段 ≤600 token，最多 8 段 | 对话截断后难以判断认知演进 |
| 题目内容 | ≤3000 token | 复杂题目截断后丢失约束条件 |
| 主 Prompt findings | ~10-20K total | 允许携带更丰富的统计上下文 |
| 深潜单次调用 | ≤15K input token | 保证分析质量的同时控制成本 |

## 7. LLM Prompt 设计

### 7.1 主 Prompt（3a：全局教学建议）

```
System:
你是一位精通形成性评价与精准教学的资深编程教研员。根据规则引擎提取的
客观课堂数据，为教师生成高度结构化的学情概览。

【分析框架与优先级规则】
1. P0级（全局知识缺陷）：与本次教学目标强相关，且大面积（>20%）报错
   的共性问题。
2. P1级（题目认知障碍）：大面积向AI询问题意，说明题目设计可能超出了
   学生的最近发展区(ZPD)。
3. P2级（学习策略/高危个体）：过度依赖AI、或连续提交失败导致严重
   挫败感的学生。

【处理边缘情况】
- 如果发现的问题很少或通过率极高，将重点转向"培优建议"（推荐进阶挑战）
  和肯定教学成果。
- 必须基于给定的JSON数据说话，严禁捏造数据或比例。
- 如果"教学上下文"中标注"教学目标未提供"，则退回纯数据驱动分析：
  只报告客观现象和建议的教学动作，不做"是否偏离教学目标"的判断。

【输出格式要求】
请严格按照以下Markdown结构输出，不要输出多余的寒暄：

### 📊 班级学情诊断结论
（1-2句话总结本次作业整体达成情况）

### 🚨 核心教学建议 (按优先级排序)
- **[P0/P1/P2] {问题简述}** (受影响人数/比例)：
  - **教学动作**：{具体且可执行的动作}

User:
## 教学上下文
作业标题：{tdoc.title}
作业介绍：{tdoc.content || '未提供'}
教师补充教学重点：{teachingFocus || '教学目标未提供'}
参与情况：{participatedStudents}/{totalStudents} (共 {problemCount} 题)
其中 {aiUserCount} 名学生使用了AI助手

## 规则引擎异常发现 (JSON)
{findings_JSON}
```

### 7.2 深潜 Prompt（3b：单点问题下钻诊断）

```
System:
你是一位擅长认知诊断的编程教育专家。分析特定题目的异常数据、代码切片
和AI交互日志，为教师提供深度微观诊断和课堂干预素材。

【分析维度：布卢姆认知层级】
判断学生主要卡在哪个认知层级：
- 记忆/理解层：看不懂题意，或忘记了基本语法结构。
- 应用层：理解逻辑，但无法用代码正确实现（如边界条件遗漏）。
- 分析/评价层：算法超时（TLE），无法分析时间复杂度并优化。

【处理边缘情况】
如果代码样本看起来完善，但AI对话显示学生在索要完整代码或频繁询问
低级问题，优先判定为"学习策略与元认知问题（过度依赖）"，而非知识问题。

【输出格式要求】
严格按照以下Markdown结构输出：

### 🧠 认知障碍诊断
（学生卡在哪个布卢姆认知层级，根本原因：前置知识薄弱还是缺乏特定思维图式？）

### 🔍 典型误区还原
（结合代码或对话样本，指出学生脑海中错误的思维逻辑）

### 🛠️ 教学干预与脚手架 (Scaffolding)
1. **反例设计**：一组能打破学生错误逻辑的测试数据（Input/Output）
2. **提问设计**：1-2个引导学生自主发现错误的启发式提问（Socratic Questioning）

User:
## 异常上下文
问题描述：{finding.title}
影响面：{affectedStudents}人 ({severity})

## 题目信息
{problem_content}

## 证据样本
【代表性错误代码 (节选)】
{code_samples}

【代表性AI辅导对话 (节选)】
{conversation_samples}

## 统计数据
{metrics}
```

## 8. 前端设计

### 8.1 双入口

**入口 1：作业成绩表页面**
与"生成学习总结"按钮并列，操作后展示该次作业的教学建议。

**入口 2：AI 助手后台 — 新增"教学总结回顾"Tab**

```
[概览] [对话管理] [数据分析] [教学总结回顾] [费用分析] [设置]
```

### 8.2 单次教学建议页面（概览→清单→下钻）

**概览条：** 参与学生数、发现问题总数、高优先数量

**问题发现清单（按优先级排序）：**
- 每条显示：维度标签、问题简述、涉及人数、"查看详情"入口
- 按 高优先（红）/ 中优先（黄）/ 低优先（绿）分组

**AI 教学建议（整体）：** LLM 生成的结构化建议（3a 输出）

**下钻详情页（点击"查看详情"展开）：**
- 统计面板：提交分布、平均尝试次数、平均 AC 耗时
- AI 深潜分析：认知障碍诊断、典型误区还原、教学干预脚手架（3b 输出）
- 涉及学生列表：姓名、提交次数、最终状态、AI 对话轮次（可点击跳转到对话记录）
- 代表性代码样本：默认匿名化，可选显示姓名

### 8.3 教学总结回顾页面

**时间线列表：** 当前域下所有已生成的教学总结，按时间倒序，每条显示摘要（发现数量、关键问题），点击进入详情。

**筛选：** 按作业名称、严重级别、时间范围过滤。

**v2 预留：** 跨作业趋势概览（纵向对比反复出现的问题、持续预警学生、积极趋势），需积累多次教学总结数据后开启。

### 8.4 教师反馈

每份教学建议底部提供 👍/👎 按钮 + 可选文字评论，存入 `ai_teaching_summaries.feedback`，用于未来优化 prompt 和规则阈值。

### 8.5 数据来源提示

页面顶部显示"数据截止时间：{dataSnapshotAt}"。基于 AI 对话数据的维度在 finding 卡片上标注"基于 N 名使用 AI 助手的学生"。

### 8.6 支持导出

支持导出为 PDF/CSV，方便教研记录。

## 9. 权限控制

| 操作 | 所需权限 | 说明 |
|---|---|---|
| 生成教学建议 | `PRIV_EDIT_PROBLEM`（域级教师权限） | 与"查看成绩表"权限一致 |
| 查看教学建议详情 | 同上 | 含下钻、学生列表 |
| 教学总结回顾 Tab | 同上 | 仅看到当前域数据 |
| 删除/重新生成 | `PRIV_EDIT_SYSTEM`（管理员） | 防止误操作 |

## 10. 生成流程

```
老师点击 [生成教学建议]
    │
    ├─ 已存在 → 提示"已存在，是否重新生成？"
    │
    └─ 否则 → 创建 TeachingSummary (status: pending)
              │
              ▼ 后台异步执行
         status → generating
              │
              ├─ 第一层：数据采集聚合
              ├─ 第二层：规则引擎异常检测 → findings[]
              ├─ 第三层a：LLM 生成整体教学建议
              ├─ 第三层b：对 needsDeepDive 的 finding 逐个 LLM 深潜（可并行）
              │
              ▼
         status → completed
         前端轮询检测到完成，展示结果
```

## 11. 路由注册

```typescript
// 教学建议 — 生成与查看
ctx.Route('ai_teaching_summary', '/ai-helper/teaching-summary/:contestId', TeachingSummaryHandler);
ctx.Route('ai_teaching_summary_with_domain', '/d/:domainId/ai-helper/teaching-summary/:contestId', TeachingSummaryHandler);

// 教学总结回顾列表
ctx.Route('ai_teaching_review', '/ai-helper/teaching-review', TeachingReviewHandler);
ctx.Route('ai_teaching_review_with_domain', '/d/:domainId/ai-helper/teaching-review', TeachingReviewHandler);
```

## 12. 错误处理

- **LLM 调用失败：** finding 保留规则引擎的结构化数据，`aiSuggestion` 标记为"生成失败，请重试"
- **深潜失败：** 不影响主报告，该 finding 详情页仅展示统计数据
- **数据不足（参与学生 <10 人）：** 提示"参与人数过少，统计结果可能不具代表性"
- **首次作业（无历史数据）：** 维度 D（高危预警）和 E（难度异常 z-score）自动降级：D 仅报告本次放弃率，不做趋势判断；E 使用绝对通过率 <20% 替代 z-score
- **作业未截止时生成：** 记录 `dataSnapshotAt` 时间戳，页面显示"基于 X 时间点的数据"
- **教学目标缺失：** LLM 退回纯数据驱动分析，不做目标关联诊断

## 13. 成本估算

| 场景 | input token | output token | 估算成本 | 延迟 |
|---|---|---|---|---|
| 主调用（3a） | ~10-20K | ~2K | $0.05-0.15 | 5-10s |
| 深潜（3b）×1-3 次 | ~15K × N | ~1K × N | $0.05-0.15 × N | 5-10s × N |
| 典型总成本 | — | — | $0.10-0.50/次 | 10-30s |

## 14. 设计决策记录

| 决策 | 选择 | 理由 |
|---|---|---|
| 数据边界 | 作业（homework/contest） | 符合现有教学习惯，无需新增"课"实体 |
| 教学目标获取 | 优先自动提取 + 可选手动补充 | 老师已在创建作业时填写；content 为空时提供单行输入框；都无则优雅降级 |
| 输出形式 | 交互式探索（概览→清单→下钻） | Gemini 从认知负荷、精准教学、可执行性、采纳度四维分析推荐 |
| 技术架构 | 规则引擎 + 选择性 LLM 深潜 | 行业验证（Carnegie Learning、Khanmigo、Gradescope）；成本仅为纯 LLM 的 1/30；避免 LLM 捏造数据 |
| v1 维度范围 | 全部 8 个维度（A-H） | 50+ 学生规模支持全量分析；C/G/H 与核心维度共享数据管道，边际成本低 |
| v2 范围 | 仅跨作业趋势概览 | 需先积累多次教学总结数据，首次使用时无历史数据 |
| 错误分类粒度 | v1 按状态码（WA/TLE/RE/CE），细分由深潜 LLM 推断 | record 集合无结构化错误类型；避免依赖不稳定的编译输出文本 |
| "创意解法"检测 | 砍掉 | 需 AST/LLM，成本高且主观，保留"进步趋势"即可 |
| "过度依赖"措辞 | "AI 使用频率偏高" | 避免误判勤奋提问的学生 |
| 最小样本门控 | 每条 finding ≥ 5 人 | 避免小样本虚假告警 |
| 教师反馈闭环 | 👍/👎 + 可选评论 | 为未来优化 prompt 和阈值提供信号 |
| 数据来源标注 | AI 相关维度标注 AI 用户数 | 避免幸存者偏差误导 |
| 抄袭风险提示 | finding 附注提醒 | 高一致性错误可能涉及代码共享，不做抄袭检测 |
| Prompt 教育框架 | 布卢姆认知分类 + ZPD + 形成性评价 | Gemini 从教育学角度推荐，使分析从"数据统计"跃升为"教学诊断" |
