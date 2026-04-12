/**
 * Basic export tests for TeachingSummaryHandler, TeachingReviewHandler, TeachingSummaryFeedbackHandler
 */

jest.mock('hydrooj', () => ({
  Handler: class Handler {},
  PRIV: { PRIV_READ_RECORD_CODE: 1 << 9 },
  db: {
    collection: jest.fn().mockReturnValue({
      findOne: jest.fn(),
      find: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) }),
    }),
  },
}));

jest.mock('../../services/openaiClient', () => ({
  createOpenAIClientFromConfig: jest.fn(),
}));

jest.mock('../../services/teachingAnalysisService', () => ({
  TeachingAnalysisService: jest.fn(),
}));

jest.mock('../../services/teachingSuggestionService', () => ({
  TeachingSuggestionService: jest.fn(),
}));

jest.mock('../../utils/domainHelper', () => ({
  getDomainId: jest.fn().mockReturnValue('system'),
}));

jest.mock('../../utils/mongo', () => ({
  ObjectId: class ObjectId {
    constructor(id?: string) {}
  },
}));

jest.mock('../../utils/ensureObjectId', () => ({
  ensureObjectId: jest.fn((id: any) => id),
}));

import {
  TeachingSummaryHandler,
  TeachingReviewHandler,
  TeachingSummaryFeedbackHandler,
  TeachingSummaryHandlerPriv,
} from '../../handlers/teachingSummaryHandler';

describe('TeachingSummaryHandler exports', () => {
  it('should export TeachingSummaryHandler', () => {
    expect(TeachingSummaryHandler).toBeDefined();
  });

  it('should export TeachingReviewHandler', () => {
    expect(TeachingReviewHandler).toBeDefined();
  });

  it('should export TeachingSummaryFeedbackHandler', () => {
    expect(TeachingSummaryFeedbackHandler).toBeDefined();
  });

  it('should export TeachingSummaryHandlerPriv', () => {
    expect(TeachingSummaryHandlerPriv).toBeDefined();
  });

  it('TeachingSummaryHandler should be a class', () => {
    expect(typeof TeachingSummaryHandler).toBe('function');
  });

  it('TeachingReviewHandler should be a class', () => {
    expect(typeof TeachingReviewHandler).toBe('function');
  });

  it('TeachingSummaryFeedbackHandler should be a class', () => {
    expect(typeof TeachingSummaryFeedbackHandler).toBe('function');
  });
});
