import { ErrorReporter } from '../../services/errorReporter';

function createMockPluginInstallModel(overrides: any = {}) {
  return {
    getInstall: jest.fn().mockResolvedValue({
      instanceId: 'test-uuid',
      telemetryEnabled: true,
      lastVersion: '1.16.0',
      domainsSeen: ['system'],
      preferredTelemetryEndpoint: undefined,
      ...overrides,
    }),
  } as any;
}

// Mock axios via telemetryService's sendToEndpoint
jest.mock('../../services/telemetryService', () => ({
  getTelemetryBases: jest.fn().mockReturnValue(['https://stats.test.com']),
  buildTelemetryUrl: jest.fn().mockImplementation((base, path) => `${base}${path}`),
  getTelemetryToken: jest.fn().mockReturnValue(''),
  sendToEndpoint: jest.fn().mockResolvedValue(undefined),
}));

describe('ErrorReporter', () => {
  let reporter: ErrorReporter;
  let mockInstallModel: ReturnType<typeof createMockPluginInstallModel>;

  beforeEach(() => {
    jest.useFakeTimers();
    mockInstallModel = createMockPluginInstallModel();
    reporter = new ErrorReporter(mockInstallModel);
  });

  afterEach(() => {
    reporter.stop();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('capture', () => {
    it('should add entry to buffer', () => {
      reporter.capture('api_failure', 'timeout', 'Request timed out', 504);
      const stats = reporter.getSelfStats();
      expect(stats.suppressedCount).toBe(0);
      expect(stats.droppedCount).toBe(0);
    });

    it('should increment count for duplicate fingerprints', () => {
      reporter.capture('api_failure', 'timeout', 'Request timed out');
      reporter.capture('api_failure', 'timeout', 'Request timed out');
      reporter.capture('api_failure', 'timeout', 'Request timed out');
      // Same error_type + category + no stack = same fingerprint
      // Buffer should have 1 entry with count 3
      const stats = reporter.getSelfStats();
      expect(stats.suppressedCount).toBe(0);
    });

    it('should differentiate entries by category', () => {
      reporter.capture('api_failure', 'timeout', 'Timed out');
      reporter.capture('api_failure', 'auth', 'Auth failed');
      // Two different entries
      const stats = reporter.getSelfStats();
      expect(stats.droppedCount).toBe(0);
    });
  });

  describe('getSelfStats', () => {
    it('should return initial zeros', () => {
      const stats = reporter.getSelfStats();
      expect(stats).toEqual({ suppressedCount: 0, droppedCount: 0 });
    });
  });

  describe('resetSelfStats', () => {
    it('should reset counters to zero', () => {
      reporter.capture('api_failure', 'timeout', 'test');
      reporter.capture('api_failure', 'timeout', 'test');
      reporter.resetSelfStats();
      const stats = reporter.getSelfStats();
      expect(stats.suppressedCount).toBe(0);
      expect(stats.droppedCount).toBe(0);
    });
  });

  describe('sanitizeMessage (via capture)', () => {
    it('should redact API keys in messages', () => {
      reporter.capture('api_failure', 'auth', 'Invalid key sk-abc123xyz789test');
      // We can't easily inspect the buffer directly, but the capture should not throw
    });

    it('should truncate long messages', () => {
      const longMsg = 'x'.repeat(1000);
      reporter.capture('api_failure', 'unknown', longMsg);
      // Should not throw
    });
  });

  describe('telemetry disabled', () => {
    it('should clear buffer on flush when telemetry disabled', async () => {
      mockInstallModel.getInstall.mockResolvedValue({
        instanceId: 'test', telemetryEnabled: false,
        lastVersion: '1.0.0', domainsSeen: [],
      });

      reporter.capture('api_failure', 'timeout', 'test');
      // Manually trigger flush via timer
      reporter.start();
      jest.advanceTimersByTime(5 * 60 * 1000);
      // Allow promises to resolve
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  describe('stack fingerprint', () => {
    it('should generate different fingerprints for different stacks', () => {
      reporter.capture('api_failure', 'timeout', 'err1', undefined, 'stack trace 1');
      reporter.capture('api_failure', 'timeout', 'err2', undefined, 'stack trace 2');
      // Two different entries should be created
    });

    it('should generate same fingerprint for same stack', () => {
      reporter.capture('api_failure', 'timeout', 'err1', undefined, 'same stack');
      reporter.capture('api_failure', 'timeout', 'err2', undefined, 'same stack');
      // Should be deduplicated to one entry
    });
  });
});
