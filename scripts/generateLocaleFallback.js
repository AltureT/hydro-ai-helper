#!/usr/bin/env node
/**
 * 从 locales/*.yaml 生成前端 i18n 兜底字典（frontend/generated/localeFallback.ts）
 *
 * 用法: npm run gen:locale （修改 locales/*.yaml 后必须重新运行）
 *
 * 背景: HydroOJ 把插件翻译注册到服务端 i18n 后，浏览器可能仍缓存旧版翻译资源，
 * 插件更新新增的键会在页面上原样显示为 "ai_helper_xxx"，需强制刷新才恢复。
 * 该字典随前端 bundle 一起发布（bundle 更新即更新），供 frontend/utils/i18n.ts
 * 在服务端翻译缺失时兜底。
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const LOCALES = ['zh', 'en'];
const root = path.resolve(__dirname, '..');
const outFile = path.join(root, 'frontend', 'generated', 'localeFallback.ts');

const dicts = {};
for (const locale of LOCALES) {
  const file = path.join(root, 'locales', `${locale}.yaml`);
  const dict = yaml.load(fs.readFileSync(file, 'utf-8'));
  if (!dict || typeof dict !== 'object') {
    throw new Error(`Invalid locale file: ${file}`);
  }
  // 仅收录本插件前缀的键，键排序保证输出确定性（便于 diff 和同步测试）
  dicts[locale] = Object.fromEntries(
    Object.entries(dict)
      .filter(([k, v]) => k.startsWith('ai_helper_') && typeof v === 'string')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

const content = `/**
 * 自动生成文件，请勿手动修改 — 来源: locales/*.yaml
 * 重新生成: npm run gen:locale
 * 作用: 浏览器缓存了旧版翻译资源时的前端兜底字典（见 frontend/utils/i18n.ts）
 */

export const LOCALE_FALLBACK: Record<'zh' | 'en', Record<string, string>> = ${JSON.stringify(dicts, null, 2)};
`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, content);
console.log(`[gen:locale] written ${path.relative(root, outFile)} (zh: ${Object.keys(dicts.zh).length}, en: ${Object.keys(dicts.en).length} keys)`);
