import {
  TESTDATA_MODEL_TIMEOUT_DEFAULT_MS,
  getTestdataModelTimeoutMs,
} from '../../services/testdata/latency';

describe('getTestdataModelTimeoutMs', () => {
  it('defaults to five minutes when the environment value is absent', () => {
    expect(getTestdataModelTimeoutMs(undefined)).toBe(TESTDATA_MODEL_TIMEOUT_DEFAULT_MS);
  });

  it.each([
    ['30', 30_000],
    ['300', 300_000],
    ['1800', 1_800_000],
  ])('accepts bounded whole seconds: %s', (raw, expected) => {
    expect(getTestdataModelTimeoutMs(raw)).toBe(expected);
  });

  it.each(['', '29', '1801', '30.5', ' 300 ', 'abc', '-30']) (
    'falls back for invalid or out-of-range values: %p',
    raw => {
      expect(getTestdataModelTimeoutMs(raw)).toBe(TESTDATA_MODEL_TIMEOUT_DEFAULT_MS);
    },
  );
});
