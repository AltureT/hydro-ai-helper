/**
 * TestdataGenService 单元测试
 */

import {
  validateGenerateOptions,
  isSafeTestdataFilename,
  buildCompileSh,
  buildConfigYaml,
  extractJsonObject,
  normalizeFileContent,
  parseGenerationResponse,
  assemblePlan,
  buildTestdataSystemPrompt,
  buildTestdataUserPrompt,
  detectStdFilename,
  TestdataGenService,
  GenerateOptions,
  TESTDATA_GEN_LIMITS,
} from '../../services/testdataGenService';

const baseOptions: GenerateOptions = {
  problemKind: 'auto',
  caseCount: 3,
  languages: ['py', 'java', 'cc'],
};

// ─── validateGenerateOptions ──────────────────────────────────────────────────

describe('validateGenerateOptions', () => {
  it('接受合法选项', () => {
    expect(validateGenerateOptions(baseOptions)).toBeNull();
    expect(validateGenerateOptions({ ...baseOptions, problemKind: 'function', languages: ['py'] })).toBeNull();
    expect(validateGenerateOptions({ ...baseOptions, problemKind: 'traditional', languages: [] })).toBeNull();
  });

  it('拒绝非法题型', () => {
    expect(validateGenerateOptions({ ...baseOptions, problemKind: 'weird' as GenerateOptions['problemKind'] }))
      .toBe('ai_helper_testdata_err_invalid_kind');
  });

  it('拒绝越界的测试点数量', () => {
    expect(validateGenerateOptions({ ...baseOptions, caseCount: 0 })).toBe('ai_helper_testdata_err_invalid_case_count');
    expect(validateGenerateOptions({ ...baseOptions, caseCount: TESTDATA_GEN_LIMITS.MAX_CASES + 1 }))
      .toBe('ai_helper_testdata_err_invalid_case_count');
    expect(validateGenerateOptions({ ...baseOptions, caseCount: 2.5 })).toBe('ai_helper_testdata_err_invalid_case_count');
  });

  it('拒绝非法语言', () => {
    expect(validateGenerateOptions({ ...baseOptions, languages: ['rust'] as unknown as GenerateOptions['languages'] }))
      .toBe('ai_helper_testdata_err_invalid_languages');
  });

  it('函数题必须至少选择一种语言', () => {
    expect(validateGenerateOptions({ ...baseOptions, problemKind: 'function', languages: [] }))
      .toBe('ai_helper_testdata_err_no_languages');
  });

  it('auto 模式同样要求至少一种语言（AI 可能判定为函数题）', () => {
    expect(validateGenerateOptions({ ...baseOptions, problemKind: 'auto', languages: [] }))
      .toBe('ai_helper_testdata_err_no_languages');
  });

  it('拒绝过长的补充要求', () => {
    expect(validateGenerateOptions({
      ...baseOptions,
      extraRequirements: 'x'.repeat(TESTDATA_GEN_LIMITS.MAX_EXTRA_REQUIREMENTS + 1),
    })).toBe('ai_helper_testdata_err_extra_too_long');
  });

  it('接受合法的填空/规模/标准答案选项', () => {
    expect(validateGenerateOptions({
      ...baseOptions, fillInMode: 'yes', dataScale: 'large', providedStd: 'print(1)',
    })).toBeNull();
  });

  it('拒绝非法填空模式与数据规模', () => {
    expect(validateGenerateOptions({ ...baseOptions, fillInMode: 'maybe' as GenerateOptions['fillInMode'] }))
      .toBe('ai_helper_testdata_err_invalid_fill_in');
    expect(validateGenerateOptions({ ...baseOptions, dataScale: 'huge' as GenerateOptions['dataScale'] }))
      .toBe('ai_helper_testdata_err_invalid_scale');
  });

  it('拒绝过长的标准答案', () => {
    expect(validateGenerateOptions({
      ...baseOptions, providedStd: 'x'.repeat(TESTDATA_GEN_LIMITS.MAX_PROVIDED_STD + 1),
    })).toBe('ai_helper_testdata_err_std_too_long');
  });
});

// ─── detectStdFilename ────────────────────────────────────────────────────────

describe('detectStdFilename', () => {
  it('按代码特征选择扩展名', () => {
    expect(detectStdFilename('#include <bits/stdc++.h>\nint main(){}')).toBe('std.cc');
    expect(detectStdFilename('public class Main { }')).toBe('std.java');
    expect(detectStdFilename('import java.util.*;\nclass X { void f(){ System.out.println(1); } }')).toBe('std.java');
    expect(detectStdFilename('def solve():\n    pass')).toBe('std.py');
  });
});

// ─── isSafeTestdataFilename ───────────────────────────────────────────────────

describe('isSafeTestdataFilename', () => {
  it('接受常见测试数据文件名', () => {
    for (const name of ['1.in', '1.out', '12.in', 'config.yaml', 'compile.sh', 'template.py', 'template.cc', 'std.py', 'a_b-c.txt']) {
      expect(isSafeTestdataFilename(name)).toBe(true);
    }
  });

  it('拒绝路径穿越与非法字符', () => {
    for (const name of ['../etc/passwd', 'a/b.in', 'a\\b.in', '.hidden', '', ' ', 'a b.in', 'x'.repeat(70), '中文.in']) {
      expect(isSafeTestdataFilename(name)).toBe(false);
    }
  });
});

// ─── buildCompileSh ───────────────────────────────────────────────────────────

describe('buildCompileSh', () => {
  it('包含所选语言的分支并以 if/elif 链拼接', () => {
    const sh = buildCompileSh(['py', 'java', 'cc']);
    expect(sh).toContain('#!/bin/bash');
    expect(sh).toContain('set -e');
    expect(sh).toContain('if [[ "$HYDRO_LANG" == py* ]]; then');
    expect(sh).toContain('elif [[ "$HYDRO_LANG" == java* ]]; then');
    expect(sh).toContain('elif [[ "$HYDRO_LANG" == cc* ]]; then');
    expect(sh).toContain('cat template.py >>foo.py');
    expect(sh).toContain('mv Main.java Solution.java');
    expect(sh).toContain('g++ -x c++ template.cc -o foo');
    expect(sh.trim().endsWith('fi')).toBe(true);
  });

  it('仅生成所选语言的分支', () => {
    const sh = buildCompileSh(['py']);
    expect(sh).toContain('if [[ "$HYDRO_LANG" == py* ]]; then');
    expect(sh).not.toContain('java');
    expect(sh).not.toContain('g++');
  });

  it('单语言时不产生 elif', () => {
    const sh = buildCompileSh(['cc']);
    expect(sh).toContain('if [[ "$HYDRO_LANG" == cc* ]]; then');
    expect(sh).not.toContain('elif');
  });

  it('空语言列表抛错（防御：避免产出损坏的脚本）', () => {
    expect(() => buildCompileSh([])).toThrow();
  });
});

// ─── buildConfigYaml ──────────────────────────────────────────────────────────

describe('buildConfigYaml', () => {
  it('函数题包含 user_extra_files、subtasks 与 langs', () => {
    const yamlText = buildConfigYaml({ problemType: 'function', caseCount: 2, languages: ['py', 'java', 'cc'] });
    expect(yamlText).toContain('type: default');
    expect(yamlText).toContain('user_extra_files:');
    expect(yamlText).toContain('- template.py');
    expect(yamlText).toContain('- template.java');
    expect(yamlText).toContain('- template.cc');
    expect(yamlText).toContain('- compile.sh');
    expect(yamlText).toContain('input: 1.in');
    expect(yamlText).toContain('output: 2.out');
    expect(yamlText).toContain('langs:');
    expect(yamlText).toContain('- py.py3');
    expect(yamlText).toContain('- cc.cc14o2');
    expect(yamlText).toContain('score: 100');
    expect(yamlText).toContain('type: sum');
  });

  it('传统题不包含 user_extra_files 与 langs', () => {
    const yamlText = buildConfigYaml({ problemType: 'traditional', caseCount: 1, languages: [] });
    expect(yamlText).toContain('type: default');
    expect(yamlText).not.toContain('user_extra_files');
    expect(yamlText).not.toContain('langs');
    expect(yamlText).toContain('input: 1.in');
  });

  it('语言子集只生成对应条目', () => {
    const yamlText = buildConfigYaml({ problemType: 'function', caseCount: 1, languages: ['py'] });
    expect(yamlText).toContain('- template.py');
    expect(yamlText).not.toContain('template.java');
    expect(yamlText).not.toContain('- java');
  });
});

// ─── extractJsonObject / normalizeFileContent ────────────────────────────────

describe('extractJsonObject', () => {
  it('提取纯 JSON', () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it('剥离代码围栏', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('剥离 think 标签与前后说明文字', () => {
    expect(extractJsonObject('<think>(thinking...)</think>好的，如下：{"a":{"b":2}} 以上。')).toBe('{"a":{"b":2}}');
  });

  it('无 JSON 时抛错', () => {
    expect(() => extractJsonObject('没有对象')).toThrow();
  });
});

describe('normalizeFileContent', () => {
  it('统一 CRLF 并补齐末尾换行', () => {
    expect(normalizeFileContent('a\r\nb')).toBe('a\nb\n');
    expect(normalizeFileContent('a\n')).toBe('a\n');
    expect(normalizeFileContent('')).toBe('\n');
  });
});

// ─── parseGenerationResponse ──────────────────────────────────────────────────

function makeAiJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    problemType: 'function',
    analysis: '测试分析',
    functionName: 'solve',
    templates: {
      py: 'print(solve(input()))',
      java: 'public class Main {}',
      cc: '#include "foo.cc"',
    },
    stdSolution: { language: 'python', code: 'def solve(x):\n    return x' },
    cases: [
      { label: '样例1', input: '1 2\n', output: '3\n' },
      { label: '边界', input: '0\n', output: '0\n' },
    ],
    notes: '注意事项',
    ...overrides,
  });
}

describe('parseGenerationResponse', () => {
  const fnOptions: GenerateOptions = { problemKind: 'function', caseCount: 2, languages: ['py', 'java', 'cc'] };

  it('解析合法函数题响应', () => {
    const res = parseGenerationResponse(makeAiJson(), fnOptions);
    expect(res.problemType).toBe('function');
    expect(res.cases).toHaveLength(2);
    expect(res.templates?.py).toContain('print');
    expect(res.stdSolution?.code).toContain('def solve');
    expect(res.cases[0].input.endsWith('\n')).toBe(true);
  });

  it('容忍代码围栏包装', () => {
    const res = parseGenerationResponse('```json\n' + makeAiJson() + '\n```', fnOptions);
    expect(res.cases).toHaveLength(2);
  });

  it('非法 JSON 抛错', () => {
    expect(() => parseGenerationResponse('not json at all', fnOptions)).toThrow(/JSON/);
  });

  it('cases 为空抛错', () => {
    expect(() => parseGenerationResponse(makeAiJson({ cases: [] }), fnOptions)).toThrow(/测试点/);
  });

  it('测试点缺少 output 抛错', () => {
    expect(() => parseGenerationResponse(makeAiJson({ cases: [{ input: '1' }] }), fnOptions)).toThrow(/input\/output/);
  });

  it('函数题缺少所选语言模板时抛错', () => {
    expect(() => parseGenerationResponse(
      makeAiJson({ templates: { py: 'x' } }),
      fnOptions,
    )).toThrow(/模板/);
  });

  it('用户指定题型时覆盖 AI 判断', () => {
    const res = parseGenerationResponse(
      makeAiJson({ problemType: 'function' }),
      { problemKind: 'traditional', caseCount: 2, languages: [] },
    );
    expect(res.problemType).toBe('traditional');
  });

  it('传统题不要求模板', () => {
    const res = parseGenerationResponse(
      makeAiJson({ problemType: 'traditional', templates: undefined }),
      { problemKind: 'auto', caseCount: 2, languages: ['py'] },
    );
    expect(res.problemType).toBe('traditional');
    expect(res.templates).toBeUndefined();
  });

  it('problemType 非法时抛错', () => {
    expect(() => parseGenerationResponse(makeAiJson({ problemType: 'other' }), fnOptions)).toThrow(/problemType/);
  });

  it('auto 模式采纳 AI 的 isFillIn 结论', () => {
    expect(parseGenerationResponse(makeAiJson({ isFillIn: true }), fnOptions).isFillIn).toBe(true);
    expect(parseGenerationResponse(makeAiJson({ isFillIn: false }), fnOptions).isFillIn).toBe(false);
    expect(parseGenerationResponse(makeAiJson({}), fnOptions).isFillIn).toBe(false);
  });

  it('用户显式指定填空模式时覆盖 AI 结论', () => {
    expect(parseGenerationResponse(
      makeAiJson({ isFillIn: false }),
      { ...fnOptions, fillInMode: 'yes' },
    ).isFillIn).toBe(true);
    expect(parseGenerationResponse(
      makeAiJson({ isFillIn: true }),
      { ...fnOptions, fillInMode: 'no' },
    ).isFillIn).toBe(false);
  });
});

// ─── assemblePlan ─────────────────────────────────────────────────────────────

describe('assemblePlan', () => {
  const fnOptions: GenerateOptions = { problemKind: 'function', caseCount: 2, languages: ['py', 'cc'] };

  it('函数题生成完整文件集（模板 + compile.sh + std + config）', () => {
    const response = parseGenerationResponse(makeAiJson(), fnOptions);
    const plan = assemblePlan(response, fnOptions);
    const names = plan.files.map(f => f.name);
    expect(names).toEqual(expect.arrayContaining([
      '1.in', '1.out', '2.in', '2.out',
      'template.py', 'template.cc', 'compile.sh', 'std.py', 'config.yaml',
    ]));
    expect(names).not.toContain('template.java'); // 未选择 java
    expect(plan.caseCount).toBe(2);
    const config = plan.files.find(f => f.name === 'config.yaml');
    expect(config?.content).toContain('user_extra_files:');
    expect(config?.content).not.toContain('template.java');
  });

  it('传统题只生成测试点 + std + config', () => {
    const options: GenerateOptions = { problemKind: 'traditional', caseCount: 2, languages: [] };
    const response = parseGenerationResponse(makeAiJson({ problemType: 'traditional' }), options);
    const plan = assemblePlan(response, options);
    const names = plan.files.map(f => f.name);
    expect(names).toEqual(['1.in', '1.out', '2.in', '2.out', 'std.py', 'config.yaml']);
    const config = plan.files.find(f => f.name === 'config.yaml');
    expect(config?.content).not.toContain('user_extra_files');
  });

  it('测试点文件按 AI 返回数量而非请求数量组装', () => {
    const response = parseGenerationResponse(makeAiJson(), { ...fnOptions, caseCount: 10 });
    const plan = assemblePlan(response, { ...fnOptions, caseCount: 10 });
    expect(plan.caseCount).toBe(2);
    expect(plan.files.filter(f => f.kind === 'case-in')).toHaveLength(2);
    const config = plan.files.find(f => f.name === 'config.yaml');
    expect(config?.content).toContain('input: 2.in');
    expect(config?.content).not.toContain('input: 3.in');
  });

  it('教师提供标准答案时以其为准（内容与扩展名），忽略 AI 版本', () => {
    const options: GenerateOptions = { ...fnOptions, providedStd: '#include <cstdio>\nint main(){return 0;}' };
    const response = parseGenerationResponse(makeAiJson(), options);
    const plan = assemblePlan(response, options);
    const stdFiles = plan.files.filter(f => f.kind === 'std');
    expect(stdFiles).toHaveLength(1);
    expect(stdFiles[0].name).toBe('std.cc');
    expect(stdFiles[0].content).toContain('#include <cstdio>');
    expect(stdFiles[0].content).not.toContain('def solve');
  });

  it('isFillIn 透传到计划', () => {
    const response = parseGenerationResponse(makeAiJson({ isFillIn: true }), fnOptions);
    const plan = assemblePlan(response, fnOptions);
    expect(plan.isFillIn).toBe(true);
  });
});

// ─── 提示词构建 ───────────────────────────────────────────────────────────────

describe('buildTestdataSystemPrompt / buildTestdataUserPrompt', () => {
  it('System Prompt 包含机制说明与 JSON 契约', () => {
    const sp = buildTestdataSystemPrompt();
    expect(sp).toContain('HydroOJ');
    expect(sp).toContain('template.py');
    expect(sp).toContain('#include "foo.cc"');
    expect(sp).toContain('problemType');
    expect(sp).toContain('stdSolution');
    expect(sp).toContain('JSON');
  });

  it('System Prompt 包含填空题、标准答案与数据规模规则', () => {
    const sp = buildTestdataSystemPrompt();
    expect(sp).toContain('填空题');
    expect(sp).toContain('isFillIn');
    expect(sp).toContain('教师提供的标准答案');
    expect(sp).toContain('可解析构造');
    expect(sp).toContain('small');
    expect(sp).toContain('large');
  });

  it('User Prompt 包含题面、选项与已有文件', () => {
    const up = buildTestdataUserPrompt({
      problemTitle: '提莫攻击',
      statementMarkdown: '# 题目\n内容',
      options: { problemKind: 'function', caseCount: 5, languages: ['py'], extraRequirements: '链表用类实现' },
      existingFiles: ['1.in', 'config.yaml'],
    });
    expect(up).toContain('提莫攻击');
    expect(up).toContain('# 题目');
    expect(up).toContain('5 个');
    expect(up).toContain('Python (template.py)');
    expect(up).toContain('链表用类实现');
    expect(up).toContain('1.in, config.yaml');
  });

  it('超长题面被截断', () => {
    const up = buildTestdataUserPrompt({
      problemTitle: 't',
      statementMarkdown: 'x'.repeat(TESTDATA_GEN_LIMITS.MAX_STATEMENT_LENGTH + 100),
      options: baseOptions,
    });
    expect(up).toContain('题面过长已截断');
  });

  it('User Prompt 包含填空指定、数据规模与标准答案', () => {
    const up = buildTestdataUserPrompt({
      problemTitle: '回文日期',
      statementMarkdown: '题面',
      options: {
        ...baseOptions,
        fillInMode: 'yes',
        dataScale: 'large',
        providedStd: 'def judge(a, b):\n    return 0',
      },
    });
    expect(up).toContain('填空题（完善代码）：是');
    expect(up).toContain('large');
    expect(up).toContain('可解析构造');
    expect(up).toContain('教师提供的标准答案');
    expect(up).toContain('def judge(a, b):');
  });

  it('auto 模式下携带规则引擎的填空初判信号', () => {
    const withHint = buildTestdataUserPrompt({
      problemTitle: 't', statementMarkdown: 's',
      options: { ...baseOptions, fillInMode: 'auto' },
      fillInDetected: true,
    });
    expect(withHint).toContain('疑似含待完善代码');
    const withoutHint = buildTestdataUserPrompt({
      problemTitle: 't', statementMarkdown: 's',
      options: { ...baseOptions, fillInMode: 'auto' },
      fillInDetected: false,
    });
    expect(withoutHint).not.toContain('疑似含待完善代码');
  });
});

// ─── TestdataGenService.generate ──────────────────────────────────────────────

describe('TestdataGenService.generate', () => {
  it('调用 AI 客户端并返回组装后的计划', async () => {
    const mockClient = {
      chat: jest.fn().mockResolvedValue({
        content: makeAiJson(),
        usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
        usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
      }),
    };
    const service = new TestdataGenService(mockClient as never);
    const plan = await service.generate({
      problemTitle: '提莫攻击',
      statementMarkdown: '题面',
      options: { problemKind: 'function', caseCount: 2, languages: ['py'] },
    });
    expect(mockClient.chat).toHaveBeenCalledTimes(1);
    const [messages, systemPrompt] = mockClient.chat.mock.calls[0];
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toContain('提莫攻击');
    expect(systemPrompt).toContain('JSON');
    expect(plan.files.map(f => f.name)).toContain('config.yaml');
    expect(plan.tokenUsage?.totalTokens).toBe(300);
    expect(plan.usedModel).toBe('main/gpt-test');
  });

  it('AI 返回非法内容时抛出中文错误', async () => {
    const mockClient = { chat: jest.fn().mockResolvedValue({ content: 'oops', usedModel: { endpointId: 'e', endpointName: 'n', modelName: 'm' } }) };
    const service = new TestdataGenService(mockClient as never);
    await expect(service.generate({
      problemTitle: 't',
      statementMarkdown: 's',
      options: baseOptions,
    })).rejects.toThrow(/JSON/);
  });
});
