import { GoJudgeSandboxRunner } from '../../services/goJudgeSandboxService';

const limit = 4 * 1024 * 1024;

function setup() {
  const http = {
    post: jest.fn().mockResolvedValue({ data: [{ status: 'Accepted', exitStatus: 0,
      files: { stderr: '' }, fileIds: { stdout: 'answer-cache' } }] }),
    get: jest.fn().mockResolvedValue({ data: '界'.repeat(400000) + '\n' }),
    delete: jest.fn().mockResolvedValue({ data: {} }),
  };
  return { http, runner: new GoJudgeSandboxRunner('http://sandbox:5050', http) };
}

describe('bounded answer transport', () => {
  it.each(['python', 'cpp', 'java'])('preserves complete %s answers above 1 MiB via cached files', async language => {
    const { http, runner } = setup();
    const method = language === 'python' ? 'runPythonBatchDetailed'
      : language === 'cpp' ? 'runCompiledBatchDetailed' : 'runJavaBatchDetailed';
    const result = await runner[method]('SOURCE_OR_CACHE', ['input'], { outputLimitBytes: limit });
    expect(result[0].stdout).toBe('界'.repeat(400000) + '\n');
    expect(result[0].accepted).toBe(true);
    expect(http.post.mock.calls[0][1].cmd[0]).toMatchObject({
      copyOut: ['stderr'], copyOutCached: ['stdout'], copyOutMax: limit, copyOutTruncate: false,
    });
    expect(http.get).toHaveBeenCalledWith('http://sandbox:5050/file/answer-cache', expect.objectContaining({ maxContentLength: limit }));
    expect(http.delete).toHaveBeenCalledWith('http://sandbox:5050/file/answer-cache', expect.any(Object));
  });

  it('rejects measured UTF-8 overflow and deletes every returned cache', async () => {
    const { http, runner } = setup();
    http.get.mockResolvedValue({ data: '界'.repeat(1400000) });
    await expect(runner.runPythonBatchDetailed('SOURCE', ['input'], { outputLimitBytes: limit }))
      .rejects.toMatchObject({ code: 'SANDBOX_OUTPUT_BUDGET_EXCEEDED', maxBytes: limit });
    expect(http.delete).toHaveBeenCalledTimes(1);
  });

  it('bounds the sum of downloaded answers before retaining an oversized batch', async () => {
    const { http, runner } = setup();
    http.post.mockResolvedValue({ data: Array.from({ length: 3 }, (_, i) => ({ status: 'Accepted', exitStatus: 0,
      files: { stderr: '' }, fileIds: { stdout: `answer-${i}` } })) });
    http.get.mockResolvedValue({ data: 'x'.repeat(3 * 1024 * 1024) });
    await expect(runner.runPythonBatchDetailed('SOURCE', ['a', 'b', 'c'], { outputLimitBytes: limit }))
      .rejects.toMatchObject({ code: 'SANDBOX_OUTPUT_BUDGET_EXCEEDED', maxBytes: 8 * 1024 * 1024 });
    expect(http.delete).toHaveBeenCalledTimes(3);
  });

  it('cleans up malformed responses and preserves ordinary execution limits', async () => {
    const { http, runner } = setup();
    http.post.mockResolvedValue({ data: [{ status: 'Accepted', exitStatus: 0, files: { stderr: '' }, fileIds: {} }] });
    await expect(runner.runPythonBatchDetailed('SOURCE', ['input'], { outputLimitBytes: limit })).rejects.toThrow();
    http.post.mockResolvedValue({ data: [{ status: 'Accepted', exitStatus: 0, files: { stdout: '1\n', stderr: '' } }] });
    expect((await runner.runPythonBatchDetailed('SOURCE', ['input']))[0].stdout).toBe('1\n');
    expect(http.post.mock.calls[1][1].cmd[0].copyOutMax).toBe(1024 * 1024);
  });

  it('rejects invalid UTF-8 instead of silently replacing bytes', async () => {
    const { http, runner } = setup();
    http.get.mockResolvedValue({ data: Buffer.from([0xff]) });
    await expect(runner.runPythonBatchDetailed('SOURCE', ['input'], { outputLimitBytes: limit })).rejects.toThrow();
    expect(http.delete).toHaveBeenCalledTimes(1);
  });

  it('preserves a UTF-8 BOM as part of the actual answer bytes', async () => {
    const { http, runner } = setup();
    http.get.mockResolvedValue({ data: Buffer.from('\uFEFFanswer\n') });
    const result = await runner.runPythonBatchDetailed('SOURCE', ['input'], { outputLimitBytes: limit });
    expect(result[0].stdout).toBe('\uFEFFanswer\n');
  });

  it('preserves caller cancellation when Axios wraps its reason', async () => {
    const { http, runner } = setup();
    const controller = new AbortController(), reason = new Error('caller reason');
    http.get.mockImplementation(async () => { controller.abort(reason); throw Object.assign(new Error('wrapped'), { name: 'CanceledError' }); });
    await expect(runner.runPythonBatchDetailed('SOURCE', ['input'], { outputLimitBytes: limit, signal: controller.signal })).rejects.toBe(reason);
    expect(http.delete).toHaveBeenCalledTimes(1);
  });

  it('classifies a download timeout at the shared deadline as budget exhaustion', async () => {
    const { http, runner } = setup();
    const now = jest.spyOn(Date, 'now').mockReturnValue(100);
    http.get.mockImplementation(async () => { now.mockReturnValue(201); throw new Error('download timeout'); });
    try {
      await expect(runner.runPythonBatchDetailed('SOURCE', ['input'], { outputLimitBytes: limit, deadlineAt: 200 }))
        .rejects.toMatchObject({ code: 'SANDBOX_BUDGET_EXHAUSTED' });
      expect(http.delete).toHaveBeenCalledTimes(1);
    } finally { now.mockRestore(); }
  });

  it('classifies transport-enforced overflow without inventing an exact byte count', async () => {
    const { http, runner } = setup();
    http.get.mockRejectedValue(new Error(`maxContentLength size of ${limit} exceeded`));
    await expect(runner.runPythonBatchDetailed('SOURCE', ['input'], { outputLimitBytes: limit }))
      .rejects.toMatchObject({ code: 'SANDBOX_OUTPUT_BUDGET_EXCEEDED', maxBytes: limit, actualBytes: undefined });
    expect(http.delete).toHaveBeenCalledTimes(1);
  });

  it('never downloads partial answers left by an output-limited execution', async () => {
    const { http, runner } = setup();
    http.post.mockResolvedValue({ data: [{ status: 'Output Limit Exceeded', exitStatus: 0,
      files: { stderr: '' }, fileIds: { stdout: 'oversized-partial' },
      fileError: [{ name: 'stdout', type: 'CollectSizeExceeded' }] }] });
    const result = await runner.runPythonBatchDetailed('SOURCE', ['input'], { outputLimitBytes: limit });
    expect(result[0]).toMatchObject({ accepted: false, status: 'Output Limit Exceeded', stdout: '' });
    expect(http.get).not.toHaveBeenCalled();
    expect(http.delete).toHaveBeenCalledTimes(1);
  });

  it('cleans all known cached answers when download is canceled', async () => {
    const { http, runner } = setup();
    const controller = new AbortController();
    const error = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    http.post.mockResolvedValue({ data: ['a', 'b'].map(name => ({ status: 'Accepted', exitStatus: 0,
      files: { stderr: '' }, fileIds: { stdout: name } })) });
    http.get.mockImplementation(async () => { controller.abort(error); throw error; });
    await expect(runner.runPythonBatchDetailed('SOURCE', ['a', 'b'], { outputLimitBytes: limit, signal: controller.signal })).rejects.toBe(error);
    expect(http.delete).toHaveBeenCalledTimes(2);
  });
});
