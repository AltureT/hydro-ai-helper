import {
  evaluateDiscrimination,
  reduceCheckerExecution,
} from '../../services/testdataGenService';

describe('reduceCheckerExecution', () => {
  it('exit 0 归约为 accept', () => {
    expect(reduceCheckerExecution({
      status: 'Accepted',
      accepted: true,
      timedOut: false,
      exitStatus: 0,
    })).toBe('accept');
  });

  it('checker 非零退出归约为 reject', () => {
    expect(reduceCheckerExecution({
      status: 'Nonzero Exit Status',
      accepted: false,
      timedOut: false,
      exitStatus: 1,
    })).toBe('reject');
  });

  it.each([
    [undefined, true],
    [{ status: 'Time Limit Exceeded', accepted: false, timedOut: true }, false],
    [{ status: 'System Error', accepted: false, timedOut: false }, false],
    [{ status: 'Output Limit Exceeded', accepted: false, timedOut: false }, false],
  ])('HTTP/协议失败、超时或系统错误归约为 infra-error', (detail, infrastructureError) => {
    expect(reduceCheckerExecution(detail, infrastructureError)).toBe('infra-error');
  });
});

describe('checker 三态在区分度判定中的语义', () => {
  const evaluate = (checkerVerdict: 'accept' | 'reject' | 'infra-error') =>
    evaluateDiscrimination({
      targetRuns: [{
        kind: 'wrong-algorithm',
        description: '错误解',
        perCase: [{
          accepted: true,
          timedOut: false,
          stdout: '候选输出\n',
          checkerVerdict,
        }],
      }],
      oracleOutputs: ['标准输出\n'],
      customChecker: true,
    }).targets[0];

  it('reject 才能将自定义 checker 靶子判为 WA', () => {
    expect(evaluate('reject')).toMatchObject({ killed: true, killedBy: 'wa', killedByCase: 1 });
  });

  it('accept 保留靶子为存活，infra-error 则只跳过本次判断', () => {
    expect(evaluate('accept')).toEqual({
      kind: 'wrong-algorithm',
      description: '错误解',
      killed: false,
    });
    expect(evaluate('infra-error')).toMatchObject({
      killed: false,
      skippedReason: 'checker-infra-error',
    });
  });
});
