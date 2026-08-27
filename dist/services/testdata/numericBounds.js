"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.canonicalIntegerLiteral = canonicalIntegerLiteral;
exports.compareIntegerLiterals = compareIntegerLiterals;
exports.safeNumberFromIntegerLiteral = safeNumberFromIntegerLiteral;
exports.intersectIntegerBounds = intersectIntegerBounds;
exports.parseNumericBoundExpression = parseNumericBoundExpression;
const MAX_LITERAL_LENGTH = 64;
const MAX_LITERAL_DIGITS = 40;
const MAX_EXPONENT = 100;
const FIELD_REFERENCE = '([A-Za-z][A-Za-z0-9_.:-]{0,63})(?:\\[[^\\]]{1,64}\\]){0,2}';
const INTEGER_TOKEN = '([^\\s<>=]+)';
function boundedExponent(raw) {
    if (!/^\d{1,3}$/.test(raw))
        return undefined;
    const exponent = Number(raw);
    return Number.isSafeInteger(exponent) && exponent <= MAX_EXPONENT ? exponent : undefined;
}
function canonicalIntegerLiteral(raw) {
    if (raw.length === 0 || raw.length > MAX_LITERAL_LENGTH)
        return undefined;
    if (/^(?:0|-?[1-9]\d*)$/.test(raw)) {
        const digits = raw.startsWith('-') ? raw.length - 1 : raw.length;
        if (digits > MAX_LITERAL_DIGITS)
            return undefined;
        try {
            return BigInt(raw).toString();
        }
        catch {
            return undefined;
        }
    }
    const power = /^(-?)10\^(\d+)$/.exec(raw);
    if (power) {
        const exponent = boundedExponent(power[2]);
        if (exponent === undefined)
            return undefined;
        const value = 10n ** BigInt(exponent);
        return (power[1] ? -value : value).toString();
    }
    const scientific = /^(-?)(0|[1-9]\d*)[eE]\+?(\d+)$/.exec(raw);
    if (scientific) {
        const exponent = boundedExponent(scientific[3]);
        if (exponent === undefined || scientific[2].length > MAX_LITERAL_DIGITS)
            return undefined;
        const magnitude = BigInt(scientific[2]) * (10n ** BigInt(exponent));
        return (scientific[1] ? -magnitude : magnitude).toString();
    }
    return undefined;
}
function compareIntegerLiterals(left, right) {
    const leftValue = BigInt(left);
    const rightValue = BigInt(right);
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}
function safeNumberFromIntegerLiteral(value) {
    if (value === undefined)
        return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && String(parsed) === value ? parsed : undefined;
}
function intersectIntegerBounds(current, next) {
    const min = next.min === undefined
        ? current.min : current.min === undefined ? next.min
        : compareIntegerLiterals(current.min, next.min) >= 0 ? current.min : next.min;
    const max = next.max === undefined
        ? current.max : current.max === undefined ? next.max
        : compareIntegerLiterals(current.max, next.max) <= 0 ? current.max : next.max;
    if (min !== undefined && max !== undefined && compareIntegerLiterals(min, max) > 0) {
        return undefined;
    }
    return { ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) };
}
function normalizeExpression(expression) {
    return expression
        .replace(/≤/g, '<=')
        .replace(/≥/g, '>=')
        .replace(/−/g, '-')
        .replace(/\s+/g, ' ')
        .trim();
}
function parseNumericBoundExpression(expression) {
    const looksLikeComparison = /[<>≤≥]/.test(expression);
    if (expression.length > 256) {
        return { kind: looksLikeComparison ? 'invalid-bound' : 'not-bound' };
    }
    const normalized = normalizeExpression(expression);
    const range = new RegExp(`^${INTEGER_TOKEN}\\s*<=\\s*${FIELD_REFERENCE}\\s*<=\\s*${INTEGER_TOKEN}$`).exec(normalized);
    if (range) {
        const min = canonicalIntegerLiteral(range[1]);
        const max = canonicalIntegerLiteral(range[3]);
        if (min === undefined || max === undefined || compareIntegerLiterals(min, max) > 0) {
            return { kind: 'invalid-bound' };
        }
        return { kind: 'parsed', fieldId: range[2], bounds: { min, max } };
    }
    const fieldBound = new RegExp(`^${FIELD_REFERENCE}\\s*(<=|>=)\\s*${INTEGER_TOKEN}$`).exec(normalized);
    if (fieldBound) {
        const literal = canonicalIntegerLiteral(fieldBound[3]);
        if (literal === undefined)
            return { kind: 'invalid-bound' };
        return {
            kind: 'parsed',
            fieldId: fieldBound[1],
            bounds: fieldBound[2] === '<=' ? { max: literal } : { min: literal },
        };
    }
    const reversedBound = new RegExp(`^${INTEGER_TOKEN}\\s*(<=|>=)\\s*${FIELD_REFERENCE}$`).exec(normalized);
    if (reversedBound) {
        const literal = canonicalIntegerLiteral(reversedBound[1]);
        if (literal === undefined)
            return { kind: 'invalid-bound' };
        return {
            kind: 'parsed',
            fieldId: reversedBound[3],
            bounds: reversedBound[2] === '<=' ? { min: literal } : { max: literal },
        };
    }
    return { kind: looksLikeComparison ? 'invalid-bound' : 'not-bound' };
}
//# sourceMappingURL=numericBounds.js.map