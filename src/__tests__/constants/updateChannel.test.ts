import { getUpdateChannel, isEdgeChannel, DEFAULT_UPDATE_CHANNEL } from '../../constants/updateChannel';

describe('updateChannel', () => {
  const original = process.env.AI_HELPER_UPDATE_CHANNEL;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.AI_HELPER_UPDATE_CHANNEL;
    } else {
      process.env.AI_HELPER_UPDATE_CHANNEL = original;
    }
  });

  it('defaults to stable when unset', () => {
    delete process.env.AI_HELPER_UPDATE_CHANNEL;
    expect(getUpdateChannel()).toBe('stable');
    expect(DEFAULT_UPDATE_CHANNEL).toBe('stable');
    expect(isEdgeChannel()).toBe(false);
  });

  it('returns edge for edge/dev/main aliases (case-insensitive)', () => {
    for (const v of ['edge', 'EDGE', 'dev', 'main', ' Edge ']) {
      process.env.AI_HELPER_UPDATE_CHANNEL = v;
      expect(getUpdateChannel()).toBe('edge');
    }
    expect(isEdgeChannel()).toBe(true);
  });

  it('returns stable for stable/release aliases and empty', () => {
    for (const v of ['stable', 'release', 'prod', '']) {
      process.env.AI_HELPER_UPDATE_CHANNEL = v;
      expect(getUpdateChannel()).toBe('stable');
    }
  });

  it('falls back to stable for unknown values (safe default)', () => {
    process.env.AI_HELPER_UPDATE_CHANNEL = 'nonsense';
    expect(getUpdateChannel()).toBe('stable');
  });
});
