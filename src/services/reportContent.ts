import type { ChatCallOptions } from './openaiClient';
import { normalizeReportMarkdown } from '../utils/reportMarkdown';

/** Remove provider metadata and normalize report headings before persistence. */
export function reportContent(content: string): string {
  const result = normalizeReportMarkdown(content);
  if (!result.trim()) throw new Error('Model returned an empty report');
  return result;
}

// Reports need room for both reasoning and the final answer. Let the provider
// choose its model default instead of inheriting the 4096-token chat limit.
// Keep the configured endpoint timeout and the existing bounded retries.
export const REPORT_CHAT_OPTIONS: ChatCallOptions = { contentMode: 'report', maxTokens: null };
