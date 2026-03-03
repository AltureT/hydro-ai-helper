jest.mock('../../utils/ensureObjectId', () => ({
  ensureObjectId: jest.fn((id: any) => id),
}));

import { MessageModel } from '../../models/message';

function createChainMock() {
  const mock: any = {
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    toArray: jest.fn().mockResolvedValue([]),
  };
  return mock;
}

function createMockCollection() {
  const chainMock = createChainMock();
  return {
    createIndex: jest.fn(),
    insertOne: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn().mockReturnValue(chainMock),
    deleteMany: jest.fn(),
    countDocuments: jest.fn(),
    aggregate: jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) }),
    _chain: chainMock,
  };
}

function createMockDb(collection: any) {
  return { collection: jest.fn().mockReturnValue(collection) } as any;
}

describe('MessageModel', () => {
  let mockColl: ReturnType<typeof createMockCollection>;
  let model: MessageModel;

  beforeEach(() => {
    mockColl = createMockCollection();
    model = new MessageModel(createMockDb(mockColl));
    jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ─── ensureIndexes ──────────────────────────────────

  describe('ensureIndexes', () => {
    it('should create 3 indexes', async () => {
      await model.ensureIndexes();
      expect(mockColl.createIndex).toHaveBeenCalledTimes(3);
      expect(console.log).toHaveBeenCalledWith('[MessageModel] Indexes created successfully');
    });
  });

  // ─── create ─────────────────────────────────────────

  describe('create', () => {
    it('should insert and return insertedId', async () => {
      mockColl.insertOne.mockResolvedValue({ insertedId: 'msg-1' });

      const data = {
        conversationId: 'conv-1' as any,
        role: 'student' as const,
        content: 'Hello',
        timestamp: new Date(),
      };

      const result = await model.create(data);
      expect(result).toBe('msg-1');
      expect(mockColl.insertOne).toHaveBeenCalledWith(data);
    });
  });

  // ─── findByConversationId ───────────────────────────

  describe('findByConversationId', () => {
    it('should return messages sorted by timestamp ascending', async () => {
      const messages = [{ _id: '1', content: 'a' }, { _id: '2', content: 'b' }];
      mockColl._chain.toArray.mockResolvedValue(messages);

      const result = await model.findByConversationId('conv-1');
      expect(result).toEqual(messages);
      expect(mockColl.find).toHaveBeenCalledWith({ conversationId: 'conv-1' });
      expect(mockColl._chain.sort).toHaveBeenCalledWith({ timestamp: 1 });
    });
  });

  // ─── findRecentByConversationId ─────────────────────

  describe('findRecentByConversationId', () => {
    it('should sort desc then reverse for ascending order', async () => {
      const messages = [{ _id: '2' }, { _id: '1' }];
      mockColl._chain.toArray.mockResolvedValue(messages);

      const result = await model.findRecentByConversationId('conv-1', 10);
      expect(result).toEqual([{ _id: '1' }, { _id: '2' }]);
      expect(mockColl._chain.sort).toHaveBeenCalledWith({ timestamp: -1 });
      expect(mockColl._chain.limit).toHaveBeenCalledWith(10);
    });

    it('should clamp limit to minimum 1', async () => {
      mockColl._chain.toArray.mockResolvedValue([]);
      await model.findRecentByConversationId('conv-1', 0);
      expect(mockColl._chain.limit).toHaveBeenCalledWith(1);
    });

    it('should clamp limit to maximum 50', async () => {
      mockColl._chain.toArray.mockResolvedValue([]);
      await model.findRecentByConversationId('conv-1', 100);
      expect(mockColl._chain.limit).toHaveBeenCalledWith(50);
    });

    it('should floor non-integer limit', async () => {
      mockColl._chain.toArray.mockResolvedValue([]);
      await model.findRecentByConversationId('conv-1', 5.7);
      expect(mockColl._chain.limit).toHaveBeenCalledWith(5);
    });

    it('should clamp negative limit to 1', async () => {
      mockColl._chain.toArray.mockResolvedValue([]);
      await model.findRecentByConversationId('conv-1', -5);
      expect(mockColl._chain.limit).toHaveBeenCalledWith(1);
    });
  });

  // ─── findById ───────────────────────────────────────

  describe('findById', () => {
    it('should return message when found', async () => {
      const msg = { _id: 'msg-1', content: 'Hello' };
      mockColl.findOne.mockResolvedValue(msg);

      const result = await model.findById('msg-1');
      expect(result).toEqual(msg);
      expect(mockColl.findOne).toHaveBeenCalledWith({ _id: 'msg-1' });
    });

    it('should return null when not found', async () => {
      mockColl.findOne.mockResolvedValue(null);
      const result = await model.findById('nonexistent');
      expect(result).toBeNull();
    });
  });

  // ─── deleteByConversationId ─────────────────────────

  describe('deleteByConversationId', () => {
    it('should return deletedCount', async () => {
      mockColl.deleteMany.mockResolvedValue({ deletedCount: 5 });

      const result = await model.deleteByConversationId('conv-1');
      expect(result).toBe(5);
      expect(mockColl.deleteMany).toHaveBeenCalledWith({ conversationId: 'conv-1' });
    });

    it('should return 0 when nothing deleted', async () => {
      mockColl.deleteMany.mockResolvedValue({ deletedCount: 0 });
      const result = await model.deleteByConversationId('empty-conv');
      expect(result).toBe(0);
    });
  });

  // ─── countByConversationId ──────────────────────────

  describe('countByConversationId', () => {
    it('should return count', async () => {
      mockColl.countDocuments.mockResolvedValue(10);
      const result = await model.countByConversationId('conv-1');
      expect(result).toBe(10);
      expect(mockColl.countDocuments).toHaveBeenCalledWith({ conversationId: 'conv-1' });
    });
  });

  // ─── findStudentMessagesByConversationId ────────────

  describe('findStudentMessagesByConversationId', () => {
    it('should filter by role=student and sort ascending', async () => {
      mockColl._chain.toArray.mockResolvedValue([]);

      await model.findStudentMessagesByConversationId('conv-1');
      expect(mockColl.find).toHaveBeenCalledWith({ conversationId: 'conv-1', role: 'student' });
      expect(mockColl._chain.sort).toHaveBeenCalledWith({ timestamp: 1 });
    });
  });

  // ─── findAiMessagesByConversationId ─────────────────

  describe('findAiMessagesByConversationId', () => {
    it('should filter by role=ai and sort ascending', async () => {
      mockColl._chain.toArray.mockResolvedValue([]);

      await model.findAiMessagesByConversationId('conv-1');
      expect(mockColl.find).toHaveBeenCalledWith({ conversationId: 'conv-1', role: 'ai' });
      expect(mockColl._chain.sort).toHaveBeenCalledWith({ timestamp: 1 });
    });
  });

  // ─── findFirstStudentMessage ────────────────────────

  describe('findFirstStudentMessage', () => {
    it('should return first student message', async () => {
      const msg = { _id: 'msg-1', role: 'student', content: 'First' };
      mockColl.findOne.mockResolvedValue(msg);

      const result = await model.findFirstStudentMessage('conv-1');
      expect(result).toEqual(msg);
      expect(mockColl.findOne).toHaveBeenCalledWith(
        { conversationId: 'conv-1', role: 'student' },
        { sort: { timestamp: 1 } },
      );
    });

    it('should return null when no student messages', async () => {
      mockColl.findOne.mockResolvedValue(null);
      const result = await model.findFirstStudentMessage('conv-1');
      expect(result).toBeNull();
    });
  });

  // ─── findFirstStudentMessagesForConversations ───────

  describe('findFirstStudentMessagesForConversations', () => {
    it('should return empty Map for empty input', async () => {
      const result = await model.findFirstStudentMessagesForConversations([]);
      expect(result).toEqual(new Map());
      expect(mockColl.aggregate).not.toHaveBeenCalled();
    });

    it('should build Map from aggregation results', async () => {
      const aggResults = [
        { _id: { toString: () => 'conv-1' }, firstMessage: { _id: 'msg-1', content: 'Hello' } },
        { _id: { toString: () => 'conv-2' }, firstMessage: { _id: 'msg-2', content: 'World' } },
      ];
      const aggToArray = jest.fn().mockResolvedValue(aggResults);
      mockColl.aggregate.mockReturnValue({ toArray: aggToArray });

      const result = await model.findFirstStudentMessagesForConversations(['conv-1', 'conv-2']);
      expect(result.size).toBe(2);
      expect(result.get('conv-1')).toEqual({ _id: 'msg-1', content: 'Hello' });
      expect(result.get('conv-2')).toEqual({ _id: 'msg-2', content: 'World' });
    });

    it('should pass correct aggregation pipeline', async () => {
      const aggToArray = jest.fn().mockResolvedValue([]);
      mockColl.aggregate.mockReturnValue({ toArray: aggToArray });

      await model.findFirstStudentMessagesForConversations(['conv-1']);

      const pipeline = mockColl.aggregate.mock.calls[0][0];
      expect(pipeline).toHaveLength(3);
      expect(pipeline[0].$match).toEqual({
        conversationId: { $in: ['conv-1'] },
        role: 'student',
      });
      expect(pipeline[1].$sort).toEqual({ conversationId: 1, timestamp: 1 });
      expect(pipeline[2].$group._id).toBe('$conversationId');
      expect(pipeline[2].$group.firstMessage).toEqual({ $first: '$$ROOT' });
    });
  });
});
