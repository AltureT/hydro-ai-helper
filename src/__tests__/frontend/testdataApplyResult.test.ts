import {
  getTestdataApplyPresentation,
  parseTestdataApplyResult,
} from '../../../frontend/testdataGen/applyResult';

describe('parseTestdataApplyResult', () => {
  it('preserves bounded written/failed details from non-2xx apply responses', () => {
    expect(parseTestdataApplyResult({
      written: ['1.in'],
      failed: [{ name: '1.out', error: 'storage down' }],
      code: 'APPLY_STATE_CONFLICT',
    })).toEqual({
      written: ['1.in'],
      failed: [{ name: '1.out', error: 'storage down' }],
    });
  });

  it('rejects generic errors and malformed file details', () => {
    expect(parseTestdataApplyResult({ code: 'OUTCOME_ALREADY_RECORDED' })).toBeNull();
    expect(parseTestdataApplyResult({ written: [1], failed: [] })).toBeNull();
    expect(parseTestdataApplyResult({ written: [], failed: [{ name: 'x' }] })).toBeNull();
  });

  it('never presents a non-2xx result as success even when every file was written', () => {
    const result = { written: ['1.in'], failed: [] };
    expect(getTestdataApplyPresentation(false, result)).toBe('conflict');
    expect(getTestdataApplyPresentation(true, result)).toBe('success');
    expect(getTestdataApplyPresentation(true, {
      written: ['1.in'], failed: [{ name: '1.out', error: 'storage down' }],
    })).toBe('partial');
  });
});
