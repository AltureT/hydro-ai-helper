import { ExportService, ConversationExportFilters } from '../../services/exportService';

const mockConversations = [
  {
    _id: { toString: () => 'conv1' },
    userId: 1001,
    classId: 'class-A',
    problemId: 'P1000',
    startTime: new Date('2024-01-01T10:00:00Z'),
    endTime: new Date('2024-01-01T10:30:00Z'),
    messageCount: 5,
    isEffective: true,
    teacherNote: '学生表现良好',
    tags: ['算法', '循环'],
    metadata: { problemTitle: '两数之和' }
  },
  {
    _id: { toString: () => 'conv2' },
    userId: 1002,
    classId: 'class-B',
    problemId: 'P1001',
    startTime: new Date('2024-01-02T14:00:00Z'),
    endTime: new Date('2024-01-02T14:45:00Z'),
    messageCount: 8,
    isEffective: false,
    teacherNote: '',
    tags: [],
    metadata: {}
  }
];

describe('ExportService', () => {
  let service: ExportService;
  let mockCtx: any;
  let mockCursor: any;

  beforeEach(() => {
    mockCursor = {
      sort: jest.fn().mockReturnThis(),
      [Symbol.asyncIterator]: async function* () {
        for (const conv of mockConversations) {
          yield conv;
        }
      }
    };

    mockCtx = {
      db: {
        collection: jest.fn().mockReturnValue({
          find: jest.fn().mockReturnValue(mockCursor)
        })
      },
      get: jest.fn().mockReturnValue({
        findByFilters: jest.fn()
      })
    };

    service = new ExportService(mockCtx);
  });

  describe('exportConversations', () => {
    it('should export conversations to CSV format', async () => {
      const filters: ConversationExportFilters = {};
      const csv = await service.exportConversations(filters);

      expect(csv).toContain('conversationId');
      expect(csv).toContain('anonymousId');
      expect(csv).toContain('classId');
      expect(csv).toContain('problemId');
    });

    it('should include all required headers', async () => {
      const csv = await service.exportConversations({});
      const headers = csv.split('\n')[0];

      expect(headers).toContain('conversationId');
      expect(headers).toContain('classId');
      expect(headers).toContain('problemId');
      expect(headers).toContain('problemTitle');
      expect(headers).toContain('startTime');
      expect(headers).toContain('endTime');
      expect(headers).toContain('messageCount');
      expect(headers).toContain('isEffective');
    });

    it('should anonymize userId by default', async () => {
      const csv = await service.exportConversations({});
      const lines = csv.split('\n');
      const dataRows = lines.slice(1);

      expect(csv).toContain('user_001');
      expect(csv).toContain('user_002');
      // Check that userId column contains anonymized IDs, not real IDs
      dataRows.forEach(row => {
        const columns = row.split(',');
        if (columns.length > 1) {
          expect(columns[1]).toMatch(/^user_\d{3}$/);
        }
      });
    });

    it('should include real userId when includeSensitive is true', async () => {
      const csv = await service.exportConversations({}, { includeSensitive: true });

      expect(csv).toContain('1001');
      expect(csv).toContain('1002');
    });

    it('should apply domainId filter', async () => {
      await service.exportConversations({ domainId: 'test-domain' });

      const collection = mockCtx.db.collection();
      expect(collection.find).toHaveBeenCalledWith(
        expect.objectContaining({ domainId: 'test-domain' }),
        expect.anything()
      );
    });

    it('should apply date range filters', async () => {
      const startDate = new Date('2024-01-01');
      const endDate = new Date('2024-01-31');

      await service.exportConversations({ startDate, endDate });

      const collection = mockCtx.db.collection();
      expect(collection.find).toHaveBeenCalledWith(
        expect.objectContaining({
          startTime: {
            $gte: startDate,
            $lte: endDate
          }
        }),
        expect.anything()
      );
    });

    it('should escape CSV fields with special characters', async () => {
      const conversationWithSpecialChars = {
        ...mockConversations[0],
        teacherNote: '包含,逗号和"引号"的内容'
      };

      mockCursor[Symbol.asyncIterator] = async function* () {
        yield conversationWithSpecialChars;
      };

      const csv = await service.exportConversations({});
      expect(csv).toContain('"包含,逗号和""引号""的内容"');
    });

    it('should join tags with semicolon', async () => {
      const csv = await service.exportConversations({});
      expect(csv).toContain('算法;循环');
    });
  });
});
