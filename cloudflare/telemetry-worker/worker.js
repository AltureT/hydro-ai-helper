import {
  deriveAesKey,
  decryptConfig,
  readAlertConfig,
  writeAlertConfig,
  removeAlertConfig,
  buildSafeAlertText,
  buildTelegramRequest,
  mapTelegramError,
  testThrottled,
} from './alertConfig.mjs';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const BADGE_CACHE_CONTROL = 'public, max-age=0, s-maxage=300';

const compactFormatter = new Intl.NumberFormat('en', {
  notation: 'compact',
  compactDisplay: 'short',
  maximumFractionDigits: 1,
});

function applyCorsHeaders(headers) {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
}

function json(data, init = {}) {
  const headers = new Headers(init.headers);
  applyCorsHeaders(headers);
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json; charset=utf-8');
  }
  return new Response(JSON.stringify(data), { ...init, headers });
}

function badge({ label, message, color }) {
  return json(
    { schemaVersion: 1, label, message, color },
    { status: 200, headers: { 'Cache-Control': BADGE_CACHE_CONTROL } },
  );
}

function formatCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '0';
  }
  return compactFormatter.format(value);
}

function readFiniteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `${field} is required`);
  }
  return value;
}

function requireNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new HttpError(400, `${field} must be a number`);
  }
  return value;
}

function parseDate(value, field, required) {
  if (value === undefined || value === null || value === '') {
    if (required) {
      throw new HttpError(400, `${field} is required`);
    }
    return undefined;
  }

  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new HttpError(400, `${field} is invalid`);
  }

  return date;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function isAuthorized(request, env) {
  const token = (env.REPORT_TOKEN || '').trim();
  if (!token) {
    return false;
  }

  const header = request.headers.get('Authorization') || '';
  const [type, value] = header.split(' ');
  if (type !== 'Bearer' || !value) {
    return false;
  }

  return value === token;
}

async function handleReport(request, env) {
  if (request.method === 'OPTIONS') {
    const headers = new Headers();
    applyCorsHeaders(headers);
    return new Response(null, { status: 204, headers });
  }

  if (request.method !== 'POST') {
    return json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  if (!isAuthorized(request, env)) {
    return json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  if (!env.DB) {
    return json({ success: false, error: 'DB binding not configured' }, { status: 500 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!isRecord(body)) {
    return json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    const instanceId = requireString(body.instance_id, 'instance_id');
    const eventRaw = requireString(body.event, 'event');
    if (eventRaw !== 'install' && eventRaw !== 'heartbeat') {
      throw new HttpError(400, 'event must be install or heartbeat');
    }

    const version = requireString(body.version, 'version');
    const installedAt = parseDate(body.installed_at, 'installed_at', true);
    const firstUsedAt = parseDate(body.first_used_at, 'first_used_at', false);
    const lastReportAt = parseDate(body.timestamp, 'timestamp', true);
    const domainHash = requireString(body.domain_hash, 'domain_hash');

    if (!isRecord(body.stats)) {
      throw new HttpError(400, 'stats is required');
    }

    const activeUsers7d = Math.max(
      0,
      Math.floor(requireNumber(body.stats.active_users_7d, 'stats.active_users_7d')),
    );
    const totalConversations = Math.max(
      0,
      Math.floor(requireNumber(body.stats.total_conversations, 'stats.total_conversations')),
    );
    const lastUsedAt = parseDate(body.stats.last_used_at, 'stats.last_used_at', false);

    // Enhanced heartbeat fields (optional, backward compatible)
    const stats = body.stats || {};
    const env_info = body.environment || {};
    const errorCount24h = typeof stats.error_count_24h === 'number' ? stats.error_count_24h : 0;
    const apiSuccessCount24h = typeof stats.api_success_count_24h === 'number' ? stats.api_success_count_24h : 0;
    const apiFailureCount24h = typeof stats.api_failure_count_24h === 'number' ? stats.api_failure_count_24h : 0;
    const avgLatencyMs24h = typeof stats.avg_latency_ms_24h === 'number' ? stats.avg_latency_ms_24h : 0;
    const activeEndpointCount = typeof stats.active_endpoint_count === 'number' ? stats.active_endpoint_count : 0;
    const nodeVersion = typeof env_info.node_version === 'string' ? env_info.node_version : null;
    const osPlatform = typeof env_info.os_platform === 'string' ? env_info.os_platform : null;
    const features = body.features ? JSON.stringify(body.features) : null;
    const latencyBuckets = isRecord(stats.latency_buckets)
      ? JSON.stringify(stats.latency_buckets).slice(0, 2000)
      : null;

    await env.DB.prepare(
      `INSERT INTO plugin_stats (
        instance_id, event, version, installed_at, first_used_at,
        last_report_at, active_users_7d, total_conversations, last_used_at, domain_hash,
        error_count_24h, api_success_count_24h, api_failure_count_24h,
        avg_latency_ms_24h, active_endpoint_count, node_version, os_platform, features,
        latency_buckets
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(instance_id) DO UPDATE SET
        event = excluded.event,
        version = excluded.version,
        first_used_at = COALESCE(plugin_stats.first_used_at, excluded.first_used_at),
        last_report_at = excluded.last_report_at,
        active_users_7d = excluded.active_users_7d,
        total_conversations = excluded.total_conversations,
        last_used_at = excluded.last_used_at,
        domain_hash = excluded.domain_hash,
        error_count_24h = excluded.error_count_24h,
        api_success_count_24h = excluded.api_success_count_24h,
        api_failure_count_24h = excluded.api_failure_count_24h,
        avg_latency_ms_24h = excluded.avg_latency_ms_24h,
        active_endpoint_count = excluded.active_endpoint_count,
        node_version = excluded.node_version,
        os_platform = excluded.os_platform,
        features = excluded.features,
        latency_buckets = excluded.latency_buckets`,
    )
      .bind(
        instanceId, eventRaw, version,
        installedAt.toISOString(),
        firstUsedAt ? firstUsedAt.toISOString() : null,
        lastReportAt.toISOString(),
        activeUsers7d, totalConversations,
        lastUsedAt ? lastUsedAt.toISOString() : null,
        domainHash,
        errorCount24h, apiSuccessCount24h, apiFailureCount24h,
        avgLatencyMs24h, activeEndpointCount, nodeVersion, osPlatform, features,
        latencyBuckets,
      )
      .run();

    // Per-feature health snapshot (optional, backward compatible). Upsert one
    // row per (instance_id, feature) holding the latest 24h counters.
    if (Array.isArray(body.feature_stats) && body.feature_stats.length > 0) {
      const reportAt = lastReportAt.toISOString();
      const featureStmts = [];
      for (const f of body.feature_stats.slice(0, 50)) {
        if (!isRecord(f) || typeof f.feature !== 'string' || f.feature.trim() === '') continue;
        featureStmts.push(
          env.DB.prepare(
            `INSERT INTO plugin_feature_stats (
              instance_id, feature, attempts, successes, last_success_at, version, report_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(instance_id, feature) DO UPDATE SET
              attempts = excluded.attempts,
              successes = excluded.successes,
              last_success_at = excluded.last_success_at,
              version = excluded.version,
              report_at = excluded.report_at,
              received_at = datetime('now')`,
          ).bind(
            instanceId,
            f.feature.slice(0, 60),
            Math.max(0, Math.floor(typeof f.attempts === 'number' ? f.attempts : 0)),
            Math.max(0, Math.floor(typeof f.successes === 'number' ? f.successes : 0)),
            typeof f.last_success_at === 'string' ? f.last_success_at.slice(0, 40) : null,
            version,
            reportAt,
          ),
        );
      }
      if (featureStmts.length > 0) await env.DB.batch(featureStmts);
    }

    return json({ success: true }, { status: 200 });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof HttpError ? error.message : 'Internal Server Error';
    console.error('[report] error', error);
    return json({ success: false, error: message }, { status });
  }
}

async function handleBadgeInstalls(env) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM plugin_stats').first();
  const count = row ? readFiniteNumber(row.count) : 0;
  console.info('[badge-installs] count', count);
  return badge({ label: 'installations', message: formatCount(count), color: 'blue' });
}

async function handleBadgeActive(env) {
  const row = await env.DB.prepare('SELECT COALESCE(SUM(active_users_7d), 0) AS total FROM plugin_stats').first();
  const total = row ? readFiniteNumber(row.total) : 0;
  console.info('[badge-active] total', total);
  return badge({ label: 'active users (7d)', message: formatCount(total), color: 'green' });
}

async function handleBadgeConversations(env) {
  const row = await env.DB.prepare('SELECT COALESCE(SUM(total_conversations), 0) AS total FROM plugin_stats').first();
  const total = row ? readFiniteNumber(row.total) : 0;
  console.info('[badge-conversations] total', total);
  return badge({ label: 'conversations', message: formatCount(total), color: 'purple' });
}

async function handleBadgeVersion(env) {
  const row = await env.DB.prepare(
    `SELECT version, COUNT(*) AS installs, MAX(last_report_at) AS last_report_at_max
     FROM plugin_stats
     WHERE version IS NOT NULL AND version != ''
     GROUP BY version
     ORDER BY installs DESC, last_report_at_max DESC, version DESC
     LIMIT 1`,
  ).first();

  const version = row && typeof row.version === 'string' ? row.version : '';
  console.info('[badge-version] version', version);
  return badge({
    label: 'version (mode)',
    message: version ? `v${version}` : 'n/a',
    color: 'orange',
  });
}

// ─── Error Reports Handler ──────────────────────────────

// Merge the plugin-supplied stack frames and runtime env into a single metadata
// JSON blob (the trust boundary: re-sanitize lengths/shapes defensively). No
// schema migration needed — these ride along in the existing `metadata` column.
function buildErrorMetadata(e) {
  const meta = isRecord(e.metadata) ? { ...e.metadata } : {};

  if (Array.isArray(e.stack_frames)) {
    const frames = e.stack_frames
      .filter((f) => typeof f === 'string')
      .slice(0, 10)
      .map((f) => f.slice(0, 240));
    if (frames.length) meta.stack_frames = frames;
  }

  if (isRecord(e.env)) {
    const env_info = {};
    if (typeof e.env.mongodb_version === 'string') {
      env_info.mongodb_version = e.env.mongodb_version.slice(0, 40);
    }
    if (typeof e.env.node_version === 'string') {
      env_info.node_version = e.env.node_version.slice(0, 40);
    }
    if (Object.keys(env_info).length) meta.env = env_info;
  }

  return Object.keys(meta).length ? JSON.stringify(meta).slice(0, 4000) : null;
}

async function handleErrors(request, env) {
  if (request.method === 'OPTIONS') {
    const headers = new Headers();
    applyCorsHeaders(headers);
    return new Response(null, { status: 204, headers });
  }

  if (request.method !== 'POST') {
    return json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  if (!isAuthorized(request, env)) {
    return json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!isRecord(body)) {
    return json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    const instanceId = requireString(body.instance_id, 'instance_id');
    const version = typeof body.version === 'string' ? body.version : null;
    const domainHash = typeof body.domain_hash === 'string' ? body.domain_hash : null;

    if (!Array.isArray(body.errors) || body.errors.length === 0) {
      throw new HttpError(400, 'errors array is required');
    }

    // Rate limit: max 500 error records per instance per day
    const today = new Date().toISOString().slice(0, 10);
    const countRow = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM plugin_errors
       WHERE instance_id = ? AND received_at >= ?`,
    ).bind(instanceId, today).first();
    const currentCount = countRow ? readFiniteNumber(countRow.cnt) : 0;
    if (currentCount >= 500) {
      return json({ success: false, error: 'Daily error limit reached' }, { status: 429 });
    }

    const maxToInsert = Math.min(body.errors.length, 100, 500 - currentCount);
    const stmts = [];
    for (let i = 0; i < maxToInsert; i++) {
      const e = body.errors[i];
      if (!isRecord(e)) continue;
      stmts.push(
        env.DB.prepare(
          `INSERT INTO plugin_errors (
            instance_id, version, domain_hash, error_type, category,
            message, http_status, count, first_seen, last_seen, stack_fingerprint, metadata
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          instanceId,
          version,
          domainHash,
          typeof e.error_type === 'string' ? e.error_type : 'unknown',
          typeof e.category === 'string' ? e.category : 'unknown',
          typeof e.message === 'string' ? e.message.slice(0, 1000) : null,
          typeof e.http_status === 'number' ? e.http_status : null,
          typeof e.count === 'number' ? e.count : 1,
          typeof e.first_seen === 'string' ? e.first_seen : new Date().toISOString(),
          typeof e.last_seen === 'string' ? e.last_seen : new Date().toISOString(),
          typeof e.stack_fingerprint === 'string' ? e.stack_fingerprint.slice(0, 16) : null,
          buildErrorMetadata(e),
        ),
      );
    }

    if (stmts.length > 0) {
      await env.DB.batch(stmts);
    }

    return json({ success: true, inserted: stmts.length }, { status: 200 });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof HttpError ? error.message : 'Internal Server Error';
    console.error('[errors] error', error);
    return json({ success: false, error: message }, { status });
  }
}

// ─── Feedback Handler ──────────────────────────────────

async function handleFeedback(request, env) {
  if (request.method === 'OPTIONS') {
    const headers = new Headers();
    applyCorsHeaders(headers);
    return new Response(null, { status: 204, headers });
  }

  if (request.method !== 'POST') {
    return json({ success: false, error: 'Method Not Allowed' }, { status: 405 });
  }

  if (!isAuthorized(request, env)) {
    return json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!isRecord(body)) {
    return json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    const instanceId = requireString(body.instance_id, 'instance_id');
    const version = typeof body.version === 'string' ? body.version : null;
    const domainHash = typeof body.domain_hash === 'string' ? body.domain_hash : null;

    if (!isRecord(body.feedback)) {
      throw new HttpError(400, 'feedback object is required');
    }

    const fb = body.feedback;
    const fbType = requireString(fb.type, 'feedback.type');
    if (!['bug', 'feature', 'other'].includes(fbType)) {
      throw new HttpError(400, 'feedback.type must be bug, feature, or other');
    }
    const subject = requireString(fb.subject, 'feedback.subject').slice(0, 200);
    const fbBody = typeof fb.body === 'string' ? fb.body.slice(0, 2000) : null;
    const contactEmail = typeof fb.contact_email === 'string' ? fb.contact_email.slice(0, 200) : null;
    const envInfo = isRecord(fb.environment) ? JSON.stringify(fb.environment) : null;

    // Rate limit: max 10 feedbacks per instance per day
    const today = new Date().toISOString().slice(0, 10);
    const countRow = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM plugin_feedback
       WHERE instance_id = ? AND received_at >= ?`,
    ).bind(instanceId, today).first();
    const currentCount = countRow ? readFiniteNumber(countRow.cnt) : 0;
    if (currentCount >= 10) {
      return json({ success: false, error: 'Daily feedback limit reached' }, { status: 429 });
    }

    await env.DB.prepare(
      `INSERT INTO plugin_feedback (
        instance_id, version, domain_hash, type, subject, body, contact_email, environment_info
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(instanceId, version, domainHash, fbType, subject, fbBody, contactEmail, envInfo).run();

    return json({ success: true }, { status: 200 });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof HttpError ? error.message : 'Internal Server Error';
    console.error('[feedback] error', error);
    return json({ success: false, error: message }, { status });
  }
}

// ─── Dashboard API ─────────────────────────────────────

function isDashboardAuthorized(request, env) {
  const token = (env.DASHBOARD_TOKEN || '').trim();
  if (!token) return false;
  const header = request.headers.get('Authorization') || '';
  const [type, value] = header.split(' ');
  return type === 'Bearer' && value === token;
}

async function handleDashboardOverview(request, env) {
  if (!isDashboardAuthorized(request, env)) {
    return json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const cutoff90d = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS instance_count,
            COALESCE(SUM(active_users_7d), 0) AS active_users_7d,
            COALESCE(SUM(total_conversations), 0) AS total_conversations,
            COALESCE(SUM(api_failure_count_24h), 0) AS failures,
            COALESCE(SUM(api_success_count_24h), 0) AS successes
     FROM plugin_stats
     WHERE last_report_at >= ?`,
  ).bind(cutoff90d).first();

  const totalRequests = (row?.successes || 0) + (row?.failures || 0);
  const errorRate = totalRequests > 0 ? ((row?.failures || 0) / totalRequests * 100).toFixed(2) : '0.00';

  // Merge per-instance latency histograms and interpolate global percentiles.
  const latRows = await env.DB.prepare(
    `SELECT latency_buckets FROM plugin_stats
     WHERE last_report_at >= ? AND latency_buckets IS NOT NULL`,
  ).bind(cutoff90d).all();
  const merged = {};
  for (const r of (latRows?.results || [])) {
    let buckets;
    try { buckets = JSON.parse(r.latency_buckets); } catch { continue; }
    if (!isRecord(buckets)) continue;
    for (const [k, v] of Object.entries(buckets)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) merged[k] = (merged[k] || 0) + n;
    }
  }

  return json({
    instances: row?.instance_count || 0,
    active_users_7d: row?.active_users_7d || 0,
    total_conversations: row?.total_conversations || 0,
    error_rate_percent: parseFloat(errorRate),
    latency_p50_ms: percentileFromBuckets(merged, 0.5),
    latency_p95_ms: percentileFromBuckets(merged, 0.95),
    latency_p99_ms: percentileFromBuckets(merged, 0.99),
  });
}

// Histogram upper bounds (ms) — must match the plugin's recordSuccess buckets.
const LATENCY_BUCKET_BOUNDS = [250, 500, 1000, 2000, 5000, 10000, 20000, 30000, 60000];
const LATENCY_INF_BOUND = 120000; // sentinel upper bound for the open-ended 'inf' bucket

// Linear-interpolated percentile over a merged bucket histogram.
function percentileFromBuckets(merged, p) {
  const ordered = [...LATENCY_BUCKET_BOUNDS, Infinity];
  const keyFor = (b) => (b === Infinity ? 'inf' : String(b));
  let total = 0;
  for (const b of ordered) total += merged[keyFor(b)] || 0;
  if (total === 0) return null;

  const target = p * total;
  let cum = 0;
  let lower = 0;
  for (const b of ordered) {
    const upper = b === Infinity ? LATENCY_INF_BOUND : b;
    const count = merged[keyFor(b)] || 0;
    if (count > 0 && cum + count >= target) {
      const within = (target - cum) / count;
      return Math.round(lower + (upper - lower) * within);
    }
    cum += count;
    lower = upper;
  }
  return LATENCY_INF_BOUND;
}

async function handleDashboardInstances(request, env) {
  if (!isDashboardAuthorized(request, env)) {
    return json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  const cutoff90d = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const rows = await env.DB.prepare(
    `SELECT instance_id, version, active_users_7d, total_conversations,
            error_count_24h, api_failure_count_24h, last_report_at, node_version, os_platform
     FROM plugin_stats
     WHERE last_report_at >= ?
     ORDER BY last_report_at DESC LIMIT ? OFFSET ?`,
  ).bind(cutoff90d, limit, offset).all();

  return json({ instances: rows?.results || [] });
}

async function handleDashboardErrors(request, env) {
  if (!isDashboardAuthorized(request, env)) {
    return json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  const cutoff30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const rows = await env.DB.prepare(
    `SELECT stack_fingerprint, error_type, category, message, metadata,
            COUNT(DISTINCT instance_id) AS affected_instances,
            SUM(count) AS total_count,
            MAX(last_seen) AS last_seen,
            GROUP_CONCAT(DISTINCT version) AS versions
     FROM plugin_errors
     WHERE received_at >= ?
     GROUP BY stack_fingerprint
     ORDER BY last_seen DESC
     LIMIT ? OFFSET ?`,
  ).bind(cutoff30d, limit, offset).all();

  return json({ errors: rows?.results || [] });
}

async function handleDashboardFeatureHealth(request, env) {
  if (!isDashboardAuthorized(request, env)) {
    return json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  // Aggregate the latest per-instance snapshots across instances that reported
  // in the last 7 days. broken_instances = instances that attempted the feature
  // but produced zero successes (the "100% broken, error rate 0%" signal).
  const cutoff7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const rows = await env.DB.prepare(
    `SELECT feature,
            SUM(attempts) AS attempts,
            SUM(successes) AS successes,
            SUM(CASE WHEN attempts > 0 AND successes = 0 THEN 1 ELSE 0 END) AS broken_instances,
            COUNT(*) AS reporting_instances,
            MAX(last_success_at) AS last_success_at
     FROM plugin_feature_stats
     WHERE report_at >= ?
     GROUP BY feature
     ORDER BY feature`,
  ).bind(cutoff7d).all();

  return json({ features: rows?.results || [] });
}

async function handleDashboardFeedback(request, env) {
  if (!isDashboardAuthorized(request, env)) {
    return json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  // Exclude teaching-summary rating beacons (type='other', subject
  // 'teaching_summary_up'/'teaching_summary_down') emitted by the plugin when a
  // teacher rates a summary. They are usage telemetry, not bug/feature feedback,
  // and otherwise drown real reports in this view. Data is retained in D1.
  const rows = await env.DB.prepare(
    `SELECT id, instance_id, version, type, subject, body, contact_email, received_at
     FROM plugin_feedback
     WHERE NOT (type = 'other' AND subject LIKE 'teaching_summary_%')
     ORDER BY received_at DESC LIMIT ? OFFSET ?`,
  ).bind(limit, offset).all();

  const feedback = rows?.results || [];
  const enriched = await attachRelatedErrors(feedback, env);
  return json({ feedback: enriched });
}

// Link each feedback item to the errors its instance was seeing around the time
// it was submitted (same instance_id, received_at within [-7d, +1d] of the
// feedback). Works retroactively on existing data — no plugin change needed.
async function attachRelatedErrors(feedback, env) {
  const WINDOW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;
  const WINDOW_AFTER_MS = 1 * 24 * 60 * 60 * 1000;
  const MAX_PER_FEEDBACK = 5;

  const instanceIds = [...new Set(feedback.map((f) => f.instance_id).filter(Boolean))];
  if (instanceIds.length === 0) return feedback;

  // plugin_errors is retained ~30d; widen slightly to cover the lookback window.
  const cutoff = new Date(Date.now() - 37 * 24 * 60 * 60 * 1000).toISOString();
  const placeholders = instanceIds.map(() => '?').join(',');
  const errRows = await env.DB.prepare(
    `SELECT instance_id, stack_fingerprint, error_type, category, message, count, last_seen, received_at
     FROM plugin_errors
     WHERE instance_id IN (${placeholders}) AND received_at >= ?
     ORDER BY received_at DESC`,
  ).bind(...instanceIds, cutoff).all();

  const byInstance = new Map();
  for (const e of (errRows?.results || [])) {
    if (!byInstance.has(e.instance_id)) byInstance.set(e.instance_id, []);
    byInstance.get(e.instance_id).push(e);
  }

  return feedback.map((fb) => {
    const fbTime = new Date(fb.received_at).getTime();
    const candidates = (byInstance.get(fb.instance_id) || [])
      .filter((e) => {
        const t = new Date(e.received_at).getTime();
        return Number.isFinite(t) && t >= fbTime - WINDOW_BEFORE_MS && t <= fbTime + WINDOW_AFTER_MS;
      })
      .slice(0, MAX_PER_FEEDBACK)
      .map((e) => ({
        stack_fingerprint: e.stack_fingerprint,
        error_type: e.error_type,
        category: e.category,
        message: e.message,
        count: e.count,
        last_seen: e.last_seen,
      }));
    return { ...fb, related_errors: candidates };
  });
}

// ─── Alerting ──────────────────────────────────────────

const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // don't re-raise the same key within 6h

// Evaluate alert rules against collected data, dedup against recently-raised
// alerts, persist new ones, and push to a webhook if configured. Rules backed by
// plugin_errors work on existing data; feature-outage needs v2.1.0+ instances.
async function evaluateAlerts(env) {
  const now = Date.now();
  const cutoff24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const cutoff7d = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  const candidates = [];

  // Rule A — a whole feature is down (attempted but zero successes).
  try {
    const rows = await env.DB.prepare(
      `SELECT feature, SUM(attempts) AS attempts, SUM(successes) AS successes
       FROM plugin_feature_stats
       WHERE report_at >= ?
       GROUP BY feature
       HAVING SUM(attempts) >= 5 AND SUM(successes) = 0`,
    ).bind(cutoff7d).all();
    for (const r of (rows?.results || [])) {
      candidates.push({
        alert_key: `feature_outage:${r.feature}`,
        severity: 'critical',
        title: `功能瘫痪: ${r.feature}`,
        detail: `近 7 天 ${r.attempts} 次尝试、0 次成功（错误率聚合无法体现）`,
      });
    }
  } catch (e) { console.error('[alerts] rule A failed', e); }

  // Rule B — background-job features are throwing.
  try {
    const rows = await env.DB.prepare(
      `SELECT category, SUM(count) AS total, COUNT(DISTINCT instance_id) AS instances, MAX(message) AS sample
       FROM plugin_errors
       WHERE error_type = 'background_job' AND received_at >= ?
       GROUP BY category`,
    ).bind(cutoff24h).all();
    for (const r of (rows?.results || [])) {
      candidates.push({
        alert_key: `bg_error:${r.category}`,
        severity: 'warning',
        title: `后台功能报错: ${r.category}`,
        detail: `近 24h ${r.total} 次 / ${r.instances} 实例 · ${(r.sample || '').slice(0, 160)}`,
      });
    }
  } catch (e) { console.error('[alerts] rule B failed', e); }

  // Rule C — the same error hitting many instances (widespread regression).
  try {
    const rows = await env.DB.prepare(
      `SELECT stack_fingerprint, category, SUM(count) AS total, COUNT(DISTINCT instance_id) AS instances, MAX(message) AS sample
       FROM plugin_errors
       WHERE received_at >= ? AND error_type != 'background_job'
       GROUP BY stack_fingerprint
       HAVING COUNT(DISTINCT instance_id) >= 3
       ORDER BY instances DESC
       LIMIT 10`,
    ).bind(cutoff24h).all();
    for (const r of (rows?.results || [])) {
      candidates.push({
        alert_key: `widespread:${r.stack_fingerprint}`,
        severity: 'warning',
        title: `多实例错误: ${r.category}`,
        detail: `近 24h ${r.instances} 实例 / ${r.total} 次 · ${(r.sample || '').slice(0, 160)}`,
      });
    }
  } catch (e) { console.error('[alerts] rule C failed', e); }

  if (candidates.length === 0) return;

  // Dedup against alerts raised within the cooldown window.
  const cooldownCutoff = new Date(now - ALERT_COOLDOWN_MS).toISOString();
  const fresh = [];
  for (const c of candidates) {
    const existing = await env.DB.prepare(
      `SELECT 1 FROM plugin_alerts WHERE alert_key = ? AND created_at >= ? LIMIT 1`,
    ).bind(c.alert_key, cooldownCutoff).first();
    if (!existing) fresh.push(c);
  }
  if (fresh.length === 0) return;

  await env.DB.batch(fresh.map((c) =>
    env.DB.prepare(
      `INSERT INTO plugin_alerts (alert_key, severity, title, detail) VALUES (?, ?, ?, ?)`,
    ).bind(c.alert_key, c.severity, c.title, c.detail || null),
  ));

  await pushAlerts(fresh, env);
  console.log(`[alerts] raised ${fresh.length} new alert(s)`);
}

async function pushAlerts(alerts, env) {
  // Channel 1: opt-in generic webhook (admin-set secret).
  const url = (env.ALERT_WEBHOOK_URL || '').trim();
  if (url) {
    const format = (env.ALERT_WEBHOOK_FORMAT || 'generic').trim().toLowerCase();
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formatAlertPayload(format, alerts)),
      });
    } catch (e) {
      console.error('[alerts] webhook push failed', e);
    }
  }
  // Channel 2: in-panel Telegram (D1 config). Best-effort; never breaks the cron.
  await pushTelegram(alerts, env).catch((e) => console.error('[alerts] telegram push failed', e));
}

// External-push text is redacted (title + severity only, never raw detail/sample).
function formatAlertPayload(format, alerts) {
  const text = buildSafeAlertText(alerts);
  switch (format) {
    case 'slack':
      return { text };
    case 'discord':
      return { content: text };
    case 'feishu':
      return { msg_type: 'text', content: { text } };
    case 'dingtalk':
      return { msgtype: 'text', text: { content: text } };
    default:
      // Structured, non-secret fields only — no raw `detail`.
      return {
        summary: `${alerts.length} alert(s)`,
        text,
        alerts: alerts.map((a) => ({ severity: a.severity, title: a.title, alert_key: a.alert_key })),
      };
  }
}

// ─── In-panel Telegram alert config ────────────────────

/** Single-row D1-backed store consumed by the alertConfig handlers. */
function alertConfigStore(env) {
  return {
    async get() {
      return env.DB.prepare(
        `SELECT id, enabled, bot_id, config_cipher, config_iv, key_version, last_test_at
         FROM plugin_alert_channels WHERE id = 'telegram'`,
      ).first();
    },
    async put(row) {
      await env.DB.prepare(
        `INSERT INTO plugin_alert_channels (id, enabled, bot_id, config_cipher, config_iv, key_version, updated_at)
         VALUES ('telegram', ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           enabled = excluded.enabled, bot_id = excluded.bot_id,
           config_cipher = excluded.config_cipher, config_iv = excluded.config_iv,
           key_version = excluded.key_version, updated_at = excluded.updated_at`,
      ).bind(row.enabled, row.bot_id, row.config_cipher, row.config_iv, row.key_version).run();
    },
    async del() {
      await env.DB.prepare(`DELETE FROM plugin_alert_channels WHERE id = 'telegram'`).run();
    },
  };
}

/** Derive the envelope key from the dedicated secret. null ⇒ key not configured. */
async function alertKey(env) {
  const secret = (env.ALERT_CONFIG_KEY || '').trim();
  if (!secret) return null;
  return deriveAesKey(secret);
}

function noStoreJson(data, status = 200) {
  return json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function pushTelegram(alerts, env) {
  const key = await alertKey(env);
  if (!key) return;
  const row = await alertConfigStore(env).get();
  if (!row || !row.enabled || !row.config_cipher) return;
  let cfg;
  try {
    cfg = await decryptConfig(key, row.config_cipher, row.config_iv, { id: 'telegram', keyVersion: row.key_version });
  } catch {
    return; // rotated key / tampered row — skip silently
  }
  await sendTelegram(cfg.token, cfg.chat_id, buildSafeAlertText(alerts));
}

/** Fire a Telegram sendMessage. Never logs the URL/token/body; bounded + redirect-safe. */
async function sendTelegram(token, chatId, text) {
  const { url, body } = buildTelegramRequest(token, chatId, text);
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  });
  return resp.status; // caller maps; response body intentionally discarded
}

async function handleAlertConfigGet(request, env) {
  if (!isDashboardAuthorized(request, env)) return noStoreJson({ success: false, error: 'Unauthorized' }, 401);
  const key = await alertKey(env);
  if (!key) return noStoreJson({ success: false, error: 'encryption key not configured (set ALERT_CONFIG_KEY)' }, 503);
  const telegram = await readAlertConfig(alertConfigStore(env), key);
  return noStoreJson({ telegram });
}

async function handleAlertConfigSave(request, env) {
  if (!isDashboardAuthorized(request, env)) return noStoreJson({ success: false, error: 'Unauthorized' }, 401);
  const key = await alertKey(env);
  if (!key) return noStoreJson({ success: false, error: 'encryption key not configured (set ALERT_CONFIG_KEY)' }, 503);

  if (Number(request.headers.get('content-length') || 0) > 4096) {
    return noStoreJson({ success: false, error: 'body too large' }, 413);
  }
  let body;
  try { body = await request.json(); } catch { return noStoreJson({ success: false, error: 'Invalid JSON body' }, 400); }
  if (!isRecord(body) || !isRecord(body.telegram)) return noStoreJson({ success: false, error: 'telegram object required' }, 400);

  const t = body.telegram;
  const res = await writeAlertConfig(alertConfigStore(env), key, {
    enabled: t.enabled === true,
    chat_id: typeof t.chat_id === 'string' ? t.chat_id : '',
    token: typeof t.token === 'string' && t.token !== '' ? t.token : undefined,
  });
  if (!res.ok) return noStoreJson({ success: false, error: res.error }, 400);
  return noStoreJson({ success: true });
}

async function handleAlertConfigRemove(request, env) {
  if (!isDashboardAuthorized(request, env)) return noStoreJson({ success: false, error: 'Unauthorized' }, 401);
  if (request.method !== 'POST') return noStoreJson({ success: false, error: 'Method Not Allowed' }, 405);
  await removeAlertConfig(alertConfigStore(env));
  return noStoreJson({ success: true });
}

async function handleAlertConfigTest(request, env) {
  if (!isDashboardAuthorized(request, env)) return noStoreJson({ success: false, error: 'Unauthorized' }, 401);
  if (request.method !== 'POST') return noStoreJson({ success: false, error: 'Method Not Allowed' }, 405);
  const key = await alertKey(env);
  if (!key) return noStoreJson({ success: false, error: 'encryption key not configured (set ALERT_CONFIG_KEY)' }, 503);

  const store = alertConfigStore(env);
  const row = await store.get();
  if (!row || !row.config_cipher) return noStoreJson({ ok: false, error: 'not_configured' });

  const lastMs = row.last_test_at ? Date.parse(row.last_test_at) : null;
  if (testThrottled(lastMs, Date.now())) return noStoreJson({ ok: false, error: 'rate_limited' }, 429);

  let cfg;
  try {
    cfg = await decryptConfig(key, row.config_cipher, row.config_iv, { id: 'telegram', keyVersion: row.key_version });
  } catch {
    return noStoreJson({ ok: false, error: 'not_decryptable' });
  }

  await env.DB.prepare(`UPDATE plugin_alert_channels SET last_test_at = datetime('now') WHERE id = 'telegram'`).run();

  try {
    const status = await sendTelegram(cfg.token, cfg.chat_id, '✅ hydro-ai-helper 测试消息');
    const code = mapTelegramError(status);
    return noStoreJson({ ok: code === null, error: code || undefined });
  } catch {
    return noStoreJson({ ok: false, error: 'upstream_failure' });
  }
}

async function handleDashboardAlerts(request, env) {
  if (!isDashboardAuthorized(request, env)) {
    return json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);
  const cutoff7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const rows = await env.DB.prepare(
    `SELECT id, alert_key, severity, title, detail, created_at
     FROM plugin_alerts
     WHERE created_at >= ?
     ORDER BY created_at DESC
     LIMIT ?`,
  ).bind(cutoff7d, limit).all();
  return json({ alerts: rows?.results || [] });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') {
      const headers = new Headers();
      applyCorsHeaders(headers);
      return new Response(null, { status: 204, headers });
    }

    if (pathname === '/') {
      return new Response('hydro-ai-helper telemetry ok', { status: 200 });
    }

    if (!pathname.startsWith('/api/')) {
      return json({ success: false, error: 'Not Found' }, { status: 404 });
    }

    if (!env.DB) {
      return json({ success: false, error: 'DB binding not configured' }, { status: 500 });
    }

    switch (pathname) {
      case '/api/report':
        return handleReport(request, env);
      case '/api/errors':
        return handleErrors(request, env);
      case '/api/feedback':
        return handleFeedback(request, env);
      case '/api/dashboard/overview':
        return handleDashboardOverview(request, env);
      case '/api/dashboard/instances':
        return handleDashboardInstances(request, env);
      case '/api/dashboard/errors':
        return handleDashboardErrors(request, env);
      case '/api/dashboard/feature-health':
        return handleDashboardFeatureHealth(request, env);
      case '/api/dashboard/alerts':
        return handleDashboardAlerts(request, env);
      case '/api/dashboard/alert-config':
        return request.method === 'POST'
          ? handleAlertConfigSave(request, env)
          : handleAlertConfigGet(request, env);
      case '/api/dashboard/alert-config/remove':
        return handleAlertConfigRemove(request, env);
      case '/api/dashboard/alert-config/test':
        return handleAlertConfigTest(request, env);
      case '/api/dashboard/feedback':
        return handleDashboardFeedback(request, env);
      case '/api/badge-installs':
        return handleBadgeInstalls(env);
      case '/api/badge-active':
        return handleBadgeActive(env);
      case '/api/badge-conversations':
        return handleBadgeConversations(env);
      case '/api/badge-version':
        return handleBadgeVersion(env);
      default:
        return json({ success: false, error: 'Not Found' }, { status: 404 });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      if (!env.DB) {
        console.error('[cron] DB binding missing (expected env.DB)');
        return;
      }

      // Evaluate alerts on every tick (hourly); cheap and dedup-protected.
      await evaluateAlerts(env).catch((e) => console.error('[cron] evaluateAlerts failed', e));

      // Cleanup is heavier and only needs to run once a day.
      if (event && event.cron !== '0 19 * * *') return;

      const cutoff90d = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      const cutoff30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

      // Clean up stale plugin stats (90 days)
      await env.DB.prepare(
        `DELETE FROM plugin_stats
         WHERE last_report_at IS NOT NULL
           AND last_report_at < ?`,
      ).bind(cutoff90d).run();

      // Clean up old errors (30 days)
      await env.DB.prepare(
        `DELETE FROM plugin_errors WHERE received_at < ?`,
      ).bind(cutoff30d).run();

      // Clean up feature-health snapshots from instances that stopped reporting (90 days)
      await env.DB.prepare(
        `DELETE FROM plugin_feature_stats WHERE report_at < ?`,
      ).bind(cutoff90d).run();

      // Clean up old feedback (90 days)
      await env.DB.prepare(
        `DELETE FROM plugin_feedback WHERE received_at < ?`,
      ).bind(cutoff90d).run();

      // Nullify contact_email after 90 days (privacy)
      await env.DB.prepare(
        `UPDATE plugin_feedback SET contact_email = NULL
         WHERE contact_email IS NOT NULL AND received_at < ?`,
      ).bind(cutoff90d).run();

      // Clean up old alerts (30 days)
      await env.DB.prepare(
        `DELETE FROM plugin_alerts WHERE created_at < ?`,
      ).bind(cutoff30d).run();

      console.log('[cron] cleanup done, 90d =', cutoff90d, ', 30d =', cutoff30d);
    })());
  },
};
