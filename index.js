/**
 * HydroOJ 插件入口 (CommonJS)
 * HydroOJ Loader 仅会在插件根目录寻找 `index.(ts|js)`，
 * 因此这里简单地代理到构建产物 `dist/index.js`。
 */
module.exports = require('./dist/index.js');
