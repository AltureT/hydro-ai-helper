# Teaching Analysis Redesign — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the teaching analysis frontend to match HydroOJ's native look (green theme, simplified stats), rewrite the LLM prompt for actionable suggestions, and add error clustering with richer data extraction.

**Architecture:** Phase 1 splits into 1a (frontend + prompt, ~1 day) and 1b (data pipeline, ~2 days). Frontend changes are CSS/style-only — no layout restructure yet (60/40 split is Phase 2). Backend adds split MongoDB queries and a new error clustering analyzer.

**Tech Stack:** TypeScript, React 17 (JSX inline styles), MongoDB aggregation pipelines, Jest for testing.

**Spec:** `docs/superpowers/specs/2026-04-12-teaching-analysis-redesign.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `frontend/utils/styles.ts` | Add HydroOJ-native color tokens |
| Modify | `frontend/components/ScoreboardTabContainer.tsx` | Tab green accent, ARIA, keyboard nav |
| Modify | `frontend/teachingSummary/TeachingSummaryPanel.tsx` | Stat bar, finding cards, suggestion styling |
| Modify | `src/models/teachingSummary.ts` | Extended types: FindingDimension, ErrorCluster |
| Modify | `src/services/teachingSuggestionService.ts` | New system prompt + user prompt format |
| Modify | `src/services/teachingAnalysisService.ts` | Split queries, integrate error clustering |
| Create | `src/services/analyzers/errorClusterAnalyzer.ts` | Error signature + clustering logic |
| Modify | `src/handlers/teachingSummaryHandler.ts` | Pass problem context to overall suggestion |
| Modify | `src/__tests__/services/teachingSuggestionService.test.ts` | Test new prompt format |
| Create | `src/__tests__/services/analyzers/errorClusterAnalyzer.test.ts` | Test error signatures + clustering |

---

## Phase 1a — Frontend + Prompt

### Task 1: Add HydroOJ-native color tokens to styles.ts

**Files:**
- Modify: `frontend/utils/styles.ts`

- [ ] **Step 1: Add green accent and native tokens**

In `frontend/utils/styles.ts`, add to the `COLORS` object after the existing `codeBorder` line:

```typescript
// After line 40 (codeBorder)
  // HydroOJ native integration colors
  hydroGreen: '#21ba45',
  hydroGreenLight: '#e8f5e9',
  hydroGreenDark: '#1a9c39',
  nativeText: '#333333',
  nativeBorder: '#dddddd',
  nativeHeaderBg: '#f9fafb',
```

- [ ] **Step 2: Build to verify no errors**

Run: `npm run build:plugin`
Expected: clean build, 0 errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/utils/styles.ts
git commit -m "feat: add HydroOJ-native color tokens for green theme"
```

---

### Task 2: Restyle Tab Bar — green accent + ARIA

**Files:**
- Modify: `frontend/components/ScoreboardTabContainer.tsx`

- [ ] **Step 1: Replace tab styling function**

Replace `getTabItemStyle` function (lines 87-105) with:

```typescript
function getTabItemStyle(isActive: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '10px 15px',
    fontSize: '14px',
    fontWeight: isActive ? 700 : 400,
    color: isActive ? '#000000' : '#666666',
    backgroundColor: 'transparent',
    border: 'none',
    borderBottom: isActive ? '2px solid #21ba45' : '2px solid transparent',
    cursor: 'pointer',
    outline: 'none',
    whiteSpace: 'nowrap',
    transition: 'all 200ms ease',
    lineHeight: 1.5,
  };
}
```

- [ ] **Step 2: Update tab bar container styles**

Replace the tab bar container div style (lines 196-205) — remove `backgroundColor`, `borderRadius`, and `padding`:

```typescript
<div style={{
  display: 'flex',
  alignItems: 'stretch',
  borderBottom: '1px solid #dddddd',
  marginBottom: SPACING.base,
  overflowX: 'auto',
}}>
```

- [ ] **Step 3: Update badge colors**

Replace the badge `<span>` style (lines 216-228) — gray default, green when active:

```typescript
<span style={{
  fontSize: '11px',
  fontWeight: 600,
  backgroundColor: isActive ? '#21ba45' : '#94a3b8',
  color: '#ffffff',
  padding: '1px 7px',
  borderRadius: RADIUS.full,
  minWidth: '18px',
  textAlign: 'center',
  lineHeight: '16px',
}}>
  {tab.badge}
</span>
```

- [ ] **Step 4: Add ARIA attributes to tab list**

Add `role="tablist"` to the tab bar container div:

```typescript
<div role="tablist" style={{
  display: 'flex',
  // ... same as step 2
}}>
```

Add `role="tab"`, `aria-selected`, and `aria-controls` to each tab button:

```typescript
<button
  key={tab.id}
  role="tab"
  aria-selected={isActive}
  aria-controls={`tabpanel-${tab.id}`}
  onClick={() => switchTab(tab.id)}
  style={getTabItemStyle(isActive)}
>
```

- [ ] **Step 5: Add keyboard navigation**

Add `onKeyDown` handler to the tab bar container. Place this callback after the `switchTab` callback (~line 153):

```typescript
const handleTabKeyDown = useCallback((e: React.KeyboardEvent) => {
  const currentIndex = tabsList.findIndex(t => t.id === activeTab);
  let nextIndex = currentIndex;
  if (e.key === 'ArrowRight') {
    nextIndex = (currentIndex + 1) % tabsList.length;
  } else if (e.key === 'ArrowLeft') {
    nextIndex = (currentIndex - 1 + tabsList.length) % tabsList.length;
  } else {
    return;
  }
  e.preventDefault();
  switchTab(tabsList[nextIndex].id);
}, [activeTab, tabsList, switchTab]);
```

Add `onKeyDown={handleTabKeyDown}` to the tab bar container div.

- [ ] **Step 6: Add role="tabpanel" and transition to content panels**

Wrap each tab panel div with `role="tabpanel"` and `id`:

```typescript
{/* Teaching Analysis tab */}
{isTeacher && mountedTabs.has(TABS.TEACHING) && (
  <div
    role="tabpanel"
    id="tabpanel-TEACHING"
    style={{
      display: activeTab === TABS.TEACHING ? 'block' : 'none',
      animation: activeTab === TABS.TEACHING ? 'fadeSlideIn 200ms ease-out' : 'none',
    }}
  >
    <TeachingSummaryPanel ... />
  </div>
)}
```

Do the same for the LEARNING tab panel. Add a `<style>` tag for the animation keyframe:

```typescript
<style>{`@keyframes fadeSlideIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }`}</style>
```

- [ ] **Step 7: Build and verify**

Run: `npm run build:plugin`
Expected: clean build.

- [ ] **Step 8: Commit**

```bash
git add frontend/components/ScoreboardTabContainer.tsx
git commit -m "feat: restyle tabs with green accent, ARIA attributes, keyboard navigation"
```

---

### Task 3: Simplify stat bar and restyle finding cards + suggestion

**Files:**
- Modify: `frontend/teachingSummary/TeachingSummaryPanel.tsx`

- [ ] **Step 1: Replace OverviewBar with inline stats**

Replace the entire `OverviewBar` component (lines 208-239) with:

```typescript
const OverviewBar: React.FC<OverviewBarProps> = ({ stats, findingsCount, highCount }) => (
  <div style={{
    display: 'flex', flexWrap: 'wrap', gap: SPACING.lg,
    marginBottom: SPACING.base,
    padding: `${SPACING.sm} 0`,
  }}>
    {[
      { label: t('ai_helper_teaching_summary_participated'), value: stats.participatedStudents },
      { label: t('ai_helper_teaching_summary_findings'), value: findingsCount },
      { label: t('ai_helper_teaching_summary_high_priority'), value: highCount, highlight: highCount > 0 },
      { label: t('ai_helper_teaching_summary_ai_users'), value: stats.aiUserCount },
    ].map(({ label, value, highlight }) => (
      <span key={label} style={{ display: 'inline-flex', alignItems: 'baseline', gap: '4px' }}>
        <span style={{ fontSize: '12px', color: '#94a3b8' }}>{label}</span>
        <span style={{
          fontSize: '18px', fontWeight: 700,
          color: highlight ? '#dc2626' : '#1e293b',
        }}>
          {value}
        </span>
      </span>
    ))}
  </div>
);
```

- [ ] **Step 2: Restyle FindingCard — white bg + left color bar**

Replace the FindingCard's outer `<div>` style (lines 84-90) with:

```typescript
<div style={{
  backgroundColor: '#ffffff',
  borderLeft: `3px solid ${colors.text}`,
  border: `1px solid ${COLORS.border}`,
  borderLeftWidth: '3px',
  borderLeftColor: colors.text,
  borderRadius: RADIUS.md,
  marginBottom: SPACING.sm,
  overflow: 'hidden',
}}>
```

Replace the dimension badge style (lines 101-108) — smaller inline badge:

```typescript
<span style={{
  fontSize: '11px', fontWeight: 500, padding: '1px 6px',
  borderRadius: RADIUS.sm,
  border: `1px solid ${colors.text}`,
  color: colors.text,
  backgroundColor: 'transparent',
  flexShrink: 0,
}}>
  {dimensionLabel}
</span>
```

- [ ] **Step 3: Make suggestion default expanded and restyle**

Change `suggestionExpanded` initial state from `false` to `true`:

```typescript
const [suggestionExpanded, setSuggestionExpanded] = useState(true);
```

Replace the suggestion container style (lines 503-509) with green left border:

```typescript
<div style={{
  borderLeft: '4px solid #21ba45',
  border: `1px solid ${COLORS.border}`,
  borderLeftWidth: '4px',
  borderLeftColor: '#21ba45',
  borderRadius: RADIUS.md,
  marginBottom: SPACING.base,
  overflow: 'hidden',
  boxShadow: SHADOWS.sm,
}}>
```

Replace the suggestion header style (lines 514-518) — lighter background:

```typescript
style={{
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: `${SPACING.sm} ${SPACING.base}`,
  cursor: 'pointer', userSelect: 'none',
  backgroundColor: '#f0fdf4',
  borderBottom: suggestionExpanded ? `1px solid ${COLORS.border}` : 'none',
}}
```

Change the suggestion title color to green:

```typescript
<span style={{ fontWeight: 600, fontSize: '14px', color: '#1a9c39' }}>
```

- [ ] **Step 4: Restyle feedback buttons to ghost style**

Replace the feedback buttons section (lines 552-571). Change button styles:

```typescript
<button
  onClick={() => handleFeedback('up')}
  style={{
    fontSize: '12px', padding: '3px 8px',
    border: '1px solid #e2e8f0',
    borderRadius: RADIUS.sm,
    backgroundColor: 'transparent',
    color: summary.feedback?.rating === 'up' ? '#16a34a' : '#94a3b8',
    cursor: 'pointer',
  }}
>
  👍 {t('ai_helper_teaching_summary_feedback_helpful')}
</button>
```

Same pattern for the down button (color: `'#dc2626'` when active).

- [ ] **Step 5: Build and verify**

Run: `npm run build:plugin`
Expected: clean build.

- [ ] **Step 6: Commit**

```bash
git add frontend/teachingSummary/TeachingSummaryPanel.tsx
git commit -m "feat: simplify stat bar, restyle findings and suggestion with green theme"
```

---

### Task 4: Rewrite LLM System Prompt

**Files:**
- Modify: `src/services/teachingSuggestionService.ts`
- Modify: `src/__tests__/services/teachingSuggestionService.test.ts`

- [ ] **Step 1: Write test for new prompt structure**

In `src/__tests__/services/teachingSuggestionService.test.ts`, add to the `describe('buildMainPrompt')` block:

```typescript
it('should include few-shot quality examples in system prompt', () => {
  const input = makeInput();
  const { system } = buildMainPrompt(input);
  expect(system).toContain('坏例子');
  expect(system).toContain('好例子');
  expect(system).toContain('明天上课就能直接用');
});

it('should include edge case handling in system prompt', () => {
  const input = makeInput();
  const { system } = buildMainPrompt(input);
  expect(system).toContain('培优建议');
  expect(system).toContain('AI 使用数据为 0');
});

it('should include P0/P1/P2 framework with classroom action format', () => {
  const input = makeInput();
  const { system } = buildMainPrompt(input);
  expect(system).toContain('开场提问');
  expect(system).toContain('演示/板书');
  expect(system).toContain('当堂检验');
  expect(system).toContain('persistent_learner');
  expect(system).toContain('burst_then_quit');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/__tests__/services/teachingSuggestionService.test.ts --testNamePattern="few-shot|edge case|classroom action" -v`
Expected: FAIL — current prompt doesn't contain these strings.

- [ ] **Step 3: Replace MAIN_SYSTEM_PROMPT**

In `src/services/teachingSuggestionService.ts`, replace the `MAIN_SYSTEM_PROMPT` constant (lines 11-31) with:

```typescript
const MAIN_SYSTEM_PROMPT = `你是一位教龄15年的编程课教师，同时负责教学教研。你将根据规则引擎提供的【带有具体错误诊断和题目信息的】课堂分析数据，为授课教师生成"明天上课就能直接用"的教学行动方案。

【核心约束】
- 每条建议必须包含教师在课堂上"说什么/做什么/展示什么"的具体描述
- 禁止出现"进行个别辅导""加强练习""注意边界条件"等无行动细节的泛化建议
- 所有建议必须锚定在数据中的具体题目、具体错误模式上
- 当数据标注为"low_confidence"或"insufficient_data"时，明确说明"数据有限，以下建议仅供参考"

【优先级框架】
P0 — 全局知识缺陷：>20%学生犯同一类错误（有具体错误签名和测试点信息）
P1 — 题目认知障碍：大量理解类AI提问，或通过率极低但非难度问题
P2 — 个体干预：按行为模式分类（persistent_learner / burst_then_quit / stuck_silent / disengaged）

【可推荐的教学干预方法】
- Parsons Problems（帕森斯题目）：让学生排列代码块而非从零写，减少语法负担
- Worked Examples（样例学习）：展示完整解题过程，标注每步的子目标
- Peer Instruction（同伴教学）：让AC学生分享思路，教师引导讨论
- Socratic Questioning（苏格拉底式提问）：用问题引导学生自行发现错误

【处理边缘情况】
- 如果全班 AC 率 > 90% 且无 commonError 发现，转为"培优建议"：推荐时空复杂度优化挑战、进阶变式题
- 如果 AI 使用数据为 0（全班未使用 AI），聚焦于提交记录分析，不做 AI 有效性对比
- 必须基于给定数据说话，严禁捏造数据或比例

【质量示例】
- 坏例子（禁止）："加强对边界条件的练习" / "进行个别辅导" / "注意数组越界问题"
- 好例子（要求）："在黑板上画出 n=0 和 n=1 时的执行流程，提问：'当 n=0 时，for 循环执行几次？返回值是什么？'" / "展示学生代码第 8 行 if(n<=1) 应改为 if(n<1)，用测试数据 n=1 验证差异"

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

#### [P2] 个体干预建议
| 行为模式 | 人数 | 建议动作 |
|---|---|---|
| persistent_learner | N | {具体建议} |
| burst_then_quit | N | {具体建议} |
| stuck_silent | N | {具体建议} |
| disengaged | N | {具体建议} |`;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/__tests__/services/teachingSuggestionService.test.ts -v`
Expected: ALL PASS.

- [ ] **Step 5: Build and verify**

Run: `npm run build:plugin`
Expected: clean build.

- [ ] **Step 6: Commit**

```bash
git add src/services/teachingSuggestionService.ts src/__tests__/services/teachingSuggestionService.test.ts
git commit -m "feat: rewrite teaching suggestion prompt for actionable classroom instructions"
```

---

## Phase 1b — Data Pipeline

### Task 5: Extend TeachingSummary types

**Files:**
- Modify: `src/models/teachingSummary.ts`

- [ ] **Step 1: Add new FindingDimension value**

Update `FindingDimension` type (line 11-12) to include `errorCluster`:

```typescript
export type FindingDimension =
  | 'commonError' | 'comprehension' | 'strategy'
  | 'atRisk' | 'difficulty' | 'progress' | 'cognitivePath' | 'aiEffectiveness'
  | 'errorCluster';
```

- [ ] **Step 2: Add ErrorCluster interface**

After the `TeachingFinding` interface (after line 29), add:

```typescript
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
```

- [ ] **Step 3: Build and verify**

Run: `npm run build:plugin`
Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add src/models/teachingSummary.ts
git commit -m "feat: extend TeachingSummary types with errorCluster dimension"
```

---

### Task 6: Create error cluster analyzer

**Files:**
- Create: `src/services/analyzers/errorClusterAnalyzer.ts`
- Create: `src/__tests__/services/analyzers/errorClusterAnalyzer.test.ts`

- [ ] **Step 1: Write tests for errorSignature**

Create `src/__tests__/services/analyzers/errorClusterAnalyzer.test.ts`:

```typescript
import { errorSignature, normalizeCompilerError, analyzeErrorClusters } from '../../../services/analyzers/errorClusterAnalyzer';

describe('errorSignature', () => {
  it('should generate CE signature from compiler text', () => {
    const record = {
      status: 7,
      compilerTexts: ["error: 'x' was not declared in this scope at line 5"],
      testCases: [],
    };
    const sig = errorSignature(record as any);
    expect(sig).toBe("CE:error: 'VAR' was not declared in this scope at line N");
  });

  it('should return CE:unknown when no compiler text', () => {
    const record = { status: 7, compilerTexts: [], testCases: [] };
    expect(errorSignature(record as any)).toBe('CE:unknown');
  });

  it('should generate signature from failing test case IDs', () => {
    const record = {
      status: 2, // WA
      testCases: [
        { id: 1, status: 1 }, // AC
        { id: 2, status: 2 }, // WA
        { id: 3, status: 2 }, // WA
      ],
    };
    expect(errorSignature(record as any)).toBe('WA:tests[2,3]');
  });

  it('should fallback to subtaskId when id is undefined', () => {
    const record = {
      status: 2,
      testCases: [
        { subtaskId: 10, status: 2 },
        { subtaskId: 20, status: 2 },
      ],
    };
    expect(errorSignature(record as any)).toBe('WA:tests[10,20]');
  });

  it('should cap failing tests at 5 and show remainder', () => {
    const record = {
      status: 2,
      testCases: Array.from({ length: 10 }, (_, i) => ({ id: i + 1, status: 2 })),
    };
    const sig = errorSignature(record as any);
    expect(sig).toBe('WA:tests[1,2,3,4,5...+5]');
  });
});

describe('normalizeCompilerError', () => {
  it('should normalize C++ error', () => {
    const msg = "error: 'myVar' was not declared in this scope\n  at /home/user/main.cpp:10";
    const result = normalizeCompilerError(msg);
    expect(result).toBe("error: 'VAR' was not declared in this scope");
    expect(result).not.toContain('myVar');
    expect(result).not.toContain('/home');
  });

  it('should handle Python traceback by taking last line', () => {
    const msg = "Traceback (most recent call last):\n  File \"test.py\", line 5\nTypeError: 'str' object is not callable";
    const result = normalizeCompilerError(msg);
    expect(result).toContain('TypeError');
    expect(result).not.toContain('Traceback');
  });
});

describe('analyzeErrorClusters', () => {
  it('should cluster records by error signature', () => {
    const records = [
      { pid: 1, uid: 1, status: 2, testCases: [{ id: 1, status: 1 }, { id: 2, status: 2 }] },
      { pid: 1, uid: 2, status: 2, testCases: [{ id: 1, status: 1 }, { id: 2, status: 2 }] },
      { pid: 1, uid: 3, status: 2, testCases: [{ id: 1, status: 1 }, { id: 2, status: 2 }] },
      { pid: 1, uid: 4, status: 2, testCases: [{ id: 1, status: 2 }, { id: 2, status: 1 }] },
      { pid: 1, uid: 5, status: 2, testCases: [{ id: 1, status: 1 }, { id: 2, status: 2 }] },
      { pid: 1, uid: 6, status: 2, testCases: [{ id: 1, status: 1 }, { id: 2, status: 2 }] },
    ];
    const totalStudents = 10;
    const findings = analyzeErrorClusters(records as any[], [1], totalStudents);
    // 5 students have same signature WA:tests[2] → 50% > 30% threshold
    expect(findings.length).toBeGreaterThanOrEqual(1);
    const mainFinding = findings.find(f => f !== null);
    expect(mainFinding).toBeDefined();
    expect(mainFinding!.dimension).toBe('errorCluster');
  });

  it('should return empty when cluster ratio below threshold', () => {
    const records = [
      { pid: 1, uid: 1, status: 2, testCases: [{ id: 1, status: 2 }] },
      { pid: 1, uid: 2, status: 2, testCases: [{ id: 2, status: 2 }] },
    ];
    const findings = analyzeErrorClusters(records as any[], [1], 20);
    const nonNull = findings.filter(f => f !== null);
    expect(nonNull.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/__tests__/services/analyzers/errorClusterAnalyzer.test.ts -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the analyzer**

Create directory and file:

```bash
mkdir -p src/services/analyzers
```

Create `src/services/analyzers/errorClusterAnalyzer.ts`:

```typescript
/**
 * Error Cluster Analyzer — groups non-AC submissions by error signature
 * to find common error patterns across students.
 */

import { TeachingFinding } from '../../models/teachingSummary';

const STATUS_LABEL: Record<number, string> = {
  2: 'WA', 3: 'TLE', 4: 'MLE', 5: 'OLE', 6: 'RE', 7: 'CE',
};

const MIN_AFFECTED = 5;

interface ClusterRecord {
  pid: number;
  uid: number;
  status: number;
  testCases?: Array<{ id?: number; subtaskId?: number; status?: number }>;
  compilerTexts?: string[];
  code?: string;
}

export function errorSignature(record: ClusterRecord): string {
  if (record.status === 7) {
    if (record.compilerTexts?.length) {
      return `CE:${normalizeCompilerError(record.compilerTexts[0])}`;
    }
    return 'CE:unknown';
  }
  const failingTests = (record.testCases || [])
    .filter(tc => tc.status !== 1)
    .map(tc => tc.id ?? tc.subtaskId ?? '?')
    .sort()
    .slice(0, 5)
    .join(',');
  const totalFailing = (record.testCases || []).filter(tc => tc.status !== 1).length;
  const suffix = totalFailing > 5 ? `...+${totalFailing - 5}` : '';
  return `${STATUS_LABEL[record.status] || record.status}:tests[${failingTests}${suffix}]`;
}

export function normalizeCompilerError(msg: string): string {
  const lines = msg.split('\n').filter(l => l.trim());
  const errorLine = msg.includes('Traceback') ? lines[lines.length - 1] : lines[0];
  return (errorLine || msg)
    .replace(/line \d+/gi, 'line N')
    .replace(/column \d+/gi, 'col N')
    .replace(/'[a-zA-Z_]\w*'/g, "'VAR'")
    .replace(/\/[\w\/]+\.\w+/g, 'FILE');
}

/**
 * Analyze error clusters for a set of non-AC records.
 * Groups by (pid, errorSignature) and generates findings for clusters > 30% of students.
 */
export function analyzeErrorClusters(
  records: ClusterRecord[],
  pids: number[],
  totalStudents: number,
): (TeachingFinding | null)[] {
  const findings: (TeachingFinding | null)[] = [];
  let counter = 0;

  for (const pid of pids) {
    const pidRecords = records.filter(r => r.pid === pid);

    // Group by (uid, signature) — take the most recent signature per student
    const studentSignatures = new Map<number, string>();
    for (const rec of pidRecords) {
      const sig = errorSignature(rec);
      studentSignatures.set(rec.uid, sig); // last submission wins
    }

    // Count students per signature
    const sigStudents = new Map<string, Set<number>>();
    for (const [uid, sig] of studentSignatures) {
      if (!sigStudents.has(sig)) sigStudents.set(sig, new Set());
      sigStudents.get(sig)!.add(uid);
    }

    const threshold = Math.max(MIN_AFFECTED, Math.ceil(totalStudents * 0.3));

    for (const [sig, uids] of sigStudents) {
      if (uids.size < threshold) continue;

      counter++;
      const statusLabel = sig.split(':')[0];
      const pct = Math.round((uids.size / totalStudents) * 100);

      // Find a sample code snippet
      const sampleRecord = pidRecords.find(r => uids.has(r.uid) && r.code);

      findings.push({
        id: `finding_errorCluster_${counter}`,
        dimension: 'errorCluster',
        severity: uids.size >= totalStudents * 0.5 ? 'high' : 'medium',
        title: `题目 ${pid}：${pct}% 学生遇到相同错误模式 (${statusLabel})`,
        evidence: {
          affectedStudents: Array.from(uids),
          affectedProblems: [pid],
          metrics: {
            affectedCount: uids.size,
            totalStudents,
            percentage: pct,
          },
          samples: sampleRecord?.code ? { code: [sampleRecord.code.slice(0, 500)] } : undefined,
        },
        needsDeepDive: true,
      });
    }
  }

  return findings;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/__tests__/services/analyzers/errorClusterAnalyzer.test.ts -v`
Expected: ALL PASS.

- [ ] **Step 5: Build and verify**

Run: `npm run build:plugin`
Expected: clean build.

- [ ] **Step 6: Commit**

```bash
git add src/services/analyzers/errorClusterAnalyzer.ts src/__tests__/services/analyzers/errorClusterAnalyzer.test.ts
git commit -m "feat: add error cluster analyzer with signature-based grouping"
```

---

### Task 7: Add split queries to teachingAnalysisService

**Files:**
- Modify: `src/services/teachingAnalysisService.ts`

- [ ] **Step 1: Add fetchRecordsForClustering method**

Add after the existing `fetchRecords` method (~line 188):

```typescript
/**
 * Fetch non-AC records with testCases and compilerTexts for error clustering.
 * Separate query to avoid loading heavy fields for all dimensions.
 */
private async fetchRecordsForClustering(input: AnalyzeInput): Promise<any[]> {
  const matchStage: any = {
    domainId: input.domainId,
    pid: { $in: input.pids },
    uid: { $in: input.studentUids },
    status: { $ne: 1 }, // exclude AC
  };
  if (input.contestStartTime || input.contestEndTime) {
    matchStage.judgeAt = {};
    if (input.contestStartTime) matchStage.judgeAt.$gte = input.contestStartTime;
    if (input.contestEndTime) matchStage.judgeAt.$lte = input.contestEndTime;
  }

  return this.db.collection('record').aggregate([
    { $match: matchStage },
    { $project: {
      pid: 1, uid: 1, status: 1,
      testCases: { $slice: ['$testCases', 80] },
      compilerTexts: { $slice: ['$compilerTexts', -3] },
      code: 1,
    }},
    { $sort: { judgeAt: 1 } },
  ]).toArray();
}
```

- [ ] **Step 2: Integrate error clustering into analyze()**

In the `analyze()` method, after the existing Layer 1 data fetching (after line 126), add a parallel fetch for clustering data:

```typescript
// Layer 1b: Fetch extended data for error clustering (separate query)
const clusteringRecords = await this.fetchRecordsForClustering(input);
```

In the Layer 2 section (after line 161), add the error clustering dimension:

```typescript
import { analyzeErrorClusters } from './analyzers/errorClusterAnalyzer';

// ... inside analyze(), after dimensionResults loop
const errorClusterFindings = analyzeErrorClusters(
  clusteringRecords,
  input.pids,
  input.studentUids.length,
);
for (const f of errorClusterFindings) {
  if (f) findings.push(f);
}
```

Add the import at the top of the file:

```typescript
import { analyzeErrorClusters } from './analyzers/errorClusterAnalyzer';
```

- [ ] **Step 3: Build and run existing tests**

Run: `npm run build:plugin && npx jest src/__tests__/services/teachingAnalysisService.test.ts -v`
Expected: clean build + ALL existing tests PASS (error clustering is additive, doesn't break existing dimensions).

- [ ] **Step 4: Commit**

```bash
git add src/services/teachingAnalysisService.ts
git commit -m "feat: add split query for error clustering and integrate analyzer"
```

---

### Task 8: Attach problem context to overall suggestion

**Files:**
- Modify: `src/services/teachingSuggestionService.ts`
- Modify: `src/handlers/teachingSummaryHandler.ts`

- [ ] **Step 1: Add problemContexts field to MainPromptInput**

In `src/services/teachingSuggestionService.ts`, update the `MainPromptInput` interface (lines 59-70):

```typescript
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
}
```

- [ ] **Step 2: Include problem context in user prompt**

In `buildMainPrompt()`, after the `contextSection` construction (after line 114), add:

```typescript
const problemSection = input.problemContexts?.length
  ? `\n## 题目内容\n${input.problemContexts
      .map(p => `### ${p.pid}. ${p.title}\n${p.content.slice(0, 500)}`)
      .join('\n\n')}`
  : '';
```

Then include `${problemSection}` in the userPrompt template, after the class stats section and before the findings JSON.

- [ ] **Step 3: Pass problem contexts from handler**

In `src/handlers/teachingSummaryHandler.ts`, in the background generation function (around line 191), where `generateOverallSuggestion` is called, fetch problem docs and add them to the input:

Find where the `suggestionService.generateOverallSuggestion()` call is made. Before that call, build the problemContexts array from the `problemDocs` that are already fetched later for deep dive (around line 207). Move that fetch earlier:

```typescript
// Fetch problem content for overall suggestion (before deep dive loop)
const documentColl = this.db.collection('document');
const problemDocs = await documentColl
  .find({ domainId, docType: 10, docId: { $in: input.pids } })
  .toArray();

const problemContexts = problemDocs.map((doc: any) => ({
  pid: doc.docId,
  title: doc.title || String(doc.docId),
  content: doc.content || '',
}));
```

Then pass `problemContexts` to the `generateOverallSuggestion` input.

- [ ] **Step 4: Build and run tests**

Run: `npm run build:plugin && npx jest src/__tests__/services/teachingSuggestionService.test.ts -v`
Expected: clean build + ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/teachingSuggestionService.ts src/handlers/teachingSummaryHandler.ts
git commit -m "feat: attach problem title and content to overall suggestion prompt"
```

---

### Task 9: Update user prompt data format

**Files:**
- Modify: `src/services/teachingSuggestionService.ts`
- Modify: `src/__tests__/services/teachingSuggestionService.test.ts`

- [ ] **Step 1: Write test for new user prompt format**

Add to `src/__tests__/services/teachingSuggestionService.test.ts`:

```typescript
it('should format user prompt with problem contexts', () => {
  const input = makeInput({
    problemContexts: [
      { pid: 101, title: '数组求和', content: '给定一个数组...' },
    ],
  });
  const { user } = buildMainPrompt(input);
  expect(user).toContain('## 题目内容');
  expect(user).toContain('101. 数组求和');
  expect(user).toContain('给定一个数组');
});

it('should omit problem section when no contexts provided', () => {
  const input = makeInput({ problemContexts: undefined });
  const { user } = buildMainPrompt(input);
  expect(user).not.toContain('## 题目内容');
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx jest src/__tests__/services/teachingSuggestionService.test.ts --testNamePattern="problem contexts|omit problem" -v`
Expected: FAIL.

- [ ] **Step 3: Update buildMainPrompt user prompt template**

In `buildMainPrompt()`, replace the `userPrompt` template string (lines 118-129) with:

```typescript
const strippedFindings = stripSamples(findings);

const problemSection = input.problemContexts?.length
  ? `\n## 题目内容\n${input.problemContexts
      .map(p => `### ${p.pid}. ${p.title}\n${p.content.slice(0, 500)}`)
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
${JSON.stringify(strippedFindings, null, 2)}`;
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `npx jest src/__tests__/services/teachingSuggestionService.test.ts -v`
Expected: ALL PASS.

- [ ] **Step 5: Build and run full test suite**

Run: `npm run build:plugin && npm test`
Expected: clean build + ALL tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/services/teachingSuggestionService.ts src/__tests__/services/teachingSuggestionService.test.ts
git commit -m "feat: update user prompt to include problem contexts and new data format"
```

---

## Final Verification

- [ ] **Step 1: Full build**

Run: `npm run build:plugin`
Expected: 0 errors.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: ALL PASS.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no new warnings.

---

## What's Next

After Phase 1 is deployed and verified on the live system:

1. **Phase 2 plan** will cover: 60/40 split layout, temporal behavior patterns, cross-dimensional correlation, class size strategy, code fill-in exercises
2. Phase 2 depends on Phase 1b's error clustering being correct — verify with real data first
3. The `analyzers/` directory established in Task 6 will host additional analyzer files in Phase 2
