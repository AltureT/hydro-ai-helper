import type {
  TestdataModelRole,
  TestdataQualityRate,
  TestdataQualityResponse,
} from './types';

const EMPTY_RATE: TestdataQualityRate = { count: 0, total: 0, rate: null };

export function formatTestdataQualityRate(metric?: TestdataQualityRate): string {
  const value = metric ?? EMPTY_RATE;
  if (value.total <= 0 || value.rate === null || !Number.isFinite(value.rate)) {
    return `暂无数据 (${value.count}/${value.total})`;
  }
  return `${(value.rate * 100).toFixed(1)}% (${value.count}/${value.total})`;
}

export interface TestdataQualityCard {
  key: string;
  label: string;
  value: string;
}

export interface TestdataModelRoleRow {
  role: TestdataModelRole;
  label: string;
  runs: number;
  completed: string;
  verified: string;
  failed: string;
}

export function buildTestdataModelRoleRows(
  data: TestdataQualityResponse,
): TestdataModelRoleRow[] {
  return (['primary', 'fallback'] as const).map(role => {
    const metrics = data.model_roles?.[role];
    return {
      role,
      label: role === 'primary' ? '首选模型' : '后备模型',
      runs: metrics?.runs ?? 0,
      completed: formatTestdataQualityRate(metrics?.completed),
      verified: formatTestdataQualityRate(metrics?.verified),
      failed: formatTestdataQualityRate(metrics?.failed),
    };
  });
}

export function buildTestdataQualityCards(data: TestdataQualityResponse): TestdataQualityCard[] {
  const metric = (key: keyof NonNullable<TestdataQualityResponse['metrics']>) => (
    formatTestdataQualityRate(data.metrics?.[key])
  );
  return [
    { key: 'total_runs', label: '总运行数', value: String(data.total_runs ?? 0) },
    { key: 'pipeline_completion', label: 'Pipeline 完成率', value: metric('pipeline_completion') },
    { key: 'verified', label: '机器验证通过率', value: metric('verified') },
    { key: 'would_block', label: 'WouldBlock 率', value: metric('would_block') },
    { key: 'accepted_unchanged', label: '直接采用率', value: metric('accepted_unchanged') },
    { key: 'accepted_edited', label: '编辑后采用率', value: metric('accepted_edited') },
    { key: 'discarded', label: '放弃率', value: metric('discarded') },
    { key: 'regenerated', label: '重新生成率', value: metric('regenerated') },
    { key: 'model_escalation_rescue', label: '模型升级挽救率', value: metric('model_escalation_rescue') },
    {
      key: 'verified_but_teacher_changed',
      label: '机器通过但教师编辑/放弃',
      value: metric('verified_but_teacher_changed'),
    },
  ];
}
