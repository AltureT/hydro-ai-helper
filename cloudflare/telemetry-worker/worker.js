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

    await env.DB.prepare(
      `INSERT INTO plugin_stats (
        instance_id,
        event,
        version,
        installed_at,
        first_used_at,
        last_report_at,
        active_users_7d,
        total_conversations,
        last_used_at,
        domain_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(instance_id) DO UPDATE SET
        event = excluded.event,
        version = excluded.version,
        first_used_at = COALESCE(plugin_stats.first_used_at, excluded.first_used_at),
        last_report_at = excluded.last_report_at,
        active_users_7d = excluded.active_users_7d,
        total_conversations = excluded.total_conversations,
        last_used_at = excluded.last_used_at,
        domain_hash = excluded.domain_hash`,
    )
      .bind(
        instanceId,
        eventRaw,
        version,
        installedAt.toISOString(),
        firstUsedAt ? firstUsedAt.toISOString() : null,
        lastReportAt.toISOString(),
        activeUsers7d,
        totalConversations,
        lastUsedAt ? lastUsedAt.toISOString() : null,
        domainHash,
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

      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

      await env.DB.prepare(
        `DELETE FROM plugin_stats
         WHERE last_report_at IS NOT NULL
           AND last_report_at < ?`,
      ).bind(cutoff).run();

      console.log('[cron] cleanup done, cutoff =', cutoff);
    })());
  },
};
