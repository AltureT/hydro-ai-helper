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

## Screenshots

**Student chat panel integrated with problem view:**

<img src="assets/screenshots/1.png" alt="Student panel - wide screen" width="800">

<img src="assets/screenshots/2.png" alt="Student panel - narrow screen" width="400">

**Admin dashboard:**

<img src="assets/screenshots/3.png" alt="Admin - conversations" width="800">

<img src="assets/screenshots/4.png" alt="Admin - analytics" width="800">

<img src="assets/screenshots/5.png" alt="Admin - configuration" width="800">

<img src="assets/screenshots/6.png" alt="Admin - jailbreak logs" width="400">

<img src="assets/screenshots/7.png" alt="Admin - cost dashboard" width="500">

## Features

### For Students

- **AI chat panel on problem pages** — auto-reads the problem statement and supports optional code attachment
- **Differentiated question types** — choose "Understand the Problem", "Organize Approach", "Debug Errors", or "Code Optimization" (AC-only) for tailored guidance
- **Multi-turn conversations** — ask follow-ups within the same conversation; history persists across page refreshes
- **"I Don't Understand"** — select confusing text in an AI reply for a concise, targeted explanation
- **Real-time streaming** — AI responses appear character-by-character via SSE
- **LaTeX rendering** — math formulas in AI responses are rendered automatically
- **Responsive UI** — LeetCode-style three-column layout on wide screens; floating panel on narrow screens

### For Teachers

- **Conversation viewer** — browse student conversation history with filters (time / problem / class / student)
- **Usage analytics** — multi-dimensional stats with sortable tables and question-type distribution
- **Data export** — CSV export with optional anonymization

### For Admins

- **Unified management portal** — one "AI Assistant" entry with tab navigation (Conversations / Analytics / Configuration)
- **Multi-endpoint & model management** — add multiple API endpoints, auto-discover models, drag to set priority with automatic failover
- **Cost control** — token usage tracking, budget limits, cost dashboard
- **Rate limiting** — configurable per-user request limits
- **Custom system prompt** — override the built-in tutoring prompt
- **One-click update** — check and install new versions from the admin panel

<details>
<summary><b>Security</b></summary>

- Multi-layer jailbreak detection (input / prompt / output) with cross-turn protection
- CSRF token validation on critical operations
- SSRF prevention on API endpoint configuration
- AES-256-GCM encrypted API key storage
- Paginated jailbreak audit logs

</details>

## Installation

```bash
# Clone (choose one)
git clone https://github.com/AltureT/hydro-ai-helper.git   # GitHub
git clone https://gitee.com/alture/hydro-ai-helper.git      # Gitee (mirror)

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

1. **Add API endpoints** — fill in endpoint name, API Base URL, and API Key, then click "Fetch Models"
2. **Select models & set priority** — pick models from enabled endpoints and drag to reorder; failover is automatic
3. **Adjust settings** — rate limit (default: 5/min/user), custom system prompt
4. **Test & save** — click "Test Connection" to verify, then save

## Usage

### Students

1. Open a problem page; expand the AI panel from the bottom-right corner (wide screens show it as a side panel)
2. Choose a question type (Understand / Approach / Debug)
3. Optional: describe your understanding and what you've tried
4. Optional: attach your current code
5. Send and receive guided AI responses
6. If something is unclear, select the text and click "I don't understand" for a follow-up
7. After AC, use the "Code Optimization" feature for performance improvement suggestions

### Teachers / Admins

Go to **Control Panel → AI Assistant** (`/ai-helper`) and switch between tabs:

- **Conversations** — view student conversation history with multi-dimensional filters
- **Analytics** — AI usage statistics and question-type distribution
- **AI Configuration** (admins only) — API endpoints, model priority, system prompt, cost dashboard

## Telemetry & Privacy

This plugin collects **anonymous statistics** (installation count, active users, conversation count, plugin version) to display GitHub badges and guide feature development.

- Fully anonymous (random UUID, no PII); domain IDs are SHA-256 hashed
- Only aggregated counts — no code, conversations, or personal data
- Auto-cleanup after 90 days of inactivity

<details>
<summary><b>How to disable telemetry</b></summary>

```javascript
// Connect to MongoDB
use your_hydro_db

// Disable telemetry
db.ai_plugin_install.updateOne(
  { _id: 'install' },
  { $set: { telemetryEnabled: false } }
)
```

The plugin continues to work normally after disabling.

</details>

## Changelog

<details>
<summary><b>v1.14.1</b> — Streaming Fix</summary>

- Fix SSE streaming response path issue, restoring real-time output

</details>

<details>
<summary><b>v1.14.0</b> — SSE Streaming & Cost Control & Security Hardening</summary>

- SSE streaming output — AI responses display character-by-character in real time
- API cost control: token usage tracking, budget limits, cost dashboard
- Error classification in frontend with retry/cancel support
- Security hardening: CSRF protection, SSRF prevention, 3-layer prompt injection defense
- Support AI assistant in homework/contest mode

</details>

<details>
<summary><b>v1.12.0</b> — Judge Data Integration & Prompt Optimization</summary>

- Integrate judge data to help AI analyze errors
- Contest mode restrictions on AI usage
- Prompt optimization — ~45% token reduction

</details>

<details>
<summary><b>v1.11.0</b> — AI Response Style & Anti-Jailbreak Enhancement</summary>

- More natural guided AI responses
- Strengthen multi-turn anti-jailbreak detection

</details>

<details>
<summary><b>v1.10.x</b> — Telemetry & One-click Update</summary>

- Anonymous telemetry statistics and GitHub badges
- One-click update with streaming progress display

</details>

<details>
<summary><b>v1.9.0 and earlier</b></summary>

- v1.9.0: Comprehensive security audit and hardening
- v1.8.x: "Code Optimization" question type (AC-only), real-time AC detection
- v1.6.0: Unified management portal with tab navigation
- v1.5.0: Draggable AI panel width
- v1.4.0: Multi-endpoint configuration with model priority fallback
- v1.3.0: One-click plugin update, domain isolation
- v1.2.0: Differentiated question types
- v1.0.0: Initial release — AI chat, multi-turn conversations, selection-based Q&A

</details>

## About

A third-party plugin for [HydroOJ](https://github.com/hydro-dev/Hydro). Feel free to open an Issue for questions or suggestions.

## License

MIT License
