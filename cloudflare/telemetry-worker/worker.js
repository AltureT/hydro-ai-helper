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
    return true;
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

    await env.DB.prepare(
      `INSERT INTO plugin_stats (
        instance_id, event, version, installed_at, first_used_at,
        last_report_at, active_users_7d, total_conversations, last_used_at, domain_hash,
        error_count_24h, api_success_count_24h, api_failure_count_24h,
        avg_latency_ms_24h, active_endpoint_count, node_version, os_platform, features
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        features = excluded.features`,
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
      )
      .run();

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
          isRecord(e.metadata) ? JSON.stringify(e.metadata).slice(0, 4000) : null,
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
  if (!token) return true;
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

  return json({
    instances: row?.instance_count || 0,
    active_users_7d: row?.active_users_7d || 0,
    total_conversations: row?.total_conversations || 0,
    error_rate_percent: parseFloat(errorRate),
  });
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

async function handleDashboardFeedback(request, env) {
  if (!isDashboardAuthorized(request, env)) {
    return json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  const rows = await env.DB.prepare(
    `SELECT id, instance_id, version, type, subject, body, contact_email, received_at
     FROM plugin_feedback ORDER BY received_at DESC LIMIT ? OFFSET ?`,
  ).bind(limit, offset).all();

  return json({ feedback: rows?.results || [] });
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

  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      if (!env.DB) {
        console.error('[cron] DB binding missing (expected env.DB)');
        return;
      }

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

      // Clean up old feedback (90 days)
      await env.DB.prepare(
        `DELETE FROM plugin_feedback WHERE received_at < ?`,
      ).bind(cutoff90d).run();

      // Nullify contact_email after 90 days (privacy)
      await env.DB.prepare(
        `UPDATE plugin_feedback SET contact_email = NULL
         WHERE contact_email IS NOT NULL AND received_at < ?`,
      ).bind(cutoff90d).run();

      console.log('[cron] cleanup done, 90d =', cutoff90d, ', 30d =', cutoff30d);
    })());
  },
};
