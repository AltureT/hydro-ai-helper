/**
 * Class Size Strategy — adapts analysis dimensions based on student count.
 * Spec reference: §3.5
 */

import { FindingDimension } from '../../models/teachingSummary';

export interface ClassSizeStrategy {
  label: 'individual' | 'mixed' | 'full';
  disabledDimensions: FindingDimension[];
  minAffected: number;
  ratioThreshold: number;
}

/**
 * Determine which dimensions to enable based on class size.
 *
 * | Size    | Strategy   | Disabled                                          |
 * |---------|------------|---------------------------------------------------|
 * | < 10    | individual | commonError, aiEffectiveness, difficulty           |
 * | 10-20   | mixed      | aiEffectiveness (if AI users < 5)                 |
 * | 20+     | full       | none                                              |
 */
export function getClassSizeStrategy(
  totalStudents: number,
  aiUserCount: number,
): ClassSizeStrategy {
  if (totalStudents < 10) {
    return {
      label: 'individual',
      disabledDimensions: ['commonError', 'aiEffectiveness', 'difficulty'],
      minAffected: 3,
      ratioThreshold: 0.25,
    };
  }

  if (totalStudents <= 20) {
    const disabled: FindingDimension[] = [];
    if (aiUserCount < 5) disabled.push('aiEffectiveness');
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
