jest.mock('../../lib/crypto', () => ({ decrypt: jest.fn((value: string) => value) }));

import { GoJudgeSandboxRunner } from '../../services/goJudgeSandboxService';
import { parseGeneratorOutput, assemblePlan } from '../../services/testdataGenService';
import { evaluateSemanticCoverage } from '../../services/testdata/coverage';
import { buildTestdataApplyFiles, buildTestdataApplyRequest } from '../../../frontend/testdataGen/applyFiles';
import { materializeGeneratorPlan, renderGeneratorArtifacts } from '../../services/testdata/generatorDsl';
import { assertTestdataPlanBudget } from '../../services/testdata/fileBudget';
import { inflateSync } from 'zlib';
import type { ProblemSpecV1 } from '../../services/testdata/problemSpec';

const largeInput = '200000\n' + Array.from({ length: 200000 }, (_, i) => i - 100000).join(' ') + '\n';

describe('large testdata transport', () => {
  it('preserves all 200000 values beyond both old transport limits', () => {
    const payload = JSON.stringify({ cases: [{ input: largeInput }] });
    expect(Buffer.byteLength(payload)).toBeGreaterThan(1024 * 1024);
    expect(parseGeneratorOutput(payload, 1)[0].input).toBe(largeInput);
  });

  it('rejects normalized inputs above the new finite per-input limit', () => {
    expect(() => parseGeneratorOutput(JSON.stringify({ cases: [{ input: 'x'.repeat(4 * 1024 * 1024) }] }), 1))
      .toThrow(expect.objectContaining({ code: 'GENERATOR_OUTPUT_TOO_LARGE' }));
  });

  it('retains the small-input and 1 MiB limits for stress generation', () => {
    expect(() => parseGeneratorOutput(JSON.stringify({ cases: [{ input: largeInput }] }), 1, true)).toThrow();
    expect(() => parseGeneratorOutput(JSON.stringify({ cases: [{ input: 'x'.repeat(270000) }] }), 1, true)).toThrow();
  });

  it('materializes a full-size random array and replays every byte using a small script plus bounded data', () => {
    const spec: ProblemSpecV1 = {
      schemaVersion: 1, statementHash: '1'.repeat(64), problemKind: 'traditional',
      testCaseMode: { kind: 'single' }, constraints: [], invariants: [],
      outputPolicy: { kind: 'exact' }, subtasks: [], uncertainties: [],
      inputFields: [
        { id: 'n', name: 'n', type: 'integer', encoding: 'line:1 token:1' },
        { id: 'a', name: 'a', type: 'array', encoding: 'line:2 tokens:1..n', dependsOn: ['n'] },
      ],
    };
    const plan = { version: 1 as const, seed: 17, cases: [{ label: 'full-size', fields: {
      n: { kind: 'integer' as const, value: 'derived' },
      a: { kind: 'array' as const, length: 200000, min: -1000000000, max: 1000000000, pattern: 'random' as const },
    } }] };
    const cases = materializeGeneratorPlan(plan, spec);
    expect(cases[0].input.split('\n')[1].split(' ')).toHaveLength(200000);
    expect(cases[0].input.startsWith('200000\n')).toBe(true);
    const replay = renderGeneratorArtifacts(plan, cases);
    expect(Buffer.byteLength(replay.code)).toBeLessThan(256 * 1024);
    expect(replay.data).toBeDefined();
    expect(evaluateSemanticCoverage({ spec, cases, coverageMode: 'trusted-dsl' }).mode).toBe('trusted-dsl');
    const assembled = assemblePlan({
      problemType: 'traditional', generatorPlan: plan, generatorCode: replay.code,
      generatorReplayData: replay.data, cases: cases.map(item => ({ ...item, output: '1\n' })),
    }, { problemKind: 'traditional', caseCount: 1, languages: [] }, { mode: 'sandbox' });
    expect(assembled.files.find(file => file.name === 'generator-data.b64')?.content).toBe(replay.data);
    expect(JSON.parse(inflateSync(Buffer.from(replay.data!, 'base64')).toString('utf8')))
      .toEqual({ cases: cases.map(({ label, input }) => ({ label, input })) });
    expect(() => assertTestdataPlanBudget({ files: [
      { name: '1.in', content: cases[0].input }, { name: 'generator.py', content: replay.code },
      { name: 'generator-data.b64', content: replay.data! },
    ] })).not.toThrow();
  });

  it('keeps code/output limits and counts the entire normalized plan', () => {
    expect(() => assertTestdataPlanBudget({ files: [{ name: 'std.py', content: largeInput }] })).toThrow();
    expect(() => assertTestdataPlanBudget({ files: [{ name: '1.out', content: largeInput }] })).toThrow();
    expect(() => assertTestdataPlanBudget({ files: Array.from({ length: 3 }, (_, i) => ({
      name: `${i}.in`, content: 'x'.repeat(3 * 1024 * 1024),
    })) })).toThrow();
  });

  it('references unchanged job files but sends edits and legacy content verbatim', () => {
    const files = [{ name: '1.in', content: largeInput }, { name: '1.out', content: '1\n' }];
    const selected = { '1.in': true, '1.out': true };
    expect(buildTestdataApplyFiles(files, selected, { '1.out': '2\n' }, 'job-id'))
      .toEqual([{ name: '1.in', fromJob: true }, { name: '1.out', content: '2\n' }]);
    expect(buildTestdataApplyFiles(files, selected, {}, null)).toEqual(files);
    expect(buildTestdataApplyFiles(files, { '1.out': true }, {}, 'job-id'))
      .toEqual([{ name: '1.out', fromJob: true }]);
  });

  it('transports large edited inputs as raw multipart files without JSON expansion', async () => {
    const content = '0\n'.repeat(2000000);
    const request = buildTestdataApplyRequest({ problemId: 'fixture', jobId: 'job-id', files: [
      { name: '1.in', content }, { name: '2.in', content }, { name: '1.out', fromJob: true },
      { name: '2.out', content: '' },
    ] });
    expect(request.headers).toEqual({});
    expect(request.body).toBeInstanceOf(FormData);
    const form = request.body as FormData;
    expect(JSON.parse(form.get('payload') as string).files).toEqual([
      { name: '1.in', uploadField: 'file-0' }, { name: '2.in', uploadField: 'file-1' },
      { name: '1.out', fromJob: true },
      { name: '2.out', content: '' },
    ]);
    expect(await (form.get('file-0') as Blob).text()).toBe(content);
    expect((form.get('file-1') as Blob).size).toBe(4000000);
  });

  function mockHttp() {
    return {
      post: jest.fn().mockResolvedValue({ data: [{ status: 'Accepted', exitStatus: 0,
        files: { stderr: '' }, fileIds: { stdout: 'fixture-file' } }] }),
      get: jest.fn().mockResolvedValue({ data: JSON.stringify({ cases: [{ input: largeInput }] }) }),
      delete: jest.fn().mockResolvedValue({ data: '' }),
    };
  }

  it('downloads generator stdout as a bounded cached file and always releases it', async () => {
    const http = mockHttp();
    const runner = new GoJudgeSandboxRunner('http://localhost:5050', http);
    const result = await runner.runPythonGenerator('print(1)');
    expect(parseGeneratorOutput(result.stdout, 1)[0].input).toBe(largeInput);
    expect(http.post.mock.calls[0][1].cmd[0]).toMatchObject({
      copyOut: ['stderr'], copyOutCached: ['stdout'], copyOutMax: 8 * 1024 * 1024,
      copyOutTruncate: false,
    });
    expect(http.get).toHaveBeenCalledWith('http://localhost:5050/file/fixture-file', expect.objectContaining({
      responseType: 'text', maxContentLength: 8 * 1024 * 1024, proxy: false,
    }));
    expect(http.delete).toHaveBeenCalledTimes(1);
  });

  it.each(['download', 'overflow', 'execution', 'malformed'])('releases cached data on %s failure', async failure => {
    const http = mockHttp();
    if (failure === 'download') http.get.mockRejectedValue(new Error('network error'));
    if (failure === 'overflow') http.get.mockResolvedValue({ data: 'x'.repeat(8 * 1024 * 1024 + 1) });
    if (failure === 'execution') http.post.mockResolvedValue({ data: [{ status: 'Output Limit Exceeded',
      exitStatus: 0, fileIds: { stdout: 'fixture-file' } }] });
    if (failure === 'malformed') http.post.mockResolvedValue({ data: [{ status: 'Accepted', exitStatus: 0,
      fileIds: { unexpected: 'fixture-file' } }] });
    await expect(new GoJudgeSandboxRunner('http://localhost:5050', http).runPythonGenerator('print(1)')).rejects.toThrow();
    expect(http.delete).toHaveBeenCalledTimes(1);
    if (failure === 'execution' || failure === 'malformed') expect(http.get).not.toHaveBeenCalled();
  });

  it('preserves cancellation and releases returned cache without downloading', async () => {
    const controller = new AbortController();
    const http = mockHttp();
    const cancelled = Object.assign(new Error('canceled'), { name: 'AbortError' });
    http.post.mockImplementation(async () => {
      controller.abort(cancelled);
      return { data: [{ status: 'Accepted', exitStatus: 0, fileIds: { stdout: 'fixture-file' } }] };
    });
    await expect(new GoJudgeSandboxRunner('http://localhost:5050', http)
      .runPythonGenerator('print(1)', controller.signal)).rejects.toBe(cancelled);
    expect(http.get).not.toHaveBeenCalled();
    expect(http.delete).toHaveBeenCalledTimes(1);
  });

  it('checks the shared deadline again before downloading and still cleans up', async () => {
    const http = mockHttp();
    const now = jest.spyOn(Date, 'now').mockReturnValue(100);
    http.post.mockImplementation(async () => {
      now.mockReturnValue(1000);
      return { data: [{ status: 'Accepted', exitStatus: 0, fileIds: { stdout: 'fixture-file' } }] };
    });
    try {
      await expect(new GoJudgeSandboxRunner('http://localhost:5050', http)
        .runPythonGenerator('print(1)', undefined, 900)).rejects.toMatchObject({ code: 'SANDBOX_BUDGET_EXHAUSTED' });
      expect(http.get).not.toHaveBeenCalled();
      expect(http.delete).toHaveBeenCalledTimes(1);
    } finally { now.mockRestore(); }
  });
});
