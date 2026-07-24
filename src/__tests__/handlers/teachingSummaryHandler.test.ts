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
  createMultiModelClientFromConfig: jest.fn(),
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
import { db } from 'hydrooj';

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

  it('TeachingReviewHandler enriches summaries with the HydroOJ contest rule', async () => {
    const summary = {
      _id: 'summary-1',
      domainId: 'system',
      contestId: 'contest-1',
      contestTitle: 'Homework 1',
      status: 'completed',
      findings: [],
    };
    const model = {
      findByDomain: jest.fn().mockResolvedValue([summary]),
      countByDomain: jest.fn().mockResolvedValue(1),
      getFeedbackStats: jest.fn().mockResolvedValue({ up: 1, down: 0 }),
    };
    const find = jest.fn().mockReturnValue({
      toArray: jest.fn().mockResolvedValue([{ docId: 'contest-1', rule: 'homework' }]),
    });
    (db.collection as jest.Mock).mockReturnValueOnce({ find });

    const handler = Object.create(TeachingReviewHandler.prototype) as any;
    handler.request = { query: { page: '1', limit: '20' } };
    handler.response = {};
    handler.ctx = { get: jest.fn().mockReturnValue(model) };

    await handler.get();

    expect(find).toHaveBeenCalledWith(
      { domainId: 'system', docType: 30, docId: { $in: ['contest-1'] } },
      { projection: { docId: 1, rule: 1 } },
    );
    expect(handler.response.body.summaries[0]).toMatchObject({
      contestId: 'contest-1',
      contestRule: 'homework',
    });
  });
});
