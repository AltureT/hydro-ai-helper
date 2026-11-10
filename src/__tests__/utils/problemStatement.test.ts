import { ProblemModel } from 'hydrooj';
import { resolveProblemContent, resolveProblemContents } from '../../utils/problemStatement';

type MockedProblemModel = typeof ProblemModel & { getStatements?: jest.Mock };
const model = ProblemModel as MockedProblemModel;

describe('problemStatement', () => {
  afterEach(() => {
    delete model.getStatements;
    jest.restoreAllMocks();
  });

  describe('Hydro 4 (no ProblemModel.getStatements)', () => {
    it('returns stored content unchanged', async () => {
      await expect(resolveProblemContent({ docId: 1, content: '# A+B' }, 'system')).resolves.toBe('# A+B');
    });

    it('returns empty string when content is missing', async () => {
      await expect(resolveProblemContent({ docId: 1 }, 'system')).resolves.toBe('');
    });
  });

  describe('Hydro 5 (problem.statement)', () => {
    it('keeps legacy content without querying statements', async () => {
      model.getStatements = jest.fn();
      await expect(resolveProblemContent({ docId: 1, content: '{"zh":"题面"}' }, 'd1')).resolves.toBe('{"zh":"题面"}');
      expect(model.getStatements).not.toHaveBeenCalled();
    });

    it('returns the single inline statement and fills in domainId', async () => {
      model.getStatements = jest.fn().mockResolvedValue([{ name: 'zh.md', lang: 'zh', content: '求两数之和' }]);
      await expect(resolveProblemContent({ docId: 7, content: '' }, 'd1')).resolves.toBe('求两数之和');
      expect(model.getStatements).toHaveBeenCalledWith(expect.objectContaining({ domainId: 'd1', docId: 7 }));
    });

    it('builds legacy {lang: content} JSON for multiple languages and skips file-only entries', async () => {
      model.getStatements = jest.fn().mockResolvedValue([
        { name: 'zh.md', lang: 'zh', content: '中文题面' },
        { name: 'zh.pdf', lang: 'zh', file: 'statement.pdf' },
        { name: 'en.md', lang: 'en', content: 'English statement' },
      ]);
      const content = await resolveProblemContent({ docId: 7, content: '' }, 'd1');
      expect(JSON.parse(content as string)).toEqual({ zh: '中文题面', en: 'English statement' });
    });

    it('falls back to empty content when only file statements exist', async () => {
      model.getStatements = jest.fn().mockResolvedValue([{ name: 'zh.pdf', lang: 'zh', file: 'statement.pdf' }]);
      await expect(resolveProblemContent({ docId: 7, content: '' }, 'd1')).resolves.toBe('');
    });

    it('does not throw when statement lookup fails', async () => {
      jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      model.getStatements = jest.fn().mockRejectedValue(new Error('reference missing'));
      await expect(resolveProblemContent({ docId: 7, content: '' }, 'd1')).resolves.toBe('');
    });

    it('fills content in place for batch-loaded documents', async () => {
      model.getStatements = jest.fn().mockResolvedValue([{ name: 'zh.md', lang: 'zh', content: '新题面' }]);
      const docs = [
        { docId: 1, title: 'A', content: '旧题面' },
        { docId: 2, title: 'B', content: '' },
      ];
      const result = await resolveProblemContents(docs, 'd1');
      expect(result).toBe(docs);
      expect(docs.map(d => d.content)).toEqual(['旧题面', '新题面']);
      expect(model.getStatements).toHaveBeenCalledTimes(1);
    });
  });
});
