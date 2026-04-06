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

    describe('includeMetrics option', () => {
      const metricsConversations = [
        {
          ...mockConversations[0],
          metrics: {
            v: 1,
            studentMessageCount: 3,
            studentTotalLength: 150,
            submissionsAfter: 2,
            firstAcceptedIndex: 1,
            problemDifficulty: 0.45,
            backfilledAt: new Date('2024-01-01T11:00:00Z'),
          },
        },
        {
          ...mockConversations[1],
          // no metrics — legacy conversation
        },
      ];

      beforeEach(() => {
        mockCursor[Symbol.asyncIterator] = async function* () {
          for (const conv of metricsConversations) yield conv;
        };
      });

      it('should not include metrics columns by default', async () => {
        const csv = await service.exportConversations({});
        const headers = csv.split('\n')[0];
        expect(headers).not.toContain('metrics_status');
        expect(headers).not.toContain('student_msg_count');
      });

      it('should include metrics columns when includeMetrics=true', async () => {
        const csv = await service.exportConversations({}, { includeMetrics: true });
        const headers = csv.split('\n')[0];
        expect(headers).toContain('metrics_status');
        expect(headers).toContain('student_msg_count');
        expect(headers).toContain('avg_msg_length');
        expect(headers).toContain('submissions_after');
        expect(headers).toContain('first_ac_index');
        expect(headers).toContain('problem_difficulty');
      });

      it('should output correct metrics values for complete conversation', async () => {
        const csv = await service.exportConversations({}, { includeMetrics: true });
        const lines = csv.split('\n');
        const firstDataRow = lines[1];
        // complete,3,50,2,1,0.45
        expect(firstDataRow).toContain('complete');
        expect(firstDataRow).toContain(',3,');
        expect(firstDataRow).toContain(',50,');  // 150/3 = 50
        expect(firstDataRow).toContain(',2,');
        expect(firstDataRow).toContain(',1,');
        expect(firstDataRow).toContain('0.45');
      });

      it('should output legacy status for conversation without metrics', async () => {
        const csv = await service.exportConversations({}, { includeMetrics: true });
        const lines = csv.split('\n');
        const secondDataRow = lines[2];
        expect(secondDataRow).toContain('legacy');
      });

      it('should output firstAcceptedIndex=0 as "0" not empty (0-based trap)', async () => {
        const zeroAcConv = [{
          ...mockConversations[0],
          metrics: {
            v: 1,
            studentMessageCount: 2,
            studentTotalLength: 80,
            submissionsAfter: 1,
            firstAcceptedIndex: 0,  // first-try AC
            problemDifficulty: null,
            backfilledAt: new Date(),
          },
        }];
        mockCursor[Symbol.asyncIterator] = async function* () {
          for (const c of zeroAcConv) yield c;
        };

        const csv = await service.exportConversations({}, { includeMetrics: true });
        const dataRow = csv.split('\n')[1];
        // Should contain ",0," for firstAcceptedIndex, not ",,"
        const cols = dataRow.split(',');
        const acIdxCol = cols[cols.length - 2]; // second to last column
        expect(acIdxCol).toBe('0');
      });
    });
  });
});
