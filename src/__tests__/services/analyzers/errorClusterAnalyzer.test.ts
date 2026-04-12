import { errorSignature, normalizeCompilerError, analyzeErrorClusters } from '../../../services/analyzers/errorClusterAnalyzer';

describe('errorSignature', () => {
  it('should generate CE signature from compiler text', () => {
    const record = {
      status: 7,
      compilerTexts: ["error: 'x' was not declared in this scope at line 5"],
      testCases: [],
    };
    const sig = errorSignature(record as any);
    expect(sig).toBe("CE:error: 'VAR' was not declared in this scope at line N");
  });

  it('should return CE:unknown when no compiler text', () => {
    const record = { status: 7, compilerTexts: [], testCases: [] };
    expect(errorSignature(record as any)).toBe('CE:unknown');
  });

  it('should handle CE with undefined compilerTexts', () => {
    const record = { status: 7, testCases: [] };
    expect(errorSignature(record as any)).toBe('CE:unknown');
  });

  it('should generate signature from failing test case IDs', () => {
    const record = {
      status: 2,
      testCases: [
        { id: 1, status: 1 },
        { id: 2, status: 2 },
        { id: 3, status: 2 },
      ],
    };
    expect(errorSignature(record as any)).toBe('WA:tests[2,3]');
  });

  it('should fallback to subtaskId when id is undefined', () => {
    const record = {
      status: 2,
      testCases: [
        { subtaskId: 10, status: 2 },
        { subtaskId: 20, status: 2 },
      ],
    };
    expect(errorSignature(record as any)).toBe('WA:tests[10,20]');
  });

  it('should use ? when both id and subtaskId are undefined', () => {
    const record = {
      status: 2,
      testCases: [{ status: 2 }, { status: 2 }],
    };
    expect(errorSignature(record as any)).toBe('WA:tests[?,?]');
  });

  it('should cap failing tests at 5 and show remainder', () => {
    const record = {
      status: 2,
      testCases: Array.from({ length: 10 }, (_, i) => ({ id: i + 1, status: 2 })),
    };
    const sig = errorSignature(record as any);
    expect(sig).toBe('WA:tests[1,2,3,4,5...+5]');
  });

  it('should handle TLE status', () => {
    const record = {
      status: 3,
      testCases: [{ id: 5, status: 3 }],
    };
    expect(errorSignature(record as any)).toBe('TLE:tests[5]');
  });
});

describe('normalizeCompilerError', () => {
  it('should normalize C++ error', () => {
    const msg = "error: 'myVar' was not declared in this scope\n  at /home/user/main.cpp:10";
    const result = normalizeCompilerError(msg);
    expect(result).toBe("error: 'VAR' was not declared in this scope");
    expect(result).not.toContain('myVar');
    expect(result).not.toContain('/home');
  });

  it('should handle Python traceback by taking last line', () => {
    const msg = "Traceback (most recent call last):\n  File \"test.py\", line 5\nTypeError: 'str' object is not callable";
    const result = normalizeCompilerError(msg);
    expect(result).toContain('TypeError');
    expect(result).not.toContain('Traceback');
  });

  it('should normalize line and column numbers', () => {
    const msg = "error at line 42, column 13: syntax error";
    const result = normalizeCompilerError(msg);
    expect(result).toContain('line N');
    expect(result).toContain('col N');
  });
});

describe('analyzeErrorClusters', () => {
  it('should cluster records by error signature and generate finding', () => {
    const records = [
      { pid: 1, uid: 1, status: 2, testCases: [{ id: 1, status: 1 }, { id: 2, status: 2 }] },
      { pid: 1, uid: 2, status: 2, testCases: [{ id: 1, status: 1 }, { id: 2, status: 2 }] },
      { pid: 1, uid: 3, status: 2, testCases: [{ id: 1, status: 1 }, { id: 2, status: 2 }] },
      { pid: 1, uid: 4, status: 2, testCases: [{ id: 1, status: 1 }, { id: 2, status: 2 }] },
      { pid: 1, uid: 5, status: 2, testCases: [{ id: 1, status: 1 }, { id: 2, status: 2 }] },
      { pid: 1, uid: 6, status: 2, testCases: [{ id: 1, status: 1 }, { id: 2, status: 2 }] },
    ];
    const findings = analyzeErrorClusters(records as any[], [1], 10);
    const nonNull = findings.filter(f => f !== null);
    expect(nonNull.length).toBeGreaterThanOrEqual(1);
    expect(nonNull[0]!.dimension).toBe('errorCluster');
    expect(nonNull[0]!.evidence.affectedStudents.length).toBe(6);
  });

  it('should return empty when cluster ratio below threshold', () => {
    const records = [
      { pid: 1, uid: 1, status: 2, testCases: [{ id: 1, status: 2 }] },
      { pid: 1, uid: 2, status: 2, testCases: [{ id: 2, status: 2 }] },
    ];
    const findings = analyzeErrorClusters(records as any[], [1], 20);
    const nonNull = findings.filter(f => f !== null);
    expect(nonNull.length).toBe(0);
  });

  it('should set severity high when >= 50% affected', () => {
    const records = Array.from({ length: 6 }, (_, i) => ({
      pid: 1, uid: i + 1, status: 2,
      testCases: [{ id: 1, status: 2 }],
    }));
    const findings = analyzeErrorClusters(records as any[], [1], 10);
    const nonNull = findings.filter(f => f !== null);
    expect(nonNull.length).toBe(1);
    expect(nonNull[0]!.severity).toBe('high');
  });

  it('should handle multiple problems independently', () => {
    const records = [
      ...Array.from({ length: 5 }, (_, i) => ({
        pid: 1, uid: i + 1, status: 2,
        testCases: [{ id: 1, status: 2 }],
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        pid: 2, uid: i + 1, status: 6,
        testCases: [{ id: 3, status: 6 }],
      })),
    ];
    const findings = analyzeErrorClusters(records as any[], [1, 2], 10);
    const nonNull = findings.filter(f => f !== null);
    expect(nonNull.length).toBe(2);
  });
});
