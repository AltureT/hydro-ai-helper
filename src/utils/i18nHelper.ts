import type { Handler } from 'hydrooj';

/**
 * HydroOJ's Handler.translate() only accepts a single key string
 * and does NOT interpolate {0}/{1} placeholders.
 * This helper translates the key and then substitutes positional params.
 */
export function translateWithParams(handler: Handler, key: string, ...params: (string | number)[]): string {
  let str = handler.translate(key);
  for (let i = 0; i < params.length; i++) {
    str = str.replace(`{${i}}`, String(params[i]));
  }
  return str;
}
