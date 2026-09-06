jest.mock('../../lib/crypto', () => ({ decrypt: jest.fn((value: string) => value) }));
import { assertPythonTemplateInterface, parsePythonTemplateInterfaceReport } from '../../services/testdata/templateInterface';
import { materializeSandboxBlueprint, TestdataGenService } from '../../services/testdataGenService';
import type { TestdataSandboxRunner } from '../../services/goJudgeSandboxService';
import { SandboxBudgetExceededError } from '../../services/goJudgeSandboxService';

describe('Python template interface preflight', () => {
  it('reports a specific template repair without exposing source code', () => {
    expect(() => assertPythonTemplateInterface({ kind: 'conflict', names: ['lengthOfLIS'] })).toThrow(expect.objectContaining({
      code: 'TEMPLATE_COMPILE_FAILED', artifact: 'template-py', safeDetails: { failureKind: 'interface' },
      message: expect.stringContaining('lengthOfLIS'),
    }));
    expect(() => assertPythonTemplateInterface({ kind: 'syntax', section: 'solution' }))
      .toThrow(expect.objectContaining({ artifact: 'oracle' }));
  });

  it.each(['null', '{"kind":"ok","ignored":true}', '{"kind":"conflict","names":[]}', '{"kind":"unknown"}'])
  ('does not accept malformed inspection results: %s', raw => {
    expect(() => parsePythonTemplateInterfaceReport(raw)).toThrow();
  });

  it('rejects restored template conflicts before running a formal generator', async () => {
    const runner = { inspectPythonTemplate: jest.fn().mockResolvedValue({ kind: 'conflict', names: ['solve'] }),
      runPythonGenerator: jest.fn(), runPython: jest.fn() } as unknown as TestdataSandboxRunner;
    await expect(materializeSandboxBlueprint({
      problemType: 'function', oracleCode: 'print(1)', solutionCode: 'def solve(): return 1',
      generatorCode: 'GENERATOR', templates: { py: 'def solve(): pass' },
    }, { problemKind: 'function', caseCount: 1, languages: ['py'] }, '', runner))
      .rejects.toMatchObject({ artifact: 'template-py', safeDetails: { failureKind: 'interface' } });
    expect(runner.runPythonGenerator).not.toHaveBeenCalled();
    expect(runner.runPython).not.toHaveBeenCalled();
  });

  it('repairs template conflicts in the existing artifact-validation round', async () => {
    const client = { chat: jest.fn().mockResolvedValue({ content: '@@@GENERATOR@@@\nprint(1)\n@@@TEMPLATE:py@@@\nprint(solve())',
      usedModel: { endpointId: 'fixture', endpointName: 'fixture', modelName: 'fixture' } }) };
    const service = Object.create(TestdataGenService.prototype) as any;
    service.clientForRole = () => client;
    service.sandboxRunner = { inspectPythonTemplate: jest.fn()
      .mockResolvedValueOnce({ kind: 'conflict', names: ['solve'] })
      .mockResolvedValueOnce({ kind: 'ok' }) };
    const state = await service.generateGenerationArtifacts({
      options: { problemKind: 'function', caseCount: 1, languages: ['py'] },
      statementMarkdown: 'Return a value', problemTitle: 'Fixture',
    }, { problemType: 'function', oracleCode: 'print(1)', solutionCode: 'def solve(): return 1' }, [], {}, []);
    expect(state.artifacts.templates.py).toBe('print(solve())\n');
    expect(client.chat).toHaveBeenCalledTimes(2);
    expect(client.chat.mock.calls[1][0][2].content).toContain('solve');
    expect(client.chat.mock.calls[1][0][2].content).toContain('不得改写 SOLUTION');
  });

  it.each(['budget', 'solution'] as const)('does not send %s preflight failures to an artifact repair', async kind => {
    const client = { chat: jest.fn().mockResolvedValue({ content: '@@@GENERATOR@@@\nprint(1)\n@@@TEMPLATE:py@@@\nprint(solve())',
      usedModel: { endpointId: 'fixture', endpointName: 'fixture', modelName: 'fixture' } }) };
    const service = Object.create(TestdataGenService.prototype) as any;
    service.clientForRole = () => client;
    service.sandboxRunner = { inspectPythonTemplate: kind === 'budget'
      ? jest.fn().mockRejectedValue(new SandboxBudgetExceededError())
      : jest.fn().mockResolvedValue({ kind: 'syntax', section: 'solution' }) };
    await expect(service.generateGenerationArtifacts({
      options: { problemKind: 'function', caseCount: 1, languages: ['py'] }, statementMarkdown: 'Return a value', problemTitle: 'Fixture',
    }, { problemType: 'function', oracleCode: 'print(1)', solutionCode: 'def solve(): return 1' }, [], {}, []))
      .rejects.toMatchObject(kind === 'budget'
        ? { code: 'PIPELINE_BUDGET_EXHAUSTED', retryPolicy: 'no-retry', recommendDeeperReasoning: false }
        : { artifact: 'oracle', failedModelRole: 'oracle' });
    expect(client.chat).toHaveBeenCalledTimes(1);
  });
});
