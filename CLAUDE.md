# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

HydroOJ AI Learning Assistant (`hydro-ai-helper`) — a TypeScript plugin for HydroOJ (online judge system) that provides guided AI tutoring for programming students. Teaching-first design: hints and guidance only, never complete solutions. Multi-tenant via `domainId` isolation.

## Build & Dev Commands

```bash
# Build the plugin (compiles TypeScript → dist/)
npm run build:plugin    # tsc

# Watch mode for development
npm run dev             # tsc --watch

# Lint
npm run lint            # eslint src --ext .ts,.tsx

# Run all tests
npm test                # jest

# Run a single test file
npx jest src/__tests__/services/promptService.test.ts

# Run tests matching a pattern
npx jest --testPathPattern="rateLimitService"
```

Note: `npm run build` is a no-op (Vercel Functions stub). Use `build:plugin` for the actual TypeScript compilation.

## Architecture

### Plugin Lifecycle

Entry point: `src/index.ts` — uses `definePlugin()` from HydroOJ. The `apply(ctx)` function:
1. Instantiates all models with `ctx.db` (MongoDB)
2. Creates indexes, runs migrations
3. Injects models into `ctx` via `ctx.provide('modelName', instance)`
4. Registers routes via `ctx.Route(name, path, Handler, Priv)`

All routes support domain-prefixed variants: `/d/:domainId/ai-helper/*`.

### Layer Structure

```
handlers/  → HTTP handlers (extend HydroOJ's Handler class)
services/  → Business logic (prompt building, rate limiting, safety, AI client)
models/    → MongoDB collection wrappers (CRUD + indexes)
lib/       → Generic utilities (crypto, query helpers, HTTP helpers)
constants/ → Jailbreak patterns, permission constants
utils/     → HydroOJ-specific helpers (ObjectId resolution, domain extraction)
frontend/  → React 17 components (TSX, rendered into HydroOJ templates)
```

### Request Flow (Student Chat)

`ChatHandler.post()` → rate limit check → contest mode validation → topic guard → prompt construction (with question type differentiation) → `OpenAIClient` tries endpoints by priority → output safety filter → effectiveness analysis → save to MongoDB → respond

### Key Abstractions

- **Handlers** access models via `this.ctx.get('modelName')`, user via `this.user._id`, domain via `getDomainId(this)` from `utils/domainHelper.ts`
- **Models** wrap MongoDB collections; constructor takes `db: Db`, expose `ensureIndexes()` and CRUD methods
- **AIConfigModel** stores a single config record (id=`'default'`) with v2 schema supporting multiple API endpoints with fallback priority
- **API keys** are AES-256-GCM encrypted via `lib/crypto.ts`; encryption key from `ENCRYPTION_KEY` env var

### MongoDB Collections & Model Injection

All records carry `domainId` for tenant isolation (default: `'system'`). Models are injected in `src/index.ts` via `ctx.provide()`:

| `ctx.get(name)` | Class | Collection |
|---|---|---|
| `'aiConfigModel'` | `AIConfigModel` | `ai_config` |
| `'conversationModel'` | `ConversationModel` | `ai_conversations` |
| `'messageModel'` | `MessageModel` | `ai_messages` |
| `'rateLimitRecordModel'` | `RateLimitRecordModel` | `ai_rate_limit_records` (TTL 2min) |
| `'jailbreakLogModel'` | `JailbreakLogModel` | `ai_jailbreak_logs` |
| `'tokenUsageModel'` | `TokenUsageModel` | `ai_token_usage` |

Other collections (no model wrapper): `ai_plugin_install`, `ai_version_cache`.

## Critical Import Pattern

**Always** import `ObjectId` from `src/utils/mongo.ts`, not directly from `mongodb`:

```typescript
import { ObjectId, ObjectIdType } from '../utils/mongo';
```

This resolves `ObjectId` from HydroOJ's runtime `mongodb` package to avoid BSON major-version mismatches. Importing directly from `mongodb` will cause runtime failures.

## TypeScript Configuration

- `strict: false` — required for compatibility with HydroOJ's loose types
- `target: ES2020`, `module: CommonJS`
- Path alias: `"hydrooj"` → `["types/hydrooj"]`
- `skipLibCheck: true` to avoid node_modules type conflicts

## Testing

- Jest + ts-jest, node environment
- Tests in `src/__tests__/` mirroring `src/` structure
- HydroOJ mocked in `src/__tests__/__mocks__/hydrooj.ts`
- Mock Handler and db objects for handler/service isolation

## Environment Variables

- `ENCRYPTION_KEY` (required in production): 32-char string for AES-256-GCM. Dev default exists but logs a warning.
- `MONGODB_URI` / `MONGODB_DB`: Only needed if running outside HydroOJ (plugin uses `ctx.db` at runtime).

## Conventions

- Files: camelCase. Classes: PascalCase. Constants: UPPER_SNAKE_CASE.
- Handlers set `this.response.body`, `this.response.type`, `this.response.status`.
- Console logging prefixed with `[AI-Helper]` or `[ServiceName]`.
- `domainId` is always a string; extract via `getDomainId(this)` in handlers.
- `pid` (problem ID) can be string or number depending on context — always check the schema before comparisons.

## Verification Workflow

After any TypeScript change:
1. `npm run build:plugin` — must pass with zero errors
2. `npm run lint` — fix any warnings before committing
3. `npm test` — run affected test files at minimum

## Route Map (Quick Reference)

Handler registration is in `src/index.ts`. Key routes:
- `/ai-helper/chat` → `studentHandler.ChatHandler` (POST=send message, supports SSE streaming)
- `/ai-helper/config` → `adminConfigHandler` (GET/POST config, requires PRIV_EDIT_SYSTEM)
- `/ai-helper/conversations` → `studentHandler` (GET=list user conversations)
- `/ai-helper/analytics` → `analyticsHandler` (teacher/admin stats)
- `/ai-helper/dashboard` → `dashboardHandler` (admin overview)
- `/ai-helper/export` → `exportHandler` (data export)
- `/ai-helper/cost-analytics` → `costAnalyticsHandler` (token usage stats)
- `/ai-helper/version` → `versionHandler` (plugin version check)

All routes also registered with `/d/:domainId/` prefix for domain isolation.

## Handler Response Patterns

- **JSON API**: `this.response.type = 'application/json'; this.response.body = {...}`
- **HTML template**: `this.response.template = 'ai-helper/xxx.html'; this.response.body = {...}`
- **SSE streaming**: Use `createSSEWriter()` from `lib/sseHelper.ts`, set headers via helper
- Always check `this.request.headers.accept` when handler supports both HTML and JSON

## Frontend

React 17 components in `frontend/` are bundled by HydroOJ's build system (not this plugin).
Page files (`*.page.tsx`) register with HydroOJ's page loader automatically.
No separate frontend build command needed — HydroOJ handles compilation.

### Frontend Build Pipeline (HydroOJ internals)

HydroOJ uses **esbuild at runtime** (not webpack) to compile addon `frontend/*.page.tsx` files:
- `@hydrooj/ui-default/backendlib/builder.ts` → `buildUI()` runs on `app/started` event
- Scans all addon `frontend/` dirs for `*.page.tsx` / `*.lazy.tsx`
- Output served via `/lazy/:version/:name` with cache-busting version hash
- **After `pm2 restart hydrooj`**, frontend is automatically recompiled

### i18n — Critical: How Translations Reach the Frontend

Frontend `i18n()` (from `@hydrooj/ui-default/utils/base.ts`) reads from `window.LOCALES` object.
This object is serialized into `lang-zh.js` during `buildUI()` from `global.Hydro.locales`.

**Translation flow:**
1. Plugin `apply()` calls `ctx.i18n.load('zh', dict)` → registers translations in `global.Hydro.locales`
2. `ctx.i18n.load()` emits `app/i18n/update` event
3. Builder listens: `ctx.on('app/i18n/update', debouncedBuildUI)` (2s debounce)
4. `buildUI()` serializes `global.Hydro.locales[lang]` → `lang-zh.js` → `window.LOCALES={...}`
5. Browser loads versioned `lang-zh.js`, frontend `i18n(key)` finds the translation

**When adding new i18n keys:**
- Add keys to BOTH `locales/en.yaml` and `locales/zh.yaml`
- The plugin's `apply()` in `src/index.ts` loads these via `ctx.i18n.load()`
- After deploy + `pm2 restart`, the debouncedBuildUI should regenerate `lang-zh.js`
- Users may need to **hard-refresh** (Ctrl+Shift+R) to bypass browser cache of old `lang-*.js`
- If translations still show as raw keys, verify: (1) YAML parses correctly, (2) `[AI-Helper] Locales loaded` appears in pm2 logs, (3) timing — buildUI may run before plugin locale load; a full `pm2 restart` (not reload) ensures proper sequencing
