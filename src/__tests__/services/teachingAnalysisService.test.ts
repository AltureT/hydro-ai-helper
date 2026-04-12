import { TeachingAnalysisService, AnalyzeInput } from '../../services/teachingAnalysisService';

// ─── Mock helpers ────────────────────────────────────────────────────────────

const STATUS_AC = 1;
const STATUS_WA = 2;
const STATUS_TLE = 3;
const STATUS_RE = 6;

function createMockDb(overrides: Record<string, any[]> = {}) {
  const collections: Record<string, any[]> = {
    record: [],
    ai_conversations: [],
    ai_messages: [],
    ai_jailbreak_logs: [],
    ...overrides,
  };

  return {
    collection: (name: string) => ({
      find: (filter?: any) => {
        let data = collections[name] || [];
        if (filter) {
          data = data.filter((doc: any) => {
            for (const [key, val] of Object.entries(filter)) {
              const docVal = doc[key];
              if (val && typeof val === 'object' && !Array.isArray(val)) {
                const op = val as any;
                if (op.$in && !op.$in.includes(docVal)) return false;
                if (op.$gte && docVal < op.$gte) return false;
                if (op.$lte && docVal > op.$lte) return false;
              } else {
                if (docVal !== val) return false;
              }
            }
            return true;
          });
        }
        return {
          sort: () => ({
            toArray: () => Promise.resolve(data),
          }),
          project: () => ({
            toArray: () => Promise.resolve(data.map((d: any) => ({ _id: d._id }))),
          }),
          toArray: () => Promise.resolve(data),
        };
      },
    }),
  } as any;
}

function makeRecord(pid: number, uid: number, status: number, id?: string): any {
  return {
    _id: id || `rec_${pid}_${uid}_${status}_${Math.random().toString(36).slice(2, 6)}`,
    domainId: 'test',
    pid,
    uid,
    status,
    score: status === STATUS_AC ? 100 : 0,
    judgeAt: new Date(),
  };
}

function makeConversation(userId: number, problemId: string, id?: string): any {
  return {
    _id: id || `conv_${userId}_${problemId}`,
    domainId: 'test',
    userId,
    problemId,
    startTime: new Date(),
  };
}

function makeMessage(conversationId: string, role: string, questionType?: string): any {
  return {
    _id: `msg_${Math.random().toString(36).slice(2, 8)}`,
    conversationId,
    role,
    questionType,
    content: 'test message',
    timestamp: new Date(),
  };
}

function makeJailbreak(userId: number): any {
  return {
    _id: `jb_${userId}_${Math.random().toString(36).slice(2, 6)}`,
    userId,
    createdAt: new Date(),
  };
}

function baseInput(overrides: Partial<AnalyzeInput> = {}): AnalyzeInput {
  return {
    domainId: 'test',
    contestId: 'contest1',
    pids: [1, 2, 3],
    studentUids: [101, 102, 103, 104, 105, 106, 107, 108, 109, 110],
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('TeachingAnalysisService', () => {
  describe('stats', () => {
    it('should compute basic stats including aiUserCount', async () => {
      const records = [
        makeRecord(1, 101, STATUS_AC),
        makeRecord(1, 102, STATUS_WA),
      ];
      const conversations = [
        makeConversation(101, '1'),
        makeConversation(103, '2'),
      ];

      const db = createMockDb({
        record: records,
        ai_conversations: conversations,
        ai_messages: [],
      });

      const service = new TeachingAnalysisService(db);
      const result = await service.analyze(baseInput());

      expect(result.stats.totalStudents).toBe(10);
      expect(result.stats.participatedStudents).toBe(2);
      expect(result.stats.aiUserCount).toBe(2);
      expect(result.stats.problemCount).toBe(3);
    });
  });

  describe('Dim A: commonError', () => {
    it('should detect common error when >30% students have same non-AC status', async () => {
      // 6 out of 10 students (60%) get WA on problem 1
      const records = [
        ...([101, 102, 103, 104, 105, 106] as number[]).map((uid) => makeRecord(1, uid, STATUS_WA)),
        // 4 students get AC
        ...([107, 108, 109, 110] as number[]).map((uid) => makeRecord(1, uid, STATUS_AC)),
      ];

      const db = createMockDb({ record: records });
      const service = new TeachingAnalysisService(db);
      const result = await service.analyze(baseInput());

      const commonErrors = result.findings.filter((f) => f.dimension === 'commonError');
      expect(commonErrors.length).toBeGreaterThanOrEqual(1);

      const waFinding = commonErrors.find((f) => f.title.includes('WA'));
      expect(waFinding).toBeDefined();
      expect(waFinding!.evidence.affectedStudents.length).toBe(6);
      expect(waFinding!.evidence.affectedProblems).toEqual([1]);
    });

    it('should NOT trigger finding when affected students < MIN_AFFECTED (5)', async () => {
      // Only 3 students get WA — below min sample gate
      const records = [
        ...([101, 102, 103] as number[]).map((uid) => makeRecord(1, uid, STATUS_WA)),
        ...([104, 105, 106, 107, 108, 109, 110] as number[]).map((uid) => makeRecord(1, uid, STATUS_AC)),
      ];

      const db = createMockDb({ record: records });
      const service = new TeachingAnalysisService(db);
      const result = await service.analyze(baseInput());

      const commonErrors = result.findings.filter((f) => f.dimension === 'commonError');
      // 3 out of 10 = 30%, but threshold is max(5, ceil(10*0.3)) = 5, so 3 < 5 → no finding
      expect(commonErrors.length).toBe(0);
    });
  });

  describe('Dim B: comprehension', () => {
    it('should detect comprehension dominance among AI users', async () => {
      const uids = [101, 102, 103, 104, 105, 106];
      const conversations = uids.map((uid) => makeConversation(uid, '1', `conv_${uid}`));
      const messages: any[] = [];

      for (const uid of uids) {
        // Each user sends 5 messages: 3 understand + 2 debug = 60% comprehension
        messages.push(makeMessage(`conv_${uid}`, 'student', 'understand'));
        messages.push(makeMessage(`conv_${uid}`, 'student', 'understand'));
        messages.push(makeMessage(`conv_${uid}`, 'student', 'understand'));
        messages.push(makeMessage(`conv_${uid}`, 'student', 'debug'));
        messages.push(makeMessage(`conv_${uid}`, 'student', 'debug'));
      }

      const db = createMockDb({
        ai_conversations: conversations,
        ai_messages: messages,
      });

      const service = new TeachingAnalysisService(db);
      const result = await service.analyze(baseInput());

      const comprehension = result.findings.filter((f) => f.dimension === 'comprehension');
      expect(comprehension.length).toBe(1);
      expect(comprehension[0].title).toContain('AI 用户数据');
      expect(comprehension[0].evidence.affectedStudents.length).toBe(6);
    });
  });

  describe('Dim C: strategy', () => {
    it('should detect jailbreak attempts', async () => {
      const jailbreakLogs = [101, 102, 103, 104, 105].flatMap((uid) => [
        makeJailbreak(uid),
      ]);

      const conversations = [101, 102, 103, 104, 105].map((uid) => makeConversation(uid, '1'));

      const db = createMockDb({
        ai_conversations: conversations,
        ai_jailbreak_logs: jailbreakLogs,
      });

      const service = new TeachingAnalysisService(db);
      const result = await service.analyze(baseInput());

      const strategy = result.findings.filter(
        (f) => f.dimension === 'strategy' && f.title.includes('越狱'),
      );
      expect(strategy.length).toBe(1);
      expect(strategy[0].evidence.affectedStudents.length).toBe(5);
    });
  });

  describe('Dim D: atRisk', () => {
    it('should detect at-risk students who failed >=70% of problems', async () => {
      // 6 students fail all 3 problems (100% fail rate)
      const records: any[] = [];
      for (const uid of [101, 102, 103, 104, 105, 106]) {
        for (const pid of [1, 2, 3]) {
          records.push(makeRecord(pid, uid, STATUS_WA));
        }
      }
      // 4 students AC all
      for (const uid of [107, 108, 109, 110]) {
        for (const pid of [1, 2, 3]) {
          records.push(makeRecord(pid, uid, STATUS_AC));
        }
      }

      const db = createMockDb({ record: records });
      const service = new TeachingAnalysisService(db);
      const result = await service.analyze(baseInput());

      const atRisk = result.findings.filter((f) => f.dimension === 'atRisk');
      expect(atRisk.length).toBe(1);
      expect(atRisk[0].evidence.affectedStudents.length).toBe(6);
    });
  });

  describe('Dim E: difficulty', () => {
    it('should detect difficulty anomaly when pass rate <20%', async () => {
      // Problem 1: 1 out of 10 students AC = 10% pass rate
      const records: any[] = [];
      records.push(makeRecord(1, 101, STATUS_AC));
      for (const uid of [102, 103, 104, 105, 106, 107, 108, 109, 110]) {
        records.push(makeRecord(1, uid, STATUS_WA));
      }

      const db = createMockDb({ record: records });
      const service = new TeachingAnalysisService(db);
      const result = await service.analyze(baseInput({ pids: [1] }));

      const difficulty = result.findings.filter((f) => f.dimension === 'difficulty');
      expect(difficulty.length).toBe(1);
      expect(difficulty[0].title).toContain('通过率极低');
      expect(difficulty[0].evidence.metrics.passRate).toBeLessThan(20);
      expect(difficulty[0].evidence.affectedStudents.length).toBe(9);
    });

    it('should NOT trigger difficulty when fewer than 5 students attempted', async () => {
      // Only 3 students attempted problem 1
      const records = [
        makeRecord(1, 101, STATUS_WA),
        makeRecord(1, 102, STATUS_WA),
        makeRecord(1, 103, STATUS_WA),
      ];

      const db = createMockDb({ record: records });
      const service = new TeachingAnalysisService(db);
      const result = await service.analyze(baseInput({ pids: [1] }));

      const difficulty = result.findings.filter((f) => f.dimension === 'difficulty');
      expect(difficulty.length).toBe(0);
    });
  });

  describe('Dim F: progress', () => {
    it('should detect students who ACd all problems', async () => {
      const records: any[] = [];
      // 6 students AC all 3 problems
      for (const uid of [101, 102, 103, 104, 105, 106]) {
        for (const pid of [1, 2, 3]) {
          records.push(makeRecord(pid, uid, STATUS_AC));
        }
      }
      // 4 students fail problem 3
      for (const uid of [107, 108, 109, 110]) {
        records.push(makeRecord(1, uid, STATUS_AC));
        records.push(makeRecord(2, uid, STATUS_AC));
        records.push(makeRecord(3, uid, STATUS_WA));
      }

      const db = createMockDb({ record: records });
      const service = new TeachingAnalysisService(db);
      const result = await service.analyze(baseInput());

      const progress = result.findings.filter((f) => f.dimension === 'progress');
      expect(progress.length).toBe(1);
      expect(progress[0].evidence.affectedStudents.length).toBe(6);
    });
  });

  describe('Dim G: cognitivePath', () => {
    it('should detect brute-force guessing (>=8 submissions, no AC, no AI)', async () => {
      const records: any[] = [];
      // 5 students submit >=8 times on problem 1, no AC, no AI usage
      for (const uid of [101, 102, 103, 104, 105]) {
        for (let i = 0; i < 10; i++) {
          records.push(makeRecord(1, uid, STATUS_WA, `rec_bf_${uid}_${i}`));
        }
      }

      // No conversations (these students don't use AI)
      const db = createMockDb({ record: records });
      const service = new TeachingAnalysisService(db);
      const result = await service.analyze(baseInput({ pids: [1] }));

      const cognitive = result.findings.filter((f) => f.dimension === 'cognitivePath');
      expect(cognitive.length).toBe(1);
      expect(cognitive[0].evidence.affectedStudents.length).toBe(5);
    });

    it('should NOT flag students who use AI even with many submissions', async () => {
      const records: any[] = [];
      for (const uid of [101, 102, 103, 104, 105]) {
        for (let i = 0; i < 10; i++) {
          records.push(makeRecord(1, uid, STATUS_WA, `rec_ai_${uid}_${i}`));
        }
      }

      // These students all use AI
      const conversations = [101, 102, 103, 104, 105].map(
        (uid) => makeConversation(uid, '1'),
      );

      const db = createMockDb({ record: records, ai_conversations: conversations });
      const service = new TeachingAnalysisService(db);
      const result = await service.analyze(baseInput({ pids: [1] }));

      const cognitive = result.findings.filter((f) => f.dimension === 'cognitivePath');
      expect(cognitive.length).toBe(0);
    });
  });

  describe('Dim H: aiEffectiveness', () => {
    it('should compare AI vs non-AI user pass rates', async () => {
      const records: any[] = [];

      // 5 AI users: all AC problem 1 (100% pass rate)
      for (const uid of [101, 102, 103, 104, 105]) {
        records.push(makeRecord(1, uid, STATUS_AC));
      }
      // 5 non-AI users: only 1 AC (20% pass rate)
      records.push(makeRecord(1, 106, STATUS_AC));
      for (const uid of [107, 108, 109, 110]) {
        records.push(makeRecord(1, uid, STATUS_WA));
      }

      const conversations = [101, 102, 103, 104, 105].map(
        (uid) => makeConversation(uid, '1'),
      );

      const db = createMockDb({ record: records, ai_conversations: conversations });
      const service = new TeachingAnalysisService(db);
      const result = await service.analyze(baseInput({ pids: [1] }));

      const effectiveness = result.findings.filter((f) => f.dimension === 'aiEffectiveness');
      expect(effectiveness.length).toBe(1);
      expect(effectiveness[0].evidence.metrics.aiPassRate).toBe(100);
      expect(effectiveness[0].evidence.metrics.nonAiPassRate).toBe(20);
      expect(effectiveness[0].evidence.metrics.diff).toBe(80);
    });
  });

  describe('min sample gate', () => {
    it('should not create finding when affected students < 5', async () => {
      // Only 4 students in total — below MIN_AFFECTED for any dimension
      const input = baseInput({ studentUids: [101, 102, 103, 104], pids: [1] });
      const records = [101, 102, 103, 104].map((uid) => makeRecord(1, uid, STATUS_WA));

      const db = createMockDb({ record: records });
      const service = new TeachingAnalysisService(db);
      const result = await service.analyze(input);

      // atRisk would have 4 students (all fail) but 4 < 5 → null
      const atRisk = result.findings.filter((f) => f.dimension === 'atRisk');
      expect(atRisk.length).toBe(0);
    });
  });
});
