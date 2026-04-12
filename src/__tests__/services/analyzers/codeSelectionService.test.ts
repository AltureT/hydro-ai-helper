import { shouldGenerateFillIn, scoreReadability, selectACCode, isFillInBlankProblem } from '../../../services/analyzers/codeSelectionService';

describe('shouldGenerateFillIn', () => {
  it('returns true when all trigger conditions are met', () => {
    expect(shouldGenerateFillIn({
      hasCommonError: true, finalACRate: 0.6, firstAttemptACRate: 0.5, avgSubmissionCount: 3,
    })).toBe(true);
  });

  it('returns false when no commonError finding', () => {
    expect(shouldGenerateFillIn({
      hasCommonError: false, finalACRate: 0.6, firstAttemptACRate: 0.5, avgSubmissionCount: 3,
    })).toBe(false);
  });

  it('returns false when first-attempt AC rate > 70%', () => {
    expect(shouldGenerateFillIn({
      hasCommonError: true, finalACRate: 0.95, firstAttemptACRate: 0.8, avgSubmissionCount: 1.5,
    })).toBe(false);
  });

  it('returns true when AC rate >= 90% but avgSubmissions >= 2', () => {
    expect(shouldGenerateFillIn({
      hasCommonError: true, finalACRate: 0.92, firstAttemptACRate: 0.5, avgSubmissionCount: 3,
    })).toBe(true);
  });
});

describe('scoreReadability', () => {
  it('scores higher for code with comments and functions', () => {
    const goodCode = '// 反转链表\nfunction reverse(head) {\n  let prev = null;\n  let current = head;\n  while (current) {\n    let next = current.next;\n    current.next = prev;\n    prev = current;\n    current = next;\n  }\n  return prev;\n}';
    const bareCode = 'a=input()\nb=int(a)\nprint(b*2)';
    expect(scoreReadability(goodCode)).toBeGreaterThan(scoreReadability(bareCode));
  });
});

describe('isFillInBlankProblem', () => {
  it('detects fill-in-blank patterns', () => {
    expect(isFillInBlankProblem('请补全代码中的 ___ 部分')).toBe(true);
    expect(isFillInBlankProblem('请补全 /* your code here */ 的内容')).toBe(true);
    expect(isFillInBlankProblem('写一个函数计算阶乘')).toBe(false);
  });
});

describe('selectACCode', () => {
  it('returns top 3 candidates sorted by readability score', () => {
    const submissions = [
      { uid: 1, code: 'a=1\nb=2\nprint(a+b)', lang: 'python3', score: 100 },
      { uid: 2, code: '// 加法\nfunction add(a, b) {\n  return a + b;\n}\nconsole.log(add(1,2));', lang: 'javascript', score: 100 },
      { uid: 3, code: 'x=input()\nprint(int(x)+1)', lang: 'python3', score: 100 },
      { uid: 4, code: '// 解题思路\nint main() {\n  int a, b;\n  scanf("%d%d", &a, &b);\n  printf("%d\\n", a+b);\n  return 0;\n}', lang: 'cc.cc14', score: 100 },
    ];
    const result = selectACCode(submissions, 10);
    expect(result.length).toBeLessThanOrEqual(3);
    expect(result[0].score).toBeGreaterThanOrEqual(result[result.length - 1].score);
  });

  it('filters out extreme lengths when >10 submissions', () => {
    const submissions = Array.from({ length: 20 }, (_, i) => ({
      uid: i, code: 'x'.repeat(i === 0 ? 5 : i === 19 ? 5000 : 100 + i * 10),
      lang: 'python3', score: 100,
    }));
    const result = selectACCode(submissions, 10);
    const selectedUids = result.map(r => r.uid);
    expect(selectedUids).not.toContain(0);
    expect(selectedUids).not.toContain(19);
  });

  it('returns empty array for empty input', () => {
    expect(selectACCode([])).toEqual([]);
  });
});
