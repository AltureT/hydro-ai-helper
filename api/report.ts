import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  ensurePluginStatsIndexes,
  getDb,
  PLUGIN_STATS_COLLECTION
} from '../lib/mongodb';

interface HeartbeatPayload {
  instance_id: string;
  event: 'install' | 'heartbeat';
  version: string;
  installed_at: string;
  first_used_at?: string;
  stats: {
    active_users_7d: number;
    total_conversations: number;
    last_used_at?: string;
  };
  domain_hash: string;
  timestamp: string;
}

interface ParsedPayload {
  instanceId: string;
  event: 'install' | 'heartbeat';
  version: string;
  installedAt: Date;
  firstUsedAt?: Date;
  lastReportAt: Date;
  stats: {
    activeUsers7d: number;
    totalConversations: number;
    lastUsedAt?: Date;
  };
  domainHash: string;
}

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJsonBody(
  req: VercelRequest
): Promise<Record<string, unknown>> {
  if (isRecord(req.body)) {
    return req.body;
  }

  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch (error) {
      throw new HttpError(400, 'Invalid JSON body');
    }
  }

  if (Buffer.isBuffer(req.body)) {
    try {
      return JSON.parse(req.body.toString('utf8'));
    } catch (error) {
      throw new HttpError(400, 'Invalid JSON body');
    }
  }

  // Fallback for runtimes that do not pre-parse the body.
  const raw = await new Promise<string>((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });

  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, `${field} is required`);
  }
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new HttpError(400, `${field} must be a number`);
  }
  return value;
}

function parseDate(
  value: unknown,
  field: string,
  required: boolean
): Date | undefined {
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

function parsePayload(body: Record<string, unknown>): ParsedPayload {
  const payload = body as Partial<HeartbeatPayload>;
  const instanceId = requireString(payload.instance_id, 'instance_id');
  const eventRaw = requireString(payload.event, 'event');
  if (eventRaw !== 'install' && eventRaw !== 'heartbeat') {
    throw new HttpError(400, 'event must be install or heartbeat');
  }
  const version = requireString(payload.version, 'version');
  const installedAt = parseDate(payload.installed_at, 'installed_at', true);
  const firstUsedAt = parseDate(payload.first_used_at, 'first_used_at', false);
  const lastReportAt = parseDate(payload.timestamp, 'timestamp', true);
  const domainHash = requireString(payload.domain_hash, 'domain_hash');

  if (!isRecord(payload.stats)) {
    throw new HttpError(400, 'stats is required');
  }

  const activeUsers7d = requireNumber(
    payload.stats.active_users_7d,
    'stats.active_users_7d'
  );
  const totalConversations = requireNumber(
    payload.stats.total_conversations,
    'stats.total_conversations'
  );
  const lastUsedAt = parseDate(
    payload.stats.last_used_at,
    'stats.last_used_at',
    false
  );

  const stats: ParsedPayload['stats'] = {
    activeUsers7d,
    totalConversations
  };

  if (lastUsedAt) {
    stats.lastUsedAt = lastUsedAt;
  }

  return {
    instanceId,
    event: eventRaw as 'install' | 'heartbeat',
    version,
    installedAt: installedAt as Date,
    firstUsedAt,
    lastReportAt: lastReportAt as Date,
    stats,
    domainHash
  };
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ success: false, error: 'Method Not Allowed' });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const payload = parsePayload(body);
    const db = await getDb();

    // Ensure TTL index exists before writing new reports.
    await ensurePluginStatsIndexes(db);

    const collection = db.collection(PLUGIN_STATS_COLLECTION);
    const stats = payload.stats;

    const setFields: Record<string, unknown> = {
      event: payload.event,
      version: payload.version,
      lastReportAt: payload.lastReportAt,
      stats: {
        activeUsers7d: stats.activeUsers7d,
        totalConversations: stats.totalConversations,
        ...(stats.lastUsedAt ? { lastUsedAt: stats.lastUsedAt } : {})
      },
      domainHash: payload.domainHash
    };

    if (payload.firstUsedAt) {
      setFields.firstUsedAt = payload.firstUsedAt;
    }

    // Upsert by instance id to deduplicate installations.
    await collection.updateOne(
      { _id: payload.instanceId },
      {
        $set: setFields,
        $setOnInsert: {
          installedAt: payload.installedAt
        }
      },
      { upsert: true }
    );

    console.info('[report] upserted', {
      instanceId: payload.instanceId,
      event: payload.event
    });

    res.status(200).json({ success: true });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message =
      error instanceof HttpError ? error.message : 'Internal Server Error';
    console.error('[report] error', error);
    res.status(status).json({ success: false, error: message });
  }
}
