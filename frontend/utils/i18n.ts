/**
 * 带兜底字典的 i18n 包装器
 *
 * 插件更新后，浏览器可能仍缓存旧版翻译资源，新增的键会在页面上
 * 原样显示为 "ai_helper_xxx"，必须强制刷新才恢复。该包装器在服务端
 * 翻译缺失时回退到随前端 bundle 发布的字典（frontend/generated/
 * localeFallback.ts，bundle 更新即更新），用户无需强制刷新。
 *
 * 服务端翻译存在时优先使用（保留站点级自定义翻译的可能）。
 */
import { i18n as baseI18n } from '@hydrooj/ui-default';
import { lookupFallback, normalizeLang } from './i18nFallbackCore';

export function i18n(key: string, ...params: Array<string | number>): string {
  let translated: string;
  try {
    translated = baseI18n(key, ...params);
  } catch {
    translated = key;
  }
  // 翻译存在（返回值 != 键名）或非本插件的键：直接使用
  if (translated !== key || !key.startsWith('ai_helper_')) return translated;

  let lang: string | undefined;
  try {
    lang = (window as any)?.UserContext?.viewLang
      || document?.documentElement?.getAttribute('lang')
      || undefined;
  } catch { /* 非浏览器环境 */ }

  return lookupFallback(key, normalizeLang(lang), params) ?? translated;
}
