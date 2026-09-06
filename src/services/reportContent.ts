import { normalizeReportMarkdown } from '../utils/reportMarkdown';

/** Remove provider metadata and normalize report headings before persistence. */
export function reportContent(content: string): string {
  const result = normalizeReportMarkdown(content);
  if (!result.trim()) throw new Error('Model returned an empty report');
  return result;
}
