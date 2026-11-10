"use strict";
/**
 * 时区工具（plan R6）
 *
 * 次数额度按配置时区的自然日计算。只用 Intl，不新增依赖；有夏令时的时区也按当地零点重置。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_TIMEZONE = void 0;
exports.isValidTimezone = isValidTimezone;
exports.resolveTimezone = resolveTimezone;
exports.dateKey = dateKey;
exports.nextResetAt = nextResetAt;
exports.minutesOfDay = minutesOfDay;
exports.startOfDay = startOfDay;
exports.previousDateKey = previousDateKey;
exports.DEFAULT_TIMEZONE = 'Asia/Shanghai';
const formatterCache = new Map();
function getFormatter(timeZone) {
    let formatter = formatterCache.get(timeZone);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-US', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hourCycle: 'h23',
        });
        formatterCache.set(timeZone, formatter);
    }
    return formatter;
}
function zonedParts(timeZone, date) {
    const values = {};
    for (const part of getFormatter(timeZone).formatToParts(date)) {
        if (part.type !== 'literal')
            values[part.type] = Number(part.value);
    }
    return {
        year: values.year,
        month: values.month,
        day: values.day,
        hour: values.hour === 24 ? 0 : values.hour,
        minute: values.minute,
        second: values.second,
    };
}
function pad(value) {
    return String(value).padStart(2, '0');
}
/** 时区名称是否可被 Intl 识别 */
function isValidTimezone(timeZone) {
    if (typeof timeZone !== 'string' || !timeZone.trim())
        return false;
    try {
        getFormatter(timeZone);
        return true;
    }
    catch {
        return false;
    }
}
/** 非法时区回退到默认时区 */
function resolveTimezone(timeZone) {
    return isValidTimezone(timeZone) ? timeZone : exports.DEFAULT_TIMEZONE;
}
/** 指定时区下的日期键 YYYY-MM-DD */
function dateKey(timeZone, now = new Date()) {
    const p = zonedParts(resolveTimezone(timeZone), now);
    return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}
/** 某一时刻在该时区相对 UTC 的偏移（毫秒） */
function offsetMs(timeZone, instant) {
    const p = zonedParts(timeZone, new Date(instant));
    const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return wallAsUtc - Math.floor(instant / 1000) * 1000;
}
/** 该时区的下一个零点（额度重置时间） */
function nextResetAt(timeZone, now = new Date()) {
    const tz = resolveTimezone(timeZone);
    const today = zonedParts(tz, now);
    const wallMidnight = Date.UTC(today.year, today.month - 1, today.day + 1);
    const nextDay = new Date(wallMidnight);
    const nextKey = `${nextDay.getUTCFullYear()}-${pad(nextDay.getUTCMonth() + 1)}-${pad(nextDay.getUTCDate())}`;
    // 两次迭代收敛到跨越夏令时切换的正确偏移
    let ts = wallMidnight - offsetMs(tz, wallMidnight);
    ts = wallMidnight - offsetMs(tz, ts);
    // 极少数时区在零点切换夏令时，当地零点不存在：前移到新一天的第一个整点
    for (let guard = 0; guard < 3 && dateKey(tz, new Date(ts)) !== nextKey; guard++) {
        ts += 60 * 60 * 1000;
    }
    return new Date(ts);
}
/** 指定时区下当日已过的分钟数（0–1439），用于判断每日任务是否到点 */
function minutesOfDay(timeZone, now = new Date()) {
    const p = zonedParts(resolveTimezone(timeZone), now);
    return p.hour * 60 + p.minute;
}
/** 指定时区下当天零点（上一次额度重置时间） */
function startOfDay(timeZone, now = new Date()) {
    const start = nextResetAt(timeZone, new Date(now.getTime() - 24 * 60 * 60 * 1000));
    // 跨夏令时的 23/25 小时日：结果晚于 now 时退回一天
    return start.getTime() > now.getTime()
        ? nextResetAt(timeZone, new Date(now.getTime() - 48 * 60 * 60 * 1000))
        : start;
}
/** 前一天的日期键 */
function previousDateKey(timeZone, now = new Date()) {
    return dateKey(timeZone, new Date(startOfDay(timeZone, now).getTime() - 60 * 1000));
}
//# sourceMappingURL=timezone.js.map