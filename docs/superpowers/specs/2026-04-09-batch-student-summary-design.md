# Batch Student Summary Generation — Design Spec

> GitHub Issue: #15 — feat: 课堂结束时教师为每位学生生成个性化总结建议

## Overview

Teachers click "Generate AI Summary" on a homework/contest scoreboard page. The system collects each student's problem descriptions and code submissions, samples representative submissions via a milestone-based strategy, and calls an AI API to produce a personalized learning summary per student. Results stream in real-time via SSE and are stored in MongoDB for both teachers and students to view.

## Scope

- Entry point: homework/contest scoreboard page (成绩表)
- Data scope: problem content (Markdown + samples) + submission records (code + judge results)
- AI conversation history: NOT included
- Visibility: summaries default to "draft" state (teacher-only); teacher publishes to make visible to students
- Teacher can edit/delete summaries after generation; original AI output preserved in `originalSummary` field
- Re-generation: teacher can click "Generate" again to regenerate (e.g., after students submit new code); warns if edited summaries exist
- Export: CSV export via API endpoint for downstream data integration

## Data Model

### Collection: `ai_batch_summary_jobs`

```typescript
{
  _id: ObjectId,
  domainId: string,
  contestId: ObjectId,
  createdBy: number,           // teacher userId
  status: 'pending' | 'running' | 'completed' | 'failed',
  totalStudents: number,
  completedCount: number,
  failedCount: number,
  config: {
    concurrency: number,       // default 10, configurable
    locale: string,            // system language setting
  },
  createdAt: Date,
  completedAt: Date | null,
}
```

Index: `{ domainId, contestId }` unique — one job per contest. Re-generation creates a new job (old job archived with `status='archived'`).

### Collection: `ai_student_summaries`

```typescript
{
  _id: ObjectId,
  jobId: ObjectId,
  domainId: string,
  contestId: ObjectId,
  userId: number,
  status: 'pending' | 'generating' | 'completed' | 'failed',
  publishStatus: 'draft' | 'published',  // draft = teacher-only; published = visible to student
  summary: string | null,      // current Markdown (may be teacher-edited)
  originalSummary: string | null, // original AI-generated Markdown (preserved on edit)
  problemSnapshots: [{
    pid: string,
    title: string,
    submissionCount: number,
    sampledSubmissions: [{
      recordId: ObjectId,      // for generating /d/{domainId}/record/{recordId} links
      status: string,          // AC / WA / TLE / RE / CE
      timestamp: Date,
      milestone: string,       // 'first' | 'final' | 'first_ac' | 'score_up' | 'status_change' | 'lang_change' | 'time_gap'
    }],
    allStatuses: string[],     // full [timestamp, status] timeline (no code)
  }],
  tokenUsage: { prompt: number, completion: number },
  error: string | null,
  createdAt: Date,
  updatedAt: Date,
}
```

Indexes:
- `{ jobId, userId }` unique
- `{ domainId, contestId, userId }` — student querying own summary

## Submission Sampling Strategy

### Pipeline

```
Step 1: Hash Dedup
  → Normalize code: strip comments (language-aware regex), collapse whitespace → SHA-256 first 16 chars
  → Merge only adjacent identical hashes (non-adjacent same hash = student reverted, keep both)
  → Code sent to AI retains original comments (hash normalization is only for dedup)

Step 2: Milestone Marking
  → 'first': first submission
  → 'final': last submission
  → 'first_ac': first AC submission (key turning point)
  → 'score_up': passed test case count increased
  → 'status_change': status type changed (WA→TLE, WA→AC, etc.)
  → 'lang_change': programming language switched
  → 'time_gap': gap > 10 minutes since previous submission

Step 3: Priority Sampling (fill per-problem quota)
  Priority order: final > first_ac > score_up > first > status_change > lang_change > time_gap > evenly-spaced
  Budget: ~4000 tokens code per problem, max 5 submissions per problem
  Token estimation: Math.ceil(code.length / 3.5) — no external tokenizer needed

Step 4: Special Handling
  → Consecutive CE: merge, keep only last one; CE code capped at 500 tokens
  → Single code > 2000 tokens: keep first half + last half, insert [...truncated...] in middle
  → Empty code / 0 submissions: skip
  → Only 1 submission: return directly, mark as first + final
```

### Rationale

Discussed with Codex and Gemini. Both rejected code-diff-based filtering (change volume ≠ bug difference). Consensus: use OJ judge results as primary signal, not code diffs.

## Backend Architecture

### New Files

| File | Responsibility |
|------|---------------|
| `handlers/batchSummaryHandler.ts` | HTTP endpoints: trigger generation, SSE stream, query results, single retry |
| `services/batchSummaryService.ts` | Core orchestration: data collection, sampling, concurrent AI calls, progress tracking |
| `services/submissionSampler.ts` | Submission sampling strategy (milestone + hash dedup + priority) |
| `models/batchSummaryJobModel.ts` | Job collection CRUD + indexes |
| `models/studentSummaryModel.ts` | Student summary collection CRUD + indexes |

### Request Flow

```
Teacher clicks "Generate AI Summary"
  │
  ▼
POST /ai-helper/batch-summaries/generate
  ├─ Permission check (teacher/TA role, PRIV_READ_RECORD_CODE)
  ├─ Rate limit: ai_batch_summaries, 1 op / 300s / domain
  ├─ Query all students + problems for this contestId
  ├─ Create/update Job record (status=running)
  ├─ Create Summary records per student (status=pending)
  └─ Begin SSE stream + start batchSummaryService.execute(job)
        │
        ▼
  For each student (10 concurrent via Promise.allSettled):
  ├─ Fetch all submissions for this student × all problems
  ├─ submissionSampler.sample() → sampled submissions per problem
  ├─ Build prompt (runtime context + problem content + sampled code + metadata timeline)
  ├─ openaiClient.chat() → AI generates summary
  ├─ Save summary to MongoDB (status=completed)
  ├─ Record tokenUsage
  └─ SSE push: { type: 'student_done', userId, status, summary }
        │
  On API 429: auto-throttle, wait and retry
  On single student failure: mark failed, SSE push error, continue others
        │
        ▼
  All done: update Job (status=completed), SSE push { type: 'job_done' }
```

### Routes

```typescript
// In src/index.ts
ctx.Route('ai_batch_summary_generate', '/ai-helper/batch-summaries/generate', BatchSummaryHandler, PRIV.PRIV_READ_RECORD_CODE)
ctx.Route('ai_batch_summary_result', '/ai-helper/batch-summaries/:jobId', BatchSummaryResultHandler)
ctx.Route('ai_batch_summary_retry', '/ai-helper/batch-summaries/:jobId/retry/:userId', BatchSummaryRetryHandler)
ctx.Route('ai_batch_summary_publish', '/ai-helper/batch-summaries/:jobId/publish', BatchSummaryPublishHandler)  // POST: publish all or selected
ctx.Route('ai_batch_summary_export', '/ai-helper/batch-summaries/:jobId/export', BatchSummaryExportHandler)    // GET: CSV export API
// + /d/:domainId/ prefixed variants
```

### SSE Event Format

```typescript
{ type: 'progress', completed: 12, total: 30, failed: 1 }
{ type: 'student_done', userId: 123, userName: '张三', status: 'completed', summary: '...' }
{ type: 'student_failed', userId: 456, userName: '李四', error: 'API timeout' }
{ type: 'job_done', completed: 28, failed: 2, totalTokens: 150000 }
```

### Concurrency & Error Handling

- Default 10 concurrent AI calls (configurable in AI config)
- Local server pressure negligible (HTTP requests to cloud API)
- On 429 (rate limit): exponential backoff, auto-retry
- On single student failure: mark `status=failed`, teacher can retry individually via `POST /batch-summaries/:jobId/retry/:userId`
- Process restart recovery: scan `status=generating` records on startup, reset to `pending` for re-processing

## Prompt Design

### Structure per student

```
1. Runtime Context
   - Output language: ${locale === 'zh' ? '中文' : 'English'}
   - Platform: HydroOJ
   - Contest: ${contestTitle}
   - Link format: [提交 #rXXXX] → /d/${domainId}/record/XXXX

2. Per problem:
   - Problem Markdown description (capped ~2000 tokens; keep problem statement + I/O format, trim verbose background)
   - Sample I/O
   - Test case summary (if available)
   - Full submission timeline (metadata only: timestamp + status)
   - Sampled code with milestone tags and recordId

3. System instructions (template)
```

### System Prompt (designed by Gemini)

```
你是 HydroOJ 平台上的资深编程导师。你的任务是根据学生的作业或比赛提交记录，生成一份个性化的学习总结，供学生复盘和教师查阅。

## 当前环境
- 输出语言：${locale}
- 平台名称：HydroOJ
- 作业名称：${contestTitle}
- 提交链接格式：[提交 #rXXXX] — 前端会自动解析为可点击链接

## 原则

1. **教育为先，绝不代笔**：对未通过的题目，指出逻辑漏洞和调试方向，不给完整解法。

2. **强制引用格式**：点评代码时必须使用 [提交 #rXXXX] 格式引用。

3. **洞察全局错误模式**：跨题目分析薄弱环节（如频繁边界条件出错、时间复杂度理解不足），不做逐题流水账。

4. **肯定努力与调试过程**：通过时间线识别试错过程，肯定坚持调试的精神。

5. **因材施教**：
   - 全 AC 学生：关注代码质量、优化空间、高级技巧
   - 挣扎学生：指出概念盲区、给出复习方向、温和鼓励

6. **语气与篇幅**：专业诚恳鼓励，200-800 字灵活控制，使用 Markdown 格式。
```

## Frontend Design

### Teacher View — Scoreboard Integration

**Entry point:** Blue "✨ 生成 AI 学习总结" button in the top action bar, opposite the export buttons. Uses plugin blue (#2563eb) to visually differentiate from HydroOJ's native green (#5cb85c) buttons.

**AI column:** New narrow column in scoreboard table with circular status icons:
- ✓ green circle: completed
- ⚙ yellow circle (spinning): generating
- ✗ red circle: failed (click to retry)
- — gray: not generated

**Progress bar:** During generation, a thin blue progress bar appears below the action bar showing "已完成 X / Y · Z 失败", with a cancel button.

**Expandable summary card:** Click a student row to expand their summary below. Card styling:
- Left blue border (3px, #2563eb)
- White background with subtle shadow
- Summary text with inline `[提交 #rXXXX]` rendered as clickable blue tag links
- "参考提交" section at bottom listing all sampled submissions as tag links
- Edit / Delete buttons top-right

**Batch controls:** "全部展开 / 全部折叠" toggle button near the progress bar area.

**Draft/Publish flow:**
- All summaries default to `publishStatus: 'draft'` (visible only to teacher)
- AI column icons show a "draft" badge (e.g., dashed circle outline) until published
- **One-click publish:** "一键发布全部" button appears after generation completes, publishes all draft summaries at once
- Teacher can also publish individual summaries from the expanded card
- Re-generation: if teacher clicks "Generate" again, system warns if edited summaries exist; confirmed → archives old job, generates fresh summaries as new drafts

**Export:** "导出 CSV" button calls `GET /ai-helper/batch-summaries/:jobId/export`, returns CSV with columns: userId, userName, score, summaryText, status, generatedAt.

### Student View

- Student sees the scoreboard with their own summary auto-expanded (if `publishStatus === 'published'`)
- Only their own published summary is visible; draft summaries and other students' AI column show nothing
- No edit/delete buttons
- Same submission reference links (pointing to their own records)
- If not yet generated or still in draft, AI column shows `—`

### Frontend Implementation

- React components in `frontend/teacher/` and `frontend/student/`
- Inline styles using plugin's `styles.ts` design tokens (colors, spacing, border-radius, shadows)
- SSE client: `EventSource` API, reconnect on disconnect with fallback to polling
- Markdown rendering for summary text, with post-processing to convert `[提交 #rXXXX]` to `<a>` tags

## Token Budget Summary

| Component | Budget per student |
|-----------|-------------------|
| Problem descriptions (all problems) | ~2000 tokens × N problems |
| Sampled code (all problems) | ~4000 tokens × N problems |
| Metadata timelines | ~500 tokens × N problems |
| System prompt + runtime context | ~500 tokens |
| AI output (summary) | ~500-1500 tokens |
| **Total for 5-problem homework** | ~35K-40K input + ~1K output |

For a class of 30 students: ~30 API calls, ~1M total input tokens.

## Permission & Rate Limiting

- Generation trigger: requires `PRIV_READ_RECORD_CODE` (teacher/TA)
- Rate limit: 1 generation per 5 minutes per domain (`ai_batch_summaries` op)
- Student view: requires being enrolled in the domain + own userId match
- Edit/delete summary: teacher/TA only

## Dependencies on Existing Modules

| Module | Usage |
|--------|-------|
| `openaiClient.ts` / `MultiModelClient` | AI API calls with fallback |
| `tokenUsageModel.ts` | Record token consumption per summary |
| `lib/sseHelper.ts` | SSE stream setup (createSSEWriter) |
| `utils/domainHelper.ts` | Domain ID extraction |
| `utils/mongo.ts` | ObjectId import |
| `lib/crypto.ts` | API key decryption (existing) |
| `styles.ts` (frontend) | Design tokens for card styling |
