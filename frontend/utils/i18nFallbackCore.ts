/**
 * i18n 兜底的纯逻辑部分（不依赖 @hydrooj/ui-default，可单元测试）
 */
import { LOCALE_FALLBACK } from '../generated/localeFallback';

export type FallbackLang = 'zh' | 'en';

/** 将 viewLang / html lang 等原始语言标识归一化为兜底字典支持的语言 */
export function normalizeLang(raw?: string | null): FallbackLang {
  return (raw || '').toLowerCase().startsWith('en') ? 'en' : 'zh';
}

/** HydroOJ 风格的 {0}/{1} 占位符替换；缺参时保留占位符原样 */
export function substituteParams(template: string, params: Array<string | number>): string {
  return template.replace(/\{(\d+)\}/g, (match, idx) => {
    const value = params[Number(idx)];
    return value === undefined ? match : String(value);
  });
}

/** 查兜底字典；键不存在返回 null（当前语言缺失时退回中文） */
export function lookupFallback(
  key: string,
  lang: FallbackLang,
  params: Array<string | number>,
): string | null {
  const template = LOCALE_FALLBACK[lang]?.[key] ?? LOCALE_FALLBACK.zh[key];
  if (template === undefined) return null;
  return substituteParams(template, params);
}
