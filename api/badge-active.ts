import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDb, PLUGIN_STATS_COLLECTION } from '../lib/mongodb';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const compactFormatter = new Intl.NumberFormat('en', {
  notation: 'compact',
  compactDisplay: 'short',
  maximumFractionDigits: 1
});

function applyCors(res: VercelResponse): void {
  Object.entries(CORS_HEADERS).forEach(([key, value]) => {
    res.setHeader(key, value);
  });
}

function formatCount(value: number): string {
  if (!Number.isFinite(value)) {
    return '0';
  }
  return compactFormatter.format(value);
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  applyCors(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    res.status(405).json({
      schemaVersion: 1,
      label: 'active users (7d)',
      message: 'method not allowed',
      color: 'lightgrey'
    });
    return;
  }

  try {
    const db = await getDb();
    const [result] = await db
      .collection(PLUGIN_STATS_COLLECTION)
      .aggregate([
        {
          $group: {
            _id: null,
            total: {
              $sum: { $ifNull: ['$stats.activeUsers7d', 0] }
            }
          }
        }
      ])
      .toArray();

    const total =
      result && typeof result.total === 'number' ? result.total : 0;

    console.info('[badge-active] total', total);

    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300');
    res.status(200).json({
      schemaVersion: 1,
      label: 'active users (7d)',
      message: formatCount(total),
      color: 'green'
    });
  } catch (error) {
    console.error('[badge-active] error', error);
    res.status(500).json({
      schemaVersion: 1,
      label: 'active users (7d)',
      message: 'error',
      color: 'lightgrey'
    });
  }
}
