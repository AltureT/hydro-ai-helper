"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ErrorReporter = void 0;
const crypto_1 = require("crypto");
const telemetryService_1 = require("./telemetryService");
const FLUSH_INTERVAL_MS = 5 * 60 * 1000;
const BUFFER_THRESHOLD = 50;
const MAX_BUFFER_SIZE = 1000;
const MAX_ENTRIES_PER_BATCH = 100;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const SUPPRESSION_WINDOW_MS = 60 * 60 * 1000;
const STALE_ENTRY_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT = 8000;
class ErrorReporter {
    constructor(pluginInstallModel) {
        this.pluginInstallModel = pluginInstallModel;
        this.buffer = new Map();
        this.flushing = false;
        this.pendingFlush = false;
        this.suppressedCount = 0;
        this.droppedCount = 0;
    }
    start() {
        if (this.timer)
            return;
        this.timer = setInterval(() => {
            this.tryFlush();
        }, FLUSH_INTERVAL_MS);
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }
    getSelfStats() {
        return {
            suppressedCount: this.suppressedCount,
            droppedCount: this.droppedCount,
        };
    }
    resetSelfStats() {
        this.suppressedCount = 0;
        this.droppedCount = 0;
    }
    capture(errorType, category, message, httpStatus, stack) {
        // Check telemetry asynchronously — but capture is sync/fire-and-forget
        // We check lazily on flush instead of on every capture for performance
        const fingerprint = this.computeFingerprint(errorType, category, stack);
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
                if (e.lastSeen.getTime() < staleThreshold)
                    this.buffer.delete(k);
                if (this.buffer.size < MAX_BUFFER_SIZE)
                    break;
            }
            // If still full, drop oldest entry
            if (this.buffer.size >= MAX_BUFFER_SIZE) {
                const oldest = this.buffer.keys().next().value;
                if (oldest) {
                    this.buffer.delete(oldest);
                    this.droppedCount += 1;
                }
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
            suppressedCount: 0,
        });
        if (this.buffer.size >= BUFFER_THRESHOLD) {
            this.tryFlush();
        }
    }
    tryFlush() {
        if (this.flushing) {
            this.pendingFlush = true;
            return;
        }
        this.flush().catch((err) => {
            console.error('[ErrorReporter] Flush failed:', err);
        });
    }
    async flush() {
        if (this.buffer.size === 0)
            return;
        this.flushing = true;
        this.pendingFlush = false;
        try {
            const config = await this.pluginInstallModel.getInstall();
            if (!config || !config.telemetryEnabled) {
                this.buffer.clear();
                return;
            }
            const entries = this.buildEntries();
            if (entries.length === 0)
                return;
            const domainHash = (0, crypto_1.createHash)('sha256')
                .update(config.domainsSeen.sort().join(','))
                .digest('hex')
                .substring(0, 16);
            const payload = {
                instance_id: config.instanceId,
                event: 'error',
                version: config.lastVersion,
                domain_hash: domainHash,
                timestamp: new Date().toISOString(),
                errors: entries,
            };
            const bases = (0, telemetryService_1.getTelemetryBases)(config.preferredTelemetryEndpoint);
            const token = (0, telemetryService_1.getTelemetryToken)();
            let sent = false;
            for (const base of bases) {
                try {
                    const url = (0, telemetryService_1.buildTelemetryUrl)(base, '/api/errors');
                    await (0, telemetryService_1.sendToEndpoint)(url, payload, token, REQUEST_TIMEOUT);
                    sent = true;
                    break;
                }
                catch {
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
        }
        finally {
            this.flushing = false;
            if (this.pendingFlush) {
                this.pendingFlush = false;
                this.tryFlush();
            }
        }
    }
    buildEntries() {
        const now = new Date();
        const entries = [];
        let serializedSize = 0;
        for (const entry of this.buffer.values()) {
            if (entry.count === 0)
                continue;
            // Suppression: if emitted within the window, only send count update
            if (entry.lastEmittedAt && (now.getTime() - entry.lastEmittedAt.getTime()) < SUPPRESSION_WINDOW_MS) {
                entry.suppressedCount += entry.count;
                this.suppressedCount += entry.count;
                entry.count = 0;
                continue;
            }
            const errorEntry = {
                error_type: entry.error_type,
                category: entry.category,
                message: entry.message,
                http_status: entry.http_status,
                count: entry.count,
                first_seen: entry.firstSeen.toISOString(),
                last_seen: entry.lastSeen.toISOString(),
                stack_fingerprint: entry.stackFingerprint,
                suppressed_count: entry.suppressedCount > 0 ? entry.suppressedCount : undefined,
            };
            const entrySize = JSON.stringify(errorEntry).length;
            if (serializedSize + entrySize > MAX_PAYLOAD_BYTES) {
                this.droppedCount += 1;
                break;
            }
            entries.push(errorEntry);
            serializedSize += entrySize;
            if (entries.length >= MAX_ENTRIES_PER_BATCH)
                break;
        }
        return entries;
    }
    computeFingerprint(errorType, category, stack) {
        const source = stack || `${errorType}:${category}`;
        return (0, crypto_1.createHash)('sha256')
            .update(source)
            .digest('hex')
            .substring(0, 16);
    }
    sanitizeMessage(message) {
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
exports.ErrorReporter = ErrorReporter;
//# sourceMappingURL=errorReporter.js.map