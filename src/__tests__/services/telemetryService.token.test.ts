import { getTelemetryToken } from '../../services/telemetryService';

/**
 * Guards the telemetry-auth decision (2026-06 incident).
 *
 * The official Worker's ingest endpoints (/api/report, /api/errors,
 * /api/feedback) are intentionally fail-OPEN when no REPORT_TOKEN is configured,
 * so the plugin deliberately ships WITHOUT an embedded token: a token baked into
 * an open-source repo is public anyway (not a real secret) and only adds
 * maintenance + a false sense of security. These tests lock that in:
 *   - default (no env var) must be '' — i.e. no hardcoded token leaks into the repo
 *   - self-hosters who run a fail-closed Worker can still supply one via env
 */
describe('getTelemetryToken', () => {
  const ORIGINAL = process.env.AI_HELPER_TELEMETRY_TOKEN;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.AI_HELPER_TELEMETRY_TOKEN;
    else process.env.AI_HELPER_TELEMETRY_TOKEN = ORIGINAL;
  });

  it('returns empty string when the env var is unset (no token embedded in the public plugin)', () => {
    delete process.env.AI_HELPER_TELEMETRY_TOKEN;
    expect(getTelemetryToken()).toBe('');
  });

  it('uses the env var when a self-hoster sets one (matches their Worker REPORT_TOKEN)', () => {
    process.env.AI_HELPER_TELEMETRY_TOKEN = 'custom-self-hosted-token';
    expect(getTelemetryToken()).toBe('custom-self-hosted-token');
  });

  it('trims surrounding whitespace from the env var', () => {
    process.env.AI_HELPER_TELEMETRY_TOKEN = '  spaced-token  ';
    expect(getTelemetryToken()).toBe('spaced-token');
  });
});
