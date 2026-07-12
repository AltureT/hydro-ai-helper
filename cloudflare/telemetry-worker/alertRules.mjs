const FEATURE_DEGRADED_MIN_ATTEMPTS = 10;
const FEATURE_DEGRADED_RATE = 0.8;
const TESTDATA_BURST_MIN_ERRORS = 3;

function numberValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function buildFeatureDegradationCandidates(rows = []) {
  return rows.flatMap((row) => {
    const attempts = numberValue(row.attempts);
    const successes = numberValue(row.successes);
    if (attempts < FEATURE_DEGRADED_MIN_ATTEMPTS || successes <= 0 || successes / attempts >= FEATURE_DEGRADED_RATE) {
      return [];
    }
    const rate = Math.round((successes / attempts) * 100);
    return [{
      alert_key: `feature_degraded:${row.feature}`,
      severity: 'warning',
      title: `功能降级: ${row.feature}`,
      detail: `近 7 天 ${attempts} 次尝试、${successes} 次成功（成功率 ${rate}%）`,
    }];
  });
}

export function buildTestdataBurstCandidates(rows = []) {
  return rows.flatMap((row) => {
    const total = numberValue(row.total);
    if (total < TESTDATA_BURST_MIN_ERRORS || !row.instance_id) return [];
    const suffix = String(row.instance_id).slice(-12);
    return [{
      alert_key: `testdata_burst:${suffix}`,
      severity: 'warning',
      title: '单实例测试数据生成连续失败',
      detail: `近 24h 实例 ...${suffix.slice(-8)} 共 ${total} 次 / ${numberValue(row.fingerprints)} 类错误 · ${String(row.sample || '').slice(0, 160)}`,
    }];
  });
}
