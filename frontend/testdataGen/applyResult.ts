export interface TestdataApplyResult {
  written: string[];
  failed: Array<{ name: string; error: string }>;
}

export type TestdataApplyPresentation = 'success' | 'partial' | 'conflict';

export function getTestdataApplyPresentation(
  responseOk: boolean,
  result: TestdataApplyResult,
): TestdataApplyPresentation {
  if (!responseOk) return 'conflict';
  return result.failed.length === 0 ? 'success' : 'partial';
}

/** Parse only the bounded local apply result; generic error bodies return null. */
export function parseTestdataApplyResult(value: unknown): TestdataApplyResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.written)
    || candidate.written.some(item => typeof item !== 'string')
    || !Array.isArray(candidate.failed)) return null;
  const failed = candidate.failed as unknown[];
  if (failed.some(item => (
    !item || typeof item !== 'object' || Array.isArray(item)
      || typeof (item as Record<string, unknown>).name !== 'string'
      || typeof (item as Record<string, unknown>).error !== 'string'
  ))) return null;
  return {
    written: [...candidate.written] as string[],
    failed: failed.map(item => ({
      name: (item as Record<string, string>).name,
      error: (item as Record<string, string>).error,
    })),
  };
}
