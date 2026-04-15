# HydroOJ AI Learning Assistant

<div align="center">

**[中文](README_zh.md) | English**

![GitHub release (latest by date)](https://img.shields.io/github/v/release/AltureT/hydro-ai-helper?label=Release)
![GitHub all releases](https://img.shields.io/github/downloads/AltureT/hydro-ai-helper/total?label=Downloads&color=brightgreen)
![Installations](https://img.shields.io/endpoint?url=https://stats.how2learns.com/api/badge-installs)
![Active Users (7d)](https://img.shields.io/endpoint?url=https://stats.how2learns.com/api/badge-active)
![Conversations](https://img.shields.io/endpoint?url=https://stats.how2learns.com/api/badge-conversations)
![Version (mode)](https://img.shields.io/endpoint?url=https://stats.how2learns.com/api/badge-version)
![GitHub stars](https://img.shields.io/github/stars/AltureT/hydro-ai-helper?style=social)
![License](https://img.shields.io/github/license/AltureT/hydro-ai-helper)

</div>

A teaching-first AI tutoring plugin for [HydroOJ](https://github.com/hydro-dev/Hydro) — guided hints and thought-provoking questions, never complete solutions. Supports English and Chinese (i18n).

## Screenshots

<img src="assets/screenshots/1.png" alt="Student panel - AI chat" width="800">

<details>
<summary><b>Batch AI Learning Summary</b></summary>

<img src="assets/screenshots/8.png" alt="Batch summary - scoreboard integration" width="800">

<img src="assets/screenshots/9.png" alt="Batch summary - generated results" width="800">

</details>

<details>
<summary><b>Admin screenshots</b></summary>

<img src="assets/screenshots/4.png" alt="Admin - conversation records" width="800">

<img src="assets/screenshots/5.png" alt="Admin - usage analytics" width="800">

<img src="assets/screenshots/6.png" alt="Admin - AI configuration" width="800">

<img src="assets/screenshots/7.png" alt="Admin - cost dashboard" width="500">

</details>

## Features

### Students

- AI chat panel on problem pages with real-time streaming (SSE) and LaTeX rendering
- Choose question type: **Understand** / **Approach** / **Debug** / **Optimize** (AC-only)
- Multi-turn conversations with history; select confusing text for instant clarification
- View personalized AI learning summaries on scoreboard pages

### Teachers

- **Teaching Analysis** — class-level insights from collective submission data, helping teachers discover teaching problems and take action
  - 8-dimension rule-engine analysis: common errors, comprehension gaps, learning strategies, at-risk students, difficulty anomalies, progress trends, cognitive paths, AI tutoring effectiveness
  - Error signature clustering: groups similar compile/runtime errors across students to surface shared misconceptions
  - Temporal behavior patterns: classifies students into 5 patterns (strategic solver, disengaged, burst-then-quit, stuck-silent, persistent learner)
  - Cross-dimensional correlation: detects compound risk patterns (e.g., high AI usage + low AC rate)
  - Code fill-in exercises: auto-generates blanked-code exercises from AC submissions for targeted practice
  - LLM-powered actionable suggestions with priority framework (P0/P1/P2) — specific classroom actions, not generic advice
  - 60/40 split layout with sticky AI suggestion sidebar, skeleton loading, confidence badges
- **Batch AI Summary** — one-click personalized learning summaries for all students on scoreboard pages
  - Longitudinal student history tracking: records error trends, struggle indicators, and actionable advice across assignments
  - Smart submission sampling based on milestones (first submit, first AC, score improvements, status changes)
  - Supplemental generation for late-arriving students without regenerating existing summaries
  - Draft/publish workflow with real-time SSE progress, stop/continue/retry controls
- Browse student conversations with filters (time / problem / class / student / userId)
- Autocomplete search for class and problem filters
- Multi-dimensional effectiveness metrics and question-type distribution
- CSV export with optional anonymization and metrics columns

### Admins

- Unified portal: Conversations / Analytics / Configuration tabs
- Multi-endpoint API management with model auto-discovery, drag-to-reorder priority, and automatic failover
- Cost control: token usage tracking, budget limits, cost dashboard
- Rate limiting, custom system prompt, one-click plugin update

<details>
<summary><b>Security</b></summary>

- Multi-layer jailbreak detection (input / prompt / output) with cross-turn protection
- CSRF token validation, SSRF prevention, AES-256-GCM encrypted API key storage
- Paginated jailbreak audit logs

</details>

## Installation

```bash
# Clone (choose one)
git clone https://github.com/AltureT/hydro-ai-helper.git   # GitHub
git clone https://gitee.com/alture/hydro-ai-helper.git      # Gitee (mirror)

cd hydro-ai-helper
npm install
npm run build:plugin

# Install into HydroOJ
hydrooj addon add /path/to/hydro-ai-helper
pm2 restart hydrooj
```

Verify: visit `/ai-helper/hello` — a JSON response means success.

## Configuration

### Environment Variables

Set `ENCRYPTION_KEY` (32 characters) to encrypt API keys:

```bash
export ENCRYPTION_KEY="your-32-character-secret-key!!!"
```

Generate a random key: `openssl rand -base64 24 | head -c 32`

### Admin Setup

Go to **Control Panel → AI Assistant** (`/ai-helper`) → "AI Configuration" tab:

1. **Add API endpoints** — endpoint name, API Base URL, API Key → click "Fetch Models"
2. **Select models & priority** — pick models, drag to reorder; failover is automatic
3. **Adjust settings** — rate limit (default 5/min/user), custom system prompt
4. **Test & save** — "Test Connection" to verify, then save

## Telemetry & Privacy

Collects **anonymous statistics** (installation count, active users, conversations, version) for GitHub badges and development.

- Fully anonymous (random UUID, no PII); domain IDs are SHA-256 hashed
- No code, conversations, or personal data; auto-cleanup after 90 days

<details>
<summary><b>Disable telemetry</b></summary>

```javascript
use your_hydro_db
db.ai_plugin_install.updateOne(
  { _id: 'install' },
  { $set: { telemetryEnabled: false } }
)
```

</details>

## Changelog

<details open>
<summary><b>v2.0.0</b> — Teaching Analysis & Design Overhaul</summary>

**Teaching Analysis System (NEW)**
- 8-dimension class-level analysis: common errors, comprehension gaps, learning strategies, at-risk students, difficulty anomalies, progress trends, cognitive paths, AI tutoring effectiveness
- Rule-engine-first architecture: anomaly detection via data pipeline, LLM for actionable suggestions — 1/30 cost of pure-LLM approach
- Error signature clustering with compiler error normalization
- Temporal behavior pattern analyzer (5-way student classification)
- Cross-dimensional correlation detection (3 priority pairs)
- Auto-generated code fill-in exercises from AC submissions
- Adaptive class-size strategy (<10 / 10-20 / 20-100+ students)
- 60/40 split layout with sticky suggestion sidebar, skeleton loading, confidence badges

**Batch Summary Enhancement**
- Student history tracking across assignments (error trends, struggle indicators, prior advice)
- Supplemental generation mode for late-arriving students
- Rewritten prompts with educational psychology principles and historical context injection
- Smart primary button state machine (generate new / retry failed / continue)

**Frontend Redesign**
- Unified design token system with green accent theme for teacher features
- Tab restyling with ARIA accessibility attributes and keyboard navigation
- Finding cards with severity-based color coding (high/medium/low)
- Responsive 60/40 → vertical layout below 768px

</details>

<details>
<summary><b>v1.21.0</b> — Batch AI Learning Summary</summary>

- One-click AI summary generation for all students on homework/contest scoreboard pages
- Smart submission sampling based on milestones (first submit, first AC, score improvements, status changes)
- Real-time SSE progress with stop / continue / retry-failed controls
- Draft → publish workflow; teachers can edit summaries before publishing
- Student view: auto-displays published summary on scoreboard with periodic polling
- Submission reference links in summaries clickable to view code details
- CSV export for generated summaries

</details>

<details>
<summary><b>v1.20.0</b> — Teacher Analytics Enhancement</summary>

- Autocomplete search for class, problem, and student filters
- UserId filtering and unified filter layout
- SVG icon set replacing emoji indicators
- Cost analytics period accuracy fixes

</details>

<details>
<summary><b>v1.19.0</b> — i18n & Effectiveness Metrics</summary>

- Full English/Chinese internationalization (frontend + backend)
- Multi-dimensional conversation effectiveness metrics replacing simple binary flag
- Metrics columns in analytics tables and CSV export

</details>

<details>
<summary><b>v1.18.0</b> — Telemetry Dashboard & Error Diagnostics</summary>

- Telemetry dashboard SPA for monitoring plugin installations
- Enhanced error diagnostics with endpoint-level context
- Admin feedback collection UI

</details>

<details>
<summary><b>v1.16.x</b> — Stability & Security</summary>

- Stabilize telemetry instanceId for Docker environments
- Upgrade DOMPurify to address XSS vulnerabilities
- Collapse jailbreak logs by default

</details>

<details>
<summary><b>v1.14.x</b> — SSE Streaming & Cost Control</summary>

- SSE streaming output — real-time character-by-character display
- Token usage tracking, budget limits, cost dashboard
- CSRF protection, SSRF prevention, 3-layer prompt injection defense
- Homework/contest mode support

</details>

<details>
<summary><b>v1.12.0 and earlier</b></summary>

- v1.12.0: Judge data integration, contest mode, ~45% token reduction
- v1.11.0: Improved guided response style, cross-turn jailbreak defense
- v1.10.x: Anonymous telemetry, one-click update
- v1.9.0: Security audit and hardening
- v1.8.x: "Code Optimization" question type (AC-only)
- v1.6.0: Unified admin portal with tabs
- v1.4.0: Multi-endpoint config with failover
- v1.2.0: Differentiated question types
- v1.0.0: Initial release

</details>

## About

A third-party plugin for [HydroOJ](https://github.com/hydro-dev/Hydro). Feel free to open an Issue for questions or suggestions.

## License

MIT License
