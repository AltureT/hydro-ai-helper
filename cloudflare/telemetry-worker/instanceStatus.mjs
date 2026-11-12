// Instance liveness classification shared by the dashboard endpoints.
//
// One plugin install = one random UUID kept in that site's MongoDB. A site
// that resets its database (fresh container without a volume, dropped DB)
// reports under a new UUID, and the old row stays in plugin_stats until the
// 90-day cleanup. Counting every row from the last 90 days therefore counts
// reinstalls and one-off trial installs as separate live deployments, and
// summing their frozen "active users" snapshots inflates the totals.

// Plugins up to v3.3.0 effectively heartbeat every 48h (a timer bug skipped
// every other report), so "alive" needs headroom beyond 48h.
export const ALIVE_HOURS = 72;

// A row whose last report came within this long of its install time never
// produced a regular heartbeat: a trial install, a container that was thrown
// away, or a database that was reset (the site lives on under a new ID).
export const ONE_SHOT_HOURS = 30;

export const INSTANCE_STATUSES = ['active', 'stale', 'one_shot'];

/**
 * SQL expression classifying a plugin_stats row. Takes exactly one bound
 * parameter: the alive cutoff as an ISO string (see aliveCutoffIso).
 * @param {string} alias table alias, e.g. 'ps'
 */
export function instanceStatusSql(alias = 'plugin_stats') {
  return `(CASE
    WHEN ${alias}.last_report_at >= ? THEN 'active'
    WHEN julianday(${alias}.last_report_at) - julianday(${alias}.installed_at) < ${ONE_SHOT_HOURS / 24} THEN 'one_shot'
    ELSE 'stale'
  END)`;
}

/**
 * Instance IDs that are not UUIDs come from plugins before v2.0.6, which
 * derived the ID from sha256('unknown:' + dbName). Every such site shares the
 * same ID, so one row stands for all of them, overwritten by whichever
 * reported last, and its installed_at belongs to the first site that ever
 * reported under it.
 */
export function legacySharedIdSql(alias = 'plugin_stats') {
  return `(length(${alias}.instance_id) <> 36)`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isLegacySharedId(instanceId) {
  return !UUID_RE.test(String(instanceId || ''));
}

export function aliveCutoffIso(now = Date.now()) {
  return new Date(now - ALIVE_HOURS * 60 * 60 * 1000).toISOString();
}

/** JS mirror of instanceStatusSql, for tests and client-side use. */
export function classifyInstance(row, now = Date.now()) {
  const last = Date.parse(row.last_report_at);
  if (last >= now - ALIVE_HOURS * 60 * 60 * 1000) return 'active';
  const installed = Date.parse(row.installed_at);
  if (Number.isFinite(installed) && last - installed < ONE_SHOT_HOURS * 60 * 60 * 1000) return 'one_shot';
  return 'stale';
}

export function parseStatusFilter(value) {
  return INSTANCE_STATUSES.includes(value) ? value : 'all';
}
