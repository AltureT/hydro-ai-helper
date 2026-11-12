jest.mock('axios', () => {
  const post = jest.fn();
  return { __esModule: true, default: { post, isAxiosError: () => false }, post, isAxiosError: () => false };
});

import axios from 'axios';
import { TelemetryService, computeDomainHash } from '../../services/telemetryService';

const HOUR = 60 * 60 * 1000;
const SEND_LATENCY = 3000;

function setup() {
  const install: Record<string, any> = {
    _id: 'install',
    instanceId: '00000000-0000-4000-8000-000000000000',
    installedAt: new Date('2026-02-01T00:00:00Z'),
    installedVersion: '3.3.0',
    lastVersion: '3.3.0',
    domainsSeen: [],
    telemetryEnabled: true,
  };
  const pluginInstallModel = {
    getInstall: jest.fn(async () => ({ ...install, domainsSeen: [...install.domainsSeen] })),
    // lastReportAt is written after the send completes (a few seconds after the timer fired)
    updateLastReportTime: jest.fn(async () => { install.lastReportAt = new Date(Date.now() + SEND_LATENCY); }),
    updatePreferredTelemetryEndpoint: jest.fn(async () => undefined),
    syncUsage: jest.fn(async (domains: string[], first: Date | null) => {
      install.domainsSeen = [...new Set([...install.domainsSeen, ...domains])];
      if (first && !install.firstUsedAt) install.firstUsedAt = first;
      return { ...install };
    }),
  };
  const conversationModel = {
    countActiveUsers: jest.fn(async () => 1),
    getTotalConversations: jest.fn(async () => 5),
    getLastConversationTime: jest.fn(async () => null),
    getDistinctDomainIds: jest.fn(async () => ['system', 'dashu']),
    getFirstConversationTime: jest.fn(async () => new Date('2026-03-01T00:00:00Z')),
  };
  const service = new TelemetryService(pluginInstallModel as any, conversationModel as any);
  return { service, install };
}

describe('TelemetryService heartbeat', () => {
  const post = (axios as any).post as jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-12T00:00:00Z'));
    post.mockReset();
    post.mockResolvedValue(undefined);
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('reports once a day, not every other day, even though sends take time', async () => {
    const { service } = setup();
    await service.init(); // first report ("install")
    expect(post).toHaveBeenCalledTimes(1);

    for (let h = 0; h < 4 * 24 + 2; h++) {
      await jest.advanceTimersByTimeAsync(HOUR);
    }
    service.stop();

    // init + one heartbeat per day for 4 days
    expect(post).toHaveBeenCalledTimes(5);
    expect(post.mock.calls.slice(1).every(c => c[1].event === 'heartbeat')).toBe(true);
  });

  it('fills domain_hash and first_used_at from existing conversations', async () => {
    const { service } = setup();
    await service.init();
    service.stop();

    const payload = post.mock.calls[0][1];
    expect(payload.domain_hash).toBe(computeDomainHash(['dashu', 'system']));
    expect(payload.domain_hash).not.toBe(computeDomainHash([]));
    expect(payload.first_used_at).toBe('2026-03-01T00:00:00.000Z');
  });
});

describe('computeDomainHash', () => {
  it('is order-independent and does not mutate its input', () => {
    const input = ['b', 'a'];
    expect(computeDomainHash(input)).toBe(computeDomainHash(['a', 'b']));
    expect(input).toEqual(['b', 'a']);
  });
});
