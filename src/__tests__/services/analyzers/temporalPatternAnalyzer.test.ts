import {
  extractTemporalFeatures,
  countStatusTransitions,
  classifyPattern,
  analyzeTemporalPatterns,
} from '../../../services/analyzers/temporalPatternAnalyzer';

// Helper: create a TimedRecord relative to a base time
function makeTimedRecord(pid: number, uid: number, status: number, minutesFromStart: number): any {
  const base = new Date('2026-04-01T09:00:00Z');
  return { pid, uid, status, judgeAt: new Date(base.getTime() + minutesFromStart * 60_000) };
}

// ── extractTemporalFeatures ───────────────────────────────────────────────────

describe('extractTemporalFeatures', () => {
  it('returns zero values for empty records', () => {
    const features = extractTemporalFeatures([]);
    expect(features.totalSubmissions).toBe(0);
    expect(features.totalActiveMinutes).toBe(0);
    expect(features.medianInterval).toBeNull();
    expect(features.burstCount).toBe(0);
    expect(features.distinctSessions).toBe(1);
    expect(features.firstACIndex).toBeNull();
    expect(features.timeSinceLastSubmit).toBeNull();
  });

  it('computes basic features from a 3-submission sequence', () => {
    // t=0, t=5min, t=15min; last is AC
    const records = [
      makeTimedRecord(1, 1, 2, 0),   // WA
      makeTimedRecord(1, 1, 2, 5),   // WA
      makeTimedRecord(1, 1, 1, 15),  // AC
    ];
    const features = extractTemporalFeatures(records);
    expect(features.totalSubmissions).toBe(3);
    expect(features.totalActiveMinutes).toBe(15);
    expect(features.firstACIndex).toBe(2);
    expect(features.medianInterval).not.toBeNull();
    // intervals: 5min=300s, 10min=600s → median = (300+600)/2 = 450
    expect(features.medianInterval).toBe(450);
    expect(features.timeSinceLastSubmit).toBeNull(); // no contestEndTime
  });

  it('detects a burst when 3+ consecutive subs < 60s apart', () => {
    // 4 submissions 30s apart → 1 burst
    const base = new Date('2026-04-01T09:00:00Z').getTime();
    const records = [0, 0.5, 1, 1.5].map(m =>
      makeTimedRecord(1, 1, 2, m),
    );
    const features = extractTemporalFeatures(records);
    expect(features.burstCount).toBe(1);
  });

  it('counts no burst when intervals >= 60s', () => {
    const records = [
      makeTimedRecord(1, 1, 2, 0),
      makeTimedRecord(1, 1, 2, 2),
      makeTimedRecord(1, 1, 2, 4),
    ];
    const features = extractTemporalFeatures(records);
    expect(features.burstCount).toBe(0);
  });

  it('detects 2 sessions when gap > 30 min', () => {
    const records = [
      makeTimedRecord(1, 1, 2, 0),
      makeTimedRecord(1, 1, 2, 45), // 45min gap → new session
    ];
    const features = extractTemporalFeatures(records);
    expect(features.distinctSessions).toBe(2);
  });

  it('returns null firstACIndex when no AC', () => {
    const records = [
      makeTimedRecord(1, 1, 2, 0),
      makeTimedRecord(1, 1, 6, 10),
    ];
    const features = extractTemporalFeatures(records);
    expect(features.firstACIndex).toBeNull();
  });

  it('computes timeSinceLastSubmit when contestEndTime provided', () => {
    const contestEnd = new Date('2026-04-01T12:00:00Z'); // 3h after base
    const records = [makeTimedRecord(1, 1, 2, 0)]; // at base time
    const features = extractTemporalFeatures(records, contestEnd);
    expect(features.timeSinceLastSubmit).toBe(3 * 60 * 60_000);
  });
});

// ── countStatusTransitions ────────────────────────────────────────────────────

describe('countStatusTransitions', () => {
  it('returns 0 for empty records', () => {
    expect(countStatusTransitions([])).toBe(0);
  });

  it('returns 0 when all records have the same status', () => {
    const records = [
      makeTimedRecord(1, 1, 2, 0),
      makeTimedRecord(1, 1, 2, 5),
    ];
    expect(countStatusTransitions(records)).toBe(0);
  });

  it('returns correct count for 3 distinct statuses', () => {
    const records = [
      makeTimedRecord(1, 1, 2, 0),  // WA
      makeTimedRecord(1, 1, 6, 5),  // RE
      makeTimedRecord(1, 1, 1, 10), // AC
    ];
    expect(countStatusTransitions(records)).toBe(2);
  });
});

// ── classifyPattern ───────────────────────────────────────────────────────────

describe('classifyPattern', () => {
  const baseFeatures = {
    totalSubmissions: 5,
    totalActiveMinutes: 30,
    medianInterval: 300,
    burstCount: 0,
    distinctSessions: 1,
    firstACIndex: null,
    timeSinceLastSubmit: null,
  };

  it('classifies strategic_solver when AC within first 3 submissions', () => {
    const features = { ...baseFeatures, firstACIndex: 1 };
    expect(classifyPattern(features, 1, false)).toBe('strategic_solver');
  });

  it('classifies strategic_solver when firstACIndex = 0', () => {
    const features = { ...baseFeatures, firstACIndex: 0 };
    expect(classifyPattern(features, 1, false)).toBe('strategic_solver');
  });

  it('does NOT classify strategic_solver when firstACIndex = 3', () => {
    const features = { ...baseFeatures, firstACIndex: 3 };
    const result = classifyPattern(features, 1, false);
    expect(result).not.toBe('strategic_solver');
  });

  it('classifies disengaged for <=2 subs, no AC, and time > threshold', () => {
    const threeHours = 3 * 60 * 60_000;
    const features = {
      ...baseFeatures,
      totalSubmissions: 2,
      timeSinceLastSubmit: threeHours,
    };
    expect(classifyPattern(features, 2, false)).toBe('disengaged');
  });

  it('does NOT classify disengaged if timeSinceLastSubmit below threshold', () => {
    const features = {
      ...baseFeatures,
      totalSubmissions: 1,
      timeSinceLastSubmit: 30 * 60_000, // only 30 min
    };
    expect(classifyPattern(features, 2, false)).not.toBe('disengaged');
  });

  it('classifies burst_then_quit when burst >= 1 and quit > 2h', () => {
    const features = {
      ...baseFeatures,
      burstCount: 1,
      timeSinceLastSubmit: 3 * 60 * 60_000,
    };
    expect(classifyPattern(features, 2, false)).toBe('burst_then_quit');
  });

  it('classifies stuck_silent for >=8 subs, no AC, no AI conversation', () => {
    const features = { ...baseFeatures, totalSubmissions: 10 };
    expect(classifyPattern(features, 2, false)).toBe('stuck_silent');
  });

  it('does NOT classify stuck_silent when student used AI', () => {
    const features = { ...baseFeatures, totalSubmissions: 10 };
    const result = classifyPattern(features, 2, true); // hasAIConversation=true
    expect(result).not.toBe('stuck_silent');
  });

  it('classifies persistent_learner for >=2 sessions and >=2 transitions', () => {
    const features = { ...baseFeatures, totalSubmissions: 5, distinctSessions: 2 };
    expect(classifyPattern(features, 2, false, 2)).toBe('persistent_learner');
  });

  it('returns null when no pattern matches', () => {
    // 4 submissions, no AC, no burst, 1 session, no AI, few transitions
    const features = { ...baseFeatures, totalSubmissions: 4 };
    expect(classifyPattern(features, 2, false, 0)).toBeNull();
  });
});

// ── analyzeTemporalPatterns ───────────────────────────────────────────────────

describe('analyzeTemporalPatterns', () => {
  it('returns empty array when no student group reaches MIN_AFFECTED=5', () => {
    // 4 students all classified as stuck_silent — below threshold
    const pids = [1];
    const uids = [1, 2, 3, 4];
    const records = uids.flatMap(uid =>
      Array.from({ length: 10 }, (_, i) =>
        makeTimedRecord(1, uid, 2, i * 2), // all WA, many submissions
      ),
    );
    const contestEnd = new Date('2026-04-01T18:00:00Z');
    const findings = analyzeTemporalPatterns(
      records, pids, uids, new Map(), undefined, contestEnd,
    );
    const nonNull = findings.filter(f => f !== null);
    expect(nonNull.length).toBe(0);
  });

  it('generates a finding for stuck_silent when >= 5 students qualify', () => {
    const pids = [1];
    const uids = [1, 2, 3, 4, 5];
    // Each student: 10 WA submissions, no AI, quit 3h before contest end
    // Contest ends at base+12h; last submission at base+0h → 12h gap
    const contestEnd = new Date('2026-04-01T21:00:00Z'); // 12h after base
    const records = uids.flatMap(uid =>
      Array.from({ length: 10 }, (_, i) =>
        makeTimedRecord(1, uid, 2, i), // submissions at 0..9 min
      ),
    );
    const findings = analyzeTemporalPatterns(
      records, pids, uids, new Map(), undefined, contestEnd,
    );
    const nonNull = findings.filter(f => f !== null);
    expect(nonNull.length).toBeGreaterThanOrEqual(1);
    const stuckFinding = nonNull.find(f => f!.title.includes('沉默挣扎'));
    expect(stuckFinding).toBeDefined();
    expect(stuckFinding!.dimension).toBe('temporalPattern');
    expect(stuckFinding!.needsDeepDive).toBe(true);
  });

  it('populates outProfiles when provided', () => {
    const pids = [1];
    const uids = [1, 2, 3, 4, 5];
    const contestEnd = new Date('2026-04-01T21:00:00Z');
    const records = uids.flatMap(uid =>
      Array.from({ length: 10 }, (_, i) =>
        makeTimedRecord(1, uid, 2, i),
      ),
    );
    const profiles: any[] = [];
    analyzeTemporalPatterns(
      records, pids, uids, new Map(), undefined, contestEnd, profiles,
    );
    expect(profiles.length).toBeGreaterThan(0);
    expect(profiles[0]).toHaveProperty('uid');
    expect(profiles[0]).toHaveProperty('pid');
    expect(profiles[0]).toHaveProperty('pattern');
    expect(profiles[0]).toHaveProperty('features');
  });

  it('does not generate findings for strategic_solver pattern', () => {
    const pids = [1];
    const uids = [1, 2, 3, 4, 5];
    // All students solve on first submission
    const records = uids.map(uid => makeTimedRecord(1, uid, 1, 5));
    const findings = analyzeTemporalPatterns(
      records, pids, uids, new Map(),
    );
    const nonNull = findings.filter(f => f !== null);
    // strategic_solver should not generate findings
    expect(nonNull.filter(f => f!.title.includes('高效解题')).length).toBe(0);
  });

  it('sets confidence=high when >= 15 students affected', () => {
    const pids = [1];
    const uids = Array.from({ length: 15 }, (_, i) => i + 1);
    const contestEnd = new Date('2026-04-01T21:00:00Z');
    const records = uids.flatMap(uid =>
      Array.from({ length: 10 }, (_, i) =>
        makeTimedRecord(1, uid, 2, i),
      ),
    );
    const findings = analyzeTemporalPatterns(
      records, pids, uids, new Map(), undefined, contestEnd,
    );
    const nonNull = findings.filter(f => f !== null);
    expect(nonNull.length).toBeGreaterThan(0);
    expect(nonNull[0]!.confidence).toBe('high');
  });
});
