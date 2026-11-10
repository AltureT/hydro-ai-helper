import { ObjectId } from '../../utils/mongo';
import {
  HIGH_USAGE_RATIO,
  MANUAL_USER_LOOKBACK_DAYS,
  selectCandidates,
  selectManualCandidates,
  type CandidateConversation,
  type CandidateSources,
} from '../../services/aiReviewCandidates';

const ids = Array.from({ length: 12 }, (_, i) => new ObjectId(`6560f0000000000000000${String(i + 10).padStart(3, '0')}`));
const conv = (index: number, userId = 1000 + index): CandidateConversation => ({ conversationId: ids[index], domainId: 'oi2023', userId });
const since = new Date('2026-11-09T18:00:00.000Z');

function sources(overrides: Partial<CandidateSources> = {}): CandidateSources & Record<string, jest.Mock> {
  return {
    mediumConfidenceConversations: jest.fn().mockResolvedValue([conv(0), conv(1)]),
    offTopicUsers: jest.fn().mockResolvedValue([1002]),
    highUsageUsers: jest.fn().mockResolvedValue([1003]),
    conversationsOfUsers: jest.fn(async (uids: number[]) => {
      const byUser: Record<number, CandidateConversation[]> = { 1002: [conv(2), conv(1)], 1003: [conv(3), conv(4, 1003)] };
      return uids.flatMap((uid) => byUser[uid] || []);
    }),
    countConversations: jest.fn().mockResolvedValue(100),
    sampleConversations: jest.fn(async (_since: Date, size: number) => [conv(5), conv(6), conv(7), conv(8), conv(9)].slice(0, size)),
    conversationsByIds: jest.fn(async (list: string[]) => list.map((id) => ({ conversationId: new ObjectId(id), domainId: 'club', userId: 1031 }))),
    ...overrides,
  } as CandidateSources & Record<string, jest.Mock>;
}

describe('selectCandidates (FR-041)', () => {
  it('combines the four sources in priority order and dedupes by conversation', async () => {
    const src = sources();
    const result = await selectCandidates(src, { since, sampleRate: 0.05, max: 200 });
    expect(result.map((c) => [String(c.conversationId), c.reason])).toEqual([
      [String(ids[0]), 'medium_confidence'],
      [String(ids[1]), 'medium_confidence'],
      [String(ids[2]), 'off_topic'],
      [String(ids[3]), 'high_usage'],
      [String(ids[4]), 'high_usage'],
      [String(ids[5]), 'sample'],
      [String(ids[6]), 'sample'],
      [String(ids[7]), 'sample'],
      [String(ids[8]), 'sample'],
      [String(ids[9]), 'sample'],
    ]);
    expect(src.highUsageUsers).toHaveBeenCalledWith(HIGH_USAGE_RATIO);
    // 5% of 100 conversations, excluding the ones already chosen
    expect(src.sampleConversations).toHaveBeenCalledWith(since, 5, ids.slice(0, 5).map(String));
  });

  it('cuts the random sample first when over the limit', async () => {
    const result = await selectCandidates(sources(), { since, sampleRate: 0.05, max: 6 });
    expect(result).toHaveLength(6);
    expect(result.filter((c) => c.reason === 'sample')).toHaveLength(1);
  });

  it('cuts the priority sources too when they alone exceed the limit', async () => {
    const src = sources();
    const result = await selectCandidates(src, { since, sampleRate: 0.5, max: 2 });
    expect(result.map((c) => c.reason)).toEqual(['medium_confidence', 'medium_confidence']);
    expect(src.conversationsOfUsers).not.toHaveBeenCalled();
    expect(src.sampleConversations).not.toHaveBeenCalled();
  });

  it('skips sampling when the rate is 0 and returns nothing when the limit is 0', async () => {
    const src = sources();
    const result = await selectCandidates(src, { since, sampleRate: 0, max: 200 });
    expect(result.some((c) => c.reason === 'sample')).toBe(false);
    expect(src.countConversations).not.toHaveBeenCalled();
    expect(await selectCandidates(sources(), { since, sampleRate: 0.05, max: 0 })).toEqual([]);
  });
});

describe('selectManualCandidates (FR-040)', () => {
  it('reviews the given conversations and the students’ recent conversations', async () => {
    const src = sources();
    const now = new Date('2026-11-10T06:30:00.000Z');
    const result = await selectManualCandidates(src, { uids: [1003], conversationIds: [String(ids[11])] }, now, 200);
    expect(result.map((c) => [String(c.conversationId), c.reason])).toEqual([
      [String(ids[11]), 'manual'],
      [String(ids[3]), 'manual'],
      [String(ids[4]), 'manual'],
    ]);
    expect(src.conversationsOfUsers).toHaveBeenCalledWith(
      [1003], new Date(now.getTime() - MANUAL_USER_LOOKBACK_DAYS * 24 * 60 * 60 * 1000), 200,
    );
    expect(src.mediumConfidenceConversations).not.toHaveBeenCalled();
  });
});
