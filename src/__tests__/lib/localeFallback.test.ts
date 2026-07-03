/**
 * 前端 i18n 兜底字典的同步与逻辑测试
 *
 * 同步测试失败说明 locales/*.yaml 改动后未重新生成字典：
 * 请运行 `npm run gen:locale` 并提交 frontend/generated/localeFallback.ts
 */
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { LOCALE_FALLBACK } from '../../../frontend/generated/localeFallback';
import { substituteParams, normalizeLang, lookupFallback } from '../../../frontend/utils/i18nFallbackCore';

function loadLocaleYaml(locale: string): Record<string, string> {
  const file = path.resolve(__dirname, '../../../locales', `${locale}.yaml`);
  const dict = yaml.load(fs.readFileSync(file, 'utf-8')) as Record<string, string>;
  return Object.fromEntries(
    Object.entries(dict).filter(([k, v]) => k.startsWith('ai_helper_') && typeof v === 'string'),
  );
}

describe('localeFallback generated dictionary', () => {
  it.each(['zh', 'en'] as const)(
    'stays in sync with locales/%s.yaml (if this fails, run `npm run gen:locale`)',
    (locale) => {
      expect(LOCALE_FALLBACK[locale]).toEqual(loadLocaleYaml(locale));
    },
  );

  it('contains a reasonable number of keys', () => {
    expect(Object.keys(LOCALE_FALLBACK.zh).length).toBeGreaterThan(100);
    expect(Object.keys(LOCALE_FALLBACK.en).length).toBeGreaterThan(100);
  });
});

describe('i18nFallbackCore', () => {
  it('substitutes {0}/{1} placeholders and keeps unmatched ones', () => {
    expect(substituteParams('已获取 {0} 个模型', [133])).toBe('已获取 133 个模型');
    expect(substituteParams('{0} + {1} = {2}', [1, 2])).toBe('1 + 2 = {2}');
    expect(substituteParams('无占位符', ['x'])).toBe('无占位符');
  });

  it('normalizes language identifiers to zh/en', () => {
    expect(normalizeLang('en')).toBe('en');
    expect(normalizeLang('en_US')).toBe('en');
    expect(normalizeLang('EN-GB')).toBe('en');
    expect(normalizeLang('zh')).toBe('zh');
    expect(normalizeLang('zh_CN')).toBe('zh');
    expect(normalizeLang(undefined)).toBe('zh');
    expect(normalizeLang(null)).toBe('zh');
  });

  it('looks up fallback strings with param substitution', () => {
    expect(lookupFallback('ai_helper_admin_scenario_title', 'zh', [])).toBe('场景模型分配');
    expect(lookupFallback('ai_helper_admin_scenario_title', 'en', [])).toBe('Per-Scenario Model Assignment');
    expect(lookupFallback('ai_helper_admin_scenario_effective_global', 'zh', ['gpt-4o-mini']))
      .toBe('当前生效（跟随全局）：gpt-4o-mini');
  });

  it('returns null for unknown keys', () => {
    expect(lookupFallback('ai_helper_nonexistent_key_xyz', 'zh', [])).toBeNull();
  });
});
