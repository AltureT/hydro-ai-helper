jest.mock('../../models/rateLimitRecord', () => ({
  getRateLimitCollection: jest.fn()
}));

import { RateLimitService } from '../../services/rateLimitService';
import { getRateLimitCollection } from '../../models/rateLimitRecord';

const mockGetRateLimitCollection = getRateLimitCollection as jest.MockedFunction<typeof getRateLimitCollection>;

describe('RateLimitService', () => {
  let service: RateLimitService;
  let mockCtx: any;
  let mockCollection: any;

  beforeEach(() => {
    mockCollection = {
      findOneAndUpdate: jest.fn(),
      findOne: jest.fn()
    };

    mockGetRateLimitCollection.mockReturnValue(mockCollection);

    mockCtx = {
      db: {},
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
      }
    };

    service = new RateLimitService(mockCtx);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('checkAndIncrement', () => {
    it('should allow request when count is below limit', async () => {
      mockCollection.findOneAndUpdate.mockResolvedValue({
        value: { count: 3 }
      });

      const result = await service.checkAndIncrement('domain1', 1001, 5);

      expect(result).toBe(true);
      expect(mockCollection.findOneAndUpdate).toHaveBeenCalled();
    });

    it('should deny request when count exceeds limit', async () => {
      mockCollection.findOneAndUpdate.mockResolvedValue({
        value: { count: 6 }
      });

      const result = await service.checkAndIncrement('domain1', 1001, 5);

      expect(result).toBe(false);
    });

    it('should allow request at exactly the limit', async () => {
      mockCollection.findOneAndUpdate.mockResolvedValue({
        value: { count: 5 }
      });

      const result = await service.checkAndIncrement('domain1', 1001, 5);

      expect(result).toBe(true);
    });

    it('should use upsert to create new record if not exists', async () => {
      mockCollection.findOneAndUpdate.mockResolvedValue({
        value: { count: 1 }
      });

      await service.checkAndIncrement('domain1', 1001, 5);

      expect(mockCollection.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          domainId: 'domain1',
          userId: 1001
        }),
        expect.objectContaining({
          $inc: { count: 1 }
        }),
        expect.objectContaining({
          upsert: true
        })
      );
    });

    it('should fallback to findOne when findOneAndUpdate returns null', async () => {
      mockCollection.findOneAndUpdate.mockResolvedValue({ value: null });
      mockCollection.findOne.mockResolvedValue({ count: 2 });

      const result = await service.checkAndIncrement('domain1', 1001, 5);

      expect(result).toBe(true);
      expect(mockCollection.findOne).toHaveBeenCalled();
    });

    it('should allow request on error (fail-open)', async () => {
      mockCollection.findOneAndUpdate.mockRejectedValue(new Error('DB error'));

      const result = await service.checkAndIncrement('domain1', 1001, 5);

      expect(result).toBe(true);
      expect(mockCtx.logger.error).toHaveBeenCalled();
    });
  });

  describe('getRemainingRequests', () => {
    it('should return full limit when no record exists', async () => {
      mockCollection.findOne.mockResolvedValue(null);

      const result = await service.getRemainingRequests('domain1', 1001, 5);

      expect(result).toBe(5);
    });

    it('should return remaining count', async () => {
      mockCollection.findOne.mockResolvedValue({ count: 3 });

      const result = await service.getRemainingRequests('domain1', 1001, 5);

      expect(result).toBe(2);
    });

    it('should return 0 when count exceeds limit', async () => {
      mockCollection.findOne.mockResolvedValue({ count: 10 });

      const result = await service.getRemainingRequests('domain1', 1001, 5);

      expect(result).toBe(0);
    });

    it('should return null on error', async () => {
      mockCollection.findOne.mockRejectedValue(new Error('DB error'));

      const result = await service.getRemainingRequests('domain1', 1001, 5);

      expect(result).toBeNull();
    });
  });
});
