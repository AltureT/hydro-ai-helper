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
![GitHub forks](https://img.shields.io/github/forks/AltureT/hydro-ai-helper?style=social)
![License](https://img.shields.io/github/license/AltureT/hydro-ai-helper)

</div>

A teaching-first AI tutoring plugin for [HydroOJ](https://github.com/hydro-dev/Hydro) that provides guided hints and thought-provoking questions — never complete solutions.

## Features

### Multi-turn Conversations with Context

- **Follow-up questions**: Students can ask follow-ups within the same conversation; the AI references prior context
- **Persistent history**: Conversations auto-restore after page refresh, isolated per problem
- **Smart truncation**: Automatically trims history beyond 7 messages to prevent token overflow

### Selection-based Q&A ("I Don't Understand")

- **Precise follow-up**: Select confusing text in an AI reply and click "I don't understand"
- **Highlight preservation**: Selected text stays highlighted when the button is clicked
- **Concise explanations**: Targeted explanations limited to 2 paragraphs
- **Works on history**: Can be used on any previous AI response

### Differentiated Question Types

| Type | Description | Response Style |
| --- | --- | --- |
| Understand the Problem | Unclear about problem requirements | Detailed, step-by-step explanation |
| Organize Approach | Need help structuring a solution | Structured framework, layered guidance |
| Debug Errors | Code has issues, need root cause | Concise and direct, quick diagnosis |
| Code Optimization | Already AC'd, seeking efficiency | Complexity analysis, heuristic hints |

### Real-time Streaming

- **SSE streaming**: AI responses appear character-by-character in real time
- **Error classification & retry**: Frontend shows error types (rate limit / timeout / network) with one-click retry

### Code Optimization

- **AC-only**: The "Code Optimization" option appears only for users who have passed the problem
- **Real-time detection**: After an AC submission, the optimization option appears automatically — no page refresh needed
- **Code loading confirmation**: A dialog lets you choose between loading your AC code or using the current editor code
- **Heuristic guidance**: AI analyzes time/space complexity and suggests optimization directions without giving code
- **Server-side validation**: Backend verifies AC status to prevent bypassing frontend restrictions

### API Usage & Cost Control

- **Token tracking**: Records input/output token counts for every AI call
- **Budget limits**: Set monthly or total budget caps; auto-alert or pause service when thresholds are reached
- **Cost dashboard**: Visualize API cost trends and distribution

### Unified Management Portal

- **Single menu entry**: One "AI Assistant" entry in the control panel, replacing three separate menus
- **Tab navigation**: Switch between Conversations, Analytics, and Configuration tabs
- **URL parameters**: Direct link with `?tab=conversations|analytics|config`
- **Browser navigation**: Tab switches support browser back/forward buttons

### Teacher Analytics

- **Multi-dimensional stats**: View AI usage by class, student, or problem
- **Sortable tables**: Click column headers to sort ascending/descending
- **Quick navigation**: Click a problem name to go to its detail page; click conversation count to jump to filtered records
- **Data export**: CSV export support

### Multi-endpoint & Model Management

- **Multiple endpoints**: Add multiple API endpoints for load balancing and failover
- **Auto model discovery**: Fetches available models from the `/models` endpoint automatically
- **Fallback mechanism**: Select multiple models with priority ordering; auto-switches to fallback when the primary is unavailable
- **Drag-to-reorder**: Drag model cards to adjust priority
- **Encrypted API keys**: API keys stored with AES-256-GCM encryption

### Security

- **Jailbreak detection**: Multi-layer injection prevention (input / prompt / output) blocks attempts to bypass tutoring guardrails
- **Cross-turn protection**: Anti-jailbreak detection across conversation turns to prevent gradual bypasses
- **CSRF protection**: CSRF token validation on critical operations
- **SSRF prevention**: URL validation on API endpoint configuration to prevent internal network probing
- **Allowlist mechanism**: Trusted problem content fetched server-side to avoid false positives
- **Audit log**: Paginated jailbreak log viewer for administrators

### Modern UI

- **Three-column layout**: On wide screens (≥1200px), auto-switches to a LeetCode-style layout (Problem | Code | AI Chat)
- **Responsive design**: Floating chat panel on narrow screens
- **Resizable panel**: Drag the AI panel's left edge to resize (300–900px)
- **LaTeX rendering**: Math formulas in AI responses are rendered automatically
- **Error boundaries**: Component-level error isolation — partial failures don't crash the whole UI
- **Unified theme**: Purple gradient accent, rounded card design

## Core Capabilities at a Glance

**Students**: Floating chat panel on problem pages, auto-reads problem statement, question type selection, optional code attachment, multi-turn conversations, selection-based Q&A, code optimization (post-AC), SSE streaming, LaTeX rendering

**Teachers**: View student conversations, filter by time / problem / class / student, sortable stats tables, question type distribution, CSV export (with optional anonymization)

**Admins**: Unified AI management portal, configure multiple API endpoints, auto-fetch model lists, model priority & fallback, rate limiting, custom system prompt, paginated jailbreak logs, cost dashboard, one-click updates

## Installation

```bash
# Clone and build
git clone https://github.com/AltureT/hydro-ai-helper.git
cd hydro-ai-helper
npm install
npm run build

# Install into HydroOJ
hydrooj addon add /path/to/hydro-ai-helper
pm2 restart hydrooj
```

Verify: visit `/ai-helper/hello` — a JSON response indicates success.

## Configuration

### Environment Variables

Set `ENCRYPTION_KEY` (32 characters) to encrypt API keys:

```bash
export ENCRYPTION_KEY="your-32-character-secret-key!!!"
```

Generate a random key: `openssl rand -base64 24 | head -c 32`

### Admin Configuration

After logging in, go to **Control Panel → AI Assistant** (`/ai-helper`), then switch to the "AI Configuration" tab:

#### API Endpoint Configuration

You can add multiple API endpoints. Each endpoint includes:

| Field | Description | Example |
| --- | --- | --- |
| Endpoint Name | Custom label | `Primary`, `Backup` |
| API Base URL | AI service URL | `https://api.openai.com/v1` |
| API Key | API key (encrypted at rest) | `sk-...` |
| Enabled | Whether to use in AI calls | On / Off |

Click "Fetch Models" to auto-discover available models for the endpoint.

#### Model Selection & Priority

Select models from all enabled endpoints and drag to reorder priority. When the primary model is unavailable (rate-limited, server error, etc.), the system automatically falls back to the next model in line.

#### Other Settings

| Field | Description | Default |
| --- | --- | --- |
| Rate Limit | Requests per user per minute | `5` |
| System Prompt | AI system prompt | Built-in tutoring prompt |

Click "Test Connection" to verify, then save.

## Usage

### Students

1. Open a problem page; expand the AI panel from the bottom-right corner (wide screens show it as a side panel)
2. Choose a question type (Understand / Approach / Debug)
3. Optional: describe your understanding and what you've tried
4. Optional: attach your current code
5. Send and receive guided AI responses
6. If something is unclear, select the text and click "I don't understand" to ask a follow-up
7. After AC, use the "Code Optimization" feature for performance improvement suggestions

### Teachers / Admins

Go to **Control Panel → AI Assistant** (`/ai-helper`) and switch between tabs:

- **Conversations** tab: View student conversation history; filter by time, problem, class, or student
- **Analytics** tab: View AI usage statistics with multi-dimensional analysis
- **AI Configuration** tab (admins only): Configure API endpoints, model priority, system prompt, etc.

URL parameter shortcuts: `/ai-helper?tab=analytics`, `/ai-helper?tab=config`

Data export: Click "Export Data" on the conversations page.

### Screenshots

**Student chat panel integrated with problem view:**

<img src="assets/screenshots/1.png" alt="Student panel example" width="800">

<img src="assets/screenshots/2.png" alt="Student panel example" width="400">

**Admin dashboard:**

<img src="assets/screenshots/3.png" alt="Admin dashboard" width="800">

<img src="assets/screenshots/4.png" alt="Admin dashboard" width="800">

<img src="assets/screenshots/5.png" alt="Admin dashboard" width="800">

<img src="assets/screenshots/6.png" alt="Admin dashboard" width="400">

<img src="assets/screenshots/7.png" alt="Admin dashboard" width="500">

## Project Structure

```
hydro-ai-helper/
├── src/                # Backend (TypeScript)
│   ├── models/         # Data models
│   ├── services/       # Business logic
│   ├── handlers/       # Route handlers
│   └── lib/            # Utilities
├── frontend/           # Frontend (React)
│   ├── student/        # Student components
│   ├── teacher/        # Teacher components
│   ├── admin/          # Admin components
│   └── components/     # Shared components (e.g., Tab container)
└── dist/               # Build output
```

## Development

```bash
npm run dev      # Development mode (watch)
npm run build    # Build
npm run lint     # Lint
```

## Telemetry & Privacy

### Data Collection

To better understand plugin usage and improve features, this plugin collects the following **anonymous statistics**:

- Installation count (deduplicated via random UUID)
- Active users in the last 7 days (aggregated)
- Total conversation count
- Plugin version

### Privacy Measures

- **Fully anonymous**: Uses random UUIDs; no personally identifiable information is collected
- **Hashed domains**: Domain IDs are SHA-256 hashed
- **Aggregated only**: Only user and conversation counts — no content is recorded
- **Auto-cleanup**: Data not reported for 90 days is automatically deleted
- **User-controlled**: Telemetry can be disabled via admin configuration

### How to Disable Telemetry

If you prefer not to send statistics, set this in your database:

```javascript
// Connect to MongoDB
use your_hydro_db

// Disable telemetry
db.ai_plugin_install.updateOne(
  { _id: 'install' },
  { $set: { telemetryEnabled: false } }
)
```

The plugin continues to work normally after disabling telemetry — no data will be reported.

### Data Usage

Collected data is used solely for:
- Displaying installation count, active users, conversations, and version badges on the GitHub README
- Understanding usage trends to prioritize feature development
- Assessing plugin stability and performance

**Our commitment**:
- We will NOT sell or share data with third parties
- We will NOT collect student code, problem content, or conversation records
- We will NOT track individual user behavior

## Changelog

<details>
<summary><b>v1.14.1</b> — Streaming Fix</summary>

- Fix SSE streaming response path issue, restoring real-time output

</details>

<details>
<summary><b>v1.14.0</b> — SSE Streaming & Cost Control & Security Hardening</summary>

- Implement SSE streaming output — AI responses display character-by-character in real time
- API cost control: token usage tracking, budget limits, cost dashboard
- Error classification in frontend with retry/cancel support
- Frontend refactor: component splitting, ErrorBoundary, LaTeX rendering, responsive tables
- Security hardening: CSRF protection, domain isolation, tightened endpoint permissions, 3-layer prompt injection defense, enhanced API key encryption, SSRF prevention
- Support AI assistant in homework/contest mode
- Test coverage increased from 34% to 45% with 191 new test cases
- Fix plugin crash when ENCRYPTION_KEY is not set

</details>

<details>
<summary><b>v1.12.0</b> — Judge Data Integration & Prompt Optimization</summary>

- Integrate judge data to help AI analyze errors
- Contest mode restrictions on AI usage
- Prompt consolidation and optimization — ~45% token reduction
- Auto-check "attach code" when "Debug Errors" type is selected
- Fix session guard and orphaned session issues

</details>

<details>
<summary><b>v1.11.0</b> — AI Response Style & Anti-Jailbreak Enhancement</summary>

- Remove templated AI response style for more natural guided answers
- Strengthen multi-turn anti-jailbreak detection to prevent gradual bypasses

</details>

<details>
<summary><b>v1.10.x</b> — Telemetry & One-click Update Improvements</summary>

- Add anonymous telemetry statistics and GitHub badges
- Question type statistics (per-problem dimension)
- One-click update improvements: streaming progress display, switch to HydroOJ's official pm2 restart method
- Auto-recover expired sessions
- Support Volcengine Endpoint ID format for model fetching

</details>

<details>
<summary><b>v1.9.0</b> — Security Hardening</summary>

- Comprehensive security audit and hardening (P0 + P1 level)
- One-click update security fixes
- npm auto-publish workflow

</details>

<details>
<summary><b>v1.8.x</b> — Code Optimization Feature</summary>

- Add "Code Optimization" question type (AC-only)
- Real-time AC status detection with auto-displayed optimization option
- Code loading confirmation dialog
- Support for Doubao and other domestic LLM model fetching
- Rate limit configuration fixes

</details>

<details>
<summary><b>v1.6.0</b> — Unified Management Portal</summary>

- Consolidate three separate menus into a single "AI Assistant" entry
- Tab navigation: Conversations / Analytics / Configuration
- Resizable AI panel width

</details>

<details>
<summary><b>v1.5.0</b> — Panel Resizing & CI</summary>

- Draggable AI panel width adjustment
- GitHub → Gitee auto-sync workflow

</details>

<details>
<summary><b>v1.4.0</b> — Multi-endpoint Configuration</summary>

- Multiple API endpoint configuration with auto model discovery
- Model priority fallback mechanism
- AES-256-GCM encrypted API key storage

</details>

<details>
<summary><b>v1.3.0</b> — One-click Update</summary>

- One-click plugin update (dual-repo version detection: GitHub + Gitee)
- Domain isolation and multi-dimensional analytics

</details>

<details>
<summary><b>v1.2.0</b> — Question Type Enhancement</summary>

- Add differentiated question types (Understand / Approach / Debug)

</details>

<details>
<summary><b>v1.0.0</b> — Initial Release</summary>

- AI-assisted learning chat panel
- Multi-turn conversations with context
- Selection-based Q&A
- Teacher conversation viewer with data export
- Admin API configuration and custom system prompt

</details>

## About

This project is a third-party plugin for the [HydroOJ](https://github.com/hydro-dev/Hydro) open-source online judge system, developed with AI assistance. Feel free to open an Issue for questions or suggestions.

## License

MIT License
