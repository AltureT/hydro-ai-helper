# Teaching Analysis Full Redesign — UI + Data Pipeline + LLM Prompt

**Date:** 2026-04-12
**Scope:** Full redesign (UI, rule engine, LLM prompt)
**Status:** Approved

---

## 1. Overview

Redesign the teaching analysis feature across three layers:

1. **Frontend** — Native-first integration with HydroOJ UI, 60/40 split layout
2. **Rule Engine** — Richer data extraction, error clustering, temporal behavior patterns, cross-dimensional correlation
3. **LLM Prompt** — Actionable classroom instructions anchored in specific code/problems

### Design Principles

- Plugin should feel like a native HydroOJ feature, not an external add-on
- Analysis output must be "usable in tomorrow's class" — no generic advice
- Statistical conclusions must have sample-size guardrails
- Token budget: compress to diagnostics, not raw code

### Academic References

- **SOLO Taxonomy** — cognitive level classification more suitable than Bloom's for programming
- **Neo-Piagetian Theory** (Lister 2011) — detecting "pre-operational stage" via submission patterns
- **OverCode (MIT)** — automated code clustering for error pattern discovery
- **ProgSnap2** — educational data interchange standard
- **Evidence-based interventions**: Parsons Problems, Worked Examples, Peer Instruction, Subgoal Labeling

---

## 2. Frontend Redesign

### 2.1 Tab Bar — Native Integration

**Current:** Custom blue tab bar with `COLORS.primary` (#2563eb), visually separated from HydroOJ's `.section__header` and export buttons.

**New design:**

- Tab items: plain text + 2px bottom border, **green accent** (`#21ba45`) for active tab
- Remove blue background/border styling from tab buttons
- Remove `backgroundColor: COLORS.bgPage` and `borderRadius` from tab container
- Badge: gray background by default, green when active (not blue)
- Export buttons: integrated into tab bar right side, visible only on Scoreboard tab
- Transition: panel switch with `opacity 0→1 + translateY(4px→0)`, `200ms ease-out`

**CSS class convention:**
```css
.ai-helper-tabs { border-bottom: 1px solid #ddd; display: flex; justify-content: space-between; align-items: flex-end; }
.ai-helper-tab-item { padding: 10px 15px; border-bottom: 2px solid transparent; color: #666; }
.ai-helper-tab-item.active { border-bottom-color: #21ba45; color: #000; font-weight: bold; }
```

**Files to modify:**
- `frontend/components/ScoreboardTabContainer.tsx` — tab styling, export button integration, transition animation
- `frontend/utils/styles.ts` — add HydroOJ-native color tokens

### 2.2 Teaching Analysis Page — 60/40 Split Layout

**Current:** Vertical flow with colorful stat cards, red/yellow/green severity blocks.

**New layout:**

```
┌──────────────────────────────────────────────────────────────────┐
│  AI 教学分析                    数据快照: ...        [重新生成]  │
├──────────────────────────────────────────────────────────────────┤
│  参与学生 94    发现项 2    高优先级 0    AI使用者 0             │
│  (inline text, no colored card backgrounds)                     │
├────────────────────────────┬─────────────────────────────────────┤
│      Main Column (60%)     │       Sidebar (40%)                 │
│                            │                                     │
│  ┌─ 教学发现 ────────────┐ │  ┌─ AI 教学建议 ──────────────────┐│
│  │ [high] left-3px-red   │ │  │ left-4px-green border          ││
│  │ [medium] left-3px-org │ │  │ default EXPANDED               ││
│  │ [low] left-3px-green  │ │  │ structured: diagnosis →        ││
│  └───────────────────────┘ │  │ action plan → individuals      ││
│                            │  │                                 ││
│                            │  │        [有帮助] [没帮助]        ││
│                            │  └─────────────────────────────────┘│
└────────────────────────────┴─────────────────────────────────────┘
```

**Stat bar (top):**
- Remove colored card backgrounds entirely
- Inline text: label in `12px #94a3b8` + number in `18px 700 #1e293b`
- High priority count turns red `#dc2626` when > 0, no background color blocks

**Finding cards (main column):**
- White background + left 3px color bar (high: `#dc2626`, medium: `#d97706`, low: `#16a34a`)
- Remove full-background severity coloring
- Severity label as small inline badge (text + rounded border), not full-color pill
- Expanded area: standard table style for metrics, clean markdown for deep dive

**AI Suggestion (sidebar):**
- Default **expanded** (not collapsed)
- Container: white bg + left 4px green border (`#21ba45`) + light shadow
- Content: structured markdown (diagnosis → action plan → individual intervention)
- Feedback buttons: ghost style (gray border + small text), bottom-right aligned
- `position: sticky; top: 16px` for scroll-following

**Responsive:**
- Below 768px: sidebar collapses below main column, full-width vertical flow

**Files to modify:**
- `frontend/teachingSummary/TeachingSummaryPanel.tsx` — layout restructure, style changes
- `frontend/utils/styles.ts` — new HydroOJ-native tokens and component styles

---

## 3. Rule Engine Improvements

### 3.1 Extended RecordDoc Interface

Add fields already available in HydroOJ's `record` collection but not currently read:

```typescript
interface RecordDoc {
  // existing
  _id: any; domainId: string; pid: number; uid: number;
  status: number; score?: number; judgeAt?: Date; code?: string;
  // NEW fields to read
  lang?: string;
  time?: number;       // runtime ms
  memory?: number;     // memory KB
  testCases?: Array<{
    id?: number; subtaskId?: number; score?: number;
    time?: number; memory?: number; status?: number;
    message?: string | { message?: string; params?: string[] };
  }>;
  compilerTexts?: string[];
  judgeTexts?: Array<string | { message?: string; params?: string[] }>;
}
```

**MongoDB projection in `fetchRecords()`** must add these fields. Use `testCases: { $slice: 80 }` and `compilerTexts: { $slice: -3 }` to limit payload.

### 3.2 Error Clustering Dimension (Phase 1)

**Algorithm: signature-based clustering** (status + failing test case IDs + normalized compiler error)

```typescript
function errorSignature(record: RecordDoc): string {
  if (record.status === 7 && record.compilerTexts?.length) {
    return `CE:${normalizeCompilerError(record.compilerTexts[0])}`;
  }
  const failingTests = (record.testCases || [])
    .filter(tc => tc.status !== 1)
    .map(tc => tc.id)
    .sort()
    .join(',');
  return `${STATUS_LABEL[record.status] || record.status}:tests[${failingTests}]`;
}

function normalizeCompilerError(msg: string): string {
  return msg
    .replace(/line \d+/gi, 'line N')
    .replace(/column \d+/gi, 'col N')
    .replace(/'[a-zA-Z_]\w*'/g, "'VAR'")
    .replace(/\/[\w\/]+\.\w+/g, 'FILE')
    .split('\n')[0];
}
```

**Output:** `ErrorCluster { signature, statusLabel, failingTestIds, normalizedError, affectedStudents, ratio, sampleSubmissionIds }`

**Threshold:** cluster ratio > 0.30 of total students → finding generated.

### 3.3 Temporal Behavior Pattern Dimension (Phase 2)

**Feature extraction** from submission sequence `[(timestamp, status)]` per `(uid, pid)`:

| Feature | Calculation |
|---|---|
| `totalSubmissions` | count |
| `totalActiveMinutes` | (last - first timestamp) in minutes |
| `medianInterval` | median of inter-submission intervals (seconds) |
| `burstCount` | segments with 3+ submissions < 60s apart |
| `distinctSessions` | intervals > 30min = session boundary |
| `firstACIndex` | submission index of first AC (null if never) |
| `timeSinceLastSubmit` | hours from last submission to contest deadline |

**Classification rules:**

| Pattern | Rule | Teaching Implication |
|---|---|---|
| `strategic_solver` | firstACIndex ≤ 3 | No intervention needed |
| `disengaged` | totalSubmissions ≤ 2, finalStatus ≠ AC, timeSinceLastSubmit > 24h | Confirm objective reasons first |
| `burst_then_quit` | burstCount ≥ 1, finalStatus ≠ AC, timeSinceLastSubmit > 2h | Needs emotional support, confidence building |
| `stuck_silent` | totalSubmissions ≥ 8, finalStatus ≠ AC, no AI conversation | Teacher proactive intervention |
| `persistent_learner` | distinctSessions ≥ 2, statusTransitions ≥ 2 | Has motivation, needs method/tools |

**Threshold rationale:**
- 60s burst: "change one line and resubmit" takes 30-90s; below 60s = no substantial thinking
- 30min session: industry standard (Google Analytics session timeout)
- 8 submissions stuck: average AC is 3-5 attempts; 8+ without AC = stuck

### 3.4 Cross-Dimensional Correlation (Phase 2)

**Priority pairs:**

| Pair | Join Logic | Output |
|---|---|---|
| commonError × aiConversation | For students in same error cluster, split by hasAIConversation, compare subsequent AC rate | "AI辅导对 RE(SIGSEGV) 错误有效率72% vs 未用AI仅18%" |
| atRisk × temporalPattern | For atRisk students, classify by behavior pattern | "10名高危中: 4名persistent, 3名burst_then_quit, 3名disengaged" |
| difficulty × errorCluster | For low-pass-rate problems, show top error cluster | "T3通过率12%, 87%失败在测试点#3 (大数据量输入)" |

**Small sample guard:** any group < 5 students → do not report statistical comparison. Groups 5-15 → mark as "low confidence".

### 3.5 Class Size Strategy

| Size | Strategy | Disabled Dimensions |
|---|---|---|
| < 10 | Individual analysis only, per-student narrative | commonError, aiEffectiveness, difficulty |
| 10-20 | Mixed, relaxed thresholds (minAffected=3, ratio=0.25) | aiEffectiveness (if AI users < 5) |
| 20-100 | Full statistical analysis | None |
| > 100 | Full + quartile grouping, anonymized output | None |

### 3.6 Problem Context Attachment (Phase 1)

Read problem title + content (truncated to 500 chars) from `document` collection during analysis. Pass as structured field to LLM.

Already available in `teachingSummaryHandler.ts` for deep dive — extend to overall suggestion.

### 3.7 Code Fill-in-the-Blank Exercise Generation (Phase 2)

Generate "code with blanks" exercises from representative AC submissions, so teachers can use them for post-class consolidation practice.

#### Trigger Conditions

A fill-in exercise is generated for a problem ONLY when ALL conditions are met:

```
✅ Problem has a commonError finding (clear knowledge gap identified)
✅ Final AC rate < 90% OR average submission count ≥ 2
✅ First-attempt AC rate ≤ 70% (most students didn't get it right immediately)
❌ Skip if all above conditions not met — students already mastered it
```

#### Fill-in-the-blank Problem Detection

If the problem itself is a fill-in-the-blank format (code template with blanks):
- Detect by checking problem content for placeholder patterns: `___`, `???`, `/* your code here */`, `// TODO`, `____`
- Compare AC code against problem content to identify the "template region" (code given by the teacher) vs "student-written region"
- Blanking must ONLY target student-written code, never the template region
- If >80% of the AC code overlaps with the problem template, the blanking positions must be chosen from the remaining 20%

#### AC Code Selection Strategy

Default: **auto-select with manual override**.

**Auto-selection algorithm:**
1. Collect all AC submissions for the problem
2. Filter: remove submissions with code length in bottom 10% (too short / tricky) or top 10% (too verbose)
3. Score remaining by readability heuristics:
   - Has meaningful variable names (not single letters except `i`, `j`, `n`) → +1
   - Has comments → +1
   - Function/method structure (not all in main) → +1
   - Moderate line count (within 1 std dev of median) → +1
4. Select top-scored submission as default
5. Also prepare 2 runner-up alternatives for teacher to switch to

**Teacher override UI:** In the finding card's expanded area, show the auto-selected code with a "切换代码" dropdown listing 2 alternatives with preview.

#### Blanking Position Logic

LLM receives the selected AC code + the error cluster data, and generates:

1. **Blanked lines** — the specific lines to remove, chosen based on:
   - Lines that correspond to the error cluster's knowledge gap (e.g., if students forgot to save `next` pointer, blank that line)
   - Typically 2-4 lines blanked per exercise (not too many, not too few)
2. **Blank hints** — optional one-line hint per blank (e.g., "// 保存当前节点的下一个节点")
3. **Expected answers** — the correct code for each blank
4. **Difficulty note** — which blank is hardest based on error cluster data

#### Output Format (in LLM suggestion)

Added to the P0 action plan as a new section:

```
#### 📝 课后巩固：代码挖空练习

**题目：{pid}. {title}**
**挖空原因**：错误聚类显示 {N}% 的失败提交在{具体知识点}上出错

**练习模板**（基于学生 AC 代码）：
```{lang}
ListNode* reverse(ListNode* head) {
    ListNode* prev = NULL;
    while (head) {
        ______________________  // 提示：保存当前节点的下一个节点
        head->next = prev;
        prev = head;
        ______________________  // 提示：移动到下一个节点
    }
    return prev;
}
```

**参考答案**：
- 空1：`ListNode* next = head->next;`
- 空2：`head = next;`
```

#### Data Flow

1. **teachingAnalysisService** — for each problem with commonError finding, check trigger conditions, select AC code candidates
2. **teachingSummaryHandler** — pass selected AC code + error cluster to suggestion service
3. **teachingSuggestionService** — LLM generates blanking positions and hints as part of the teaching action plan
4. **Frontend (TeachingSummaryPanel)** — render exercise template in finding card, show code selector dropdown for teacher override

---

## 4. LLM Prompt Restructuring

### 4.1 System Prompt (Overall Suggestion)

```
你是一位教龄15年的编程课教师，同时负责教学教研。你将根据规则引擎提供的【带有具体错误诊断和题目信息的】课堂分析数据，为授课教师生成"明天上课就能直接用"的教学行动方案。

【核心约束】
- 每条建议必须包含教师在课堂上"说什么/做什么/展示什么"的具体描述
- 禁止出现"进行个别辅导""加强练习""注意边界条件"等无行动细节的泛化建议
- 所有建议必须锚定在数据中的具体题目、具体错误模式上
- 当数据标注为"low_confidence"或"insufficient_data"时，明确说明"数据有限，以下建议仅供参考"

【优先级框架】
P0 — 全局知识缺陷：>20%学生犯同一类错误（有具体错误签名和测试点信息）
P1 — 题目认知障碍：大量理解类AI提问，或通过率极低但非难度问题
P2 — 个体干预：按行为模式分类（persistent_learner / burst_then_quit / stuck_silent / disengaged）

【可推荐的教学干预方法】（根据诊断结果选用）
- Parsons Problems（帕森斯题目）：让学生排列代码块而非从零写，减少语法负担
- Worked Examples（样例学习）：展示完整解题过程，标注每步的子目标
- Peer Instruction（同伴教学）：让AC学生分享思路，教师引导讨论
- Socratic Questioning（苏格拉底式提问）：用问题引导学生自行发现错误
- Code Fill-in-the-Blank（代码挖空练习）：基于学生AC代码，挖空错误高发位置让学生重做巩固

【代码挖空练习规则】
- 仅当该题存在commonError发现、且首次提交AC率≤70%时生成
- 如果题目本身是填空形式，挖空位置必须避开题目模板代码，仅在学生自写部分挖空
- 每题挖2-4个空，锚定在错误聚类对应的知识盲点上
- 提供每个空位的提示和参考答案

【输出格式】严格遵循：

### 📊 一句话诊断
{一句话点明核心教学问题，引用具体数据}

### 🚨 教学行动方案

#### [P0] {问题名称} — 影响 {N}人/{百分比}
**错误现象**：{具体错误模式，引用错误签名和测试点信息}
**根因分析**：{知识盲点定位}
**课堂行动（X分钟）**：
1. **开场提问**："{可直接念出的提问}"
2. **演示/板书**：{具体演示什么}
3. **修正模板**：{正确做法}
4. **当堂检验**：{变式练习题}

#### 📝 课后巩固：代码挖空练习
（仅当触发条件满足时生成，见§3.7）
**题目：{pid}. {title}**
**挖空原因**：{错误聚类对应的知识盲点}
**练习模板**：{AC代码，关键行替换为空白+提示}
**参考答案**：{每个空的正确代码}

#### [P2] 个体干预建议
| 行为模式 | 人数 | 建议动作 |
|---|---|---|
| persistent_learner | N | {具体建议} |
| burst_then_quit | N | {具体建议} |
| stuck_silent | N | {具体建议} |
| disengaged | N | {具体建议} |
```

### 4.2 User Prompt Data Format

**Token budget: ~4000 tokens for user prompt.**

```
## 班级概况
竞赛标题：{title}
教学目标：{focus or "未提供"}
总人数：N，参与：N，AI使用：N，题目数：N

## 题目分析（按难度排序，最多5题）
### {pid}. {title} (通过率 X%)
- 主要错误：{错误签名} — N人 (X%)
- 次要错误：{错误签名} — N人 (X%)
- AI效果：用AI学生通过率X% vs 未用X%（如有足够样本）

## 学生群体
- **高危-持续努力型**（N人）：平均提交X次，无AC，代表：张三、李四
- **高危-受挫放弃型**（N人）：前15分钟密集提交后停止
- **高危-沉默型**（N人）：≥8次提交但从未求助AI
- **完成全部**（N人，X%）

## 关键发现（最多2条）
- {跨维度关联洞察}

## 代表性错误代码（仅1份，最关键的错误模式）
```{lang}
{15行关键代码片段}
```
错误说明：{预分析的错误描述}
```

**Core principle: send diagnostics, not raw code.** One error cluster summary line replaces 10+ raw submissions (20 tokens vs 200-500 tokens each = 10-25x compression).

### 4.3 Deep Dive Prompt Update

Add `课堂行动（5-10分钟）` section to output format, aligned with overall suggestion structure:

```
### 🛠️ 教学干预与脚手架 (Scaffolding)
1. **反例设计**：{测试数据 Input/Output}
2. **提问设计**：{启发式提问}
3. **课堂行动（5-10分钟）**：
   - 开场提问："{具体问题}"
   - 演示内容：{具体步骤}
   - 推荐方法：{Parsons Problems / Worked Examples / Peer Instruction}
```

---

## 5. Implementation Phases

### Phase 1 (1-2 days) — Quick Wins

1. **Frontend: Tab restyling** — green accent, native HydroOJ look
2. **Frontend: Stat bar simplification** — remove colored cards, inline text
3. **Frontend: Suggestion default expanded** — remove collapse, add green left border
4. **Backend: Extend RecordDoc** — add testCases, compilerTexts, judgeTexts to fetchRecords()
5. **Backend: Error signature clustering** — new `analyzeErrorCluster()` dimension
6. **Backend: Problem context** — attach title+content to overall suggestion prompt
7. **Backend: Prompt rewrite** — new system prompt with classroom action format

### Phase 2 (3-5 days) — Deeper Analysis

8. **Frontend: 60/40 split layout** — main column + sticky sidebar
9. **Frontend: Finding card restyling** — white bg + left color bar
10. **Frontend: Responsive breakpoint** — <768px collapse to vertical
11. **Frontend: Code fill-in exercise UI** — render exercise template in finding card, AC code selector dropdown for teacher override
12. **Backend: Temporal behavior pattern** — feature extraction + 5-way classification
13. **Backend: Cross-dimensional correlation** — atRisk×temporal, commonError×AI
14. **Backend: Class size strategy** — adaptive dimension enabling
15. **Backend: Small sample guards** — minimum sample sizes, confidence annotations
16. **Backend: Code fill-in exercise generation** — AC code selection, trigger conditions, fill-in-the-blank problem detection, pass to LLM

### Phase 3 (1-2 weeks) — Refinement (future iteration)

15. Code evolution analysis (inter-submission diff)
16. Code anonymization pipeline for LLM
17. Few-shot teaching action template library
18. AST-based code clustering (optional, if signature clustering proves insufficient)

---

## 6. Files Affected

### Frontend
- `frontend/components/ScoreboardTabContainer.tsx` — tab styling, transitions, export button integration
- `frontend/teachingSummary/TeachingSummaryPanel.tsx` — 60/40 layout, stat bar, finding cards, suggestion section, code fill-in exercise UI with AC code selector
- `frontend/utils/styles.ts` — new HydroOJ-native design tokens

### Backend
- `src/services/teachingAnalysisService.ts` — RecordDoc extension, error clustering, temporal patterns, cross-correlation, class size strategy, AC code selection for fill-in exercises
- `src/services/teachingSuggestionService.ts` — prompt rewrite, data compression, problem context, fill-in exercise generation prompt
- `src/handlers/teachingSummaryHandler.ts` — pass extended data to suggestion service, fill-in trigger condition checks
- `src/models/teachingSummary.ts` — extended TeachingFinding types for new dimensions

### Types
- `src/models/teachingSummary.ts` — new FindingDimension values, ErrorCluster interface, TemporalPattern interface, FillInExercise interface
