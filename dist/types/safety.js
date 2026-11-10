"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HIGH_CONFIDENCE_RISK_SCORE = exports.SAFETY_VIOLATION_CATEGORIES = void 0;
exports.SAFETY_VIOLATION_CATEGORIES = [
    'answer_seeking', 'prompt_injection', 'prompt_exfiltration', 'obfuscated_injection', 'off_topic',
];
/** 规则风险分 ≥ 70 为高置信度（FR-028a） */
exports.HIGH_CONFIDENCE_RISK_SCORE = 70;
//# sourceMappingURL=safety.js.map