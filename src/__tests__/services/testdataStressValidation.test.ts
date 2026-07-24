import {
  partitionStressValidation,
  TESTDATA_GEN_LIMITS,
} from '../../services/testdataGenService';

describe('partitionStressValidation', () => {
  it('全部合法时保留全部索引', () => {
    expect(partitionStressValidation({
      stressResults: [
        { accepted: true },
        { accepted: true },
        { accepted: true },
      ],
      minValidRatio: TESTDATA_GEN_LIMITS.STRESS_MIN_VALID_RATIO,
    })).toEqual({
      keptIndices: [0, 1, 2],
      dropped: [],
      sufficient: true,
    });
  });

  it('少量失败但存活数达到向上取整阈值时仍 sufficient', () => {
    expect(partitionStressValidation({
      stressResults: [
        { accepted: true },
        { accepted: false, stderr: '越界' },
        { accepted: true },
        { accepted: true },
      ],
      minValidRatio: 0.75,
    })).toEqual({
      keptIndices: [0, 2, 3],
      dropped: [{ index: 1, reason: '越界' }],
      sufficient: true,
    });
  });

  it('失败过多导致存活数低于阈值时 insufficient', () => {
    expect(partitionStressValidation({
      stressResults: [
        { accepted: true },
        { accepted: false, stderr: 'bad-1' },
        { accepted: false, stderr: 'bad-2' },
        { accepted: true },
      ],
      minValidRatio: 0.75,
    })).toMatchObject({
      keptIndices: [0, 3],
      sufficient: false,
    });
  });

  it('失败原因依次使用 stderr、error、status，且 stderr 优先', () => {
    const result = partitionStressValidation({
      stressResults: [
        { accepted: false, stderr: 'stderr detail', error: 'error detail', status: 'Rejected' },
        { accepted: false, error: 'error detail', status: 'Rejected' },
        { accepted: false, status: 'Rejected' },
      ],
      minValidRatio: 0,
    });

    expect(result.dropped).toEqual([
      { index: 0, reason: 'stderr detail' },
      { index: 1, reason: 'error detail' },
      { index: 2, reason: 'Rejected' },
    ]);
  });

  it('空压力集无需校验且视为 sufficient', () => {
    expect(partitionStressValidation({
      stressResults: [],
      minValidRatio: TESTDATA_GEN_LIMITS.STRESS_MIN_VALID_RATIO,
    })).toEqual({
      keptIndices: [],
      dropped: [],
      sufficient: true,
    });
  });
});
