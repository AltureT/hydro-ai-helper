/**
 * TestdataGenService 单元测试
 */

import {
  validateGenerateOptions,
  isSafeTestdataFilename,
  buildCompileSh,
  buildConfigYaml,
  buildSkeletonPlan,
  extractJsonObject,
  normalizeFileContent,
  parseGenerationResponse,
  parseDelimitedResponse,
  parseAiResponse,
  parseTemplateSections,
  getMissingTemplateLanguages,
  findAssignmentStyleCaseInput,
  extractStatementSamples,
  buildSandboxBlueprintSystemPrompt,
  buildSandboxBlueprintUserPrompt,
  parseSandboxBlueprint,
  parseGeneratorOutput,
  materializeSandboxBlueprint,
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

const groupedCoinStatement = `## 输入格式

第一行仅有一个正整数 $T$，表示测试数据的组数，对于每组测试数据包含三行，每行给出一个比较结果。

## 输出格式

依次给出 $T$ 组测试数据的结果，每组测试数据仅有一行。
`;

const coinStatementWithSample = `${groupedCoinStatement}
## 输入输出样例

\`\`\`input1
2
A>B
C<B
A>C
A<B
B>C
C>A
\`\`\`

\`\`\`output1
CBA
ACB
\`\`\`
`;

function makeSandboxBlueprint(problemType: 'traditional' | 'function' = 'traditional'): string {
  const templateSections = problemType === 'function' ? [
    '@@@TEMPLATE:py@@@',
    'print(solve(input().strip()))',
    '@@@TEMPLATE:java@@@',
    'public class Main { public static void main(String[] args) {} }',
    '@@@TEMPLATE:cc@@@',
    '#include "foo.cc"',
    'int main() { return 0; }',
  ] : [];
  return [
    '@@@META@@@',
    `problemType: ${problemType}`,
    'isFillIn: false',
    '@@@ANALYSIS@@@',
    '每个文件只放一组数据。',
    '@@@GENERATOR@@@',
    'import json',
    'print(json.dumps({"cases": []}, ensure_ascii=False))',
    '@@@ORACLE@@@',
    'print(input())',
    ...templateSections,
    '@@@NOTES@@@',
    '沙箱生成。',
  ].join('\n');
}

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

  it('服务层可宽松解析缺失模板，以便随后定向补全', () => {
    const res = parseGenerationResponse(
      makeAiJson({ templates: { py: 'x' } }),
      fnOptions,
      { allowMissingTemplates: true },
    );
    expect(getMissingTemplateLanguages(res, fnOptions)).toEqual(['java', 'cc']);
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

// ─── parseDelimitedResponse / parseAiResponse（分节文本主契约） ───────────────

function makeDelimitedResponse(): string {
  return [
    '@@@META@@@',
    'problemType: function',
    'isFillIn: false',
    'functionName: countKConstraintSubstrings',
    '@@@ANALYSIS@@@',
    '统计满足 k 约束的子串数量。',
    '@@@TEMPLATE:py@@@',
    's = input().strip()',
    'k = int(input())',
    'print(Solution().countKConstraintSubstrings(s, k))',
    '@@@TEMPLATE:java@@@',
    'import java.util.*;',
    '',
    'public class Main {',
    '    public static void main(String[] args) {',
    '        Scanner sc = new Scanner(System.in);',
    '        String s = sc.nextLine().trim();',
    '        int k = Integer.parseInt(sc.nextLine().trim().split("\\\\s+")[0]);',
    '        System.out.println(new Solution().countKConstraintSubstrings(s, k));',
    '    }',
    '}',
    '@@@TEMPLATE:cc@@@',
    '#include <bits/stdc++.h>',
    'using namespace std;',
    '#include "foo.cc"',
    'int main() { string s; int k; cin >> s >> k; cout << Solution().countKConstraintSubstrings(s, k) << endl; }',
    '@@@STD@@@',
    'class Solution:',
    '    def countKConstraintSubstrings(self, s: str, k: int) -> int:',
    '        return 12',
    '@@@CASE:1:IN:样例1@@@',
    '10101',
    '1',
    '@@@CASE:1:OUT@@@',
    '12',
    '@@@CASE:2:IN:边界-全1@@@',
    '11111',
    '1',
    '@@@CASE:2:OUT@@@',
    '15',
  ].join('\n');
}

describe('parseDelimitedResponse', () => {
  const fnOptions: GenerateOptions = { problemKind: 'function', caseCount: 2, languages: ['py', 'java', 'cc'] };

  it('解析完整分节响应（代码含引号与反斜杠，零转义）', () => {
    const res = parseDelimitedResponse(makeDelimitedResponse(), fnOptions);
    expect(res).not.toBeNull();
    expect(res!.problemType).toBe('function');
    expect(res!.functionName).toBe('countKConstraintSubstrings');
    expect(res!.analysis).toContain('k 约束');
    // 关键回归：JSON 契约下这里的 split("\\s+") 曾导致转义解析失败
    expect(res!.templates?.java).toContain('split("\\\\s+")');
    expect(res!.templates?.cc).toContain('#include "foo.cc"');
    expect(res!.stdSolution?.code).toContain('class Solution:');
    expect(res!.cases).toHaveLength(2);
    expect(res!.cases[0].label).toBe('样例1');
    expect(res!.cases[0].input).toBe('10101\n1\n');
    expect(res!.cases[1].output).toBe('15\n');
  });

  it('容忍模型把整个响应包进代码围栏', () => {
    const res = parseDelimitedResponse('```\n' + makeDelimitedResponse() + '\n```', fnOptions);
    expect(res).not.toBeNull();
    expect(res!.cases).toHaveLength(2);
  });

  it('忽略首个标记之前的寒暄文字', () => {
    const res = parseDelimitedResponse('好的，以下是生成结果：\n' + makeDelimitedResponse(), fnOptions);
    expect(res).not.toBeNull();
  });

  it('label 含冒号时完整保留', () => {
    const raw = makeDelimitedResponse().replace('@@@CASE:1:IN:样例1@@@', '@@@CASE:1:IN:边界:k=1:全串@@@');
    const res = parseDelimitedResponse(raw, fnOptions);
    expect(res!.cases[0].label).toBe('边界:k=1:全串');
  });

  it('无任何标记时返回 null（供回退 JSON）', () => {
    expect(parseDelimitedResponse('{"problemType":"function"}', fnOptions)).toBeNull();
  });

  it('测试点缺少 OUT 节时报错并指明编号', () => {
    const raw = makeDelimitedResponse().replace('@@@CASE:2:OUT@@@\n15', '');
    expect(() => parseDelimitedResponse(raw, fnOptions)).toThrow(/第 2 个测试点/);
  });

  it('疑似损坏的标记行（缺尾部 @@@）直接报错而非静默吞数据', () => {
    const raw = makeDelimitedResponse().replace('@@@CASE:2:OUT@@@', '@@@CASE:2:OUT@@');
    expect(() => parseDelimitedResponse(raw, fnOptions)).toThrow(/损坏的分节标记/);
  });

  it('无法识别的 CASE 标记报错', () => {
    const raw = makeDelimitedResponse().replace('@@@CASE:1:OUT@@@', '@@@CASE:x:OUT@@@');
    expect(() => parseDelimitedResponse(raw, fnOptions)).toThrow(/无法识别的 CASE 标记/);
  });

  it('传统题分节响应无 TEMPLATE 节', () => {
    const raw = [
      '@@@META@@@',
      'problemType: traditional',
      '@@@STD@@@',
      'print(int(input()) + 1)',
      '@@@CASE:1:IN:样例@@@',
      '1',
      '@@@CASE:1:OUT@@@',
      '2',
    ].join('\n');
    const res = parseDelimitedResponse(raw, { problemKind: 'auto', caseCount: 1, languages: ['py'] });
    expect(res!.problemType).toBe('traditional');
    expect(res!.templates).toBeUndefined();
  });
});

describe('parseAiResponse', () => {
  const fnOptions: GenerateOptions = { problemKind: 'function', caseCount: 2, languages: ['py', 'java', 'cc'] };

  it('优先解析分节文本', () => {
    const res = parseAiResponse(makeDelimitedResponse(), fnOptions);
    expect(res.cases).toHaveLength(2);
  });

  it('无分节标记时回退 JSON（兼容旧契约）', () => {
    const res = parseAiResponse(makeAiJson(), fnOptions);
    expect(res.cases).toHaveLength(2);
  });

  it('两种格式都失败时给出合并的可读错误', () => {
    expect(() => parseAiResponse('完全无法解析的内容', fnOptions))
      .toThrow(/未找到分节标记.*骨架/);
  });
});

describe('函数题生成结果防线', () => {
  it('识别把参数赋值语句写进 .in 的错误格式', () => {
    expect(findAssignmentStyleCaseInput([
      { input: 's = "1010101"\nk = 2\n', output: '12\n' },
    ])).toEqual({ caseNumber: 1, line: 's = "1010101"' });
  });

  it('不把不含空白等号的原始字符串误判为赋值语句', () => {
    expect(findAssignmentStyleCaseInput([
      { input: 'a=1\n', output: 'ok\n' },
    ])).toBeNull();
  });

  it('解析定向补全返回的单个 Java 模板节', () => {
    const templates = parseTemplateSections([
      '@@@TEMPLATE:java@@@',
      'public class Main {',
      '    public static void main(String[] args) {}',
      '}',
    ].join('\n'));
    expect(templates.java).toContain('public class Main');
    expect(templates.py).toBeUndefined();
  });
});

describe('题面样例提取', () => {
  it('提取成对的 Hydro inputN/outputN 样例供沙箱校验标程', () => {
    const samples = extractStatementSamples(coinStatementWithSample);
    expect(samples).toEqual([{
      id: '1',
      input: '2\nA>B\nC<B\nA>C\nA<B\nB>C\nC>A\n',
      output: 'CBA\nACB\n',
    }]);
  });
});

describe('Hydro 沙箱生成蓝图', () => {
  it('提示词要求 ACM 每个文件默认 T=1，并由标程实际生成输出', () => {
    const system = buildSandboxBlueprintSystemPrompt();
    expect(system).toContain('默认每个文件固定 T=1');
    expect(system).toContain('GENERATOR 只生成 .in，不生成答案');
    expect(system).toContain('ORACLE 是自包含、可直接运行的 Python 3 完整程序');
    const user = buildSandboxBlueprintUserPrompt({
      problemTitle: '三枚硬币',
      statementMarkdown: groupedCoinStatement,
      options: { problemKind: 'traditional', caseCount: 3, languages: [] },
    });
    expect(user).toContain('3 个独立的 .in/.out 文件对');
    expect(user).toContain('不要直接输出 CASE 或 .out');
  });

  it('解析生成器、标程与全部函数题模板', () => {
    const options: GenerateOptions = {
      problemKind: 'function', caseCount: 2, languages: ['py', 'java', 'cc'],
    };
    const blueprint = parseSandboxBlueprint(makeSandboxBlueprint('function'), options);
    expect(blueprint.generatorCode).toContain('json.dumps');
    expect(blueprint.oracleCode).toContain('print(input())');
    expect(blueprint.templates?.java).toContain('public class Main');
  });

  it('生成器必须返回精确数量的原始输入', () => {
    expect(parseGeneratorOutput(JSON.stringify({
      cases: [
        { label: '有效排序', input: '1\nA>B\nC<B\nA>C' },
        { label: '循环矛盾', input: '1\nA>B\nB>C\nC>A' },
      ],
    }), 2)).toEqual([
      { label: '有效排序', input: '1\nA>B\nC<B\nA>C\n' },
      { label: '循环矛盾', input: '1\nA>B\nB>C\nC>A\n' },
    ]);
    expect(() => parseGeneratorOutput('{"cases":[]}', 2)).toThrow(/期望 2 个/);
  });

  it('用沙箱标程生成全部 .out，并用题面样例校验标程', async () => {
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPythonBatchDetailed: jest.fn().mockResolvedValue([]),
      runPython: jest.fn().mockResolvedValue({
        stdout: JSON.stringify({ cases: [
          { label: '有效排序', input: '1\nA>B\nC<B\nA>C' },
          { label: '循环矛盾', input: '1\nA>B\nB>C\nC>A' },
        ] }),
        stderr: '',
      }),
      runPythonBatch: jest.fn().mockResolvedValue([
        { stdout: 'CBA\n', stderr: '' },
        { stdout: 'Impossible\n', stderr: '' },
        { stdout: 'CBA\nACB\n', stderr: '' },
      ]),
    };
    const blueprint = parseSandboxBlueprint(
      makeSandboxBlueprint('traditional'),
      { problemKind: 'traditional', caseCount: 2, languages: [] },
    );
    const response = await materializeSandboxBlueprint(
      blueprint,
      { problemKind: 'traditional', caseCount: 2, languages: [] },
      coinStatementWithSample,
      runner,
    );
    expect(response.cases.map(item => item.output)).toEqual(['CBA\n', 'Impossible\n']);
    expect(runner.runPythonBatch).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['2\nA>B\nC<B\nA>C\nA<B\nB>C\nC>A\n']),
      undefined,
    );
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
  it('System Prompt 包含机制说明与分节输出契约', () => {
    const sp = buildTestdataSystemPrompt();
    expect(sp).toContain('HydroOJ');
    expect(sp).toContain('template.py');
    expect(sp).toContain('#include "foo.cc"');
    expect(sp).toContain('problemType');
    expect(sp).toContain('@@@META@@@');
    expect(sp).toContain('@@@STD@@@');
    expect(sp).toContain('@@@CASE:1:IN:');
    expect(sp).toContain('禁止 JSON');
    // 类方法签名（LeetCode class Solution 形式）的调用约定
    expect(sp).toContain('Solution().xxx(...)');
    expect(sp).toContain('.in 文件是原始标准输入，不是代码');
    expect(sp).toContain('严禁写成 s = "1010101" / k = 2');
    expect(sp).toContain('Hydro 测试点数量是独立的');
    expect(sp).toContain('默认每个 Hydro 测试点取 T=1');
    expect(sp).toContain('默认每个参数占一行');
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
    expect(up).toContain('这不是单个输入文件首行的 T');
    expect(up).toContain('Python (template.py)');
    expect(up).toContain('@@@TEMPLATE:py@@@');
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

// ─── buildSkeletonPlan（AI 故障降级） ─────────────────────────────────────────

describe('buildSkeletonPlan', () => {
  it('函数题骨架包含模板骨架、compile.sh 与空白测试点', () => {
    const plan = buildSkeletonPlan({ problemKind: 'function', caseCount: 3, languages: ['py', 'cc'] });
    const names = plan.files.map(f => f.name);
    expect(names).toEqual(expect.arrayContaining([
      '1.in', '1.out', '2.in', '2.out', '3.in', '3.out',
      'template.py', 'template.cc', 'compile.sh', 'config.yaml',
    ]));
    expect(names).not.toContain('template.java');
    expect(plan.caseCount).toBe(3);
    expect(plan.problemType).toBe('function');
    // 模板骨架含 TODO 引导且 java/cc 骨架可编译（结构完整）
    const py = plan.files.find(f => f.name === 'template.py');
    expect(py?.content).toContain('骨架');
    // 空白测试点为单个换行，供教师在预览中填写
    expect(plan.files.find(f => f.name === '1.in')?.content).toBe('\n');
  });

  it('传统题骨架只含测试点与 config.yaml', () => {
    const plan = buildSkeletonPlan({ problemKind: 'traditional', caseCount: 2, languages: [] });
    const names = plan.files.map(f => f.name);
    expect(names).toEqual(['1.in', '1.out', '2.in', '2.out', 'config.yaml']);
    const config = plan.files.find(f => f.name === 'config.yaml');
    expect(config?.content).not.toContain('user_extra_files');
  });

  it('auto 题型按传统题处理并在说明中提示', () => {
    const plan = buildSkeletonPlan({ problemKind: 'auto', caseCount: 1, languages: ['py'] });
    expect(plan.problemType).toBe('traditional');
    expect(plan.notes).toContain('题型未指定');
  });

  it('auto 模式从高置信题面标记识别函数题并生成全部模板骨架', () => {
    const statement = '### 代码写到函数内部\n```python\ndef findPoisonedDuration(timeSeries, duration):\n    return\n```';
    const plan = buildSkeletonPlan(
      { problemKind: 'auto', caseCount: 1, languages: ['py', 'java', 'cc'] },
      statement,
    );
    expect(plan.problemType).toBe('function');
    expect(plan.files.map(f => f.name)).toEqual(expect.arrayContaining([
      'template.py', 'template.java', 'template.cc', 'compile.sh', 'config.yaml',
    ]));
    expect(plan.notes).toContain('自动生成函数题骨架');
  });

  it('提供标准答案时随骨架一并写入 std 文件', () => {
    const plan = buildSkeletonPlan({
      problemKind: 'traditional', caseCount: 1, languages: [],
      providedStd: 'print(input())',
    });
    const std = plan.files.find(f => f.kind === 'std');
    expect(std?.name).toBe('std.py');
    expect(std?.content).toContain('print(input())');
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
    const [messages, systemPrompt, callOptions] = mockClient.chat.mock.calls[0];
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toContain('提莫攻击');
    expect(systemPrompt).toContain('JSON');
    // 不限输出长度 + 长超时
    expect(callOptions.maxTokens).toBeNull();
    expect(callOptions.timeoutMs).toBe(TESTDATA_GEN_LIMITS.AI_TIMEOUT_MS);
    expect(plan.files.map(f => f.name)).toContain('config.yaml');
    expect(plan.tokenUsage?.totalTokens).toBe(300);
    expect(plan.usedModel).toBe('main/gpt-test');
  });

  it('沙箱模式运行生成器和标程后再组装文件', async () => {
    const mockClient = {
      chat: jest.fn().mockResolvedValue({
        content: makeSandboxBlueprint('traditional'),
        usage: { promptTokens: 50, completionTokens: 80, totalTokens: 130 },
        usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
      }),
    };
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPythonBatchDetailed: jest.fn().mockResolvedValue([]),
      runPython: jest.fn().mockResolvedValue({
        stdout: JSON.stringify({ cases: [
          { label: '有效排序', input: '1\nA>B\nC<B\nA>C' },
          { label: '循环矛盾', input: '1\nA>B\nB>C\nC>A' },
        ] }),
        stderr: '',
      }),
      runPythonBatch: jest.fn().mockResolvedValue([
        { stdout: 'CBA\n', stderr: '' },
        { stdout: 'Impossible\n', stderr: '' },
      ]),
    };
    const service = new TestdataGenService(mockClient as never, {
      sandboxRunner: runner,
      mode: 'sandbox',
    });
    const plan = await service.generate({
      problemTitle: '三枚硬币',
      statementMarkdown: groupedCoinStatement,
      options: { problemKind: 'traditional', caseCount: 2, languages: [] },
    });

    expect(runner.isAvailable).toHaveBeenCalled();
    expect(plan.files.find(file => file.name === '1.in')?.content).toBe('1\nA>B\nC<B\nA>C\n');
    expect(plan.files.find(file => file.name === '1.out')?.content).toBe('CBA\n');
    expect(plan.files.map(file => file.name)).toEqual(expect.arrayContaining([
      'generator.py', 'std.py', 'config.yaml',
    ]));
    expect(plan.notes).toContain('Hydro 沙箱中实际运行');
  });

  it('沙箱验证中用户中止：原样上抛且不触发修复请求', async () => {
    const mockClient = {
      chat: jest.fn().mockResolvedValue({
        content: makeSandboxBlueprint('traditional'),
        usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
      }),
    };
    const cancelErr = Object.assign(new Error('canceled'), { name: 'CanceledError', code: 'ERR_CANCELED' });
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPythonBatchDetailed: jest.fn().mockResolvedValue([]),
      runPython: jest.fn().mockRejectedValue(cancelErr),
      runPythonBatch: jest.fn(),
    };
    const service = new TestdataGenService(mockClient as never, { sandboxRunner: runner, mode: 'sandbox' });
    await expect(service.generate({
      problemTitle: 't', statementMarkdown: '题面',
      options: { problemKind: 'traditional', caseCount: 2, languages: [] },
    })).rejects.toBe(cancelErr);
    // 中止不应再烧一次修复请求
    expect(mockClient.chat).toHaveBeenCalledTimes(1);
  });

  it('修复请求本身被中止（AIServiceError aborted 形态）：原样上抛不包装', async () => {
    const abortedErr = Object.assign(new Error('请求已取消'), { category: 'aborted' });
    const mockClient = {
      chat: jest.fn()
        .mockResolvedValueOnce({
          content: makeSandboxBlueprint('traditional'),
          usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
        })
        .mockRejectedValueOnce(abortedErr),
    };
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPythonBatchDetailed: jest.fn().mockResolvedValue([]),
      // 生成器 stdout 非法 JSON → 真实失败，进入修复回路
      runPython: jest.fn().mockResolvedValue({ stdout: 'not json', stderr: '' }),
      runPythonBatch: jest.fn(),
    };
    const service = new TestdataGenService(mockClient as never, { sandboxRunner: runner, mode: 'sandbox' });
    await expect(service.generate({
      problemTitle: 't', statementMarkdown: '题面',
      options: { problemKind: 'traditional', caseCount: 2, languages: [] },
    })).rejects.toBe(abortedErr);
  });

  it('沙箱蓝图漏掉 Java 模板时定向补齐后再执行', async () => {
    const initial = makeSandboxBlueprint('function').replace(
      /@@@TEMPLATE:java@@@[\s\S]*?(?=@@@TEMPLATE:cc@@@)/,
      '',
    );
    const mockClient = {
      chat: jest.fn()
        .mockResolvedValueOnce({
          content: initial,
          usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
        })
        .mockResolvedValueOnce({
          content: '@@@TEMPLATE:java@@@\npublic class Main { public static void main(String[] args) {} }',
          usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
        }),
    };
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPythonBatchDetailed: jest.fn().mockResolvedValue([]),
      runPython: jest.fn().mockResolvedValue({
        stdout: JSON.stringify({ cases: [{ input: 'abc' }] }), stderr: '',
      }),
      runPythonBatch: jest.fn().mockResolvedValue([{ stdout: 'abc\n', stderr: '' }]),
    };
    const plan = await new TestdataGenService(mockClient as never, {
      sandboxRunner: runner, mode: 'sandbox',
    }).generate({
      problemTitle: '函数题', statementMarkdown: '题面',
      options: { problemKind: 'function', caseCount: 1, languages: ['py', 'java', 'cc'] },
    });

    expect(mockClient.chat).toHaveBeenCalledTimes(2);
    expect(mockClient.chat.mock.calls[1][0][2].content).toContain('@@@TEMPLATE:java@@@');
    expect(plan.files.find(file => file.name === 'template.java')?.content).toContain('public class Main');
  });

  it('auto 模式在沙箱不可达时回退兼容直出并明确提示', async () => {
    const mockClient = {
      chat: jest.fn().mockResolvedValue({
        content: makeAiJson(),
        usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
      }),
    };
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(false),
      runPythonBatchDetailed: jest.fn().mockResolvedValue([]),
      runPython: jest.fn(),
      runPythonBatch: jest.fn(),
    };
    const plan = await new TestdataGenService(mockClient as never, {
      sandboxRunner: runner,
      mode: 'auto',
    }).generate({
      problemTitle: '提莫攻击', statementMarkdown: '题面',
      options: { problemKind: 'function', caseCount: 2, languages: ['py'] },
    });
    expect(plan.notes).toContain('沙箱当前不可达');
    expect(runner.runPython).not.toHaveBeenCalled();
  });

  it('AI 漏掉 Java 模板时定向补全并保留原测试点', async () => {
    const initial = makeDelimitedResponse().replace(
      /@@@TEMPLATE:java@@@[\s\S]*?(?=@@@TEMPLATE:cc@@@)/,
      '',
    );
    const mockClient = {
      chat: jest.fn()
        .mockResolvedValueOnce({
          content: initial,
          usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
          usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
        })
        .mockResolvedValueOnce({
          content: [
            '@@@TEMPLATE:java@@@',
            'public class Main {',
            '    public static void main(String[] args) {',
            '        System.out.println(new Solution().countKConstraintSubstrings("10101", 1));',
            '    }',
            '}',
          ].join('\n'),
          usage: { promptTokens: 20, completionTokens: 30, totalTokens: 50 },
          usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
        }),
    };
    const options: GenerateOptions = {
      problemKind: 'function', caseCount: 2, languages: ['py', 'java', 'cc'],
    };
    const plan = await new TestdataGenService(mockClient as never).generate({
      problemTitle: '约束子串', statementMarkdown: '题面', options,
    });

    expect(mockClient.chat).toHaveBeenCalledTimes(2);
    expect(mockClient.chat.mock.calls[1][0][2].content).toContain('@@@TEMPLATE:java@@@');
    expect(plan.files.find(f => f.name === 'template.java')?.content).toContain('public class Main');
    expect(plan.files.find(f => f.name === '1.in')?.content).toBe('10101\n1\n');
    expect(plan.tokenUsage?.totalTokens).toBe(350);
  });

  it('AI 把变量赋值写入 .in 时要求完整修复后再组装', async () => {
    const invalid = makeDelimitedResponse().replace(
      '@@@CASE:1:IN:样例1@@@\n10101\n1',
      '@@@CASE:1:IN:样例1@@@\ns = "10101"\nk = 1',
    );
    const mockClient = {
      chat: jest.fn()
        .mockResolvedValueOnce({
          content: invalid,
          usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
        })
        .mockResolvedValueOnce({
          content: makeDelimitedResponse(),
          usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
        }),
    };
    const plan = await new TestdataGenService(mockClient as never).generate({
      problemTitle: '约束子串',
      statementMarkdown: '题面',
      options: { problemKind: 'function', caseCount: 2, languages: ['py', 'java', 'cc'] },
    });

    expect(mockClient.chat).toHaveBeenCalledTimes(2);
    expect(mockClient.chat.mock.calls[1][0][2].content).toContain('不是合法的评测输入文件');
    expect(plan.files.find(f => f.name === '1.in')?.content).toBe('10101\n1\n');
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

// ─── 双重验证管线 v2.1（对拍 + 模板实跑 + 输入校验） ──────────────────────────

/** 构造一条宽容明细，默认 Accepted。 */
function detail(over: Record<string, unknown> = {}) {
  return { status: 'Accepted', accepted: true, timedOut: false, exitStatus: 0, stdout: '', stderr: '', ...over };
}

const tradOpts: GenerateOptions = { problemKind: 'traditional', caseCount: 2, languages: [] };

/** 两个测试点的生成器 stdout（label c1/c2，输入 1 / 2）。 */
function twoCaseGen(): string {
  return JSON.stringify({ cases: [{ label: 'c1', input: '1' }, { label: 'c2', input: '2' }] });
}

/** ORACLE 严格批量：回显每份输入作为 .out（1→'1\n'，2→'2\n'）。 */
function echoOracle() {
  return jest.fn().mockImplementation((_code: string, inputs: string[]) =>
    Promise.resolve(inputs.map(input => ({ stdout: input, stderr: '' }))));
}

describe('parseSandboxBlueprint v2 分节', () => {
  it('解析 SOLUTION/BRUTE/VALIDATOR 三节', () => {
    const raw = [
      '@@@META@@@', 'problemType: traditional',
      '@@@GENERATOR@@@', 'print(1)',
      '@@@ORACLE@@@', 'print(input())',
      '@@@SOLUTION@@@', 'def solve(x):', '    return x',
      '@@@BRUTE@@@', 'print(input())  # brute-force',
      '@@@VALIDATOR@@@', 'import sys', 'sys.exit(0)',
    ].join('\n');
    const bp = parseSandboxBlueprint(raw, tradOpts);
    expect(bp.solutionCode).toContain('def solve');
    expect(bp.bruteCode).toContain('brute-force');
    expect(bp.validatorCode).toContain('sys.exit(0)');
  });

  it('三节全缺失时宽容解析（向后兼容旧蓝图）', () => {
    const bp = parseSandboxBlueprint(makeSandboxBlueprint('traditional'), tradOpts);
    expect(bp.solutionCode).toBeUndefined();
    expect(bp.bruteCode).toBeUndefined();
    expect(bp.validatorCode).toBeUndefined();
  });

  it('ORACLE 仍为必需节', () => {
    const raw = ['@@@META@@@', 'problemType: traditional', '@@@GENERATOR@@@', 'print(1)'].join('\n');
    expect(() => parseSandboxBlueprint(raw, tradOpts)).toThrow(/ORACLE/);
  });

  it('System Prompt 含 BRUTE 独立、SOLUTION、VALIDATOR 规则与分节', () => {
    const sp = buildSandboxBlueprintSystemPrompt();
    expect(sp).toContain('@@@SOLUTION@@@');
    expect(sp).toContain('@@@BRUTE@@@');
    expect(sp).toContain('@@@VALIDATOR@@@');
    expect(sp).toContain('相互独立的第二实现');
    // 既有断言仍需成立
    expect(sp).toContain('ORACLE 是自包含、可直接运行的 Python 3 完整程序');
  });
});

describe('materializeSandboxBlueprint 双重验证', () => {
  function tradBlueprint(extra: string[] = []): ReturnType<typeof parseSandboxBlueprint> {
    return parseSandboxBlueprint([
      '@@@META@@@', 'problemType: traditional',
      '@@@GENERATOR@@@', 'print(gen())',
      '@@@ORACLE@@@', 'print(input())',
      ...extra,
    ].join('\n'), tradOpts);
  }

  it('VALIDATOR 拒绝某个 .in 时硬失败并带 stderr，且先于标程执行', async () => {
    const bp = tradBlueprint(['@@@VALIDATOR@@@', 'check()']);
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn().mockResolvedValue({ stdout: twoCaseGen(), stderr: '' }),
      runPythonBatch: echoOracle(),
      runPythonBatchDetailed: jest.fn().mockResolvedValue([
        detail({ stdout: '' }),
        detail({ accepted: false, status: 'Nonzero Exit Status', exitStatus: 1, stderr: '数值超出范围' }),
      ]),
    };
    await expect(materializeSandboxBlueprint(bp, tradOpts, '', runner))
      .rejects.toThrow(/第 2 个 .in 未通过输入校验：数值超出范围/);
    expect(runner.runPythonBatch).not.toHaveBeenCalled();
  });

  it('GENERATOR 实跑失败时报错标明阶段', async () => {
    const bp = tradBlueprint();
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn().mockRejectedValue(
        new Error('第 1 个沙箱任务执行失败（Nonzero Exit Status）：NameError: name \'gen\' is not defined'),
      ),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn(),
    };
    await expect(materializeSandboxBlueprint(bp, tradOpts, '', runner))
      .rejects.toThrow(/GENERATOR 实跑失败：.*NameError/);
  });

  it('ORACLE 实跑失败时报错标明阶段与任务-测试点对应关系', async () => {
    const bp = tradBlueprint();
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn().mockResolvedValue({ stdout: twoCaseGen(), stderr: '' }),
      runPythonBatch: jest.fn().mockRejectedValue(
        new Error('第 1 个沙箱任务执行失败（Nonzero Exit Status）：IndexError: string index out of range'),
      ),
      runPythonBatchDetailed: jest.fn(),
    };
    const err: Error = await materializeSandboxBlueprint(bp, tradOpts, '', runner).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/ORACLE（标程）实跑失败/);
    // 无样例：说明全部任务对应生成的测试点
    expect(err.message).toContain('对应生成的第 1-2 个测试点');
    expect(err.message).toContain('IndexError');
  });

  it('用户中止（CanceledError）原样上抛，不包装为 GENERATOR/ORACLE 阶段失败', async () => {
    const bp = tradBlueprint();
    const cancelErr = Object.assign(new Error('canceled'), { name: 'CanceledError', code: 'ERR_CANCELED' });
    const genCancelRunner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn().mockRejectedValue(cancelErr),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn(),
    };
    await expect(materializeSandboxBlueprint(bp, tradOpts, '', genCancelRunner)).rejects.toBe(cancelErr);

    const oracleCancelRunner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn().mockResolvedValue({ stdout: twoCaseGen(), stderr: '' }),
      runPythonBatch: jest.fn().mockRejectedValue(cancelErr),
      runPythonBatchDetailed: jest.fn(),
    };
    await expect(materializeSandboxBlueprint(bp, tradOpts, '', oracleCancelRunner)).rejects.toBe(cancelErr);
  });

  it('BRUTE 与标程一致：记录 agreed，不拦截', async () => {
    const bp = tradBlueprint(['@@@BRUTE@@@', 'print(input())']);
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn().mockResolvedValue({ stdout: twoCaseGen(), stderr: '' }),
      runPythonBatch: echoOracle(),
      runPythonBatchDetailed: jest.fn().mockResolvedValue([detail({ stdout: '1\n' }), detail({ stdout: '2\n' })]),
    };
    const res = await materializeSandboxBlueprint(bp, tradOpts, '', runner);
    expect(res.verification?.bruteCheck).toEqual({ compared: 2, agreed: 2, skippedTimeout: [], disagreed: [] });
  });

  it('BRUTE 与 AI 标程不一致：硬失败并带证据摘录', async () => {
    const bp = tradBlueprint(['@@@BRUTE@@@', 'print(input())']);
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn().mockResolvedValue({ stdout: twoCaseGen(), stderr: '' }),
      runPythonBatch: echoOracle(),
      runPythonBatchDetailed: jest.fn().mockResolvedValue([detail({ stdout: '1\n' }), detail({ stdout: '999\n' })]),
    };
    await expect(materializeSandboxBlueprint(bp, tradOpts, '', runner))
      .rejects.toThrow(/暴力解与标程在第 2 个测试点不一致/);
  });

  it('教师 std 为唯一权威时 BRUTE 不一致不拦截，仅记录 disagreed 与复核提示', async () => {
    const bp = tradBlueprint(['@@@BRUTE@@@', 'print(input())']);
    const opts: GenerateOptions = { ...tradOpts, providedStd: 'print(input())' };
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn().mockResolvedValue({ stdout: twoCaseGen(), stderr: '' }),
      runPythonBatch: echoOracle(),
      runPythonBatchDetailed: jest.fn().mockResolvedValue([detail({ stdout: '1\n' }), detail({ stdout: '999\n' })]),
    };
    const res = await materializeSandboxBlueprint(bp, opts, '', runner);
    expect(res.verification?.oracleKind).toBe('provided-std');
    expect(res.verification?.bruteCheck).toMatchObject({ agreed: 1, disagreed: [2] });
    expect(res.notes).toContain('请人工复核');
  });

  it('BRUTE 超时：记入 skippedTimeout 并继续', async () => {
    const bp = tradBlueprint(['@@@BRUTE@@@', 'print(input())']);
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn().mockResolvedValue({ stdout: twoCaseGen(), stderr: '' }),
      runPythonBatch: echoOracle(),
      runPythonBatchDetailed: jest.fn().mockResolvedValue([
        detail({ stdout: '1\n' }),
        detail({ accepted: false, timedOut: true, status: 'Time Limit Exceeded' }),
      ]),
    };
    const res = await materializeSandboxBlueprint(bp, tradOpts, '', runner);
    expect(res.verification?.bruteCheck).toMatchObject({ agreed: 1, skippedTimeout: [2], disagreed: [] });
  });

  it('函数题 solution+template.py 组合实跑，一致则记 templateCheck.passed', async () => {
    const fnOpts: GenerateOptions = { problemKind: 'function', caseCount: 1, languages: ['py'] };
    const bp = parseSandboxBlueprint([
      '@@@META@@@', 'problemType: function', 'functionName: f',
      '@@@GENERATOR@@@', 'print(gen())',
      '@@@ORACLE@@@', 'a,b=map(int,input().split())', 'print(a+b)',
      '@@@SOLUTION@@@', 'def f(a, b):', '    return a + b',
      '@@@TEMPLATE:py@@@', 'a,b=map(int,input().split())', 'print(f(a,b))',
    ].join('\n'), fnOpts);
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn().mockResolvedValue({ stdout: JSON.stringify({ cases: [{ label: 'c1', input: '2 3' }] }), stderr: '' }),
      runPythonBatch: jest.fn().mockResolvedValue([{ stdout: '5\n', stderr: '' }]),
      runPythonBatchDetailed: jest.fn().mockResolvedValue([detail({ stdout: '5\n' })]),
    };
    const res = await materializeSandboxBlueprint(bp, fnOpts, '', runner);
    expect(res.pyTemplateExecuted).toBe(true);
    expect(res.verification?.templateCheck).toEqual({ lang: 'py', total: 1, passed: 1, skippedTimeout: [] });
    // 组合程序 = solution + '\n' + template.py
    expect(runner.runPythonBatchDetailed).toHaveBeenCalledWith(
      expect.stringContaining('def f(a, b):'), ['2 3\n'], expect.anything(),
    );
  });

  it('函数题模板与标程输出不一致：硬失败', async () => {
    const fnOpts: GenerateOptions = { problemKind: 'function', caseCount: 1, languages: ['py'] };
    const bp = parseSandboxBlueprint([
      '@@@META@@@', 'problemType: function', 'functionName: f',
      '@@@GENERATOR@@@', 'print(gen())',
      '@@@ORACLE@@@', 'a,b=map(int,input().split())', 'print(a+b)',
      '@@@SOLUTION@@@', 'def f(a, b):', '    return a + b',
      '@@@TEMPLATE:py@@@', 'a,b=map(int,input().split())', 'print(f(a,b))',
    ].join('\n'), fnOpts);
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn().mockResolvedValue({ stdout: JSON.stringify({ cases: [{ label: 'c1', input: '2 3' }] }), stderr: '' }),
      runPythonBatch: jest.fn().mockResolvedValue([{ stdout: '5\n', stderr: '' }]),
      runPythonBatchDetailed: jest.fn().mockResolvedValue([detail({ stdout: '6\n' })]),
    };
    await expect(materializeSandboxBlueprint(bp, fnOpts, '', runner))
      .rejects.toThrow(/template\.py 与标程在第 1 个测试点不一致/);
  });

  it('超过总时长预算时在阶段间报错', async () => {
    const bp = tradBlueprint();
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn().mockResolvedValue({ stdout: twoCaseGen(), stderr: '' }),
      runPythonBatch: echoOracle(),
      runPythonBatchDetailed: jest.fn().mockResolvedValue([]),
    };
    // 每次 Date.now 递增 40 万毫秒，任意两个阶段间隔都超 30 万预算
    let clock = 0;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => { clock += 400_000; return clock; });
    try {
      await expect(materializeSandboxBlueprint(bp, tradOpts, '', runner))
        .rejects.toThrow(/总时长超出预算/);
      expect(runner.runPythonBatch).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe('assemblePlan origin 矩阵与验证透传', () => {
  it('沙箱模式：数据/生成器/对拍器 executed，结构文件 deterministic', () => {
    const response = {
      problemType: 'traditional',
      cases: [{ input: '1\n', output: '1\n' }],
      generatorCode: 'print(1)',
      bruteCode: 'print(input())',
      validatorCode: 'import sys',
      oracleCode: 'print(input())',
      stdSolution: { language: 'python', code: 'print(input())' },
      verification: { mode: 'sandbox', oracleKind: 'ai-solution' },
    } as never;
    const opts: GenerateOptions = { problemKind: 'traditional', caseCount: 1, languages: [] };
    const plan = assemblePlan(response, opts, { mode: 'sandbox' });
    const byName = (n: string) => plan.files.find(f => f.name === n);
    expect(byName('1.in')?.origin).toBe('executed');
    expect(byName('1.out')?.origin).toBe('executed');
    expect(byName('generator.py')?.origin).toBe('executed');
    expect(byName('brute.py')).toMatchObject({ kind: 'brute', origin: 'executed' });
    expect(byName('validator.py')).toMatchObject({ kind: 'validator', origin: 'executed' });
    expect(byName('config.yaml')?.origin).toBe('deterministic');
    expect(plan.verification?.mode).toBe('sandbox');
  });

  it('direct 模式：数据 ai-only，且不写 brute/validator', () => {
    const response = {
      problemType: 'traditional',
      cases: [{ input: '1\n', output: '1\n' }],
      generatorCode: 'print(1)',
      bruteCode: 'print(input())',
      validatorCode: 'import sys',
      stdSolution: { language: 'python', code: 'print(input())' },
    } as never;
    const opts: GenerateOptions = { problemKind: 'traditional', caseCount: 1, languages: [] };
    const plan = assemblePlan(response, opts, { mode: 'direct' });
    expect(plan.files.find(f => f.name === '1.in')?.origin).toBe('ai-only');
    expect(plan.files.find(f => f.name === 'brute.py')).toBeUndefined();
    expect(plan.files.find(f => f.name === 'validator.py')).toBeUndefined();
  });

  it('函数题沙箱模式：std.py 用学生形式，完整标程另存 oracle.py，template.py executed', () => {
    const response = {
      problemType: 'function',
      cases: [{ input: '2 3\n', output: '5\n' }],
      templates: { py: 'print(f())' },
      solutionCode: 'def f():\n    return 5',
      oracleCode: 'print(5)',
      stdSolution: { language: 'python', code: 'print(5)' },
      pyTemplateExecuted: true,
      generatorCode: 'print(1)',
    } as never;
    const opts: GenerateOptions = { problemKind: 'function', caseCount: 1, languages: ['py'] };
    const plan = assemblePlan(response, opts, { mode: 'sandbox' });
    const std = plan.files.find(f => f.name === 'std.py');
    expect(std?.content).toContain('def f()');
    expect(std?.origin).toBe('executed');
    expect(plan.files.find(f => f.name === 'oracle.py')?.content).toContain('print(5)');
    expect(plan.files.find(f => f.name === 'template.py')?.origin).toBe('executed');
  });

  it('AI 生成的代码文件首行带用途注释（.py 用 #，.cc 模板用 //），数据文件不加', () => {
    const response = {
      problemType: 'function',
      cases: [{ input: '2 3\n', output: '5\n' }],
      templates: { py: 'print(f())', cc: 'int main(){}' },
      solutionCode: 'def f():\n    return 5',
      oracleCode: 'print(5)',
      stdSolution: { language: 'python', code: 'print(5)' },
      pyTemplateExecuted: true,
      generatorCode: 'print(1)',
      bruteCode: 'print(0)',
      validatorCode: 'import sys',
    } as never;
    const opts: GenerateOptions = { problemKind: 'function', caseCount: 1, languages: ['py', 'cc'] };
    const plan = assemblePlan(response, opts, { mode: 'sandbox' });
    const content = (n: string) => plan.files.find(f => f.name === n)?.content || '';
    for (const name of ['std.py', 'oracle.py', 'generator.py', 'brute.py', 'validator.py', 'template.py']) {
      expect(content(name)).toMatch(/^# \S/);
    }
    expect(content('template.cc')).toMatch(/^\/\/ \S/);
    // 原有代码内容保留在注释之后
    expect(content('std.py')).toContain('def f()');
    expect(content('template.py')).toContain('print(f())');
    // 数据文件与确定性文件不受影响
    expect(content('1.in')).toBe('2 3\n');
  });

  it('教师提供的 std 原样写入，不加注释头', () => {
    const response = {
      problemType: 'traditional',
      cases: [{ input: '1\n', output: '1\n' }],
      generatorCode: 'print(1)',
      stdSolution: { language: 'python', code: 'print(input())' },
    } as never;
    const opts: GenerateOptions = {
      problemKind: 'traditional', caseCount: 1, languages: [], providedStd: 'print(input())',
    };
    const plan = assemblePlan(response, opts, { mode: 'sandbox' });
    expect(plan.files.find(f => f.name === 'std.py')?.content).toBe('print(input())\n');
  });

  it('骨架模式：所有文件 deterministic 且无 verification', () => {
    const plan = buildSkeletonPlan({ problemKind: 'function', caseCount: 1, languages: ['py'] });
    expect(plan.files.every(f => f.origin === 'deterministic')).toBe(true);
    expect(plan.verification).toBeUndefined();
  });

  it('direct 模式 generate 附带 direct 验证元数据', async () => {
    const mockClient = {
      chat: jest.fn().mockResolvedValue({
        content: makeAiJson({ problemType: 'traditional' }),
        usedModel: { endpointId: 'e', endpointName: 'n', modelName: 'm' },
      }),
    };
    const plan = await new TestdataGenService(mockClient as never).generate({
      problemTitle: 't', statementMarkdown: '题面',
      options: { problemKind: 'traditional', caseCount: 2, languages: [] },
    });
    expect(plan.verification).toEqual({ mode: 'direct', oracleKind: 'ai-solution' });
  });
});
