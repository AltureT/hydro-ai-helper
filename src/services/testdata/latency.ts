export const TESTDATA_MODEL_TIMEOUT_DEFAULT_MS = 300_000;
export const TESTDATA_MODEL_TIMEOUT_MIN_SECONDS = 30;
export const TESTDATA_MODEL_TIMEOUT_MAX_SECONDS = 1_800;

export function getTestdataModelTimeoutMs(
  raw = process.env.AI_HELPER_TESTDATA_MODEL_TIMEOUT_SECONDS,
): number {
  if (!raw || !/^\d+$/.test(raw)) return TESTDATA_MODEL_TIMEOUT_DEFAULT_MS;
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds)
    || seconds < TESTDATA_MODEL_TIMEOUT_MIN_SECONDS
    || seconds > TESTDATA_MODEL_TIMEOUT_MAX_SECONDS) {
    return TESTDATA_MODEL_TIMEOUT_DEFAULT_MS;
  }
  return seconds * 1_000;
}
