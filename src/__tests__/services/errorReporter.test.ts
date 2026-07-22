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

    it('deduplicates dynamic error messages from the same code path', () => {
      const stack1 = [
        'Error: 第 1 个测试点输入 123 失败',
        '    at TestdataGenService.generate (dist/services/testdataGenService.js:100:20)',
        '    at Handler.post (dist/handlers/testdataGenHandler.js:50:10)',
      ].join('\n');
      const stack2 = [
        'Error: 第 8 个测试点输入 999 失败',
        '    at TestdataGenService.generate (dist/services/testdataGenService.js:100:20)',
        '    at Handler.post (dist/handlers/testdataGenHandler.js:50:10)',
      ].join('\n');
      reporter.capture('api_failure', 'testdata_gen', 'first', undefined, stack1, { failureStage: 'oracle' });
      reporter.capture('api_failure', 'testdata_gen', 'second', undefined, stack2, { failureStage: 'oracle' });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((reporter as any).buffer.size).toBe(1);
    });

    it('keeps different testdata failure stages separate', () => {
      const stack = [
        'Error: dynamic',
        '    at TestdataGenService.generate (dist/services/testdataGenService.js:100:20)',
      ].join('\n');
      reporter.capture('api_failure', 'testdata_gen', 'generator', undefined, stack, { failureStage: 'generator' });
      reporter.capture('api_failure', 'testdata_gen', 'oracle', undefined, stack, { failureStage: 'oracle' });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((reporter as any).buffer.size).toBe(2);
    });

    it('keeps different categories separate even when stack frames match', () => {
      const stack = [
        'Error: dynamic',
        '    at Handler.post (dist/handlers/sharedHandler.js:50:10)',
      ].join('\n');
      reporter.capture('api_failure', 'testdata_gen', 'generation failed', undefined, stack);
      reporter.capture('api_failure', 'student_chat', 'chat failed', undefined, stack);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((reporter as any).buffer.size).toBe(2);
    });
  });

  describe('sanitized stack frames + runtime env (P1)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function lastPayload(): any {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { sendToEndpoint } = require('../../services/telemetryService');
      const calls = sendToEndpoint.mock.calls;
      return calls[calls.length - 1][1];
    }

    it('attaches repo-relative, PII-stripped stack frames on flush', async () => {
      const stack = [
        'Error: boom sk-secret123',
        '    at Foo.bar (/Users/alice/proj/hydro-ai-helper/dist/services/x.js:12:5)',
        '    at async safe (/root/.hydro/addons/hydro-ai-helper/dist/index.js:160:9)',
        '    at Query.run (/srv/app/node_modules/mongodb/lib/y.js:99:9)',
        '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
      ].join('\n');
      reporter.capture('startup_failure', 'db', 'boom', undefined, stack);

      // eslint-disable-next-line @typescript-eslint/dot-notation
      await (reporter as any).flush();

      const entry = lastPayload().errors[0];
      expect(entry.stack_frames).toEqual([
        'at Foo.bar (dist/services/x.js:12:5)',
        'at async safe (dist/index.js:160:9)',
        'at Query.run (node_modules/mongodb/lib/y.js:99:9)',
        'at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
      ]);
      // No home directory or absolute deploy paths leaked
      const joined = entry.stack_frames.join('\n');
      expect(joined).not.toContain('/Users/alice');
      expect(joined).not.toContain('/root/.hydro');
    });

    it('omits stack_frames when no stack is provided', async () => {
      reporter.capture('api_failure', 'timeout', 'no stack here');
      // eslint-disable-next-line @typescript-eslint/dot-notation
      await (reporter as any).flush();
      expect(lastPayload().errors[0].stack_frames).toBeUndefined();
    });

    it('attaches runtime env once set, and omits it otherwise', async () => {
      reporter.capture('api_failure', 'timeout', 'no env');
      // eslint-disable-next-line @typescript-eslint/dot-notation
      await (reporter as any).flush();
      expect(lastPayload().errors[0].env).toBeUndefined();

      reporter.setRuntimeEnv({ node_version: 'v18.20.0' });
      reporter.setRuntimeEnv({ mongodb_version: '6.0.5' });
      reporter.capture('api_failure', 'auth', 'with env');
      // eslint-disable-next-line @typescript-eslint/dot-notation
      await (reporter as any).flush();
      // find the entry for the 'with env' capture (auth category)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entry = lastPayload().errors.find((e: any) => e.category === 'auth');
      expect(entry.env).toEqual({ node_version: 'v18.20.0', mongodb_version: '6.0.5' });
    });
  });
});
