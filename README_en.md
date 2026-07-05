# HydroOJ AI Learning Assistant

<div align="center">

**[中文](README.md) | English**

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
<summary><b>AI Test Data Generation</b></summary>

<img src="assets/screenshots/10.png" alt="Problem files page - AI test data generation panel" width="800">

</details>

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

- **AI Test Data Generation** — generate a full test data set from the statement on the problem files page (`/p/:pid/files`)
  - **Sandbox execution + double verification**: the generator and reference solution actually run in Hydro's judge sandbox to produce `.in`/`.out`, then pass four machine gates — independent brute-force cross-check, input validation, template execution, and statement-sample regression; on failure the AI gets one automatic repair round with full context
  - Supports traditional problems, LeetCode-style function problems (auto-generates `template.py/java/cc` and `compile.sh`) and fill-in-the-blank problems
  - Paste an existing reference solution as the single source of truth; `config.yaml` is built deterministically and judge settings sync automatically
  - Every generated code file (std.py, generator.py, validator.py, …) starts with a purpose comment; everything is previewed, editable and opt-in before writing
  - ⚠️ Highly sensitive to model capability: assign your strongest model to the Test Data Generation scenario; a skeleton mode (no AI) is available as fallback
- **Teaching Analysis** — class-level insights from collective submission data
  - 8-dimension rule engine (common errors / comprehension gaps / at-risk students / progress trends, …) + error-signature clustering + temporal behavior patterns
  - LLM-powered P0/P1/P2 prioritized suggestions — specific classroom actions, not generic advice; auto-generates fill-in exercises from AC code
- **Batch AI Summary** — one-click personalized learning summaries for all students on scoreboard pages
  - Longitudinal history tracking + milestone-based submission sampling; supplemental generation for late-arriving students
  - Draft/publish workflow with real-time SSE progress and stop/continue/retry controls
- Conversation browsing (time / problem / class / student filters with autocomplete), effectiveness metrics, CSV export with optional anonymization

### Admins

- Unified portal: Conversations / Analytics / Configuration tabs
- Multi-endpoint API management with model auto-discovery, drag-to-reorder priority, and automatic failover
- Per-scenario model assignment: student chat / learning summary / teaching analysis / test data generation
- Cost control: token usage tracking, budget limits, cost dashboard
- Rate limiting, custom system prompt, one-click plugin update

<details>
<summary><b>Security</b></summary>

- Multi-layer jailbreak detection (input / prompt / output) with cross-turn protection
- CSRF token validation, SSRF prevention, AES-256-GCM encrypted API key storage
- AI-generated code runs only inside the go-judge sandbox, never in the web process
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

`ENCRYPTION_KEY` (required, 32 characters) — encrypts API keys:

```bash
export ENCRYPTION_KEY="your-32-character-secret-key!!!"   # generate: openssl rand -base64 24 | head -c 32
```

`AI_HELPER_UPDATE_CHANNEL` (optional) — in-app update channel:

- `stable` (default) — updates only to official releases (`vX.Y.Z` tags), GPG-verified. Use on all real-user servers.
- `edge` — tracks the latest `main` branch code; for the maintainer's own test server only.

`AI_HELPER_TESTDATA_GENERATION_MODE` (optional) — whether test data generation requires the sandbox (`hydrojudge.sandbox_host`):

- `auto` (default) — verify in the sandbox when reachable; otherwise fall back to direct output clearly marked "unverified"
- `sandbox` — require the sandbox and fail safely when unavailable
- `direct` — always use direct output (not recommended)

### Admin Setup

Go to **Control Panel → AI Assistant** (`/ai-helper`) → "AI Configuration" tab:

1. **Add API endpoints** — endpoint name, API Base URL, API Key → click "Fetch Models"
2. **Select models & priority** — pick models, drag to reorder; failover is automatic
3. **Scenario models** — assign dedicated models per scenario (use your strongest model for Test Data Generation)
4. **Test & save** — "Test Connection" to verify, then save

## Telemetry & Privacy

Collects **anonymous statistics** (installations, active-user windows, conversations, per-day feature usage, version) for GitHub badges and development. Fully anonymous (random UUID, no PII, IPs never stored); no code, conversations or personal data — only a coarse country/region inferred by Cloudflare for distribution stats.

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
<summary><b>v3.0.0</b> — Test data generation: sandbox execution + double verification</summary>

- Test data is no longer emitted directly by the AI: the generator and reference solution actually run in the go-judge sandbox to produce `.in`/`.out`
- Four machine gates: independent brute-force cross-check, per-case input validation, function-template execution, statement-sample regression
- On failure, the failing stage, test case, input and traceback tail are fed back to the AI for one automatic repair round; teacher cancellation is no longer misreported
- Generated code files start with purpose comments; prominent strongest-model reminders on both the files page and the scenario-model page
- Telemetry: error reports carry AI failure details, startup-failure canary alerts, cumulative feature usage and instance region

</details>

<details>
<summary><b>v2.5.0</b> — AI Test Data Generation (Beta)</summary>

- One-click generation of test cases, judge templates, config.yaml and a reference solution from the statement (direct-output mode)
- Traditional / function / fill-in-the-blank problems; paste a reference solution as the single source of truth; skeleton-mode fallback
- New "Test Data Generation" AI scenario with its own model chain

</details>

<details>
<summary><b>v2.0.0</b> — Teaching Analysis & Design Overhaul</summary>

- 8-dimension class analysis + error-signature clustering + temporal behavior patterns (rule-engine first, ~1/30 the cost of pure LLM)
- LLM-generated P0/P1/P2 teaching suggestions; auto-generated fill-in exercises from AC code
- Longitudinal summary tracking with supplemental generation; unified frontend design tokens

</details>

<details>
<summary><b>Earlier versions</b></summary>

- v1.21.0: batch AI learning summaries (milestone sampling, SSE progress, draft/publish)
- v1.19.0–v1.20.0: full i18n, multi-dimensional effectiveness metrics, filter autocomplete
- v1.18.0: telemetry dashboard SPA, richer error diagnostics
- v1.14.x–v1.16.x: SSE streaming, cost control, CSRF/SSRF/prompt-injection defenses, security fixes
- v1.0.0–v1.12.0: initial release, question types, multi-endpoint failover, judge-data integration, contest mode

</details>

## About

A third-party plugin for the [HydroOJ](https://github.com/hydro-dev/Hydro) open-source online judge. Issues and suggestions welcome.

## License

MIT License
