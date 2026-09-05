import React from 'react';
import { useBatchSummary, BatchSummaryState } from '../../../frontend/batchSummary/useBatchSummary';

describe('learning summary mutation results', () => {
  let state: BatchSummaryState;

  beforeEach(() => {
    state = {
      jobId: 'current-job', jobStatus: 'completed', isGenerating: false,
      completed: 1, total: 1, failed: 0, newStudentCount: 0, error: null,
      loading: false, publishResult: null,
      summaries: new Map([[1, { userId: 1, status: 'completed', publishStatus: 'draft', summary: 'Current summary' }]]),
    };
    jest.spyOn(React, 'useState').mockImplementation((() => [state, (update: (prev: BatchSummaryState) => BatchSummaryState) => { state = update(state); }]) as any);
    jest.spyOn(React, 'useCallback').mockImplementation(callback => callback);
    jest.spyOn(React, 'useRef').mockReturnValue({ current: null });
  });

  afterEach(() => jest.restoreAllMocks());

  it('publishes or edits through a new Map so rows and aggregate counts can refresh', () => {
    const previous = state.summaries;
    const hook = useBatchSummary('system');
    hook.updateSummary(1, { publishStatus: 'published', summary: 'Reviewed summary' }, 'current-job');
    expect(state.summaries).not.toBe(previous);
    expect(previous.get(1)?.publishStatus).toBe('draft');
    expect(state.summaries.get(1)).toMatchObject({ publishStatus: 'published', summary: 'Reviewed summary' });
  });

  it('ignores late edit and publish responses belonging to a replaced job', () => {
    const before = state;
    const hook = useBatchSummary('system');
    hook.updateSummary(1, { summary: 'Old edit' }, 'previous-job');
    hook.updateSummary(1, { publishStatus: 'published' }, 'previous-job');
    expect(state).toBe(before);
  });
});
