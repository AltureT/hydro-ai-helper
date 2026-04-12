"use strict";
/**
 * Class Size Strategy — adapts analysis dimensions based on student count.
 * Spec reference: §3.5
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getClassSizeStrategy = getClassSizeStrategy;
/**
 * Determine which dimensions to enable based on class size.
 *
 * | Size    | Strategy   | Disabled                                          |
 * |---------|------------|---------------------------------------------------|
 * | < 10    | individual | commonError, aiEffectiveness, difficulty           |
 * | 10-20   | mixed      | aiEffectiveness (if AI users < 5)                 |
 * | 20+     | full       | none                                              |
 */
function getClassSizeStrategy(totalStudents, aiUserCount) {
    if (totalStudents < 10) {
        return {
            label: 'individual',
            disabledDimensions: ['commonError', 'aiEffectiveness', 'difficulty'],
            minAffected: 3,
            ratioThreshold: 0.25,
        };
    }
    if (totalStudents <= 20) {
        const disabled = [];
        if (aiUserCount < 5)
            disabled.push('aiEffectiveness');
        return {
            label: 'mixed',
            disabledDimensions: disabled,
            minAffected: 3,
            ratioThreshold: 0.25,
        };
    }
    return {
        label: 'full',
        disabledDimensions: [],
        minAffected: 5,
        ratioThreshold: 0.30,
    };
}
//# sourceMappingURL=classSizeStrategy.js.map