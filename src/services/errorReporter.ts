import { createHash } from 'crypto';
import type { PluginInstallModel } from '../models/pluginInstall';
import {
  getTelemetryBases,
  buildTelemetryUrl,
  getTelemetryToken,
  sendToEndpoint,
} from './telemetryService';

export type TelemetryErrorType = 'api_failure' | 'api_degraded' | 'startup_failure' | 'config' | 'db' | 'background_job';

export interface ErrorEntry {
  error_type: TelemetryErrorType;
  category: string;
  message: string;
  http_status?: number;
  count: number;
  first_seen: string;
  last_seen: string;
  stack_fingerprint?: string;
  suppressed_count?: number;
  metadata?: Record<string, unknown>;
}

interface BufferedError {
  key: string;
  error_type: TelemetryErrorType;
  category: string;
  message: string;
  http_status?: number;
  count: number;
  firstSeen: Date;
  lastSeen: Date;
  stackFingerprint?: string;
  metadata?: Record<string, unknown>;
  suppressedCount: number;
  lastEmittedAt?: Date;
}

interface SelfStats {
  suppressedCount: number;
  droppedCount: number;
}

const FLUSH_INTERVAL_MS = 5 * 60 * 1000;
const BUFFER_THRESHOLD = 50;
const MAX_BUFFER_SIZE = 1000;
const MAX_ENTRIES_PER_BATCH = 100;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const SUPPRESSION_WINDOW_MS = 60 * 60 * 1000;
const STALE_ENTRY_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT = 8000;

export class ErrorReporter {
  private buffer = new Map<string, BufferedError>();
  private timer?: NodeJS.Timeout;
  private flushing = false;
  private pendingFlush = false;
  private suppressedCount = 0;
  private droppedCount = 0;

  constructor(
    private pluginInstallModel: PluginInstallModel,
  ) { }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tryFlush();
    }, FLUSH_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  getSelfStats(): SelfStats {
    return {
      suppressedCount: this.suppressedCount,
      droppedCount: this.droppedCount,
    };
  }

  resetSelfStats(): void {
    this.suppressedCount = 0;
    this.droppedCount = 0;
  }

  capture(
    errorType: TelemetryErrorType,
    category: string,
    message: string,
    httpStatus?: number,
    stack?: string,
    metadata?: Record<string, unknown>,
  ): void {
    // Check telemetry asynchronously — but capture is sync/fire-and-forget
    // We check lazily on flush instead of on every capture for performance
    const discriminator = metadata?.endpointId as string | undefined;
    const fingerprint = this.computeFingerprint(errorType, category, stack, discriminator);
    const key = `${errorType}:${category}:${fingerprint}`;
    const now = new Date();

    const existing = this.buffer.get(key);
    if (existing) {
      existing.count += 1;
      existing.lastSeen = now;

      if (existing.lastEmittedAt && (now.getTime() - existing.lastEmittedAt.getTime()) < SUPPRESSION_WINDOW_MS) {
        existing.suppressedCount += 1;
        this.suppressedCount += 1;
      }
      return;
    }

    // Sanitize message: truncate, strip potential PII
    const sanitized = this.sanitizeMessage(message);

    // Evict oldest entries if buffer is full
    if (this.buffer.size >= MAX_BUFFER_SIZE) {
      const staleThreshold = now.getTime() - STALE_ENTRY_MS;
      for (const [k, e] of this.buffer) {
        if (e.lastSeen.getTime() < staleThreshold) this.buffer.delete(k);
        if (this.buffer.size < MAX_BUFFER_SIZE) break;
      }
      // If still full, drop oldest entry
      if (this.buffer.size >= MAX_BUFFER_SIZE) {
        const oldest = this.buffer.keys().next().value;
        if (oldest) { this.buffer.delete(oldest); this.droppedCount += 1; }
      }
    }

    this.buffer.set(key, {
      key,
      error_type: errorType,
      category,
      message: sanitized,
      http_status: httpStatus,
      count: 1,
      firstSeen: now,
      lastSeen: now,
      stackFingerprint: fingerprint,
      metadata: metadata ? this.sanitizeMetadata(metadata) : undefined,
      suppressedCount: 0,
    });

    if (this.buffer.size >= BUFFER_THRESHOLD) {
      this.tryFlush();
    }
  }

  private tryFlush(): void {
    if (this.flushing) {
      this.pendingFlush = true;
      return;
    }
    this.flush().catch((err) => {
      console.error('[ErrorReporter] Flush failed:', err);
    });
  }

  private async flush(): Promise<void> {
    if (this.buffer.size === 0) return;

    this.flushing = true;
    this.pendingFlush = false;

    try {
      const config = await this.pluginInstallModel.getInstall();
      if (!config || !config.telemetryEnabled) {
        this.buffer.clear();
        return;
      }

      const entries = this.buildEntries();
      if (entries.length === 0) return;

      const domainHash = createHash('sha256')
        .update(config.domainsSeen.sort().join(','))
        .digest('hex')
        .substring(0, 16);

      const payload = {
        instance_id: config.instanceId,
        event: 'error' as const,
        version: config.lastVersion,
        domain_hash: domainHash,
        timestamp: new Date().toISOString(),
        errors: entries,
      };

      const bases = getTelemetryBases(config.preferredTelemetryEndpoint);
      const token = getTelemetryToken();
      let sent = false;

      for (const base of bases) {
        try {
          const url = buildTelemetryUrl(base, '/api/errors');
          await sendToEndpoint(url, payload, token, REQUEST_TIMEOUT);
          sent = true;
          break;
        } catch {
          // try next
        }
      }

      if (sent) {
        // Mark all emitted entries
        const now = new Date();
        for (const entry of this.buffer.values()) {
          entry.lastEmittedAt = now;
          entry.count = 0;
          entry.suppressedCount = 0;
        }
        // Remove entries that have been quiet (no new occurrences since last emit)
        for (const [key, entry] of this.buffer) {
          if (entry.count === 0 && entry.lastEmittedAt) {
            this.buffer.delete(key);
          }
        }
      }
      // If not sent, entries stay in buffer for next retry
    } finally {
      this.flushing = false;
      if (this.pendingFlush) {
        this.pendingFlush = false;
        this.tryFlush();
      }
    }
  }

  private buildEntries(): ErrorEntry[] {
    const now = new Date();
    const entries: ErrorEntry[] = [];
    let serializedSize = 0;

    for (const entry of this.buffer.values()) {
      if (entry.count === 0) continue;

      // Suppression: if emitted within the window, only send count update
      if (entry.lastEmittedAt && (now.getTime() - entry.lastEmittedAt.getTime()) < SUPPRESSION_WINDOW_MS) {
        entry.suppressedCount += entry.count;
        this.suppressedCount += entry.count;
        entry.count = 0;
        continue;
      }

      const errorEntry: ErrorEntry = {
        error_type: entry.error_type,
        category: entry.category,
        message: entry.message,
        http_status: entry.http_status,
        count: entry.count,
        first_seen: entry.firstSeen.toISOString(),
        last_seen: entry.lastSeen.toISOString(),
        stack_fingerprint: entry.stackFingerprint,
        suppressed_count: entry.suppressedCount > 0 ? entry.suppressedCount : undefined,
        metadata: entry.metadata,
      };

      const entrySize = JSON.stringify(errorEntry).length;
      if (serializedSize + entrySize > MAX_PAYLOAD_BYTES) {
        this.droppedCount += 1;
        break;
      }

      entries.push(errorEntry);
      serializedSize += entrySize;

      if (entries.length >= MAX_ENTRIES_PER_BATCH) break;
    }

    return entries;
  }

  private computeFingerprint(errorType: string, category: string, stack?: string, discriminator?: string): string {
    let source = stack || `${errorType}:${category}`;
    if (discriminator) source += `:${discriminator}`;
    return createHash('sha256')
      .update(source)
      .digest('hex')
      .substring(0, 16);
  }

  private sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    const keys = Object.keys(metadata).slice(0, 10);
    for (const key of keys) {
      const val = metadata[key];
      if (typeof val === 'string') {
        sanitized[key] = val.substring(0, 200);
      } else if (typeof val === 'number' || typeof val === 'boolean') {
        sanitized[key] = val;
      } else if (Array.isArray(val)) {
        sanitized[key] = val.slice(0, 5).map(item => {
          if (typeof item === 'object' && item !== null) {
            const trimmed: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(item)) {
              trimmed[k] = typeof v === 'string' ? v.substring(0, 100) : v;
            }
            return trimmed;
          }
          return item;
        });
      }
    }
    return sanitized;
  }

  private sanitizeMessage(message: string): string {
    let sanitized = message;
    // Truncate
    if (sanitized.length > 500) {
      sanitized = sanitized.substring(0, 500) + '...';
    }
    // Strip potential API keys (sk-xxx, key-xxx patterns)
    sanitized = sanitized.replace(/\b(sk-|key-|Bearer\s+)[A-Za-z0-9_-]+/gi, '[REDACTED]');
    // Strip potential URLs with auth
    sanitized = sanitized.replace(/:\/\/[^@\s]+@/g, '://[REDACTED]@');
    // Strip control characters (eslint-disable no-control-regex)
    // eslint-disable-next-line no-control-regex
    sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
    return sanitized;
  }
}
