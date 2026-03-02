import { getRemainingRequests } from '../../services/rateLimitService';

describe('getRemainingRequests', () => {
  let mockDb: any;
  let mockCollection: any;

  beforeEach(() => {
    mockCollection = {
      findOne: jest.fn(),
    };

    mockDb = {
      collection: jest.fn().mockReturnValue(mockCollection),
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should return full limit when no opcount record exists', async () => {
    mockCollection.findOne.mockResolvedValue(null);

    const result = await getRemainingRequests(mockDb, 1001, 5);

    expect(result).toBe(5);
    expect(mockDb.collection).toHaveBeenCalledWith('opcount');
    expect(mockCollection.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        op: 'ai_chat',
        ident: '1001',
      })
    );
  });

  it('should return remaining count based on opcount', async () => {
    mockCollection.findOne.mockResolvedValue({ opcount: 3 });

    const result = await getRemainingRequests(mockDb, 1001, 5);

    expect(result).toBe(2);
  });

  it('should return 0 when opcount exceeds limit', async () => {
    mockCollection.findOne.mockResolvedValue({ opcount: 10 });

    const result = await getRemainingRequests(mockDb, 1001, 5);

    expect(result).toBe(0);
  });

  it('should return 0 when opcount equals limit', async () => {
    mockCollection.findOne.mockResolvedValue({ opcount: 5 });

    const result = await getRemainingRequests(mockDb, 1001, 5);

    expect(result).toBe(0);
  });

  it('should return null on DB error', async () => {
    mockCollection.findOne.mockRejectedValue(new Error('DB error'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation();

    const result = await getRemainingRequests(mockDb, 1001, 5);

    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('should handle record with opcount=0', async () => {
    mockCollection.findOne.mockResolvedValue({ opcount: 0 });

    const result = await getRemainingRequests(mockDb, 1001, 5);

    expect(result).toBe(5);
  });
});
