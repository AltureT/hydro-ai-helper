"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.translateWithParams = translateWithParams;
/**
 * HydroOJ's Handler.translate() only accepts a single key string
 * and does NOT interpolate {0}/{1} placeholders.
 * This helper translates the key and then substitutes positional params.
 */
function translateWithParams(handler, key, ...params) {
    let str = handler.translate(key);
    for (let i = 0; i < params.length; i++) {
        str = str.replace(`{${i}}`, String(params[i]));
    }
    return str;
}
//# sourceMappingURL=i18nHelper.js.map