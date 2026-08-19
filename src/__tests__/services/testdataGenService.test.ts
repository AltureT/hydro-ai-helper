/**
 * TestdataGenService 单元测试
 */

import yaml from 'js-yaml';
import {
  validateGenerateOptions,
  isSafeTestdataFilename,
  buildCompileSh,
  buildConfigYaml,
  mergeConfigSubtasks,
  extractRawTopLevelYamlEntry,
  assertExistingConfigParsable,
  buildCoveragePlan,
  allocateCasesToSubtasks,
  extendTieredAllocations,
  resolveTieredSubtaskGeneration,
  allocateCaseNumbers,
  getExistingNumericCases,
  buildSkeletonPlan,
  extractJsonObject,
  normalizeFileContent,
  normalizeExecutableContent,
  parseGenerationResponse,
  parseDelimitedResponse,
  parseAiResponse,
  parseTemplateSections,
  getMissingTemplateLanguages,
  findAssignmentStyleCaseInput,
  extractStatementSamples,
  buildSolutionBlueprintSystemPrompt,
  buildSolutionBlueprintUserPrompt,
  buildGenerationArtifactsSystemPrompt,
  buildGenerationArtifactsUserPrompt,
  buildSandboxBlueprintSystemPrompt,
  buildSandboxBlueprintUserPrompt,
  buildIndependentVerifierSystemPrompt,
  buildIndependentVerifierUserPrompt,
  parseOracleLanguage,
  parseSubtasksSection,
  parseSandboxBlueprint,
  parseSolutionBlueprint,
  parseGenerationArtifacts,
  parseIndependentVerifierBlueprint,
  parseGeneratorOutput,
  materializeSandboxBlueprint,
  verifySolutionBlueprintSamples,
  classifySandboxRepairScope,
  buildSandboxRepairPrompt,
  mergeSandboxBlueprintRepair,
  hasCustomChecker,
  getTestlibCheckerFilename,
  extendDeadlineByBestEffortElapsed,
  resolveMaterializationResume,
  assemblePlan,
  buildTestdataSystemPrompt,
  buildTestdataUserPrompt,
  detectStdFilename,
  TestdataGenService,
  TestdataGenerationError,
  extractTestdataErrorMetadata,
  shouldRecommendDeeperReasoning,
  GenerateOptions,
  TESTDATA_GEN_LIMITS,
} from '../../services/testdataGenService';
import { TestdataPipelineError } from '../../services/testdata/failures';
import {
  DISCRIMINATION_BUDGET_MS,
  GoJudgeSandboxRunner,
  SANDBOX_TOTAL_BUDGET_MS,
} from '../../services/goJudgeSandboxService';

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
  const solutionSections = problemType === 'function' ? [
    '@@@SOLUTION@@@',
    'def solve(value):',
    '    return value',
  ] : [];
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
    ...solutionSections,
    ...templateSections,
    '@@@NOTES@@@',
    '沙箱生成。',
  ].join('\n');
}

function makeSolutionBlueprint(problemType: 'traditional' | 'function' = 'traditional'): string {
  const solutionSections = problemType === 'function' ? [
    '@@@SOLUTION@@@',
    'def solve(value):',
    '    return value',
  ] : [];
  return [
    '@@@META@@@',
    `problemType: ${problemType}`,
    'isFillIn: false',
    '@@@ANALYSIS@@@',
    '每个文件只放一组数据。',
    '@@@ORACLE@@@',
    'print(input())',
    ...solutionSections,
    '@@@NOTES@@@',
    '解题蓝图。',
  ].join('\n');
}

function makeGenerationArtifactsBlueprint(problemType: 'traditional' | 'function' = 'traditional'): string {
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
    '@@@GENERATOR@@@',
    'import json',
    'print(json.dumps({"cases": []}, ensure_ascii=False))',
    ...templateSections,
    '@@@NOTES@@@',
    '外围制品。',
  ].join('\n');
}

function makeIndependentVerifierBlueprint(
  functionSampleInputs: Array<{ id: string; input: string }> = [],
): string {
  return [
    '@@@BRUTE@@@',
    'print(input())  # independent brute',
    '@@@STRESS_GENERATOR@@@',
    'import json  # stress generator',
    `print(json.dumps({"cases": [{"label": "stress", "input": str(i)} for i in range(${TESTDATA_GEN_LIMITS.STRESS_CASES})]}, separators=(",", ":")))`,
    '@@@VALIDATOR@@@',
    'import sys',
    'sys.exit(0)',
    ...(functionSampleInputs.length > 0 ? [
      '@@@SAMPLE_INPUTS@@@',
      JSON.stringify({ samples: functionSampleInputs }),
    ] : []),
  ].join('\n');
}

function makeEmptyKillTargetsResponse(): string {
  return '未生成可用的错误解靶子';
}

function makeSurvivingKillTargetResponse(): string {
  return [
    '=== KILL_TARGET:wrong-algorithm ===',
    'DESC: 只对已有输入返回正确答案',
    '```python',
    '# surviving wrong solution',
    'value = input().strip()',
    'print(value if value == "1" else "wrong")',
    '```',
  ].join('\n');
}

function makeSharedHackKillTargetsResponse(): string {
  return [
    '=== KILL_TARGET:boundary ===',
    'DESC: 第一个幸存错误解',
    '```python',
    '# shared hack target one',
    'value = input().strip()',
    'print(value if value == "1" else "wrong")',
    '```',
    '=== KILL_TARGET:wrong-algorithm ===',
    'DESC: 第二个幸存错误解',
    '```python',
    '# shared hack target two',
    'value = input().strip()',
    'print(value if value == "1" else "wrong")',
    '```',
  ].join('\n');
}

function makeHackCaseResponse(): string {
  return [
    '=== HACK_CASE ===',
    'RATIONALE: 输入 2 会触发幸存错误解',
    '```text',
    '2',
    '```',
  ].join('\n');
}

function stressGeneratorStdout(): string {
  return JSON.stringify({
    cases: Array.from({ length: TESTDATA_GEN_LIMITS.STRESS_CASES }, (_, i) => ({
      label: `stress-${i + 1}`,
      input: String(i + 1),
    })),
  });
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
    expect(validateGenerateOptions({ ...baseOptions, dataScale: 'auto' })).toBeNull();
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

describe('buildCoveragePlan / numeric case allocation', () => {
  it('auto 对 10 个测试点按 30/40/30 分配并保证三档覆盖', () => {
    const scales = buildCoveragePlan(10, 'auto').map(item => item.dataScale);
    expect(scales.filter(value => value === 'small')).toHaveLength(3);
    expect(scales.filter(value => value === 'medium')).toHaveLength(4);
    expect(scales.filter(value => value === 'large')).toHaveLength(3);
  });

  it('少量测试点优先保留最小与临界覆盖，显式模式保持单一档位', () => {
    expect(buildCoveragePlan(2, 'auto').map(item => item.dataScale)).toEqual(['small', 'large']);
    expect(buildCoveragePlan(3, 'auto').map(item => item.dataScale)).toEqual(['small', 'medium', 'large']);
    expect(buildCoveragePlan(3, 'medium').every(item => item.dataScale === 'medium')).toBe(true);
  });

  it('任一侧存在即保留编号，只有完整数字对进入 config', () => {
    const state = getExistingNumericCases(['1.in', '1.out', '2.in', '3.out', 'named.in']);
    expect([...state.reserved]).toEqual([1, 2, 3]);
    expect(state.complete).toEqual([1]);
    expect(allocateCaseNumbers(['1.in', '1.out', '2.in', '3.out'], 2)).toEqual([4, 5]);
  });
});

describe('parseSubtasksSection / allocateCasesToSubtasks', () => {
  const subtasks = [
    { id: 1, score: 60, constraints: 'n <= 20，且所有 a_i 相等' },
    { id: 2, score: 30, constraints: 'n <= 1000，a_i <= 100' },
    { id: 3, score: 10, constraints: 'n <= 100000，a_i <= 10^9' },
  ];

  it('解析合法 SUBTASKS 分节并保留完整约束摘要', () => {
    expect(parseSubtasksSection([
      '=== SUBTASKS ===',
      '1 | 20 | n<=20, p_i=1',
      '3 | 80 | sum n<=1000, p_i=1, 依赖子任务1',
      '@@@META@@@',
      'problemType: traditional',
    ].join('\n'))).toEqual([
      { id: 1, score: 20, constraints: 'n<=20, p_i=1' },
      { id: 3, score: 80, constraints: 'sum n<=1000, p_i=1, 依赖子任务1' },
    ]);
  });

  it('id 乱序或重复时整体丢弃', () => {
    expect(parseSubtasksSection([
      '=== SUBTASKS ===',
      '2 | 20 | n<=20',
      '1 | 80 | n<=1000',
    ].join('\n'))).toEqual([]);
    expect(parseSubtasksSection([
      '=== SUBTASKS ===',
      '1 | 20 | n<=20',
      '1 | 80 | n<=1000',
    ].join('\n'))).toEqual([]);
  });

  it('任一行格式非法时整体丢弃，缺失分节返回空数组', () => {
    expect(parseSubtasksSection([
      '=== SUBTASKS ===',
      '1 | 20 | n<=20',
      '2 | 0 | n<=1000',
    ].join('\n'))).toEqual([]);
    expect(parseSubtasksSection('@@@META@@@\nproblemType: traditional')).toEqual([]);
  });

  it('均匀分值把剩余测试点平均分配，并按顺序恢复 caseNumber', () => {
    const allocations = allocateCasesToSubtasks(6, subtasks.map(item => ({ ...item, score: 1 })));
    expect(allocations.map(item => item.subtaskId)).toEqual([1, 1, 2, 2, 3, 3]);
    expect(allocations.map(item => item.caseNumber)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(allocations[0].guidance).toBe(
      'n <= 20，且所有 a_i 相等;数据必须严格满足本子任务的全部约束;应包含该档位下的边界/极端情形',
    );
  });

  it('剩余名额按分值比例使用最大缺口法分配', () => {
    const allocations = allocateCasesToSubtasks(10, subtasks);
    expect(allocations.filter(item => item.subtaskId === 1)).toHaveLength(5);
    expect(allocations.filter(item => item.subtaskId === 2)).toHaveLength(3);
    expect(allocations.filter(item => item.subtaskId === 3)).toHaveLength(2);
  });

  it('extendTieredAllocations 总数不变时原样返回同一分配', () => {
    const base = allocateCasesToSubtasks(6, subtasks);
    expect(extendTieredAllocations(base, 6, subtasks)).toBe(base);
  });

  it('extendTieredAllocations 追加项保持原分配不变并归入最后一个子任务', () => {
    const base = allocateCasesToSubtasks(6, subtasks);
    const extended = extendTieredAllocations(base, 8, subtasks);
    expect(extended.slice(0, 6)).toEqual(base);
    expect(extended.slice(6).map(item => item.subtaskId)).toEqual([3, 3]);
    expect(extended.slice(6).map(item => item.caseNumber)).toEqual([7, 8]);
    expect(extended[6].guidance).toBe(subtasks[2].constraints);
  });

  it('extendTieredAllocations 原分配为空或总数变少时返回空数组', () => {
    const base = allocateCasesToSubtasks(6, subtasks);
    expect(extendTieredAllocations([], 3, subtasks)).toEqual([]);
    expect(extendTieredAllocations(base, 5, subtasks)).toEqual([]);
  });

  it('测试点数恰好等于子任务数时每个子任务分配一个', () => {
    expect(allocateCasesToSubtasks(3, subtasks).map(item => item.subtaskId)).toEqual([1, 2, 3]);
  });

  it.each([
    {
      name: '题面未声明 SUBTASKS',
      input: { caseCount: 3, dataScale: 'auto' as const },
      warning: undefined,
    },
    {
      name: '既有 config 已含 subtasks',
      input: {
        caseCount: 3,
        dataScale: 'auto' as const,
        subtasks,
        existingConfig: 'subtasks:\n  - id: 9\n    score: 100\n    cases: []\n',
      },
      warning: undefined,
    },
    {
      name: '用户选择非 auto 规模',
      input: { caseCount: 3, dataScale: 'medium' as const, subtasks },
      warning: undefined,
    },
    {
      name: '测试点少于子任务数',
      input: { caseCount: 2, dataScale: 'auto' as const, subtasks },
      warning: '题面含 3 个子任务但仅请求 2 个测试点,已按普通模式生成;建议将测试点数提高到 ≥3 后重新生成以获得分层数据',
    },
    {
      name: '子任务分值合计不是 100',
      input: {
        caseCount: 3,
        dataScale: 'auto' as const,
        subtasks: subtasks.map((subtask, index) => (
          index === 0 ? { ...subtask, score: 50 } : subtask
        )),
      },
      warning: '子任务分值合计为 90,非 100,已按普通模式输出配置',
    },
  ])('四条件门控：$name 时完整回退扁平模式', ({ input, warning }) => {
    expect(resolveTieredSubtaskGeneration(input)).toEqual({
      enabled: false,
      allocations: [],
      ...(warning ? { warning } : {}),
    });
  });

  it('四项条件全部满足时启用分层并返回确定性分配', () => {
    const result = resolveTieredSubtaskGeneration({
      caseCount: 3,
      dataScale: 'auto',
      subtasks,
    });
    expect(result.enabled).toBe(true);
    expect(result.allocations.map(item => item.subtaskId)).toEqual([1, 2, 3]);
    expect(result.warning).toBeUndefined();
  });

  it('既有空 subtasks 沿用原语义视为未配置，不阻止新分层', () => {
    expect(resolveTieredSubtaskGeneration({
      caseCount: 3,
      dataScale: 'auto',
      subtasks,
      existingConfig: 'subtasks: []\n',
    }).enabled).toBe(true);
  });
});

// ─── detectStdFilename ────────────────────────────────────────────────────────

describe('detectStdFilename', () => {
  it('按代码特征选择扩展名', () => {
    expect(detectStdFilename('#include <bits/stdc++.h>\nint main(){}')).toBe('std.cc');
    expect(detectStdFilename('```cpp\nint main() { return 0; }\n```')).toBe('std.cc');
    expect(detectStdFilename('```c++\nint main() { return 0; }\n```')).toBe('std.cc');
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
    expect(sh).toContain('cc.cc17|cc.cc17o2) CPP_STD=c++17');
    expect(sh).toContain('cc.cc20|cc.cc20o2) CPP_STD=c++20');
    expect(sh).toContain('if [[ "$HYDRO_LANG" == *o2 ]]');
    expect(sh.trim().endsWith('fi')).toBe(true);
  });

  it('PyPy3 保留源码作为执行目标，不生成 CPython pyc', () => {
    const sh = buildCompileSh(['py']);
    expect(sh).toContain('if [[ "$HYDRO_LANG" == "py.pypy3" ]]');
    expect(sh).toContain('mv foo.py /w/foo');
    expect(sh).toContain('py_compile.compile');
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
    expect(yamlText).toContain('- py.pypy3');
    expect(yamlText).toContain('- cc.cc14o2');
    expect(yamlText).toContain('- cc.cc17o2');
    expect(yamlText).toContain('- cc.cc20o2');
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

  it('指定文件编号时按实际完整数字对生成配置', () => {
    const yamlText = buildConfigYaml({
      problemType: 'traditional', caseCount: 3, languages: [], caseNumbers: [5, 1, 3, 3],
    });
    expect(yamlText).toContain('input: 1.in');
    expect(yamlText).toContain('input: 3.in');
    expect(yamlText).toContain('input: 5.in');
    expect(yamlText).not.toContain('input: 2.in');
  });

  it('分层模式按题面 id/score 输出多个子任务，并把既有完整测试点并入第一个子任务', () => {
    const subtasks = [
      { id: 1, score: 30, constraints: 'n<=100' },
      { id: 2, score: 70, constraints: 'n<=100000' },
    ];
    const yamlText = buildConfigYaml({
      problemType: 'traditional',
      caseCount: 3,
      languages: [],
      caseNumbers: [1, 3, 4],
      newCaseNumbers: [3, 4],
      subtasks,
      subtaskAllocations: allocateCasesToSubtasks(2, subtasks),
    });
    const parsed = yaml.load(yamlText) as {
      subtasks: Array<{
        id: number;
        score: number;
        type: string;
        cases: Array<{ input: string; output: string }>;
      }>;
    };

    expect(parsed.subtasks).toEqual([
      {
        id: 1,
        score: 30,
        type: 'sum',
        cases: [
          { input: '1.in', output: '1.out' },
          { input: '3.in', output: '3.out' },
        ],
      },
      {
        id: 2,
        score: 70,
        type: 'sum',
        cases: [{ input: '4.in', output: '4.out' }],
      },
    ]);
  });

  it('更新测试点时保留现有 checker、时限与额外文件配置', () => {
    const existingConfig = [
      'type: default',
      'time: 2500ms',
      'memory: 512m',
      'checker_type: testlib',
      'checker: checker.cc',
      'judge_extra_files:',
      '  - checker.cc',
      'subtasks:',
      '  - score: 100',
      '    cases:',
      '      - input: old.in',
      '        output: old.out',
    ].join('\n');
    const yamlText = buildConfigYaml({
      problemType: 'traditional', caseCount: 1, languages: [], existingConfig,
    });
    expect(hasCustomChecker(existingConfig)).toBe(true);
    expect(yamlText).toContain('checker_type: testlib');
    expect(yamlText).toContain('checker: checker.cc');
    expect(yamlText).toContain('time: 2500ms');
    expect(yamlText).toContain('memory: 512m');
    expect(yamlText).toContain('input: 1.in');
    expect(yamlText).toContain('old.in');
  });

  it('if 式 subtasks 原文块逐字保留注释、引号与格式', () => {
    const rawSubtasks = [
      'subtasks:',
      '  # 教师手写规则，不得格式化',
      '  - id: "phase-a"',
      '    score: 100 # 行尾说明',
      '    if: ["1.in", "2.in"]',
    ].join('\n');
    const existingConfig = [
      'type: default',
      rawSubtasks,
      'time: 2500ms',
    ].join('\n');

    expect(extractRawTopLevelYamlEntry(existingConfig, 'subtasks')).toBe(`${rawSubtasks}\n`);
    const yamlText = buildConfigYaml({
      problemType: 'traditional',
      caseCount: 1,
      languages: [],
      existingConfig,
    });
    expect(yamlText).toContain(rawSubtasks);
    expect(yamlText).not.toContain('input: 1.in');
  });

  it('default/strict checker 不按自定义 checker 处理', () => {
    expect(hasCustomChecker('checker_type: default')).toBe(false);
    expect(hasCustomChecker('checker_type: strict')).toBe(false);
  });

  it('仅为 testlib 配置提取 checker 源文件名', () => {
    expect(getTestlibCheckerFilename(
      'checker_type: testlib\nchecker: checker/checker.cc\n',
    )).toBe('checker/checker.cc');
    expect(getTestlibCheckerFilename(
      'checker_type: default\nchecker: checker.cc\n',
    )).toBeUndefined();
    expect(getTestlibCheckerFilename(
      'checker_type: interactive\nchecker: checker.cc\n',
    )).toBeUndefined();
  });
});

describe('mergeConfigSubtasks', () => {
  it('无既有 subtasks 时保持扁平配置生成路径', () => {
    expect(mergeConfigSubtasks(undefined, [1, 2])).toBeUndefined();
    expect(mergeConfigSubtasks([], [1, 2])).toBeUndefined();
  });

  it('全 cases 式 subtasks 深拷贝保留并向最后一项追加排序后的新增测试点', () => {
    const existing = [
      {
        id: 1,
        score: 40,
        cases: [{ input: 'old-a.in', output: 'old-a.out' }],
      },
      {
        id: 2,
        score: 60,
        cases: [{ input: 'old-b.in', output: 'old-b.out' }],
      },
    ];
    const result = mergeConfigSubtasks(existing, [5, 3, 5]);

    expect(result).toEqual({
      subtasks: [
        {
          id: 1,
          score: 40,
          cases: [{ input: 'old-a.in', output: 'old-a.out' }],
        },
        {
          id: 2,
          score: 60,
          cases: [
            { input: 'old-b.in', output: 'old-b.out' },
            { input: '3.in', output: '3.out' },
            { input: '5.in', output: '5.out' },
          ],
        },
      ],
      note: {
        kind: 'system',
        message: '新增测试点 #3、#5 已并入子任务 2,请核对分值分配。',
      },
      newCaseSubtaskIds: { 3: 2, 5: 2 },
    });
    expect(result?.subtasks).not.toBe(existing);
    expect(result?.subtasks[0]).not.toBe(existing[0]);
    expect(existing[1].cases).toEqual([{ input: 'old-b.in', output: 'old-b.out' }]);
  });

  it('含 if 式 subtask 时深拷贝原样保留并返回未纳入警告', () => {
    const existing = [
      { id: 7, score: 100, if: ['1 <= id && id <= 2'], type: 'sum' },
    ];
    const result = mergeConfigSubtasks(existing, [4, 3]);

    expect(result).toEqual({
      subtasks: existing,
      note: {
        kind: 'warning',
        message: '该题已配置子任务;本次新增测试点 #3、#4 未纳入任何子任务,评测不会使用它们,请手动调整 config.yaml。',
      },
      newCaseSubtaskIds: {},
    });
    expect(result?.subtasks).not.toBe(existing);
    expect(result?.subtasks[0]).not.toBe(existing[0]);
  });
});

describe('assertExistingConfigParsable', () => {
  it('非空非法 YAML 抛出带用户消息 key 的 TestdataGenerationError', () => {
    expect.assertions(3);
    try {
      assertExistingConfigParsable('subtasks:\n  - cases: [1\n');
    } catch (err) {
      expect(err).toBeInstanceOf(TestdataGenerationError);
      expect((err as TestdataGenerationError).userMessageKey)
        .toBe('ai_helper_testdata_err_config_unparsable');
      expect((err as Error).message).toContain('为避免覆盖丢失配置已中止');
    }
  });

  it.each([
    ['合法配置', 'type: default\nsubtasks: []\n'],
    ['空配置', ' \n\t'],
    ['缺失配置', undefined],
  ])('%s 不受影响', (_label, raw) => {
    expect(() => assertExistingConfigParsable(raw)).not.toThrow();
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

describe('normalizeExecutableContent', () => {
  it('剥离完整包裹单个代码节的 Markdown 围栏', () => {
    expect(normalizeExecutableContent('```python\r\nprint(1)\r\n```'))
      .toBe('print(1)\n');
  });

  it('不删除代码内部的反引号内容', () => {
    expect(normalizeExecutableContent('print("```")'))
      .toBe('print("```")\n');
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

  it('提取常见 LeetCode 单行输入/输出展示，供独立调用转换 stdin', () => {
    const samples = extractStatementSamples([
      '### 示例 1',
      '输入：nums = [2, 7, 11, 15], target = 9',
      '输出： [0, 1]',
      '解释：因为 nums[0] + nums[1] = 9。',
      '### Example 2',
      'Input: nums = [3, 2, 4], target = 6',
      'Output: [1, 2]',
    ].join('\n'));
    expect(samples).toEqual([
      { id: '1', input: 'nums = [2, 7, 11, 15], target = 9\n', output: '[0, 1]\n' },
      { id: '2', input: 'nums = [3, 2, 4], target = 6\n', output: '[1, 2]\n' },
    ]);
  });
});

describe('Hydro 沙箱生成蓝图', () => {
  it('提示词要求 ACM 每个文件默认 T=1，并由标程实际生成输出', () => {
    const system = buildSandboxBlueprintSystemPrompt();
    expect(system).toContain('默认每个文件固定 T=1');
    expect(system).toContain('GENERATOR 只生成 .in，不生成答案');
    expect(system).toContain('ORACLE 是自包含、可直接运行的 Python 3 完整程序');
    expect(system).toContain('每个 input 的 UTF-8 内容必须小于 256KB');
    expect(system).toContain('全部 .in/.out 与辅助文件合计必须小于 1MB');
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

  it('剥离每个蓝图代码节各自携带的 Markdown 围栏', () => {
    const raw = [
      '@@@META@@@',
      'problemType: traditional',
      '@@@GENERATOR@@@',
      '```python',
      'print("generator")',
      '```',
      '@@@ORACLE@@@',
      '```python',
      'print(input())',
      '```',
    ].join('\n');
    const blueprint = parseSandboxBlueprint(
      raw,
      { problemKind: 'traditional', caseCount: 1, languages: [] },
    );
    expect(blueprint.generatorCode).toBe('print("generator")\n');
    expect(blueprint.oracleCode).toBe('print(input())\n');
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
      runPythonBatch: jest.fn(),
    };
    runner.runPythonBatchDetailed = jest.fn().mockResolvedValue([
      { status: 'Accepted', accepted: true, timedOut: false, exitStatus: 0, stdout: 'CBA\n', stderr: '' },
      { status: 'Accepted', accepted: true, timedOut: false, exitStatus: 0, stdout: 'Impossible\n', stderr: '' },
      { status: 'Accepted', accepted: true, timedOut: false, exitStatus: 0, stdout: 'CBA\nACB\n', stderr: '' },
    ]);
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
    expect(runner.runPythonBatchDetailed).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['2\nA>B\nC<B\nA>C\nA<B\nB>C\nC>A\n']),
      expect.anything(),
    );
  });

  it('自定义 checker 题只验证标程可运行，不用纯文本相等误拒多解输出', async () => {
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn().mockResolvedValue({
        stdout: JSON.stringify({ cases: [{ label: 'case', input: '1\n' }] }),
        stderr: '',
      }),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn().mockResolvedValue([
        { status: 'Accepted', accepted: true, timedOut: false, exitStatus: 0, stdout: 'answer\n', stderr: '' },
        { status: 'Accepted', accepted: true, timedOut: false, exitStatus: 0, stdout: 'different but valid\n', stderr: '' },
      ]),
    };
    const blueprint = parseSandboxBlueprint(
      makeSandboxBlueprint('traditional'),
      { problemKind: 'traditional', caseCount: 1, languages: [] },
    );
    const response = await materializeSandboxBlueprint(
      blueprint,
      { problemKind: 'traditional', caseCount: 1, languages: [] },
      coinStatementWithSample,
      runner,
      undefined,
      true,
    );
    expect(response.verification?.sampleCheck).toBeUndefined();
    expect(response.notes).toContain('自定义 checker');
  });

  it('可执行 checker 用 testlib 语义回归题面样例，而非纯文本比较', async () => {
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn().mockResolvedValue({
        stdout: JSON.stringify({ cases: [{ label: 'case', input: '1\n' }] }),
        stderr: '',
      }),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn().mockResolvedValue([
        { status: 'Accepted', accepted: true, timedOut: false, exitStatus: 0, stdout: 'answer\n', stderr: '' },
        { status: 'Accepted', accepted: true, timedOut: false, exitStatus: 0, stdout: 'different but valid\n', stderr: '' },
      ]),
    };
    const checkerExecutor = {
      status: 'ready' as const,
      runtimeSkipped: 0,
      runBatch: jest.fn().mockResolvedValue(['accept']),
      runChecker: jest.fn().mockResolvedValue('accept'),
      dispose: jest.fn(),
    };
    const blueprint = parseSandboxBlueprint(
      makeSandboxBlueprint('traditional'),
      { problemKind: 'traditional', caseCount: 1, languages: [] },
    );

    const response = await materializeSandboxBlueprint(
      blueprint,
      { problemKind: 'traditional', caseCount: 1, languages: [] },
      coinStatementWithSample,
      runner,
      undefined,
      true,
      undefined,
      [],
      false,
      checkerExecutor,
    );

    expect(checkerExecutor.runBatch).toHaveBeenCalledWith([{
      input: expect.any(String),
      output: 'different but valid\n',
      answer: expect.any(String),
    }], { signal: undefined });
    expect(response.verification?.sampleCheck).toEqual({ total: 1, passed: 1 });
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

  it('避开已有或残缺数字测试点，并将完整旧数据合并进 config', () => {
    const options: GenerateOptions = { problemKind: 'traditional', caseCount: 2, dataScale: 'auto', languages: [] };
    const response = parseGenerationResponse(makeAiJson({ problemType: 'traditional' }), options);
    const plan = assemblePlan(response, options, {
      existingFiles: ['1.in', '1.out', '2.in'],
    });
    const names = plan.files.map(file => file.name);
    expect(names).toEqual(expect.arrayContaining(['3.in', '3.out', '4.in', '4.out']));
    expect(names).not.toContain('2.out');
    expect(plan.totalCaseCount).toBe(3);
    expect(plan.caseCoverage?.map(item => item.fileNumber)).toEqual([3, 4]);
    expect(plan.caseCoverage?.map(item => item.dataScale)).toEqual(['small', 'large']);
    const config = plan.files.find(file => file.name === 'config.yaml')?.content || '';
    expect(config).toContain('input: 1.in');
    expect(config).toContain('input: 3.in');
    expect(config).toContain('input: 4.in');
    expect(config).not.toContain('input: 2.in');
  });

  it('启用分层时 config、覆盖元数据与结构化说明共享同一子任务分配', () => {
    const options: GenerateOptions = {
      problemKind: 'traditional',
      caseCount: 2,
      dataScale: 'auto',
      languages: [],
    };
    const response = parseGenerationResponse(makeAiJson({ problemType: 'traditional' }), options);
    response.subtasks = [
      { id: 1, score: 30, constraints: 'n<=100' },
      { id: 2, score: 70, constraints: 'n<=100000' },
    ];
    const plan = assemblePlan(response, options, {
      mode: 'sandbox',
      existingFiles: ['1.in', '1.out', '2.in'],
    });
    const config = yaml.load(
      plan.files.find(file => file.name === 'config.yaml')?.content || '',
    ) as {
      subtasks: Array<{
        id: number;
        score: number;
        cases: Array<{ input: string; output: string }>;
      }>;
    };

    expect(config.subtasks).toEqual([
      {
        id: 1,
        score: 30,
        type: 'sum',
        cases: [
          { input: '1.in', output: '1.out' },
          { input: '3.in', output: '3.out' },
        ],
      },
      {
        id: 2,
        score: 70,
        type: 'sum',
        cases: [{ input: '4.in', output: '4.out' }],
      },
    ]);
    expect(plan.caseCoverage?.map(item => item.subtaskId)).toEqual([1, 2]);
    expect(plan.notesStructured?.warnings).toContain(
      '既有完整测试点 #1 已并入子任务 1,请人工复核其子任务归属。',
    );
    expect(plan.notesStructured?.system).toContain(
      '已按题面子任务表生成 2 档分层数据;VALIDATOR 仅机器校验全局约束,各子任务档位约束由生成器构造保证,建议抽查各档 .in 是否符合对应约束',
    );
    expect(plan.notes).not.toContain('子任务分值合计为');
  });

  it('子任务分值合计非 100 时禁用分层配置并给出普通模式警告', () => {
    const options: GenerateOptions = {
      problemKind: 'traditional',
      caseCount: 2,
      dataScale: 'auto',
      languages: [],
    };
    const response = parseGenerationResponse(makeAiJson({ problemType: 'traditional' }), options);
    response.subtasks = [
      { id: 1, score: 30, constraints: 'n<=100' },
      { id: 2, score: 60, constraints: 'n<=100000' },
    ];
    const plan = assemblePlan(response, options);
    const config = yaml.load(
      plan.files.find(file => file.name === 'config.yaml')?.content || '',
    ) as { subtasks: Array<{ id: number; score: number }> };
    const warning = '子任务分值合计为 90,非 100,已按普通模式输出配置';

    expect(config.subtasks).toEqual([expect.objectContaining({ id: 1, score: 100 })]);
    expect(plan.caseCoverage?.every(item => item.subtaskId === undefined)).toBe(true);
    expect(plan.notesStructured?.warnings).toContain(warning);
    expect(plan.notes).toContain(warning);
  });

  it('组装消费本轮冻结的分层决策，不因后续蓝图子任务漂移而重新分配', () => {
    const options: GenerateOptions = {
      problemKind: 'traditional',
      caseCount: 2,
      dataScale: 'auto',
      languages: [],
    };
    const frozenSubtasks = [
      { id: 1, score: 40, constraints: 'n<=100' },
      { id: 2, score: 60, constraints: 'n<=100000' },
    ];
    const tieredDecision = resolveTieredSubtaskGeneration({
      caseCount: 2,
      dataScale: 'auto',
      subtasks: frozenSubtasks,
    });
    const response = parseGenerationResponse(makeAiJson({ problemType: 'traditional' }), options);
    response.subtasks = [{ id: 7, score: 100, constraints: '修复响应中的漂移规格' }];

    const plan = assemblePlan(response, options, { tieredDecision });
    const config = yaml.load(
      plan.files.find(file => file.name === 'config.yaml')?.content || '',
    ) as { subtasks: Array<{ id: number; score: number }> };

    expect(config.subtasks.map(({ id, score }) => ({ id, score }))).toEqual([
      { id: 1, score: 40 },
      { id: 2, score: 60 },
    ]);
    expect(plan.caseCoverage?.map(item => item.subtaskId)).toEqual([1, 2]);
  });

  it.each([
    {
      name: '无 SUBTASKS',
      subtasks: undefined,
      options: { problemKind: 'traditional', caseCount: 2, dataScale: 'auto', languages: [] } as GenerateOptions,
      context: {},
      warning: undefined,
      expectedSubtaskIds: undefined,
    },
    {
      name: '既有 config 含 subtasks',
      subtasks: [
        { id: 1, score: 30, constraints: 'n<=100' },
        { id: 2, score: 70, constraints: 'n<=100000' },
      ],
      options: { problemKind: 'traditional', caseCount: 2, dataScale: 'auto', languages: [] } as GenerateOptions,
      context: {
        existingConfig: 'subtasks:\n  - id: 9\n    score: 100\n    cases: []\n',
      },
      warning: undefined,
      expectedSubtaskIds: [9, 9],
    },
    {
      name: '非 auto 规模',
      subtasks: [
        { id: 1, score: 30, constraints: 'n<=100' },
        { id: 2, score: 70, constraints: 'n<=100000' },
      ],
      options: { problemKind: 'traditional', caseCount: 2, dataScale: 'medium', languages: [] } as GenerateOptions,
      context: {},
      warning: undefined,
      expectedSubtaskIds: undefined,
    },
    {
      name: '请求测试点不足',
      subtasks: [
        { id: 1, score: 20, constraints: 'n<=10' },
        { id: 2, score: 30, constraints: 'n<=100' },
        { id: 3, score: 50, constraints: 'n<=1000' },
      ],
      options: { problemKind: 'traditional', caseCount: 2, dataScale: 'auto', languages: [] } as GenerateOptions,
      context: {},
      warning: '题面含 3 个子任务但仅请求 2 个测试点,已按普通模式生成;建议将测试点数提高到 ≥3 后重新生成以获得分层数据',
      expectedSubtaskIds: undefined,
    },
  ])('四条件回退集成：$name 时 config 保持既有语义', ({
    subtasks, options, context, warning, expectedSubtaskIds,
  }) => {
    const response = parseGenerationResponse(makeAiJson({ problemType: 'traditional' }), options);
    response.subtasks = subtasks;
    const plan = assemblePlan(response, options, context);
    const config = yaml.load(
      plan.files.find(file => file.name === 'config.yaml')?.content || '',
    ) as { subtasks: Array<{ score: number }> };

    if (expectedSubtaskIds) {
      expect(plan.caseCoverage?.map(item => item.subtaskId)).toEqual(expectedSubtaskIds);
    } else {
      expect(plan.caseCoverage?.every(item => item.subtaskId === undefined)).toBe(true);
    }
    expect(plan.notesStructured?.system.some(note => note.includes('已按题面子任务表生成'))).toBe(false);
    if (context.existingConfig) {
      expect(config.subtasks[0].score).toBe(100);
    } else {
      expect(config.subtasks).toHaveLength(1);
      expect(config.subtasks[0].score).toBe(100);
    }
    if (warning) {
      expect(plan.notesStructured?.warnings).toContain(warning);
      expect(plan.notes).toContain(warning);
    }
  });

  it('既有显式 cases 子任务保持顺序并将排序后的新增编号追加到最后一项', () => {
    const options: GenerateOptions = {
      problemKind: 'traditional',
      caseCount: 2,
      languages: [],
    };
    const response = parseGenerationResponse(
      makeAiJson({ problemType: 'traditional' }),
      options,
    );
    const plan = assemblePlan(response, options, {
      existingFiles: ['1.in', '1.out', '2.in'],
      existingConfig: [
        'type: default',
        'subtasks:',
        '  - id: 1',
        '    score: 40',
        '    cases:',
        '      - input: 1.in',
        '        output: 1.out',
        '  - id: 9',
        '    score: 60',
        '    cases:',
        '      - input: old.in',
        '        output: old.out',
      ].join('\n'),
    });

    const config = plan.files.find(file => file.name === 'config.yaml')?.content || '';
    expect(config.indexOf('id: 1')).toBeLessThan(config.indexOf('id: 9'));
    expect(config).toContain('input: old.in');
    expect(config.indexOf('input: 3.in')).toBeLessThan(config.indexOf('input: 4.in'));
    expect(plan.notesStructured?.system).toContain(
      '新增测试点 #3、#4 已并入子任务 9,请核对分值分配。',
    );
    expect(plan.notes).toContain('新增测试点 #3、#4 已并入子任务 9,请核对分值分配。');
    expect(plan.caseCoverage?.map(item => item.subtaskId)).toEqual([9, 9]);
  });

  it('既有 if 式子任务不接收新增测试点并在结构化与 legacy 说明中警告', () => {
    const options: GenerateOptions = {
      problemKind: 'traditional',
      caseCount: 2,
      languages: [],
    };
    const response = parseGenerationResponse(
      makeAiJson({ problemType: 'traditional' }),
      options,
    );
    const warning = '该题已配置子任务;本次新增测试点 #3、#4 未纳入任何子任务,评测不会使用它们,请手动调整 config.yaml。';
    const plan = assemblePlan(response, options, {
      existingFiles: ['1.in', '1.out', '2.in'],
      existingConfig: [
        'type: default',
        'subtasks:',
        '  - id: 1',
        '    score: 100',
        '    if:',
        '      - 1 <= id && id <= 2',
      ].join('\n'),
    });

    const config = plan.files.find(file => file.name === 'config.yaml')?.content || '';
    expect(config).toContain('1 <= id && id <= 2');
    expect(config).not.toContain('input: 3.in');
    expect(config).not.toContain('input: 4.in');
    expect(plan.notesStructured?.warnings).toContain(warning);
    expect(plan.notes).toContain(warning);
  });

  it('区分度命中编号与补刀说明使用实际分配的测试点文件编号', () => {
    const options: GenerateOptions = {
      problemKind: 'traditional',
      caseCount: 2,
      languages: [],
    };
    const response = parseGenerationResponse(
      makeAiJson({ problemType: 'traditional' }),
      options,
    );
    response.discriminationInitialCaseCount = 1;
    response.verification = {
      mode: 'sandbox',
      oracleKind: 'ai-solution',
      discrimination: {
        targets: [{
          kind: 'wrong-algorithm',
          description: '错误贪心',
          killed: true,
          killedBy: 'wa',
          killedByCase: 2,
        }],
        allKilled: true,
      },
    };

    const plan = assemblePlan(response, options, {
      mode: 'sandbox',
      existingFiles: ['1.in', '1.out', '2.in'],
    });

    expect(plan.caseCoverage?.map(item => item.fileNumber)).toEqual([3, 4]);
    expect(plan.verification?.discrimination?.targets[0].killedByCase).toBe(4);
    expect(plan.notes).toContain('已为「错误贪心」错误解定向补充 hack 测试点 #4。');
  });

  it('结构化说明分类系统事实、警告与 AI 自述，同时保持 legacy notes 顺序不变', () => {
    const options: GenerateOptions = {
      problemKind: 'traditional',
      caseCount: 2,
      languages: [],
    };
    const response = parseGenerationResponse(
      makeAiJson({ problemType: 'traditional' }),
      options,
    );
    response.notes = 'AI 自述。\n系统事实。\n已有警告。';
    response.notesStructured = {
      warnings: ['已有警告。'],
      system: ['系统事实。'],
      ai: 'AI 自述。',
    };
    response.discriminationInitialCaseCount = 1;
    response.verification = {
      mode: 'sandbox',
      oracleKind: 'ai-solution',
      discrimination: {
        targets: [
          {
            kind: 'boundary',
            description: '遗漏边界',
            killed: true,
            killedBy: 'wa',
            killedByCase: 2,
          },
          {
            kind: 'wrong-algorithm',
            description: '错误贪心',
            killed: false,
          },
        ],
        allKilled: false,
      },
    };

    const plan = assemblePlan(response, options, { mode: 'sandbox' });

    expect(plan.notes).toBe([
      response.notes,
      '已为「遗漏边界」错误解定向补充 hack 测试点 #2。',
      '警告:一个「错误贪心」类错误解通过了全部数据与定向补刀,建议教师针对该错误模式人工补充测试点。',
    ].join('\n'));
    expect(plan.notesStructured).toEqual({
      warnings: [
        '已有警告。',
        '警告:一个「错误贪心」类错误解通过了全部数据与定向补刀,建议教师针对该错误模式人工补充测试点。',
      ],
      system: [
        '系统事实。',
        '已为「遗漏边界」错误解定向补充 hack 测试点 #2。',
      ],
      ai: 'AI 自述。',
    });
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
    expect(up).toContain('逐测试点覆盖计划');
    expect(up).toContain('CASE 1: small');
    expect(up).toContain('CASE 5: large');
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

  it('历史 AC 在 Prompt 中明确标为非权威候选解', () => {
    const up = buildTestdataUserPrompt({
      problemTitle: 't', statementMarkdown: '题面',
      options: {
        problemKind: 'traditional', caseCount: 1, languages: [],
        providedStd: 'print(input())', providedStdSource: 'accepted-record',
      },
    });
    expect(up).toContain('历史 AC 候选解');
    expect(up).toContain('不是权威');
    expect(up).toContain('独立 BRUTE 压力验证');
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

describe('stage-specific sandbox repair', () => {
  const options: GenerateOptions = { problemKind: 'traditional', caseCount: 2, dataScale: 'auto', languages: [] };

  it('按单一变更产物解析最早重跑阶段与可复用集合，未知或组合变更保守全量重跑', () => {
    const none = {
      formalInputs: false,
      stressInputs: false,
      validationResults: false,
      oracleOutputs: false,
    };
    expect(resolveMaterializationResume(['GENERATOR'])).toEqual({
      phase: 'generator',
      reuse: none,
    });
    expect(resolveMaterializationResume(['full'])).toEqual({
      phase: 'generator',
      reuse: none,
    });
    expect(resolveMaterializationResume(['STRESS_GENERATOR'])).toEqual({
      phase: 'stress-generator',
      reuse: { ...none, formalInputs: true },
    });
    expect(resolveMaterializationResume(['VALIDATOR'])).toEqual({
      phase: 'validator',
      reuse: { ...none, formalInputs: true, stressInputs: true },
    });
    for (const artifact of ['ORACLE', 'SOLUTION']) {
      expect(resolveMaterializationResume([artifact])).toEqual({
        phase: 'oracle',
        reuse: {
          ...none,
          formalInputs: true,
          stressInputs: true,
          validationResults: true,
        },
      });
    }
    expect(resolveMaterializationResume(['BRUTE'])).toEqual({
      phase: 'brute',
      reuse: {
        formalInputs: true,
        stressInputs: true,
        validationResults: true,
        oracleOutputs: true,
      },
    });
    expect(resolveMaterializationResume(['template.py'])).toEqual({
      phase: 'template',
      reuse: {
        formalInputs: true,
        stressInputs: true,
        validationResults: true,
        oracleOutputs: true,
      },
    });
    expect(resolveMaterializationResume(['UNKNOWN'])).toEqual({
      phase: 'generator',
      reuse: none,
    });
    expect(resolveMaterializationResume(['ORACLE', 'BRUTE'])).toEqual({
      phase: 'generator',
      reuse: none,
    });
    expect(resolveMaterializationResume([])).toEqual({
      phase: 'generator',
      reuse: none,
    });
  });

  it('按错误阶段分类并生成定向提示词', () => {
    expect(classifySandboxRepairScope(new Error('GENERATOR 实跑失败：Output Limit Exceeded'))).toBe('generator');
    expect(classifySandboxRepairScope(new Error('STRESS_GENERATOR 输出无效'))).toBe('stress-generator');
    expect(classifySandboxRepairScope(new Error('STRESS_GENERATOR 压力数据多样性不足'))).toBe('stress-generator');
    expect(classifySandboxRepairScope(new Error('第 3 个 .in 未通过输入校验'))).toBe('generator');
    expect(classifySandboxRepairScope(new Error('第 3 个压力 .in 未通过输入校验'))).toBe('validator');
    expect(classifySandboxRepairScope(new Error('ORACLE 未通过题面样例 1'))).toBe('oracle');
    expect(classifySandboxRepairScope(new Error('函数题样例 1 转码后仍是源码赋值写法'))).toBe('function-samples');
    expect(classifySandboxRepairScope(new Error('ORACLE 未通过函数题样例 1'))).toBe('oracle');
    expect(classifySandboxRepairScope(new Error('暴力解与标程不一致'))).toBe('brute');
    expect(classifySandboxRepairScope(new Error('压力对拍 BRUTE 与 ORACLE 不一致'))).toBe('brute');
    expect(classifySandboxRepairScope(new Error('AC 候选标程与独立 BRUTE 不一致'))).toBe('accepted-std');
    expect(classifySandboxRepairScope(new Error('template.py 与标程不一致'))).toBe('template-py');
    expect(classifySandboxRepairScope(new Error('未知协议错误'))).toBe('full');
    expect(buildSandboxRepairPrompt(new Error('GENERATOR 超时'), options, 'generator')).toContain('只输出修复后的 @@@GENERATOR@@@');
    expect(buildSandboxRepairPrompt(new Error('第 3 个压力 .in 未通过输入校验'), options, 'validator'))
      .toContain('同时输出修复后的 @@@GENERATOR@@@ 与 @@@VALIDATOR@@@');
    const cppCompileFailure = new TestdataPipelineError(
      'arbitrary compile wording A',
      'ORACLE_COMPILE_FAILED',
      'oracle',
      'oracle',
      'repair-artifact',
      { failureKind: 'compile', oracleLanguage: 'cpp' },
    );
    const cppRepair = buildSandboxRepairPrompt(
      cppCompileFailure,
      options,
      'oracle',
    );
    expect(cppRepair).toContain('当前 ORACLE 语言为 C++17');
    const sameTypedCppRepair = buildSandboxRepairPrompt(
      new TestdataPipelineError(
        'completely different localized wording B',
        'ORACLE_COMPILE_FAILED',
        'oracle',
        'oracle',
        'repair-artifact',
        { failureKind: 'compile', oracleLanguage: 'cpp' },
      ),
      options,
      'oracle',
    );
    expect(sameTypedCppRepair).toContain('当前 ORACLE 语言为 C++17');
    const cppInfraRepair = buildSandboxRepairPrompt(
      new TestdataPipelineError(
        'arbitrary infrastructure wording',
        'ORACLE_COMPILE_FAILED',
        'oracle',
        'oracle',
        'repair-artifact',
        { failureKind: 'infra', oracleLanguage: 'cpp' },
      ),
      options,
      'oracle',
    );
    expect(cppInfraRepair).toContain('改用 Python 3');
    expect(cppInfraRepair).not.toContain('保持该语言不变');
    expect(buildSandboxRepairPrompt(new Error('未知协议错误'), options))
      .toContain('若输出 @@@NOTES@@@，NOTES 至多 2 句');
    const tieredCoverage = allocateCasesToSubtasks(3, [
      { id: 1, score: 40, constraints: 'n<=100' },
      { id: 2, score: 60, constraints: 'n<=100000' },
    ]);
    for (const scope of ['generator', 'full'] as const) {
      const prompt = buildSandboxRepairPrompt(
        new Error(scope === 'generator' ? 'GENERATOR 超时' : '未知协议错误'),
        { ...options, caseCount: 3 },
        scope,
        tieredCoverage,
      );
      expect(prompt).toContain('CASE 1: 子任务 1 — n<=100;数据必须严格满足本子任务的全部约束');
      expect(prompt).toContain('CASE 3: 子任务 2 — n<=100000;数据必须严格满足本子任务的全部约束');
      expect(prompt).not.toContain('CASE 1: small');
    }
  });

  it('定向替换 GENERATOR 并保留已验证的 ORACLE', () => {
    const original = parseSandboxBlueprint(makeSandboxBlueprint('traditional'), options);
    const merged = mergeSandboxBlueprintRepair(
      original,
      '@@@GENERATOR@@@\nimport json\nprint(json.dumps({"cases": []}, separators=(",", ":")))',
      'generator',
    );
    expect(merged.generatorCode).toContain('separators');
    expect(merged.oracleCode).toBe(original.oracleCode);
  });

  it('Python 模板修复必须成对替换 SOLUTION 与 TEMPLATE:py', () => {
    const fnOptions: GenerateOptions = { problemKind: 'function', caseCount: 1, languages: ['py'] };
    const original = parseSandboxBlueprint(makeSandboxBlueprint('function'), fnOptions, { allowMissingTemplates: true });
    const merged = mergeSandboxBlueprintRepair(
      original,
      '@@@SOLUTION@@@\ndef solve(x):\n    return x\n@@@TEMPLATE:py@@@\nprint(solve(input()))',
      'template-py',
    );
    expect(merged.solutionCode).toContain('def solve');
    expect(merged.templates?.py).toContain('print(solve');
  });

  it('输入校验修复必须同时替换 GENERATOR 与 VALIDATOR', () => {
    const original = parseSandboxBlueprint(makeSandboxBlueprint('traditional'), options);
    expect(() => mergeSandboxBlueprintRepair(
      original,
      '@@@GENERATOR@@@\nprint("{}")',
      'validator',
    )).toThrow(/未返回 VALIDATOR/);

    const merged = mergeSandboxBlueprintRepair(
      original,
      '@@@GENERATOR@@@\nprint("{}")\n@@@VALIDATOR@@@\nimport sys\nsys.exit(0)',
      'validator',
    );
    expect(merged.generatorCode).toContain('print');
    expect(merged.validatorCode).toContain('sys.exit');
  });

  it('最终失败携带模型与阶段遥测元数据', () => {
    const err = new TestdataGenerationError('failed', 'oracle', [{
      content: 'x',
      usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
    }] as never, true);
    expect(extractTestdataErrorMetadata(err)).toEqual(expect.objectContaining({
      failureStage: 'oracle',
      endpointName: 'main',
      modelName: 'gpt-test',
      usedModels: ['main/gpt-test'],
      aiAttemptCount: 1,
      recommendDeeperReasoning: true,
    }));
    expect(shouldRecommendDeeperReasoning(err)).toBe(true);
    expect(shouldRecommendDeeperReasoning(new Error('network'))).toBe(false);
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
  it('best-effort checker 耗时扩展正确性截止时间，不消耗主预算', () => {
    expect(extendDeadlineByBestEffortElapsed(10_000, 2_000, 7_500)).toBe(15_500);
    expect(extendDeadlineByBestEffortElapsed(10_000, 7_500, 2_000)).toBe(10_000);
  });

  it('非法既有 config 在任何 AI 或沙箱调用前中止', async () => {
    const mockClient = { chat: jest.fn() };
    const runner = {
      isAvailable: jest.fn(),
      runPython: jest.fn(),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn(),
    };
    const promise = new TestdataGenService(mockClient as never, {
      sandboxRunner: runner,
      mode: 'sandbox',
    }).generate({
      problemTitle: '配置守卫',
      statementMarkdown: '题面',
      options: { problemKind: 'traditional', caseCount: 1, languages: [] },
      existingConfig: 'subtasks:\n  - cases: [1\n',
    });

    await expect(promise).rejects.toMatchObject({
      code: 'SPEC_PARSE_FAILED',
      stage: 'config_parse',
      artifact: 'spec',
      retryPolicy: 'no-retry',
      userMessageKey: 'ai_helper_testdata_err_config_unparsable',
      telemetryMetadata: expect.objectContaining({ failureStage: 'config_parse' }),
    });
    expect(mockClient.chat).not.toHaveBeenCalled();
    expect(runner.isAvailable).not.toHaveBeenCalled();
  });

  it('真实外围制品二次解析失败保持 artifacts_parse 契约且不误启完整模型重跑', async () => {
    // Mutation caught: artifacts_parse falling back to UNKNOWN/pipeline or input-validity routing.
    const usedModel = { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' };
    const mockClient = {
      chat: jest.fn()
        .mockResolvedValueOnce({ content: makeSolutionBlueprint('traditional'), usedModel })
        .mockResolvedValueOnce({ content: makeEmptyKillTargetsResponse(), usedModel })
        .mockResolvedValueOnce({ content: 'not generation artifacts', usedModel })
        .mockResolvedValueOnce({ content: makeIndependentVerifierBlueprint(), usedModel })
        .mockResolvedValueOnce({ content: 'still not generation artifacts', usedModel }),
      createClientStartingAfter: jest.fn(),
    };
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn(),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn(),
    };

    const promise = new TestdataGenService(mockClient as never, {
      sandboxRunner: runner,
      mode: 'sandbox',
    }).generate({
      problemTitle: '外围制品解析守卫',
      statementMarkdown: '题面',
      options: { problemKind: 'traditional', caseCount: 1, languages: [] },
    });

    await expect(promise).rejects.toMatchObject({
      code: 'GENERATOR_INVALID_JSON',
      stage: 'artifacts_parse',
      artifact: 'generator',
      retryPolicy: 'repair-artifact',
      recommendDeeperReasoning: true,
    });
    expect(mockClient.chat).toHaveBeenCalledTimes(5);
    expect(mockClient.chat.mock.calls[4][0][2].content).toContain('重新完整输出 @@@GENERATOR@@@');
    expect(mockClient.createClientStartingAfter).toHaveBeenCalledTimes(1);
    expect(mockClient.createClientStartingAfter).toHaveBeenCalledWith(usedModel);
    expect(runner.runPython).not.toHaveBeenCalled();
  });

  it('真实函数题压力输入赋值写法在修复请求失败后保持 function-samples 契约', async () => {
    // Mutation caught: function-samples falling back to UNKNOWN/pipeline or repairing the main generator.
    const usedModel = { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' };
    const assignmentStressCases = Array.from(
      { length: TESTDATA_GEN_LIMITS.STRESS_CASES },
      (_, index) => ({ label: `stress-${index}`, input: `value = ${index}` }),
    );
    const mockClient = {
      chat: jest.fn()
        .mockResolvedValueOnce({ content: makeSolutionBlueprint('function'), usedModel })
        .mockResolvedValueOnce({ content: makeEmptyKillTargetsResponse(), usedModel })
        .mockResolvedValueOnce({ content: makeGenerationArtifactsBlueprint('function'), usedModel })
        .mockResolvedValueOnce({ content: makeIndependentVerifierBlueprint(), usedModel })
        .mockRejectedValueOnce(new Error('repair endpoint unavailable')),
      createClientStartingAfter: jest.fn(),
    };
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn()
        .mockResolvedValueOnce({
          stdout: JSON.stringify({ cases: [{ label: 'formal', input: '1' }] }),
          stderr: '',
        })
        .mockResolvedValueOnce({ stdout: JSON.stringify({ cases: assignmentStressCases }), stderr: '' }),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn(),
    };

    const promise = new TestdataGenService(mockClient as never, {
      sandboxRunner: runner,
      mode: 'sandbox',
    }).generate({
      problemTitle: '函数输入协议守卫',
      statementMarkdown: '函数题无公开样例',
      options: { problemKind: 'function', caseCount: 1, languages: [] },
    });

    await expect(promise).rejects.toMatchObject({
      code: 'GENERATOR_INVALID_INPUT',
      stage: 'function-samples',
      artifact: 'stress-generator',
      retryPolicy: 'repair-artifact',
      recommendDeeperReasoning: false,
    });
    expect(mockClient.chat).toHaveBeenCalledTimes(5);
    expect(mockClient.chat.mock.calls[4][0][2].content).toContain('独立验证制品未通过');
    expect(mockClient.chat.mock.calls[4][0][2].content).toContain('同一原始 stdin 编码');
    expect(mockClient.createClientStartingAfter).not.toHaveBeenCalled();
  });

  it('checkpoint 命中四项制品时跳过对应 AI 调用但仍完整运行沙箱', async () => {
    const options: GenerateOptions = {
      problemKind: 'traditional',
      caseCount: 1,
      languages: [],
    };
    const checkpoint = {
      solution: parseSolutionBlueprint(
        makeSolutionBlueprint('traditional'),
        options,
        [],
      ),
      artifacts: parseGenerationArtifacts(
        makeGenerationArtifactsBlueprint('traditional'),
        'traditional',
        [],
      ),
      verifier: parseIndependentVerifierBlueprint(
        makeIndependentVerifierBlueprint(),
        [],
      ),
      killTargets: [],
    };
    const mockClient = { chat: jest.fn() };
    const onCheckpoint = jest.fn().mockRejectedValue(new Error('checkpoint store unavailable'));
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn().mockImplementation((code: string) => Promise.resolve({
        stdout: code.includes('stress generator')
          ? stressGeneratorStdout()
          : JSON.stringify({ cases: [{ label: '正式', input: '1' }] }),
        stderr: '',
      })),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn().mockImplementation(
        (code: string, inputs: string[]) => Promise.resolve(inputs.map(input =>
          code.includes('sys.exit(0)') ? detail() : detail({ stdout: input }))),
      ),
    };

    const plan = await new TestdataGenService(mockClient as never, {
      sandboxRunner: runner,
      mode: 'sandbox',
    }).generate({
      problemTitle: '断点续跑',
      statementMarkdown: '题面',
      options,
      checkpoint,
      onCheckpoint,
    });

    expect(mockClient.chat).not.toHaveBeenCalled();
    expect(onCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      solution: checkpoint.solution,
      artifacts: checkpoint.artifacts,
      verifier: checkpoint.verifier,
      killTargets: [],
    }));
    expect(runner.runPython).toHaveBeenCalledTimes(2);
    expect(runner.runPythonBatchDetailed).toHaveBeenCalled();
    expect(plan.files.find(file => file.name === '1.out')?.content).toBe('1\n');
  });

  it('调用 AI 客户端并返回组装后的计划', async () => {
    const progress: Array<{ stage: string; percent: number; attempt: number }> = [];
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
      onProgress: event => progress.push(event),
    });
    expect(mockClient.chat).toHaveBeenCalledTimes(1);
    const [messages, systemPrompt, callOptions] = mockClient.chat.mock.calls[0];
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toContain('提莫攻击');
    expect(systemPrompt).toContain('JSON');
    // 不限输出长度，且不由插件为长推理设置截止时间。
    expect(callOptions.maxTokens).toBeNull();
    expect(callOptions.timeoutMs).toBeNull();
    expect(callOptions.retryTimeouts).toBe(false);
    expect(plan.files.map(f => f.name)).toContain('config.yaml');
    expect(plan.tokenUsage?.totalTokens).toBe(300);
    expect(plan.usedModel).toBe('main/gpt-test');
    expect(progress.map(event => event.stage)).toEqual(expect.arrayContaining([
      'preparing', 'blueprint', 'assembling', 'complete',
    ]));
    expect(progress[progress.length - 1]).toEqual({ stage: 'complete', percent: 100, attempt: 1 });
  });

  it('沙箱模式并发生成三个独立阶段，错误解靶子失败仍继续组装文件', async () => {
    const progress: Array<{ stage: string; percent: number; attempt: number }> = [];
    let releaseIndependentStages!: () => void;
    const independentStagesGate = new Promise<void>(resolve => {
      releaseIndependentStages = resolve;
    });
    const mockClient = {
      chat: jest.fn()
        .mockResolvedValueOnce({
          content: makeSolutionBlueprint('traditional'),
          usage: { promptTokens: 50, completionTokens: 80, totalTokens: 130 },
          usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
        })
        .mockImplementationOnce(async () => {
          await independentStagesGate;
          throw new Error('kill target unavailable');
        })
        .mockImplementationOnce(async () => {
          await independentStagesGate;
          return {
            content: makeGenerationArtifactsBlueprint('traditional'),
            usage: { promptTokens: 20, completionTokens: 30, totalTokens: 50 },
            usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
          };
        })
        .mockImplementationOnce(async () => {
          await independentStagesGate;
          return {
            content: makeIndependentVerifierBlueprint(),
            usage: { promptTokens: 30, completionTokens: 50, totalTokens: 80 },
            usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
          };
        }),
    };
    const stressInputs = Array.from({ length: TESTDATA_GEN_LIMITS.STRESS_CASES }, (_, i) => `${i + 1}\n`);
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPythonBatchDetailed: jest.fn()
        .mockResolvedValueOnce(Array.from(
          { length: 2 + TESTDATA_GEN_LIMITS.STRESS_CASES }, () => detail(),
        ))
        .mockResolvedValueOnce([
          detail({ stdout: 'CBA\n' }),
          detail({ stdout: 'Impossible\n' }),
          ...stressInputs.map(input => detail({ stdout: input })),
        ])
        .mockResolvedValueOnce(stressInputs.map(input => detail({ stdout: input }))),
      runPython: jest.fn()
        .mockResolvedValueOnce({
          stdout: JSON.stringify({ cases: [
            { label: '有效排序', input: '1\nA>B\nC<B\nA>C' },
            { label: '循环矛盾', input: '1\nA>B\nB>C\nC>A' },
          ] }),
          stderr: '',
        })
        .mockResolvedValueOnce({ stdout: stressGeneratorStdout(), stderr: '' }),
      runPythonBatch: jest.fn(),
    };
    const service = new TestdataGenService(mockClient as never, {
      sandboxRunner: runner,
      mode: 'sandbox',
    });
    const generationPromise = service.generate({
      problemTitle: '三枚硬币',
      statementMarkdown: groupedCoinStatement,
      options: { problemKind: 'traditional', caseCount: 2, languages: [] },
      onProgress: event => progress.push(event),
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(mockClient.chat).toHaveBeenCalledTimes(4);
    expect(mockClient.chat.mock.calls[1][2]).toEqual(expect.objectContaining({
      timeoutMs: 120_000,
    }));
    releaseIndependentStages();
    const plan = await generationPromise;

    expect(runner.isAvailable).toHaveBeenCalled();
    expect(mockClient.chat).toHaveBeenCalledTimes(4);
    expect(mockClient.chat.mock.calls[0][1]).toContain('本阶段只解决题目');
    expect(mockClient.chat.mock.calls[0][1]).not.toContain('@@@GENERATOR@@@');
    expect(mockClient.chat.mock.calls[1][1]).toContain('错误解分析专家');
    expect(mockClient.chat.mock.calls[2][1]).toContain('本阶段不得修改算法');
    expect(mockClient.chat.mock.calls[2][1]).not.toContain('@@@ORACLE@@@');
    expect(mockClient.chat.mock.calls[3][0]).toHaveLength(1);
    expect(mockClient.chat.mock.calls[3][0][0].content).not.toContain('print(input())');
    expect(plan.files.find(file => file.name === '1.in')?.content).toBe('1\nA>B\nC<B\nA>C\n');
    expect(plan.files.find(file => file.name === '1.out')?.content).toBe('CBA\n');
    expect(plan.files.map(file => file.name)).toEqual(expect.arrayContaining([
      'generator.py', 'std.py', 'config.yaml',
    ]));
    expect(plan.notes).toContain('Hydro 沙箱中实际运行');
    expect(plan.notesStructured?.ai).toBe('解题蓝图。\n外围制品。');
    expect(plan.notesStructured?.system).toContain(
      '测试输入由生成器产生，所有 .out 已在 Hydro 沙箱中实际运行 Python 标程生成。',
    );
    expect(plan.notesStructured?.warnings).not.toContain('解题蓝图。');
    expect(plan.notesStructured?.system).not.toContain('外围制品。');
    expect(plan.verification?.stressCheck?.agreed).toBe(TESTDATA_GEN_LIMITS.STRESS_CASES);
    expect(runner.runPython.mock.calls.every(call => typeof call[3] === 'number')).toBe(true);
    expect(runner.runPythonBatchDetailed.mock.calls.every(call => typeof call[2]?.deadlineAt === 'number')).toBe(true);
    expect(progress.map(event => event.stage)).toEqual(expect.arrayContaining([
      'sandbox_check', 'blueprint', 'solution_verification', 'artifacts',
      'independent_verifier', 'generating_inputs',
      'validating_inputs', 'running_oracle', 'stress_testing',
      'discrimination_testing', 'assembling', 'complete',
    ]));
  });

  it('错误解靶子请求的 AbortError 原样上抛且不触发语义升级', async () => {
    const usedModel = { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' };
    const abortError = Object.assign(new Error('user canceled'), { name: 'AbortError' });
    const mockClient = {
      chat: jest.fn()
        .mockResolvedValueOnce({ content: makeSolutionBlueprint('traditional'), usedModel })
        .mockRejectedValueOnce(abortError)
        .mockResolvedValueOnce({
          content: makeGenerationArtifactsBlueprint('traditional'),
          usedModel,
        })
        .mockResolvedValueOnce({ content: makeIndependentVerifierBlueprint(), usedModel }),
      createClientStartingAfter: jest.fn(),
    };
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn(),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn(),
    };

    await expect(new TestdataGenService(mockClient as never, {
      sandboxRunner: runner,
      mode: 'sandbox',
    }).generate({
      problemTitle: '取消测试',
      statementMarkdown: '题面',
      options: { problemKind: 'traditional', caseCount: 1, languages: [] },
    })).rejects.toBe(abortError);

    expect(mockClient.chat).toHaveBeenCalledTimes(4);
    expect(mockClient.createClientStartingAfter).not.toHaveBeenCalled();
  });

  it('幸存 WA 靶子补刀成功后把新测试点写入文件计划与 config.yaml', async () => {
    const usedModel = { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' };
    const killModel = { endpointId: 'ep2', endpointName: 'kill', modelName: 'gpt-kill' };
    const hackModel = { endpointId: 'ep3', endpointName: 'hack', modelName: 'gpt-hack' };
    const artifactsModel = { endpointId: 'ep4', endpointName: 'artifacts', modelName: 'gpt-artifacts' };
    const verifierModel = { endpointId: 'ep5', endpointName: 'verifier', modelName: 'gpt-verifier' };
    const usage = (totalTokens: number) => ({
      promptTokens: totalTokens,
      completionTokens: 0,
      totalTokens,
    });
    const mockClient = {
      chat: jest.fn()
        .mockResolvedValueOnce({
          content: makeSolutionBlueprint('traditional'), usage: usage(1), usedModel,
        })
        .mockResolvedValueOnce({
          content: makeSurvivingKillTargetResponse(), usage: usage(2), usedModel: killModel,
        })
        .mockResolvedValueOnce({
          content: makeGenerationArtifactsBlueprint('traditional'),
          usage: usage(3),
          usedModel: artifactsModel,
        })
        .mockResolvedValueOnce({
          content: makeIndependentVerifierBlueprint(), usage: usage(4), usedModel: verifierModel,
        })
        .mockResolvedValueOnce({
          content: makeHackCaseResponse(), usage: usage(5), usedModel: hackModel,
        }),
    };
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn().mockImplementation((code: string) => Promise.resolve({
        stdout: code.includes('stress generator')
          ? stressGeneratorStdout()
          : JSON.stringify({ cases: [{ label: '正式', input: '1' }] }),
        stderr: '',
      })),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn().mockImplementation(
        (code: string, inputs: string[]) => Promise.resolve(inputs.map(input => {
          if (code.includes('sys.exit(0)')) return detail();
          if (code.includes('surviving wrong solution')) {
            return detail({ stdout: input.trim() === '1' ? '1\n' : 'wrong\n' });
          }
          return detail({ stdout: input });
        })),
      ),
    };

    const plan = await new TestdataGenService(mockClient as never, {
      sandboxRunner: runner,
      mode: 'sandbox',
    }).generate({
      problemTitle: '补刀测试',
      statementMarkdown: '题面',
      options: { problemKind: 'traditional', caseCount: 1, languages: [] },
    });

    expect(mockClient.chat).toHaveBeenCalledTimes(5);
    expect(mockClient.chat.mock.calls[4][1]).toContain('反例构造专家');
    expect(mockClient.chat.mock.calls[4][2].timeoutMs).toBeGreaterThan(0);
    expect(mockClient.chat.mock.calls[4][2].timeoutMs).toBeLessThanOrEqual(
      DISCRIMINATION_BUDGET_MS,
    );
    expect(plan.caseCount).toBe(2);
    expect(plan.totalCaseCount).toBe(2);
    expect(plan.files.find(file => file.name === '2.in')?.content).toBe('2\n');
    expect(plan.files.find(file => file.name === '2.out')?.content).toBe('2\n');
    expect(plan.files.find(file => file.name === 'config.yaml')?.content).toContain('input: 2.in');
    expect(plan.verification?.discrimination?.targets[0]).toMatchObject({
      kind: 'wrong-algorithm',
      killed: true,
      killedBy: 'wa',
      killedByCase: 2,
    });
    expect(plan.tokenUsage).toEqual({
      promptTokens: 15,
      completionTokens: 0,
      totalTokens: 15,
    });
    expect(plan.usedModel).toBe(
      'main/gpt-test → artifacts/gpt-artifacts → verifier/gpt-verifier'
      + ' → kill/gpt-kill → hack/gpt-hack',
    );
    expect(plan.notes).toContain('已为「只对已有输入返回正确答案」错误解定向补充 hack 测试点 #2。');
  });

  it('补刀模型链到达区分度绝对截止时间时中止并静默保留未完成状态', async () => {
    jest.useFakeTimers();
    try {
      const usedModel = { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' };
      const deadlineAbort = Object.assign(new Error('deadline abort'), { name: 'AbortError' });
      let hackSignal: AbortSignal | undefined;
      const mockClient = {
        chat: jest.fn()
          .mockResolvedValueOnce({ content: makeSolutionBlueprint('traditional'), usedModel })
          .mockResolvedValueOnce({ content: makeSurvivingKillTargetResponse(), usedModel })
          .mockResolvedValueOnce({
            content: makeGenerationArtifactsBlueprint('traditional'),
            usedModel,
          })
          .mockResolvedValueOnce({ content: makeIndependentVerifierBlueprint(), usedModel })
          .mockImplementationOnce((_messages, _systemPrompt, options) => {
            hackSignal = options.signal;
            if (!hackSignal) return Promise.reject(new Error('缺少绝对截止时间 signal'));
            return new Promise((_resolve, reject) => {
              hackSignal?.addEventListener('abort', () => reject(deadlineAbort), { once: true });
            });
          }),
      };
      const runner = {
        isAvailable: jest.fn().mockResolvedValue(true),
        runPython: jest.fn().mockImplementation((code: string) => Promise.resolve({
          stdout: code.includes('stress generator')
            ? stressGeneratorStdout()
            : JSON.stringify({ cases: [{ label: '正式', input: '1' }] }),
          stderr: '',
        })),
        runPythonBatch: jest.fn(),
        runPythonBatchDetailed: jest.fn().mockImplementation(
          (code: string, inputs: string[]) => Promise.resolve(inputs.map(input => {
            if (code.includes('sys.exit(0)')) return detail();
            if (code.includes('surviving wrong solution')) return detail({ stdout: input });
            return detail({ stdout: input });
          })),
        ),
      };

      const generationPromise = new TestdataGenService(mockClient as never, {
        sandboxRunner: runner,
        mode: 'sandbox',
      }).generate({
        problemTitle: '补刀截止时间测试',
        statementMarkdown: '题面',
        options: { problemKind: 'traditional', caseCount: 1, languages: [] },
      });

      await jest.advanceTimersByTimeAsync(0);
      expect(mockClient.chat).toHaveBeenCalledTimes(5);
      expect(hackSignal).toBeDefined();
      expect(hackSignal?.aborted).toBe(false);

      await jest.advanceTimersByTimeAsync(DISCRIMINATION_BUDGET_MS);
      const plan = await generationPromise;

      expect(hackSignal?.aborted).toBe(true);
      expect(plan.caseCount).toBe(1);
      expect(plan.verification?.discrimination?.targets[0]).toMatchObject({
        kind: 'wrong-algorithm',
        killed: false,
      });
      expect(plan.verification?.discrimination?.targets[0].killedBy).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('补刀模型等待期间的用户取消仍原样上抛', async () => {
    const usedModel = { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' };
    const userAbort = Object.assign(new Error('user abort'), { name: 'AbortError' });
    const controller = new AbortController();
    const mockClient = {
      chat: jest.fn()
        .mockResolvedValueOnce({ content: makeSolutionBlueprint('traditional'), usedModel })
        .mockResolvedValueOnce({ content: makeSurvivingKillTargetResponse(), usedModel })
        .mockResolvedValueOnce({
          content: makeGenerationArtifactsBlueprint('traditional'),
          usedModel,
        })
        .mockResolvedValueOnce({ content: makeIndependentVerifierBlueprint(), usedModel })
        .mockImplementationOnce((_messages, _systemPrompt, options) => new Promise(
          (_resolve, reject) => options.signal.addEventListener(
            'abort',
            () => reject(userAbort),
            { once: true },
          ),
        )),
      createClientStartingAfter: jest.fn(),
    };
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn().mockImplementation((code: string) => Promise.resolve({
        stdout: code.includes('stress generator')
          ? stressGeneratorStdout()
          : JSON.stringify({ cases: [{ label: '正式', input: '1' }] }),
        stderr: '',
      })),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn().mockImplementation(
        (_code: string, inputs: string[]) => Promise.resolve(
          inputs.map(input => detail({ stdout: input })),
        ),
      ),
    };

    const generationPromise = new TestdataGenService(mockClient as never, {
      sandboxRunner: runner,
      mode: 'sandbox',
    }).generate({
      problemTitle: '补刀用户取消测试',
      statementMarkdown: '题面',
      options: { problemKind: 'traditional', caseCount: 1, languages: [] },
      signal: controller.signal,
    });

    await new Promise(resolve => setImmediate(resolve));
    expect(mockClient.chat).toHaveBeenCalledTimes(5);
    controller.abort();

    await expect(generationPromise).rejects.toBe(userAbort);
    expect(mockClient.createClientStartingAfter).not.toHaveBeenCalled();
  });

  it('补刀循环结束后用新增测试点复测其他仍幸存的靶子', async () => {
    const usedModel = { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' };
    const mockClient = {
      chat: jest.fn()
        .mockResolvedValueOnce({ content: makeSolutionBlueprint('traditional'), usedModel })
        .mockResolvedValueOnce({ content: makeSharedHackKillTargetsResponse(), usedModel })
        .mockResolvedValueOnce({
          content: makeGenerationArtifactsBlueprint('traditional'),
          usedModel,
        })
        .mockResolvedValueOnce({ content: makeIndependentVerifierBlueprint(), usedModel })
        .mockResolvedValueOnce({ content: makeHackCaseResponse(), usedModel })
        .mockRejectedValueOnce(new Error('第二个靶子补刀生成失败'))
        .mockRejectedValueOnce(new Error('第二个靶子补刀重试失败')),
    };
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn().mockImplementation((code: string) => Promise.resolve({
        stdout: code.includes('stress generator')
          ? stressGeneratorStdout()
          : JSON.stringify({ cases: [{ label: '正式', input: '1' }] }),
        stderr: '',
      })),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn().mockImplementation(
        (code: string, inputs: string[]) => Promise.resolve(inputs.map(input => {
          if (code.includes('sys.exit(0)')) return detail();
          if (code.includes('shared hack target')) {
            return detail({ stdout: input.trim() === '1' ? '1\n' : 'wrong\n' });
          }
          return detail({ stdout: input });
        })),
      ),
    };

    const plan = await new TestdataGenService(mockClient as never, {
      sandboxRunner: runner,
      mode: 'sandbox',
    }).generate({
      problemTitle: '共享补刀测试',
      statementMarkdown: '题面',
      options: { problemKind: 'traditional', caseCount: 1, languages: [] },
    });

    expect(mockClient.chat).toHaveBeenCalledTimes(7);
    expect(plan.caseCount).toBe(2);
    expect(plan.verification?.discrimination?.targets.slice(0, 2)).toEqual([
      expect.objectContaining({ description: '第一个幸存错误解', killed: true, killedByCase: 2 }),
      expect.objectContaining({ description: '第二个幸存错误解', killed: true, killedByCase: 2 }),
    ]);
  });

  it('第一阶段样例预验证连续失败时不生成外围制品或独立验证器', async () => {
    const usedModel = { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' };
    const mockClient = {
      chat: jest.fn()
        .mockResolvedValueOnce({ content: makeSolutionBlueprint('traditional'), usedModel })
        .mockResolvedValueOnce({ content: makeSolutionBlueprint('traditional'), usedModel }),
      createClientStartingAfter: jest.fn(),
    };
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn(),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn().mockResolvedValue([
        detail({ stdout: '错误答案\n' }),
      ]),
    };

    const promise = new TestdataGenService(mockClient as never, {
      sandboxRunner: runner,
      mode: 'sandbox',
    }).generate({
      problemTitle: '样例硬闸门',
      statementMarkdown: '```input1\n1\n```\n```output1\n2\n```',
      options: { problemKind: 'traditional', caseCount: 1, languages: [] },
    });

    await expect(promise).rejects.toMatchObject({
      telemetryMetadata: expect.objectContaining({ failureStage: 'solution_blueprint' }),
    });
    await expect(promise).rejects.toThrow(/第一阶段题面样例/);
    expect(mockClient.chat).toHaveBeenCalledTimes(2);
    expect(mockClient.chat.mock.calls[1][0][2].content).toContain('样例预验证');
    expect(runner.runPython).not.toHaveBeenCalled();
    expect(mockClient.createClientStartingAfter).toHaveBeenCalled();
  });

  it('自动修复仍失败时从下一配置模型完整重跑一次', async () => {
    const progress: Array<{ stage: string; percent: number; attempt: number }> = [];
    const onCheckpoint = jest.fn().mockResolvedValue(undefined);
    const brokenBlueprint = makeSolutionBlueprint('traditional').replace(
      'print(input())',
      'raise RuntimeError("broken oracle")',
    );
    const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
    const primaryModel = { endpointId: 'ep1', endpointName: 'primary', modelName: 'model-a' };
    const deeperModel = { endpointId: 'ep2', endpointName: 'deeper', modelName: 'model-b' };
    const fallbackClient = {
      chat: jest.fn()
        .mockResolvedValueOnce({ content: makeSolutionBlueprint('traditional'), usage, usedModel: deeperModel })
        .mockResolvedValueOnce({ content: makeEmptyKillTargetsResponse(), usedModel: deeperModel })
        .mockResolvedValueOnce({ content: makeGenerationArtifactsBlueprint('traditional'), usage, usedModel: deeperModel })
        .mockResolvedValueOnce({ content: makeIndependentVerifierBlueprint(), usage, usedModel: deeperModel }),
    };
    // Mutation caught: recursively applying semantic escalation after the second full run fails.
    const thirdClient = { chat: jest.fn() };
    const primaryClient = {
      chat: jest.fn()
        .mockResolvedValueOnce({ content: brokenBlueprint, usage, usedModel: primaryModel })
        .mockResolvedValueOnce({ content: makeEmptyKillTargetsResponse(), usedModel: primaryModel })
        .mockResolvedValueOnce({ content: makeGenerationArtifactsBlueprint('traditional'), usage, usedModel: primaryModel })
        .mockResolvedValueOnce({ content: makeIndependentVerifierBlueprint(), usage, usedModel: primaryModel })
        .mockResolvedValueOnce({
          content: '@@@ORACLE@@@\nraise RuntimeError("still broken")',
          usage,
          usedModel: primaryModel,
        }),
      createClientStartingAfter: jest.fn().mockReturnValueOnce(fallbackClient).mockReturnValueOnce(thirdClient),
    };
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn().mockImplementation((code: string) => Promise.resolve({
        stdout: code.includes('stress generator')
          ? stressGeneratorStdout()
          : JSON.stringify({ cases: [{ label: '正式', input: '1' }] }),
        stderr: '',
      })),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn().mockImplementation((code: string, ins: string[]) => Promise.resolve(
        ins.map(input => code.includes('RuntimeError')
          ? detail({ accepted: false, status: 'Nonzero Exit Status', exitStatus: 1, stderr: 'broken oracle' })
          : detail({ stdout: input })),
      )),
    };

    const plan = await new TestdataGenService(primaryClient as never, {
      sandboxRunner: runner,
      mode: 'sandbox',
    }).generate({
      problemTitle: 't', statementMarkdown: '题面',
      options: { problemKind: 'traditional', caseCount: 1, languages: [] },
      onCheckpoint,
      onProgress: event => progress.push(event),
    });

    expect(primaryClient.chat).toHaveBeenCalledTimes(5);
    expect(primaryClient.createClientStartingAfter).toHaveBeenCalledWith(primaryModel);
    expect(primaryClient.createClientStartingAfter).toHaveBeenCalledTimes(1);
    expect(thirdClient.chat).not.toHaveBeenCalled();
    expect(fallbackClient.chat).toHaveBeenCalledTimes(4);
    expect(plan.verification?.modelEscalation).toEqual({
      fromModel: 'primary/model-a',
      toModel: 'deeper/model-b',
    });
    expect(plan.notes).toContain('下一配置模型');
    expect(plan.notesStructured?.system.some(note => note.includes('下一配置模型'))).toBe(true);
    expect(plan.usedModel).toBe('primary/model-a → deeper/model-b');
    expect(plan.tokenUsage?.totalTokens).toBe(14);
    expect(progress).toContainEqual(expect.objectContaining({ stage: 'model_escalation', attempt: 2 }));
    expect(progress.some(event => event.attempt === 2 && event.stage === 'blueprint')).toBe(true);
    expect(progress[progress.length - 1]).toEqual({ stage: 'complete', percent: 100, attempt: 2 });
    expect(onCheckpoint).toHaveBeenCalledWith(null);
    const clearCall = onCheckpoint.mock.calls.findIndex(([update]) => update === null);
    expect(clearCall).toBeGreaterThanOrEqual(0);
    expect(onCheckpoint.mock.invocationCallOrder[clearCall])
      .toBeLessThan(fallbackClient.chat.mock.invocationCallOrder[0]);
  });

  it('沙箱验证中用户中止：原样上抛且不触发修复请求', async () => {
    const mockClient = {
      chat: jest.fn()
        .mockResolvedValueOnce({
          content: makeSolutionBlueprint('traditional'),
          usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
        })
        .mockResolvedValueOnce({
          content: makeEmptyKillTargetsResponse(),
          usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
        })
        .mockResolvedValueOnce({
          content: makeGenerationArtifactsBlueprint('traditional'),
          usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
        })
        .mockResolvedValueOnce({
          content: makeIndependentVerifierBlueprint(),
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
    expect(mockClient.chat).toHaveBeenCalledTimes(4);
  });

  it('沙箱总预算耗尽时直接停止，不触发 AI 修复或模型升级', async () => {
    const usedModel = { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' };
    const mockClient = {
      chat: jest.fn()
        .mockResolvedValueOnce({ content: makeSolutionBlueprint('traditional'), usedModel })
        .mockResolvedValueOnce({ content: makeEmptyKillTargetsResponse(), usedModel })
        .mockResolvedValueOnce({ content: makeGenerationArtifactsBlueprint('traditional'), usedModel })
        .mockResolvedValueOnce({ content: makeIndependentVerifierBlueprint(), usedModel }),
      createClientStartingAfter: jest.fn(),
    };
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn()
        .mockResolvedValueOnce({ stdout: JSON.stringify({ cases: [{ input: '1' }] }), stderr: '' })
        .mockResolvedValueOnce({ stdout: stressGeneratorStdout(), stderr: '' }),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn().mockRejectedValue(new TestdataPipelineError(
        '沙箱执行总时长超出预算，请减少测试点数量后重试',
        'PIPELINE_BUDGET_EXHAUSTED',
        'sandbox_budget',
        'pipeline',
        'no-retry',
      )),
    };

    const promise = new TestdataGenService(mockClient as never, {
      sandboxRunner: runner,
      mode: 'sandbox',
    }).generate({
      problemTitle: 't', statementMarkdown: '题面',
      options: { problemKind: 'traditional', caseCount: 1, languages: [] },
    });

    await expect(promise).rejects.toMatchObject({
      recommendDeeperReasoning: false,
      telemetryMetadata: expect.objectContaining({ failureStage: 'sandbox_budget' }),
    });
    await expect(promise).rejects.toThrow(/停止后续修复与模型升级/);
    expect(mockClient.chat).toHaveBeenCalledTimes(4);
    expect(mockClient.createClientStartingAfter).not.toHaveBeenCalled();
  });

  it('真实 runner 预算错误穿过 generator 包装后仍为 no-retry 且零修复零模型升级', async () => {
    const lowLevelRunner = new GoJudgeSandboxRunner('http://localhost:5050', {
      get: jest.fn(),
      post: jest.fn(),
    });
    const lowLevelBudgetError = await lowLevelRunner.runPythonBatchDetailed('print(1)', ['1'], {
      deadlineAt: Date.now() - 1,
    }).catch(error => error);
    const usedModel = { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' };
    const mockClient = {
      chat: jest.fn()
        .mockResolvedValueOnce({ content: makeSolutionBlueprint('traditional'), usedModel })
        .mockResolvedValueOnce({ content: makeEmptyKillTargetsResponse(), usedModel })
        .mockResolvedValueOnce({ content: makeGenerationArtifactsBlueprint('traditional'), usedModel })
        .mockResolvedValueOnce({ content: makeIndependentVerifierBlueprint(), usedModel })
        .mockRejectedValueOnce(new Error('artifact repair must not run')),
      createClientStartingAfter: jest.fn(),
    };
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn().mockRejectedValue(lowLevelBudgetError),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn(),
    };

    const promise = new TestdataGenService(mockClient as never, {
      sandboxRunner: runner,
      mode: 'sandbox',
    }).generate({
      problemTitle: '真实预算错误传播',
      statementMarkdown: '题面',
      options: { problemKind: 'traditional', caseCount: 1, languages: [] },
    });

    await expect(promise).rejects.toMatchObject({
      code: 'PIPELINE_BUDGET_EXHAUSTED',
      stage: 'sandbox_budget',
      artifact: 'pipeline',
      retryPolicy: 'no-retry',
      recommendDeeperReasoning: false,
    });
    expect(mockClient.chat).toHaveBeenCalledTimes(4);
    expect(mockClient.createClientStartingAfter).not.toHaveBeenCalled();
  });

  it.each([
    ['ORACLE_BRUTE_DIVERGENCE', 'brute', 'adjudicate'],
    ['PIPELINE_BUDGET_EXHAUSTED', 'pipeline', 'no-retry'],
    ['ORACLE_COMPILE_FAILED', 'oracle', 'manual-review'],
  ] as const)('第二模型最终 %s 保留终局策略且不再升级', async (code, artifact, retryPolicy) => {
    const primaryModel = { endpointId: 'ep1', endpointName: 'primary', modelName: 'model-a' };
    const fallbackModel = { endpointId: 'ep2', endpointName: 'fallback', modelName: 'model-b' };
    const firstError = new TestdataGenerationError(
      'primary repair failed',
      'oracle',
      [{ content: 'primary', usedModel: primaryModel }] as never,
      true,
      undefined,
      undefined,
      { code: 'ORACLE_RUNTIME_FAILED', artifact: 'oracle', retryPolicy: 'repair-artifact' },
    );
    const fallbackError = new TestdataGenerationError(
      'fallback reached a terminal typed failure',
      code === 'PIPELINE_BUDGET_EXHAUSTED' ? 'sandbox_budget' : 'stress_testing',
      [{ content: 'fallback', usedModel: fallbackModel }] as never,
      false,
      undefined,
      undefined,
      { code, artifact, retryPolicy },
    );
    const generateWithSandbox = jest.spyOn(
      TestdataGenService.prototype as unknown as { generateWithSandbox: (...args: unknown[]) => Promise<never> },
      'generateWithSandbox',
    )
      .mockRejectedValueOnce(firstError)
      .mockRejectedValueOnce(fallbackError);
    const fallbackClient = { chat: jest.fn(), createClientStartingAfter: jest.fn() };
    const primaryClient = {
      chat: jest.fn(),
      createClientStartingAfter: jest.fn().mockReturnValue(fallbackClient),
    };
    const runner = { isAvailable: jest.fn().mockResolvedValue(true) };

    try {
      const promise = new TestdataGenService(primaryClient as never, {
        sandboxRunner: runner as never,
        mode: 'sandbox',
      }).generate({
        problemTitle: '第二模型终局策略',
        statementMarkdown: '题面',
        options: { problemKind: 'traditional', caseCount: 1, languages: [] },
      });

      await expect(promise).rejects.toMatchObject({
        code,
        artifact,
        retryPolicy,
        recommendDeeperReasoning: false,
      });
      expect(primaryClient.createClientStartingAfter).toHaveBeenCalledTimes(1);
      expect(fallbackClient.createClientStartingAfter).not.toHaveBeenCalled();
      expect(generateWithSandbox).toHaveBeenCalledTimes(2);
    } finally {
      generateWithSandbox.mockRestore();
    }
  });

  it('修复请求本身被中止（AIServiceError aborted 形态）：原样上抛不包装', async () => {
    const abortedErr = Object.assign(new Error('请求已取消'), { category: 'aborted' });
    const mockClient = {
      chat: jest.fn()
        .mockResolvedValueOnce({
          content: makeSolutionBlueprint('traditional'),
          usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
        })
        .mockResolvedValueOnce({
          content: makeEmptyKillTargetsResponse(),
          usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
        })
        .mockResolvedValueOnce({
          content: makeGenerationArtifactsBlueprint('traditional'),
          usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
        })
        .mockResolvedValueOnce({
          content: makeIndependentVerifierBlueprint(),
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
    const artifacts = makeGenerationArtifactsBlueprint('function').replace(
      /@@@TEMPLATE:java@@@[\s\S]*?(?=@@@TEMPLATE:cc@@@)/,
      '',
    );
    const mockClient = {
      chat: jest.fn()
        .mockResolvedValueOnce({
          content: makeSolutionBlueprint('function'),
          usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
        })
        .mockResolvedValueOnce({
          content: makeEmptyKillTargetsResponse(),
          usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
        })
        .mockResolvedValueOnce({
          content: artifacts,
          usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
        })
        .mockResolvedValueOnce({
          content: makeIndependentVerifierBlueprint(),
          usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
        })
        .mockResolvedValueOnce({
          content: '@@@TEMPLATE:java@@@\npublic class Main { public static void main(String[] args) {} }',
          usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
        }),
    };
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      // 各阶段（ORACLE/模板实跑等）统一回显输入作为输出
      runPythonBatchDetailed: jest.fn().mockImplementation((_code: string, ins: string[]) =>
        Promise.resolve(ins.map(input => ({
          status: 'Accepted', accepted: true, timedOut: false, exitStatus: 0, stdout: input, stderr: '',
        })))),
      runPython: jest.fn()
        .mockResolvedValueOnce({
          stdout: JSON.stringify({ cases: [{ input: 'abc' }] }), stderr: '',
        })
        .mockResolvedValueOnce({ stdout: stressGeneratorStdout(), stderr: '' }),
      runPythonBatch: jest.fn(),
    };
    const plan = await new TestdataGenService(mockClient as never, {
      sandboxRunner: runner, mode: 'sandbox',
    }).generate({
      problemTitle: '函数题', statementMarkdown: '题面',
      options: { problemKind: 'function', caseCount: 1, languages: ['py', 'java', 'cc'] },
    });

    expect(mockClient.chat).toHaveBeenCalledTimes(5);
    expect(mockClient.chat.mock.calls[4][0][2].content).toContain('@@@TEMPLATE:java@@@');
    expect(mockClient.chat.mock.calls[3][0]).toHaveLength(1);
    expect(plan.files.find(file => file.name === 'template.java')?.content).toContain('public class Main');
  });

  it('GENERATOR 沙箱失败时只请求并合并生成器分节', async () => {
    const tieredSolution = [
      '=== SUBTASKS ===',
      '1 | 40 | n<=100',
      '2 | 60 | n<=100000',
      makeSolutionBlueprint('traditional'),
    ].join('\n');
    const mockClient = {
      chat: jest.fn()
        .mockResolvedValueOnce({
          content: tieredSolution,
          usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
        })
        .mockResolvedValueOnce({
          content: makeEmptyKillTargetsResponse(),
          usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
        })
        .mockResolvedValueOnce({
          content: makeGenerationArtifactsBlueprint('traditional'),
          usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
        })
        .mockResolvedValueOnce({
          content: makeIndependentVerifierBlueprint(),
          usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
        })
        .mockResolvedValueOnce({
          content: '@@@GENERATOR@@@\nimport json\nprint(json.dumps({"cases":[{"label":"修复1","input":"1"},{"label":"修复2","input":"2"}]}, separators=(",", ":")))',
          usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
        }),
    };
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn()
        .mockRejectedValueOnce(new Error('第 1 个沙箱任务执行失败（Output Limit Exceeded）'))
        .mockResolvedValueOnce({
          stdout: JSON.stringify({ cases: [
            { label: '修复1', input: '1' },
            { label: '修复2', input: '2' },
          ] }),
          stderr: '',
        })
        .mockResolvedValueOnce({ stdout: stressGeneratorStdout(), stderr: '' }),
      runPythonBatchDetailed: jest.fn().mockImplementation((_code: string, ins: string[]) => Promise.resolve(
        ins.map(input => ({ status: 'Accepted', accepted: true, timedOut: false, exitStatus: 0, stdout: input, stderr: '' })),
      )),
      runPythonBatch: jest.fn(),
    };
    const plan = await new TestdataGenService(mockClient as never, {
      sandboxRunner: runner, mode: 'sandbox',
    }).generate({
      problemTitle: 't', statementMarkdown: '题面',
      options: { problemKind: 'traditional', caseCount: 2, dataScale: 'auto', languages: [] },
    });
    expect(mockClient.chat).toHaveBeenCalledTimes(5);
    const artifactsPrompt = mockClient.chat.mock.calls[2][0][0].content;
    const repairMessages = mockClient.chat.mock.calls[4][0];
    const guidance = 'CASE 1: 子任务 1 — n<=100;数据必须严格满足本子任务的全部约束';
    expect(artifactsPrompt).toContain(guidance);
    expect(repairMessages[0].content).toContain(guidance);
    expect(repairMessages[2].content).toContain(guidance);
    expect(repairMessages[2].content).toContain('只输出修复后的 @@@GENERATOR@@@');
    expect(plan.files.find(file => file.name === 'generator.py')?.content).toContain('separators');
    expect(plan.files.find(file => file.name === 'std.py')?.content).toContain('print(input())');
    expect(plan.caseCoverage?.map(item => item.subtaskId)).toEqual([1, 2]);
  });

  it('解题蓝图修复未返回 SUBTASKS 时保留初次解析的合法子任务', async () => {
    const initialSolution = [
      '=== SUBTASKS ===',
      '1 | 40 | n<=100',
      '2 | 60 | n<=100000',
      makeSolutionBlueprint('traditional').replace(
        'print(input())',
        'raise RuntimeError("broken oracle")',
      ),
    ].join('\n');
    const usedModel = { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' };
    const mockClient = {
      chat: jest.fn()
        .mockResolvedValueOnce({ content: initialSolution, usedModel })
        .mockResolvedValueOnce({ content: makeSolutionBlueprint('traditional'), usedModel })
        .mockResolvedValueOnce({ content: makeEmptyKillTargetsResponse(), usedModel })
        .mockResolvedValueOnce({ content: makeGenerationArtifactsBlueprint('traditional'), usedModel })
        .mockResolvedValueOnce({ content: makeIndependentVerifierBlueprint(), usedModel }),
    };
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn().mockImplementation((code: string) => Promise.resolve({
        stdout: code.includes('stress generator')
          ? stressGeneratorStdout()
          : JSON.stringify({ cases: [
            { label: '第一档', input: '1' },
            { label: '第二档', input: '2' },
          ] }),
        stderr: '',
      })),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn().mockImplementation(
        (code: string, inputs: string[]) => Promise.resolve(inputs.map(input => {
          if (code.includes('RuntimeError')) {
            return detail({ accepted: false, status: 'Nonzero Exit Status', exitStatus: 1 });
          }
          if (code.includes('sys.exit(0)')) return detail();
          return detail({ stdout: input });
        })),
      ),
    };

    const plan = await new TestdataGenService(mockClient as never, {
      sandboxRunner: runner,
      mode: 'sandbox',
    }).generate({
      problemTitle: '修复保留子任务',
      statementMarkdown: '```input1\n1\n```\n```output1\n1\n```',
      options: { problemKind: 'traditional', caseCount: 2, dataScale: 'auto', languages: [] },
    });

    expect(mockClient.chat).toHaveBeenCalledTimes(5);
    expect(mockClient.chat.mock.calls[1][1]).toContain('=== SUBTASKS ===');
    expect(mockClient.chat.mock.calls[3][0][0].content).toContain('CASE 1: 子任务 1');
    expect(plan.caseCoverage?.map(item => item.subtaskId)).toEqual([1, 2]);
    const config = yaml.load(
      plan.files.find(file => file.name === 'config.yaml')?.content || '',
    ) as { subtasks: Array<{ score: number }> };
    expect(config.subtasks.map(subtask => subtask.score)).toEqual([40, 60]);
  });

  it('ORACLE 与 BRUTE 分歧时进入裁决并停止自动修复', async () => {
    const brokenVerifier = makeIndependentVerifierBlueprint().replace(
      'print(input())  # independent brute',
      'print("wrong")  # broken independent brute',
    );
    const mockClient = {
      chat: jest.fn()
        .mockResolvedValueOnce({
          content: makeSolutionBlueprint('traditional'),
          usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
        })
        .mockResolvedValueOnce({
          content: makeEmptyKillTargetsResponse(),
          usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
        })
        .mockResolvedValueOnce({
          content: makeGenerationArtifactsBlueprint('traditional'),
          usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
        })
        .mockResolvedValueOnce({
          content: brokenVerifier,
          usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
        })
        .mockResolvedValueOnce({
          content: makeIndependentVerifierBlueprint(),
          usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
        }),
    };
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn().mockImplementation((code: string) => Promise.resolve({
        stdout: code.includes('stress generator')
          ? stressGeneratorStdout()
          : JSON.stringify({ cases: [{ label: '正式', input: '1' }] }),
        stderr: '',
      })),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn().mockImplementation((code: string, ins: string[]) => Promise.resolve(
        ins.map(input => detail({ stdout: code.includes('broken independent brute') ? 'wrong\n' : input })),
      )),
    };
    const promise = new TestdataGenService(mockClient as never, {
      sandboxRunner: runner, mode: 'sandbox',
    }).generate({
      problemTitle: 't', statementMarkdown: '题面',
      options: { problemKind: 'traditional', caseCount: 1, languages: [] },
    });
    await expect(promise).rejects.toMatchObject({
      code: 'ORACLE_BRUTE_DIVERGENCE',
      artifact: 'brute',
      retryPolicy: 'adjudicate',
      recommendDeeperReasoning: false,
    });
    expect(mockClient.chat).toHaveBeenCalledTimes(4);
    expect(runner.runPython).toHaveBeenCalledTimes(2);
  });

  it('初始蓝图分节损坏时请求完整蓝图后继续验证', async () => {
    const mockClient = {
      chat: jest.fn()
        .mockResolvedValueOnce({
          content: `${makeSolutionBlueprint('traditional')}\n@@@损坏`,
          usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
        })
        .mockResolvedValueOnce({
          content: makeSolutionBlueprint('traditional'),
          usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
        })
        .mockResolvedValueOnce({
          content: makeEmptyKillTargetsResponse(),
          usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
        })
        .mockResolvedValueOnce({
          content: makeGenerationArtifactsBlueprint('traditional'),
          usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
        })
        .mockResolvedValueOnce({
          content: makeIndependentVerifierBlueprint(),
          usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
        }),
    };
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn()
        .mockResolvedValueOnce({
          stdout: JSON.stringify({ cases: [{ label: '合法', input: '1' }] }), stderr: '',
        })
        .mockResolvedValueOnce({ stdout: stressGeneratorStdout(), stderr: '' }),
      runPythonBatchDetailed: jest.fn().mockImplementation((_code: string, ins: string[]) => Promise.resolve(
        ins.map(input => ({ status: 'Accepted', accepted: true, timedOut: false, exitStatus: 0, stdout: input, stderr: '' })),
      )),
      runPythonBatch: jest.fn(),
    };
    const plan = await new TestdataGenService(mockClient as never, {
      sandboxRunner: runner, mode: 'sandbox',
    }).generate({
      problemTitle: 't', statementMarkdown: '题面',
      options: { problemKind: 'traditional', caseCount: 1, languages: [] },
    });
    expect(mockClient.chat).toHaveBeenCalledTimes(5);
    expect(mockClient.chat.mock.calls[1][0][2].content).toContain('重新完整输出 META');
    expect(plan.files.find(file => file.name === '1.in')?.content).toBe('1\n');
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
    expect(plan.notesStructured?.warnings.some(note => note.includes('沙箱当前不可达'))).toBe(true);
    expect(runner.runPython).not.toHaveBeenCalled();
  });

  it('教师 C++ 标程在 auto 模式沙箱不可达时给出编译能力硬错误，不降级直出', async () => {
    const mockClient = { chat: jest.fn() };
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(false),
      runPythonBatchDetailed: jest.fn(),
      runPython: jest.fn(),
      runPythonBatch: jest.fn(),
    };
    const service = new TestdataGenService(mockClient as never, {
      sandboxRunner: runner,
      mode: 'auto',
    });
    await expect(service.generate({
      problemTitle: '传统题',
      statementMarkdown: '题面',
      options: {
        problemKind: 'traditional',
        caseCount: 1,
        languages: [],
        providedStd: '#include <iostream>\nint main() {}',
        providedStdSource: 'manual',
      },
    })).rejects.toMatchObject({
      userMessageKey: 'ai_helper_testdata_err_cpp_oracle_unavailable',
    });
    expect(mockClient.chat).not.toHaveBeenCalled();
  });

  it('教师 C++ 标程在 direct 模式直接拒绝，不生成未由标程导出的输出', async () => {
    const mockClient = { chat: jest.fn() };
    await expect(new TestdataGenService(mockClient as never, {
      mode: 'direct',
    }).generate({
      problemTitle: '传统题',
      statementMarkdown: '题面',
      options: {
        problemKind: 'traditional',
        caseCount: 1,
        languages: [],
        providedStd: '#include <iostream>\nint main() {}',
        providedStdSource: 'manual',
      },
    })).rejects.toMatchObject({
      userMessageKey: 'ai_helper_testdata_err_cpp_oracle_unavailable',
    });
    expect(mockClient.chat).not.toHaveBeenCalled();
  });

  it('AI 选择的 C++ ORACLE 遇到编译基础设施失败时禁用 C++ 并定向改用 Python', async () => {
    const usedModel = { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' };
    const cppSolution = `=== ORACLE_LANG ===\ncpp\n${makeSolutionBlueprint('traditional')}`;
    const mockClient = {
      chat: jest.fn()
        .mockResolvedValueOnce({ content: cppSolution, usedModel })
        .mockResolvedValueOnce({ content: makeEmptyKillTargetsResponse(), usedModel })
        .mockResolvedValueOnce({
          content: makeGenerationArtifactsBlueprint('traditional'),
          usedModel,
        })
        .mockResolvedValueOnce({ content: makeIndependentVerifierBlueprint(), usedModel })
        .mockResolvedValueOnce({ content: '@@@ORACLE@@@\nprint(input())', usedModel }),
    };
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn().mockImplementation((code: string) => Promise.resolve({
        stdout: code.includes('stress generator')
          ? stressGeneratorStdout()
          : JSON.stringify({ cases: [{ label: '正式', input: '1' }] }),
        stderr: '',
      })),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn().mockImplementation((_code: string, inputs: string[]) =>
        Promise.resolve(inputs.map(input => detail({ stdout: input })))),
      compileCpp: jest.fn().mockResolvedValue({
        ok: false,
        kind: 'infra',
        error: 'connect ECONNRESET',
      }),
      runCompiledBatchDetailed: jest.fn(),
      deleteCachedFile: jest.fn(),
    };

    const plan = await new TestdataGenService(mockClient as never, {
      sandboxRunner: runner,
      mode: 'sandbox',
      cppOracleAvailable: true,
    }).generate({
      problemTitle: 'C++ 基础设施降级',
      statementMarkdown: '题面',
      options: { problemKind: 'traditional', caseCount: 1, languages: [] },
    });

    expect(runner.compileCpp).toHaveBeenCalledTimes(1);
    expect(mockClient.chat).toHaveBeenCalledTimes(5);
    expect(mockClient.chat.mock.calls[4][0][2].content).toContain('改用 Python 3');
    // ORACLE 修复从 ORACLE 阶段继续，不重复生成正式输入或压力输入。
    expect(runner.runPython).toHaveBeenCalledTimes(2);
    expect(plan.files.some(file => file.name === 'std.py')).toBe(true);
    expect(plan.files.some(file => file.name === 'std.cc')).toBe(false);
  });

  it('历史 AC 候选解在沙箱不可达时拒绝降级直出', async () => {
    const mockClient = { chat: jest.fn() };
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(false),
      runPythonBatchDetailed: jest.fn(),
      runPython: jest.fn(),
      runPythonBatch: jest.fn(),
    };
    const service = new TestdataGenService(mockClient as never, {
      sandboxRunner: runner,
      mode: 'auto',
    });

    await expect(service.generate({
      problemTitle: 't', statementMarkdown: '题面',
      options: {
        problemKind: 'traditional', caseCount: 1, languages: [],
        providedStd: 'print(input())', providedStdSource: 'accepted-record',
      },
    })).rejects.toThrow(/无法验证所选历史 AC 候选解.*拒绝降级生成/);
    expect(mockClient.chat).not.toHaveBeenCalled();
  });

  it('历史 AC 与独立 BRUTE 冲突时直接拒绝，不发起修复或模型升级', async () => {
    const mockClient = {
      chat: jest.fn()
        .mockResolvedValueOnce({
          content: makeSolutionBlueprint('traditional'),
          usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
        })
        .mockResolvedValueOnce({
          content: makeEmptyKillTargetsResponse(),
          usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
        })
        .mockResolvedValueOnce({
          content: makeGenerationArtifactsBlueprint('traditional'),
          usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
        })
        .mockResolvedValueOnce({
          content: makeIndependentVerifierBlueprint(),
          usedModel: { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' },
        }),
      createClientStartingAfter: jest.fn(),
    };
    const stressInputs = Array.from(
      { length: TESTDATA_GEN_LIMITS.STRESS_CASES },
      (_, i) => `${i + 1}\n`,
    );
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn()
        .mockResolvedValueOnce({ stdout: JSON.stringify({ cases: [{ label: 'formal', input: '1' }] }), stderr: '' })
        .mockResolvedValueOnce({ stdout: stressGeneratorStdout(), stderr: '' }),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn()
        .mockResolvedValueOnce(Array.from(
          { length: 1 + TESTDATA_GEN_LIMITS.STRESS_CASES }, () => detail(),
        ))
        .mockResolvedValueOnce([
          detail({ stdout: '1\n' }),
          ...stressInputs.map(input => detail({ stdout: input })),
        ])
        .mockResolvedValueOnce([
          detail({ stdout: 'wrong\n' }),
          ...stressInputs.slice(1).map(input => detail({ stdout: input })),
        ]),
    };

    const promise = new TestdataGenService(mockClient as never, {
      sandboxRunner: runner,
      mode: 'sandbox',
    }).generate({
      problemTitle: 't', statementMarkdown: '题面',
      options: {
        problemKind: 'traditional', caseCount: 1, languages: [],
        providedStd: 'print(input())', providedStdSource: 'accepted-record',
      },
    });
    await expect(promise).rejects.toMatchObject({
      telemetryMetadata: expect.objectContaining({ failureStage: 'accepted_std_verification' }),
    });
    await expect(promise).rejects.toThrow(/系统不会修复 BRUTE 来迁就它/);
    expect(mockClient.chat).toHaveBeenCalledTimes(4);
    expect(mockClient.createClientStartingAfter).not.toHaveBeenCalled();
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

  it('直出模板补全仍缺失时抛出对应语言的类型化失败', async () => {
    const initial = makeDelimitedResponse().replace(
      /@@@TEMPLATE:java@@@[\s\S]*?(?=@@@TEMPLATE:cc@@@)/,
      '',
    );
    const usedModel = { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' };
    const mockClient = {
      chat: jest.fn()
        .mockResolvedValueOnce({ content: initial, usedModel })
        .mockResolvedValueOnce({ content: '@@@NOTES@@@\nstill missing', usedModel }),
    };

    const promise = new TestdataGenService(mockClient as never).generate({
      problemTitle: '约束子串',
      statementMarkdown: '题面',
      options: { problemKind: 'function', caseCount: 2, languages: ['py', 'java', 'cc'] },
    });

    await expect(promise).rejects.toMatchObject({
      code: 'TEMPLATE_COMPILE_FAILED',
      stage: 'template_missing',
      artifact: 'template-java',
      retryPolicy: 'repair-artifact',
    });
    expect(mockClient.chat).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['java', 'template-java'],
    ['cc', 'template-cc'],
  ] as const)('沙箱模板补全仍缺失 %s 时归因到对应 artifact', async (language, artifact) => {
    const usedModel = { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' };
    const marker = language === 'java'
      ? /@@@TEMPLATE:java@@@[\s\S]*?(?=@@@TEMPLATE:cc@@@)/
      : /@@@TEMPLATE:cc@@@[\s\S]*?(?=@@@NOTES@@@)/;
    const artifacts = makeGenerationArtifactsBlueprint('function').replace(marker, '');
    const mockClient = {
      chat: jest.fn()
        .mockResolvedValueOnce({ content: makeSolutionBlueprint('function'), usedModel })
        .mockResolvedValueOnce({ content: makeEmptyKillTargetsResponse(), usedModel })
        .mockResolvedValueOnce({ content: artifacts, usedModel })
        .mockResolvedValueOnce({ content: makeIndependentVerifierBlueprint(), usedModel })
        .mockResolvedValueOnce({ content: '@@@NOTES@@@\nstill missing', usedModel }),
    };
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn(),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn(),
    };

    const promise = new TestdataGenService(mockClient as never, {
      sandboxRunner: runner,
      mode: 'sandbox',
    }).generate({
      problemTitle: '模板 artifact 归因',
      statementMarkdown: '题面',
      options: { problemKind: 'function', caseCount: 1, languages: [language] },
    });

    await expect(promise).rejects.toMatchObject({
      code: 'TEMPLATE_COMPILE_FAILED',
      stage: 'template_missing',
      artifact,
      retryPolicy: 'repair-artifact',
    });
    expect(mockClient.chat).toHaveBeenCalledTimes(5);
  });

  it('独立验证器二次解析失败映射到 coverage 并停止当前模型调用', async () => {
    const usedModel = { endpointId: 'ep1', endpointName: 'main', modelName: 'gpt-test' };
    const invalidVerifier = '@@@BRUTE@@@\nprint(1)';
    const mockClient = {
      chat: jest.fn()
        .mockResolvedValueOnce({ content: makeSolutionBlueprint('traditional'), usedModel })
        .mockResolvedValueOnce({ content: makeEmptyKillTargetsResponse(), usedModel })
        .mockResolvedValueOnce({ content: makeGenerationArtifactsBlueprint('traditional'), usedModel })
        .mockResolvedValueOnce({ content: invalidVerifier, usedModel })
        .mockResolvedValueOnce({ content: invalidVerifier, usedModel }),
    };
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn(),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn(),
    };

    const promise = new TestdataGenService(mockClient as never, {
      sandboxRunner: runner,
      mode: 'sandbox',
    }).generate({
      problemTitle: 't',
      statementMarkdown: '题面',
      options: { problemKind: 'traditional', caseCount: 1, languages: [] },
    });

    await expect(promise).rejects.toMatchObject({
      code: 'COVERAGE_REQUIREMENT_MISSING',
      stage: 'independent_verifier_parse',
      artifact: 'coverage',
      retryPolicy: 'switch-model',
      telemetryMetadata: expect.objectContaining({ failureStage: 'independent_verifier_parse' }),
    });
    expect(mockClient.chat).toHaveBeenCalledTimes(5);
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
    const promise = service.generate({
      problemTitle: 't',
      statementMarkdown: 's',
      options: baseOptions,
    });
    await expect(promise).rejects.toMatchObject({
      code: 'GENERATOR_INVALID_JSON',
      stage: 'direct_parse',
      artifact: 'generator',
      retryPolicy: 'repair-artifact',
    });
    await expect(promise).rejects.toThrow(/JSON/);
    expect(mockClient.chat).toHaveBeenCalledTimes(1);
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

describe('两阶段沙箱蓝图', () => {
  it('解析可选 ORACLE_LANG，缺失或非法回退 Python，函数题忽略 C++', () => {
    expect(parseOracleLanguage('=== ORACLE_LANG ===\npython', 'traditional')).toBe('python');
    expect(parseOracleLanguage('=== ORACLE_LANG ===\ncpp', 'traditional')).toBe('cpp');
    expect(parseOracleLanguage('@@@META@@@\nproblemType: traditional', 'traditional')).toBe('python');
    expect(parseOracleLanguage('=== ORACLE_LANG ===\nrust', 'traditional')).toBe('python');
    expect(parseOracleLanguage('=== ORACLE_LANG ===\ncpp', 'function')).toBe('python');

    const cppSolution = parseSolutionBlueprint(
      `=== ORACLE_LANG ===\ncpp\n${makeSolutionBlueprint('traditional')}`,
      tradOpts,
    );
    expect(cppSolution.oracleLanguage).toBe('cpp');
    const cppFull = parseSandboxBlueprint(
      `=== ORACLE_LANG ===\ncpp\n${makeSandboxBlueprint('traditional')}`,
      tradOpts,
    );
    expect(cppFull.oracleLanguage).toBe('cpp');
  });

  it('仅在编译能力可用时向模型提供 ORACLE_LANG C++ 契约', () => {
    expect(buildSolutionBlueprintSystemPrompt()).not.toContain('ORACLE_LANG');
    expect(buildSandboxBlueprintSystemPrompt()).not.toContain('ORACLE_LANG');
    expect(buildSolutionBlueprintSystemPrompt(true)).toContain('=== ORACLE_LANG ===');
    expect(buildSolutionBlueprintSystemPrompt(true)).toContain('C++17');
    expect(buildSandboxBlueprintSystemPrompt(true)).toContain('=== ORACLE_LANG ===');
  });

  it('第一阶段 Prompt 只要求解题，第二阶段只要求外围制品', () => {
    const params = {
      problemTitle: '两数之和',
      statementMarkdown: '输入两个整数，输出它们的和。',
      options: { problemKind: 'traditional', caseCount: 2, languages: [] } as GenerateOptions,
    };
    const solution = parseSolutionBlueprint(makeSolutionBlueprint('traditional'), params.options);
    const solutionSystem = buildSolutionBlueprintSystemPrompt();
    const solutionUser = buildSolutionBlueprintUserPrompt(params);
    const artifactsSystem = buildGenerationArtifactsSystemPrompt();
    const artifactsUser = buildGenerationArtifactsUserPrompt(params, solution);

    expect(solutionSystem).toContain('@@@ORACLE@@@');
    expect(solutionSystem).not.toContain('@@@GENERATOR@@@');
    expect(solutionSystem).not.toContain('@@@TEMPLATE:py@@@');
    expect(solutionSystem).toContain('=== SUBTASKS ===');
    expect(solutionSystem).toContain('仅当题面明确给出子任务/分数表时输出该分节');
    expect(solutionSystem).toContain('约束摘要为该子任务的完整生效约束');
    expect(solutionSystem).toContain('NOTES 至多 2 句');
    expect(solutionSystem).toContain('不要罗列已由沙箱验证的内容');
    expect(solutionUser).toContain('这是第一阶段');
    expect(solutionUser).not.toContain('逐测试点覆盖计划');
    expect(solutionUser).not.toContain('函数题模板语言');
    expect(solutionUser).not.toContain('Hydro 测试点数量');
    expect(artifactsSystem).toContain('@@@GENERATOR@@@');
    expect(artifactsSystem).not.toContain('@@@ORACLE@@@');
    expect(artifactsSystem).toContain('编写 GENERATOR 前，先在代码注释中逐条列出题面的所有硬性保证');
    expect(artifactsSystem).toContain('任何一条违反都会导致整体失败');
    expect(artifactsSystem).toContain('NOTES 至多 2 句');
    expect(artifactsSystem).toContain('不要罗列已由沙箱验证的内容');
    expect(artifactsUser).toContain('第一阶段已验证且必须保持不变');
    expect(artifactsUser).toContain(solution.oracleCode.trim());
    expect(artifactsUser).not.toContain('@@@ORACLE@@@');
  });

  it('分层启用时外围制品 Prompt 用子任务分配替换 small/medium/large 覆盖行', () => {
    const options: GenerateOptions = {
      problemKind: 'traditional',
      caseCount: 3,
      dataScale: 'auto',
      languages: [],
    };
    const solution = parseSolutionBlueprint([
      '=== SUBTASKS ===',
      '1 | 40 | n<=100',
      '2 | 60 | n<=100000',
      makeSolutionBlueprint('traditional'),
    ].join('\n'), options);
    const prompt = buildGenerationArtifactsUserPrompt({
      problemTitle: '分层题',
      statementMarkdown: '题面明确列出两个子任务。',
      options,
    }, solution);

    expect(prompt).toContain('CASE 1: 子任务 1 — n<=100;数据必须严格满足本子任务的全部约束');
    expect(prompt).toContain('CASE 2: 子任务 2 — n<=100000;数据必须严格满足本子任务的全部约束');
    expect(prompt).toContain('CASE 3: 子任务 2 — n<=100000;数据必须严格满足本子任务的全部约束');
    expect(prompt).not.toContain('CASE 1: small');
  });

  it('解析器拒绝跨阶段夹带或重写制品', () => {
    expect(() => parseSolutionBlueprint(
      `${makeSolutionBlueprint('traditional')}\n@@@GENERATOR@@@\nprint(1)`,
      tradOpts,
    )).toThrow(/第一阶段.*禁止的 GENERATOR/);
    expect(() => parseGenerationArtifacts(
      `${makeGenerationArtifactsBlueprint('traditional')}\n@@@ORACLE@@@\nprint(2)`,
      'traditional',
      [],
    )).toThrow(/第二阶段.*禁止的 ORACLE/);
  });

  it('函数题第一阶段逐一解析题面样例 stdin 转码', () => {
    const statement = '输入：a = 2, b = 3\n输出：5\n输入：a = -1, b = 4\n输出：3';
    const raw = [
      makeSolutionBlueprint('function'),
      '@@@SAMPLE_INPUTS@@@',
      JSON.stringify({ samples: [
        { id: '1', input: '2 3' },
        { id: '2', input: '-1 4' },
      ] }),
    ].join('\n');
    const solution = parseSolutionBlueprint(
      raw,
      { problemKind: 'function', caseCount: 1, languages: ['py'] },
      extractStatementSamples(statement),
    );
    expect(solution.functionSampleInputs).toEqual([
      { id: '1', input: '2 3\n' },
      { id: '2', input: '-1 4\n' },
    ]);
  });

  it('样例预验证执行 ORACLE，并校验规范化后的输出', async () => {
    const solution = parseSolutionBlueprint(makeSolutionBlueprint('traditional'), tradOpts);
    const runner = {
      isAvailable: jest.fn(),
      runPython: jest.fn(),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn().mockResolvedValue([
        detail({ stdout: '42\n' }),
      ]),
    };
    const result = await verifySolutionBlueprintSamples(
      solution,
      tradOpts,
      '```input1\n42\n```\n```output1\n42\n```',
      runner,
    );
    expect(result).toEqual({ total: 1, passed: 1 });
    expect(runner.runPythonBatchDetailed).toHaveBeenCalledWith(
      solution.oracleCode,
      ['42\n'],
      { signal: undefined },
    );
  });

  it('C++ ORACLE 样例闸门编译后执行缓存二进制，并在 finally 清理', async () => {
    const solution = parseSolutionBlueprint(
      `=== ORACLE_LANG ===\ncpp\n${makeSolutionBlueprint('traditional')}`,
      tradOpts,
    );
    const runner = {
      isAvailable: jest.fn(),
      runPython: jest.fn(),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn(),
      compileCpp: jest.fn().mockResolvedValue({ ok: true, fileId: 'oracle-bin' }),
      runCompiledBatchDetailed: jest.fn().mockResolvedValue([
        detail({ stdout: '42\n' }),
      ]),
      deleteCachedFile: jest.fn().mockResolvedValue(undefined),
    };
    await expect(verifySolutionBlueprintSamples(
      solution,
      tradOpts,
      '```input1\n42\n```\n```output1\n42\n```',
      runner,
      undefined,
      false,
      true,
    )).resolves.toEqual({ total: 1, passed: 1 });
    expect(runner.compileCpp).toHaveBeenCalledWith(
      solution.oracleCode,
      { signal: undefined, deadlineAt: undefined },
    );
    expect(runner.runCompiledBatchDetailed).toHaveBeenCalledWith(
      'oracle-bin',
      ['42\n'],
      { signal: undefined },
    );
    expect(runner.runPythonBatchDetailed).not.toHaveBeenCalled();
    expect(runner.deleteCachedFile).toHaveBeenCalledWith('oracle-bin');
  });

  it('教师 C++ 标程编译失败是含 g++ 摘要的硬错误，不进入 AI 修复语义', async () => {
    const options: GenerateOptions = {
      ...tradOpts,
      providedStd: '```cpp\nint main( {\n```',
      providedStdSource: 'manual',
    };
    const solution = parseSolutionBlueprint(makeSolutionBlueprint('traditional'), options);
    const runner = {
      isAvailable: jest.fn(),
      runPython: jest.fn(),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn(),
      compileCpp: jest.fn().mockResolvedValue({
        ok: false,
        kind: 'compile',
        error: 'prog.cc:1: error: expected declaration',
      }),
      runCompiledBatchDetailed: jest.fn(),
      deleteCachedFile: jest.fn(),
    };
    await expect(verifySolutionBlueprintSamples(
      solution,
      options,
      '```input1\n42\n```\n```output1\n42\n```',
      runner,
      undefined,
      false,
      true,
    )).rejects.toMatchObject({
      userMessageKey: 'ai_helper_testdata_err_cpp_std_compile_failed',
      message: expect.stringContaining('prog.cc:1: error'),
    });
  });

  it('教师 C++ 标程编译基础设施失败标为可重试生成错误，而非教师代码错误', async () => {
    const options: GenerateOptions = {
      ...tradOpts,
      providedStd: '```cpp\nint main() { return 0; }\n```',
      providedStdSource: 'manual',
    };
    const solution = parseSolutionBlueprint(makeSolutionBlueprint('traditional'), options);
    const runner = {
      isAvailable: jest.fn(),
      runPython: jest.fn(),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn(),
      compileCpp: jest.fn().mockResolvedValue({
        ok: false,
        kind: 'infra',
        error: 'connect ECONNRESET',
      }),
      runCompiledBatchDetailed: jest.fn(),
      deleteCachedFile: jest.fn(),
    };
    await expect(verifySolutionBlueprintSamples(
      solution,
      options,
      '```input1\n42\n```\n```output1\n42\n```',
      runner,
      undefined,
      false,
      true,
    )).rejects.toMatchObject({
      userMessageKey: 'ai_helper_testdata_err_cpp_oracle_infra',
      message: expect.stringContaining('ECONNRESET'),
    });
  });
});

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

  it('主蓝图 Prompt 聚焦 ORACLE/SOLUTION，不再同时要求 BRUTE/VALIDATOR', () => {
    const sp = buildSandboxBlueprintSystemPrompt();
    expect(sp).toContain('@@@SOLUTION@@@');
    expect(sp).toContain('=== SUBTASKS ===');
    expect(sp).not.toContain('@@@BRUTE@@@');
    expect(sp).not.toContain('@@@VALIDATOR@@@');
    expect(sp).toContain('独立调用中生成验证器');
    expect(sp).toContain('ORACLE 是自包含、可直接运行的 Python 3 完整程序');
    expect(sp).toContain('NOTES 至多 2 句');
    expect(sp).toContain('不要罗列已由沙箱验证的内容');
  });

  it('第一阶段与兼容完整蓝图均存储合法 SUBTASKS 规格', () => {
    const subtaskSection = [
      '=== SUBTASKS ===',
      '1 | 30 | n<=100，且所有权值相等',
      '2 | 70 | n<=100000，完整题面约束',
    ].join('\n');
    const expected = [
      { id: 1, score: 30, constraints: 'n<=100，且所有权值相等' },
      { id: 2, score: 70, constraints: 'n<=100000，完整题面约束' },
    ];

    const solution = parseSolutionBlueprint(
      `${subtaskSection}\n${makeSolutionBlueprint('traditional')}`,
      tradOpts,
    );
    const full = parseSandboxBlueprint(
      `${subtaskSection}\n${makeSandboxBlueprint('traditional')}`,
      tradOpts,
    );

    expect(solution.subtasks).toEqual(expected);
    expect(full.subtasks).toEqual(expected);
  });

  it('独立验证 Prompt 与解析器强制要求 BRUTE/STRESS_GENERATOR/VALIDATOR', () => {
    const system = buildIndependentVerifierSystemPrompt();
    expect(system).toContain(`恰好生成 ${TESTDATA_GEN_LIMITS.STRESS_CASES} 组小数据`);
    expect(system).toContain(`至少 ${Math.ceil(TESTDATA_GEN_LIMITS.STRESS_CASES * TESTDATA_GEN_LIMITS.STRESS_MIN_UNIQUE_RATIO)} 组 input 互不相同`);
    expect(system).toContain('编写 STRESS_GENERATOR 前，先在代码注释中逐条列出题面的所有硬性保证');
    expect(system).toContain('每一条“保证/约定”都必须成为一条显式校验');
    expect(system).toContain('合法输入必须接受，非法输入必须拒绝');
    expect(system).toContain('不得添加题面没有的额外限制');
    expect(system).not.toContain('宁可过严拒绝');
    expect(system).toContain('=== COMPLEXITY_GAP ===');
    expect(system).not.toContain('@@@ORACLE@@@');
    const verifier = parseIndependentVerifierBlueprint(makeIndependentVerifierBlueprint());
    expect(verifier.bruteCode).toContain('independent brute');
    expect(verifier.stressGeneratorCode).toContain('stress generator');
    expect(verifier.validatorCode).toContain('sys.exit(0)');
    expect(() => parseIndependentVerifierBlueprint('@@@BRUTE@@@\nprint(1)'))
      .toThrow(/STRESS_GENERATOR、VALIDATOR/);
  });

  it('独立验证 User Prompt 不泄漏 ORACLE 源码', () => {
    const prompt = buildIndependentVerifierUserPrompt({
      problemTitle: '题目',
      statementMarkdown: '输入一个整数并输出它',
      options: { problemKind: 'traditional', caseCount: 1, languages: [], providedStd: 'SECRET_ORACLE' },
    }, parseSandboxBlueprint(makeSandboxBlueprint('traditional'), tradOpts));
    expect(prompt).toContain('每个文件只放一组数据');
    expect(prompt).not.toContain('SECRET_ORACLE');
    expect(prompt).not.toContain('print(input())');
  });

  it('函数题样例必须由独立调用逐一转换为原始 stdin', () => {
    const statement = [
      '输入：a = 2, b = 3',
      '输出：5',
      '输入：a = -1, b = 4',
      '输出：3',
    ].join('\n');
    const samples = extractStatementSamples(statement);
    const prompt = buildIndependentVerifierUserPrompt({
      problemTitle: '两数相加',
      statementMarkdown: statement,
      options: { problemKind: 'function', caseCount: 1, languages: ['py'] },
    }, {
      problemType: 'function',
      functionName: 'add',
      analysis: 'stdin 两个整数以空格分隔。',
    });
    expect(prompt).toContain('@@@SAMPLE_INPUTS@@@');
    expect(prompt).toContain('样例 1 展示输入');

    expect(() => parseIndependentVerifierBlueprint(makeIndependentVerifierBlueprint(), samples))
      .toThrow(/缺少 SAMPLE_INPUTS/);
    const verifier = parseIndependentVerifierBlueprint(makeIndependentVerifierBlueprint([
      { id: '1', input: '2 3' },
      { id: '2', input: '-1 4' },
    ]), samples);
    expect(verifier.functionSampleInputs).toEqual([
      { id: '1', input: '2 3\n' },
      { id: '2', input: '-1 4\n' },
    ]);
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

  it('修复轮复用阶段缓存并仅延续已消耗后的沙箱预算，AI 等待时间不计入', async () => {
    const broken = tradBlueprint([
      '@@@BRUTE@@@',
      'print("wrong")  # broken-brute',
    ]);
    const repaired = {
      ...broken,
      bruteCode: 'print(input())  # fixed-brute\n',
    };
    let clock = 1_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => clock);
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn().mockImplementation(async () => {
        clock += 100;
        return { stdout: twoCaseGen(), stderr: '' };
      }),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn().mockImplementation(
        async (code: string, inputs: string[]) => {
          clock += 100;
          return inputs.map(input => detail({
            stdout: code.includes('broken-brute') ? 'wrong\n' : input,
          }));
        },
      ),
    };
    const cache = {};
    try {
      await expect(materializeSandboxBlueprint(
        broken,
        tradOpts,
        '',
        runner,
        undefined,
        false,
        undefined,
        [],
        false,
        undefined,
        { ...resolveMaterializationResume(['GENERATOR']), cache },
      )).rejects.toThrow(/暴力解与标程/);

      // 模拟两轮 materialization 之间较慢的 AI 修复；它不应吞掉沙箱余额。
      clock += 100_000;
      await expect(materializeSandboxBlueprint(
        repaired,
        tradOpts,
        '',
        runner,
        undefined,
        false,
        undefined,
        [],
        false,
        undefined,
        { ...resolveMaterializationResume(['BRUTE']), cache },
      )).resolves.toMatchObject({ cases: [{ output: '1\n' }, { output: '2\n' }] });
    } finally {
      nowSpy.mockRestore();
    }

    expect(runner.runPython).toHaveBeenCalledTimes(1);
    const fixedBruteCall = runner.runPythonBatchDetailed.mock.calls.find(
      ([code]) => String(code).includes('fixed-brute'),
    );
    expect(fixedBruteCall?.[2]?.deadlineAt).toBe(401_000);
  });

  it('C++ ORACLE 在正确性检查结束后清理 fileId，清理耗时不消耗正确性预算', async () => {
    const bp = parseSandboxBlueprint([
      '=== ORACLE_LANG ===', 'cpp',
      '@@@META@@@', 'problemType: traditional',
      '@@@GENERATOR@@@', 'print(gen())',
      '@@@ORACLE@@@', '#include <iostream>',
      '@@@BRUTE@@@', 'print(input())',
    ].join('\n'), tradOpts);
    let clock = 1_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => clock);
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn().mockResolvedValue({ stdout: twoCaseGen(), stderr: '' }),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn().mockImplementation((_code: string, inputs: string[]) =>
        Promise.resolve(inputs.map(input => detail({ stdout: input })))),
      compileCpp: jest.fn().mockResolvedValue({ ok: true, fileId: 'materialized-oracle' }),
      runCompiledBatchDetailed: jest.fn().mockResolvedValue([
        detail({ stdout: '1\n' }),
        detail({ stdout: '2\n' }),
      ]),
      deleteCachedFile: jest.fn().mockImplementation(async () => {
        clock += SANDBOX_TOTAL_BUDGET_MS + 1;
      }),
    };
    let response: Awaited<ReturnType<typeof materializeSandboxBlueprint>>;
    try {
      response = await materializeSandboxBlueprint(
        bp,
        tradOpts,
        '',
        runner,
        undefined,
        false,
        undefined,
        [],
        true,
      );
    } finally {
      nowSpy.mockRestore();
    }
    expect(response.cases.map(item => item.output)).toEqual(['1\n', '2\n']);
    expect(response.oracleLanguage).toBe('cpp');
    expect(runner.runCompiledBatchDetailed).toHaveBeenCalledWith(
      'materialized-oracle',
      ['1\n', '2\n'],
      expect.objectContaining({
        deadlineAt: expect.any(Number),
        chunkConcurrency: 3,
      }),
    );
    expect(runner.runPythonBatchDetailed).toHaveBeenCalled();
    expect(runner.deleteCachedFile).toHaveBeenCalledWith('materialized-oracle');
  });

  it('VALIDATOR 拒绝某个 .in 时硬失败并带 stderr，且先于标程执行', async () => {
    const bp = tradBlueprint(['@@@VALIDATOR@@@', 'check()']);
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn().mockResolvedValue({ stdout: twoCaseGen(), stderr: '' }),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn().mockResolvedValue([
        detail({ stdout: '' }),
        detail({ accepted: false, status: 'Nonzero Exit Status', exitStatus: 1, stderr: '数值超出范围' }),
      ]),
    };
    const failure = await materializeSandboxBlueprint(bp, tradOpts, '', runner)
      .catch(error => error);
    expect(failure).toMatchObject({
      code: 'GENERATOR_INVALID_INPUT',
      stage: 'validator',
      artifact: 'generator',
      retryPolicy: 'repair-artifact',
      safeDetails: { caseIndex: 2 },
    });
    expect(failure.message).toMatch(/第 2 个 .in 未通过输入校验：数值超出范围/);
    expect(buildSandboxRepairPrompt(failure, tradOpts))
      .toContain('请只输出修复后的 @@@GENERATOR@@@');
    expect(runner.runPythonBatch).not.toHaveBeenCalled();
  });

  it('VALIDATOR 拒绝题面样例时仍按原语义硬失败', async () => {
    const bp = tradBlueprint(['@@@VALIDATOR@@@', 'check()']);
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn().mockResolvedValue({ stdout: twoCaseGen(), stderr: '' }),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn().mockResolvedValue([
        detail(),
        detail(),
        detail({
          accepted: false,
          status: 'Nonzero Exit Status',
          exitStatus: 1,
          stderr: '样例非法',
        }),
      ]),
    };

    const failure = await materializeSandboxBlueprint(
      bp,
      tradOpts,
      '```input1\n3\n```\n```output1\n3\n```',
      runner,
    ).catch(error => error);
    expect(failure).toMatchObject({
      code: 'VALIDATOR_FALSE_REJECT',
      stage: 'validator',
      artifact: 'validator',
      retryPolicy: 'repair-artifact',
      safeDetails: { caseIndex: 3, sample: true },
    });
    expect(failure.message).toMatch(/题面样例 1 未通过输入校验：样例非法/);
    expect(buildSandboxRepairPrompt(failure, tradOpts))
      .toContain('同时输出修复后的 @@@GENERATOR@@@ 与 @@@VALIDATOR@@@');
    expect(runner.runPythonBatchDetailed).toHaveBeenCalledTimes(1);
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

  it('ORACLE 在生成的测试点上崩溃：直接点名测试点并附输入与 stderr 尾部', async () => {
    const bp = tradBlueprint();
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn().mockResolvedValue({ stdout: twoCaseGen(), stderr: '' }),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn().mockResolvedValue([
        detail({
          accepted: false, status: 'Nonzero Exit Status', exitStatus: 1,
          stderr: 'Traceback (most recent call last):\nIndexError: string index out of range',
        }),
        detail({ stdout: '2\n' }),
      ]),
    };
    const err: Error = await materializeSandboxBlueprint(bp, tradOpts, '', runner).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/ORACLE（标程）在第 1 个测试点上执行失败/);
    expect(err.message).toContain('输入：1');
    expect(err.message).toContain('IndexError: string index out of range');
  });

  it('ORACLE 在题面样例上崩溃：直接点名样例编号', async () => {
    const bp = tradBlueprint();
    const statement = ['## 样例', '```input1', '9 9', '```', '```output1', '18', '```'].join('\n');
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn().mockResolvedValue({ stdout: twoCaseGen(), stderr: '' }),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn().mockResolvedValue([
        detail({ stdout: '1\n' }),
        detail({ stdout: '2\n' }),
        detail({ accepted: false, status: 'Nonzero Exit Status', exitStatus: 1, stderr: 'ValueError: bad sample' }),
      ]),
    };
    const err: Error = await materializeSandboxBlueprint(bp, tradOpts, statement, runner).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/ORACLE（标程）在题面样例 1 上执行失败/);
    expect(err.message).toContain('ValueError: bad sample');
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
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn().mockRejectedValue(cancelErr),
    };
    await expect(materializeSandboxBlueprint(bp, tradOpts, '', oracleCancelRunner)).rejects.toBe(cancelErr);
  });

  it('BRUTE 与标程一致：记录 agreed，不拦截', async () => {
    const bp = tradBlueprint(['@@@BRUTE@@@', 'print(input())']);
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn().mockResolvedValue({ stdout: twoCaseGen(), stderr: '' }),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn()
        .mockResolvedValueOnce([detail({ stdout: '1\n' }), detail({ stdout: '2\n' })]) // ORACLE
        .mockResolvedValueOnce([detail({ stdout: '1\n' }), detail({ stdout: '2\n' })]), // BRUTE
    };
    const res = await materializeSandboxBlueprint(bp, tradOpts, '', runner);
    expect(res.verification?.bruteCheck).toEqual({ compared: 2, agreed: 2, skippedTimeout: [], disagreed: [] });
  });

  it('BRUTE 与 AI 标程不一致：硬失败并带证据摘录', async () => {
    const bp = tradBlueprint(['@@@BRUTE@@@', 'print(input())']);
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn().mockResolvedValue({ stdout: twoCaseGen(), stderr: '' }),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn()
        .mockResolvedValueOnce([detail({ stdout: '1\n' }), detail({ stdout: '2\n' })]) // ORACLE
        .mockResolvedValueOnce([detail({ stdout: '1\n' }), detail({ stdout: '999\n' })]), // BRUTE
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
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn()
        .mockResolvedValueOnce([detail({ stdout: '1\n' }), detail({ stdout: '2\n' })]) // ORACLE
        .mockResolvedValueOnce([detail({ stdout: '1\n' }), detail({ stdout: '999\n' })]), // BRUTE
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
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn()
        .mockResolvedValueOnce([detail({ stdout: '1\n' }), detail({ stdout: '2\n' })]) // ORACLE
        .mockResolvedValueOnce([
          detail({ stdout: '1\n' }),
          detail({ accepted: false, timedOut: true, status: 'Time Limit Exceeded' }),
        ]), // BRUTE
    };
    const res = await materializeSandboxBlueprint(bp, tradOpts, '', runner);
    expect(res.verification?.bruteCheck).toMatchObject({ agreed: 1, skippedTimeout: [2], disagreed: [] });
  });

  it('独立验证器在内部小数据上完成强制压力对拍且不写入正式 cases', async () => {
    const bp = {
      ...tradBlueprint(),
      ...parseIndependentVerifierBlueprint(makeIndependentVerifierBlueprint()),
    };
    const stressInputs = Array.from(
      { length: TESTDATA_GEN_LIMITS.STRESS_CASES },
      (_, i) => `${i + 1}\n`,
    );
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn()
        .mockResolvedValueOnce({ stdout: twoCaseGen(), stderr: '' })
        .mockResolvedValueOnce({ stdout: stressGeneratorStdout(), stderr: '' }),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn()
        .mockResolvedValueOnce(Array.from(
          { length: 2 + TESTDATA_GEN_LIMITS.STRESS_CASES },
          () => detail(),
        )) // VALIDATOR：正式 + stress
        .mockResolvedValueOnce([
          detail({ stdout: '1\n' }), detail({ stdout: '2\n' }),
          ...stressInputs.map(input => detail({ stdout: input })),
        ]) // ORACLE：正式 + stress
        .mockResolvedValueOnce(stressInputs.map(input => detail({ stdout: input }))), // BRUTE：stress
    };
    const res = await materializeSandboxBlueprint(bp, tradOpts, '', runner);
    expect(res.cases).toHaveLength(2);
    expect(res.verification?.stressCheck).toEqual({
      generated: TESTDATA_GEN_LIMITS.STRESS_CASES,
      uniqueInputs: TESTDATA_GEN_LIMITS.STRESS_CASES,
      duplicateInputs: 0,
      compared: TESTDATA_GEN_LIMITS.STRESS_CASES,
      agreed: TESTDATA_GEN_LIMITS.STRESS_CASES,
    });
    expect(res.verification?.bruteCheck).toBeUndefined();
    expect(res.verification?.validator?.casesChecked).toBe(2 + TESTDATA_GEN_LIMITS.STRESS_CASES);
    expect(res.notes).toContain(`${TESTDATA_GEN_LIMITS.STRESS_CASES} 组内部小数据`);
  });

  it('少量压力输入未通过 VALIDATOR 时剔除并只把存活集交给 ORACLE 与 BRUTE', async () => {
    const bp = {
      ...tradBlueprint(),
      ...parseIndependentVerifierBlueprint(makeIndependentVerifierBlueprint()),
    };
    const stressInputs = Array.from(
      { length: TESTDATA_GEN_LIMITS.STRESS_CASES },
      (_, i) => `${i + 1}\n`,
    );
    const invalidStressIndices = new Set([1, 4]);
    const keptStressInputs = stressInputs.filter((_, index) => !invalidStressIndices.has(index));
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn()
        .mockResolvedValueOnce({ stdout: twoCaseGen(), stderr: '' })
        .mockResolvedValueOnce({ stdout: stressGeneratorStdout(), stderr: '' }),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn()
        .mockResolvedValueOnce([
          detail(),
          detail(),
          ...stressInputs.map((_input, index) => invalidStressIndices.has(index)
            ? detail({
              accepted: false,
              status: 'Nonzero Exit Status',
              stderr: `invalid-${index + 1}`,
            })
            : detail()),
        ])
        .mockImplementationOnce((_code: string, actualInputs: string[]) => Promise.resolve(
          actualInputs.map(input => detail({ stdout: input })),
        ))
        .mockImplementationOnce((_code: string, actualInputs: string[]) => Promise.resolve(
          actualInputs.map(input => detail({ stdout: input })),
        )),
    };

    const res = await materializeSandboxBlueprint(bp, tradOpts, '', runner);

    expect(runner.runPythonBatchDetailed.mock.calls[1][1]).toEqual([
      '1\n',
      '2\n',
      ...keptStressInputs,
    ]);
    expect(runner.runPythonBatchDetailed.mock.calls[2][1]).toEqual(keptStressInputs);
    expect(res.verification?.stressCheck).toEqual({
      generated: TESTDATA_GEN_LIMITS.STRESS_CASES,
      uniqueInputs: TESTDATA_GEN_LIMITS.STRESS_CASES,
      duplicateInputs: 0,
      compared: keptStressInputs.length,
      agreed: keptStressInputs.length,
      droppedInvalid: invalidStressIndices.size,
    });
    expect(res.verification?.validator?.casesChecked).toBe(
      2 + TESTDATA_GEN_LIMITS.STRESS_CASES,
    );
    expect(res.notes).toContain(
      '已剔除 2 组未通过输入校验的内部压力数据(仅用于内部对拍,不影响正式测试点)。',
    );
  });

  it('压力输入过滤后错误详情仍使用对应的原始标签', async () => {
    const bp = {
      ...tradBlueprint(),
      ...parseIndependentVerifierBlueprint(makeIndependentVerifierBlueprint()),
    };
    const stressInputs = Array.from(
      { length: TESTDATA_GEN_LIMITS.STRESS_CASES },
      (_, i) => `${i + 1}\n`,
    );
    const keptStressInputs = stressInputs.slice(1);
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn()
        .mockResolvedValueOnce({ stdout: twoCaseGen(), stderr: '' })
        .mockResolvedValueOnce({ stdout: stressGeneratorStdout(), stderr: '' }),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn()
        .mockResolvedValueOnce([
          detail(),
          detail(),
          detail({
            accepted: false,
            status: 'Nonzero Exit Status',
            stderr: 'drop-first',
          }),
          ...stressInputs.slice(1).map(() => detail()),
        ])
        .mockResolvedValueOnce([
          detail({ stdout: '1\n' }),
          detail({ stdout: '2\n' }),
          ...keptStressInputs.map(input => detail({ stdout: input })),
        ])
        .mockResolvedValueOnce([
          detail({ stdout: 'wrong\n' }),
          ...keptStressInputs.slice(1).map(input => detail({ stdout: input })),
        ]),
    };

    await expect(materializeSandboxBlueprint(bp, tradOpts, '', runner)).rejects.toThrow(
      /第 1 组小数据不一致（stress-2）.*输入：2/s,
    );
  });

  it('压力输入校验存活数不足 75% 时保留现有错误格式并停止后续阶段', async () => {
    const bp = {
      ...tradBlueprint(),
      ...parseIndependentVerifierBlueprint(makeIndependentVerifierBlueprint()),
    };
    const invalidCount = Math.floor(
      TESTDATA_GEN_LIMITS.STRESS_CASES
      * (1 - TESTDATA_GEN_LIMITS.STRESS_MIN_VALID_RATIO),
    ) + 1;
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn()
        .mockResolvedValueOnce({ stdout: twoCaseGen(), stderr: '' })
        .mockResolvedValueOnce({ stdout: stressGeneratorStdout(), stderr: '' }),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn().mockResolvedValueOnce([
        detail(),
        detail(),
        ...Array.from({ length: TESTDATA_GEN_LIMITS.STRESS_CASES }, (_, index) =>
          index < invalidCount
            ? detail({
              accepted: false,
              status: 'Nonzero Exit Status',
              stderr: `invalid-${index + 1}`,
            })
            : detail()),
      ]),
    };

    const failure = await materializeSandboxBlueprint(bp, tradOpts, '', runner)
      .catch(error => error);
    expect(failure).toMatchObject({
      code: 'STRESS_INSUFFICIENT_VALID_INPUTS',
      stage: 'validator',
      artifact: 'stress-generator',
      retryPolicy: 'repair-artifact',
    });
    expect(failure.message).toMatch(/第 1 个压力 \.in 未通过输入校验：invalid-1/);
    expect(buildSandboxRepairPrompt(failure, tradOpts))
      .toContain('重新输出完整的 @@@BRUTE@@@、@@@STRESS_GENERATOR@@@、@@@VALIDATOR@@@');
    expect(runner.runPythonBatchDetailed).toHaveBeenCalledTimes(1);
  });

  it('压力生成器用重复 input 凑数时在执行标程前硬失败', async () => {
    const bp = {
      ...tradBlueprint(),
      ...parseIndependentVerifierBlueprint(makeIndependentVerifierBlueprint()),
    };
    const duplicatedStress = JSON.stringify({
      cases: Array.from({ length: TESTDATA_GEN_LIMITS.STRESS_CASES }, (_, i) => ({
        label: `duplicate-${i + 1}`,
        input: '1',
      })),
    });
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn()
        .mockResolvedValueOnce({ stdout: twoCaseGen(), stderr: '' })
        .mockResolvedValueOnce({ stdout: duplicatedStress, stderr: '' }),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn(),
    };

    await expect(materializeSandboxBlueprint(bp, tradOpts, '', runner)).rejects.toThrow(
      /STRESS_GENERATOR 压力数据多样性不足：60 组中仅 1 组 input 唯一.*至少需要 48 组/s,
    );
    expect(runner.runPythonBatchDetailed).not.toHaveBeenCalled();
  });

  it('历史 AC 仅在样例与独立压力对拍全部通过后作为候选输出依据', async () => {
    const bp = {
      ...tradBlueprint(),
      ...parseIndependentVerifierBlueprint(makeIndependentVerifierBlueprint()),
    };
    const opts: GenerateOptions = {
      ...tradOpts,
      providedStd: 'print(input())',
      providedStdSource: 'accepted-record',
    };
    const stressInputs = Array.from(
      { length: TESTDATA_GEN_LIMITS.STRESS_CASES },
      (_, i) => `${i + 1}\n`,
    );
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn()
        .mockResolvedValueOnce({ stdout: twoCaseGen(), stderr: '' })
        .mockResolvedValueOnce({ stdout: stressGeneratorStdout(), stderr: '' }),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn()
        .mockResolvedValueOnce(Array.from(
          { length: 2 + TESTDATA_GEN_LIMITS.STRESS_CASES }, () => detail(),
        ))
        .mockResolvedValueOnce([
          detail({ stdout: '1\n' }), detail({ stdout: '2\n' }),
          ...stressInputs.map(input => detail({ stdout: input })),
        ])
        .mockResolvedValueOnce(stressInputs.map(input => detail({ stdout: input }))),
    };

    const res = await materializeSandboxBlueprint(bp, opts, '', runner);
    expect(res.verification?.oracleKind).toBe('accepted-record');
    expect(res.verification?.stressCheck).toMatchObject({
      compared: TESTDATA_GEN_LIMITS.STRESS_CASES,
      agreed: TESTDATA_GEN_LIMITS.STRESS_CASES,
    });
    expect(res.notes).toContain('所选历史 AC 仅作为候选解');
    expect(res.notesStructured?.warnings.some(note => note.includes('所选历史 AC 仅作为候选解')))
      .toBe(true);
    expect(res.notesStructured?.system.some(note => note.includes('Hydro 沙箱中实际运行')))
      .toBe(true);
  });

  it('历史 AC 与独立 BRUTE 冲突时硬失败，不允许把 BRUTE 修成迎合 AC', async () => {
    const bp = {
      ...tradBlueprint(),
      ...parseIndependentVerifierBlueprint(makeIndependentVerifierBlueprint()),
    };
    const opts: GenerateOptions = {
      ...tradOpts,
      providedStd: 'print(input())',
      providedStdSource: 'accepted-record',
    };
    const stressInputs = Array.from(
      { length: TESTDATA_GEN_LIMITS.STRESS_CASES },
      (_, i) => `${i + 1}\n`,
    );
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn()
        .mockResolvedValueOnce({ stdout: twoCaseGen(), stderr: '' })
        .mockResolvedValueOnce({ stdout: stressGeneratorStdout(), stderr: '' }),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn()
        .mockResolvedValueOnce(Array.from(
          { length: 2 + TESTDATA_GEN_LIMITS.STRESS_CASES }, () => detail(),
        ))
        .mockResolvedValueOnce([
          detail({ stdout: '1\n' }), detail({ stdout: '2\n' }),
          ...stressInputs.map(input => detail({ stdout: input })),
        ])
        .mockResolvedValueOnce([
          detail({ stdout: 'wrong\n' }),
          ...stressInputs.slice(1).map(input => detail({ stdout: input })),
        ]),
    };

    await expect(materializeSandboxBlueprint(bp, opts, '', runner)).rejects.toThrow(
      /AC 候选标程与独立 BRUTE.*已拒绝使用.*不会修复 BRUTE 来迁就它/s,
    );
  });

  it('压力对拍 BRUTE 超时不允许跳过', async () => {
    const bp = {
      ...tradBlueprint(),
      ...parseIndependentVerifierBlueprint(makeIndependentVerifierBlueprint()),
    };
    const stressInputs = Array.from(
      { length: TESTDATA_GEN_LIMITS.STRESS_CASES },
      (_, i) => `${i + 1}\n`,
    );
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn()
        .mockResolvedValueOnce({ stdout: twoCaseGen(), stderr: '' })
        .mockResolvedValueOnce({ stdout: stressGeneratorStdout(), stderr: '' }),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn()
        .mockResolvedValueOnce(Array.from(
          { length: 2 + TESTDATA_GEN_LIMITS.STRESS_CASES },
          () => detail(),
        ))
        .mockResolvedValueOnce([
          detail({ stdout: '1\n' }), detail({ stdout: '2\n' }),
          ...stressInputs.map(input => detail({ stdout: input })),
        ])
        .mockResolvedValueOnce([
          detail({ accepted: false, timedOut: true, status: 'Time Limit Exceeded' }),
          ...stressInputs.slice(1).map(input => detail({ stdout: input })),
        ]),
    };
    await expect(materializeSandboxBlueprint(bp, tradOpts, '', runner))
      .rejects.toThrow(/压力对拍 BRUTE 在第 1 组小数据超时；压力阶段不允许跳过/);
  });

  it('自定义 checker 题仍实跑独立 BRUTE，但不做纯文本压力比较', async () => {
    const bp = {
      ...tradBlueprint(),
      ...parseIndependentVerifierBlueprint(makeIndependentVerifierBlueprint()),
    };
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn()
        .mockResolvedValueOnce({ stdout: twoCaseGen(), stderr: '' })
        .mockResolvedValueOnce({ stdout: stressGeneratorStdout(), stderr: '' }),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn()
        .mockResolvedValueOnce(Array.from(
          { length: 2 + TESTDATA_GEN_LIMITS.STRESS_CASES }, () => detail(),
        ))
        .mockResolvedValueOnce([
          detail({ stdout: 'official-a\n' }), detail({ stdout: 'official-b\n' }),
          ...Array.from({ length: TESTDATA_GEN_LIMITS.STRESS_CASES }, () => detail({ stdout: 'oracle-form\n' })),
        ])
        .mockResolvedValueOnce(Array.from(
          { length: TESTDATA_GEN_LIMITS.STRESS_CASES }, () => detail({ stdout: 'different-but-checker-valid\n' }),
        )),
    };
    const res = await materializeSandboxBlueprint(bp, tradOpts, '', runner, undefined, true);
    expect(res.verification?.stressCheck).toEqual({
      generated: TESTDATA_GEN_LIMITS.STRESS_CASES,
      uniqueInputs: TESTDATA_GEN_LIMITS.STRESS_CASES,
      duplicateInputs: 0,
      compared: 0,
      agreed: 0,
      skippedReason: 'custom-checker',
    });
    expect(res.notes).toContain('跳过纯文本压力对拍');
  });

  it('可执行 checker 对 BRUTE 与 ORACLE 的不同文本做压力判定', async () => {
    const bp = {
      ...tradBlueprint(),
      ...parseIndependentVerifierBlueprint(makeIndependentVerifierBlueprint()),
    };
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn()
        .mockResolvedValueOnce({ stdout: twoCaseGen(), stderr: '' })
        .mockResolvedValueOnce({ stdout: stressGeneratorStdout(), stderr: '' }),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn()
        .mockResolvedValueOnce(Array.from(
          { length: 2 + TESTDATA_GEN_LIMITS.STRESS_CASES }, () => detail(),
        ))
        .mockResolvedValueOnce([
          detail({ stdout: 'official-a\n' }), detail({ stdout: 'official-b\n' }),
          ...Array.from({ length: TESTDATA_GEN_LIMITS.STRESS_CASES }, () => detail({ stdout: 'oracle-form\n' })),
        ])
        .mockResolvedValueOnce(Array.from(
          { length: TESTDATA_GEN_LIMITS.STRESS_CASES }, () => detail({ stdout: 'alternative-form\n' }),
        ))
        .mockResolvedValueOnce([detail(), detail()]),
    };
    const checkerExecutor = {
      status: 'ready' as const,
      runtimeSkipped: 0,
      runBatch: jest.fn().mockResolvedValue(
        Array.from({ length: TESTDATA_GEN_LIMITS.STRESS_CASES }, () => 'accept'),
      ),
      runChecker: jest.fn().mockResolvedValue('accept'),
      dispose: jest.fn(),
    };

    const res = await materializeSandboxBlueprint(
      bp,
      tradOpts,
      '',
      runner,
      undefined,
      true,
      undefined,
      [],
      false,
      checkerExecutor,
    );

    expect(checkerExecutor.runBatch).toHaveBeenCalledWith(
      expect.arrayContaining([{
        input: expect.any(String),
        output: 'alternative-form\n',
        answer: 'oracle-form\n',
      }]),
      { signal: undefined },
    );
    expect(res.verification?.stressCheck).toMatchObject({
      compared: TESTDATA_GEN_LIMITS.STRESS_CASES,
      agreed: TESTDATA_GEN_LIMITS.STRESS_CASES,
    });
    expect(res.verification?.stressCheck).not.toHaveProperty('skippedReason');
    expect(res.notes).toContain('题目 checker');
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

  it('函数题将题面展示样例独立转码后回归 ORACLE 与 template.py', async () => {
    const fnOpts: GenerateOptions = { problemKind: 'function', caseCount: 1, languages: ['py'] };
    const statement = ['### 示例 1', '输入：a = 2, b = 3', '输出：5'].join('\n');
    const statementSamples = extractStatementSamples(statement);
    const bp = {
      ...parseSandboxBlueprint([
        '@@@META@@@', 'problemType: function', 'functionName: add',
        '@@@ANALYSIS@@@', 'stdin 两个整数以空格分隔。',
        '@@@GENERATOR@@@', 'print(gen())',
        '@@@ORACLE@@@', 'a,b=map(int,input().split())', 'print(a+b)',
        '@@@SOLUTION@@@', 'def add(a, b):', '    return a + b',
        '@@@TEMPLATE:py@@@', 'a,b=map(int,input().split())', 'print(add(a,b))',
      ].join('\n'), fnOpts),
      ...parseIndependentVerifierBlueprint(
        makeIndependentVerifierBlueprint([{ id: '1', input: '2 3' }]),
        statementSamples,
      ),
    };
    const stressInputs = Array.from(
      { length: TESTDATA_GEN_LIMITS.STRESS_CASES },
      (_, i) => `${i + 1}\n`,
    );
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn()
        .mockResolvedValueOnce({
          stdout: JSON.stringify({ cases: [{ label: 'formal', input: '1 1' }] }), stderr: '',
        })
        .mockResolvedValueOnce({ stdout: stressGeneratorStdout(), stderr: '' }),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn()
        .mockResolvedValueOnce(Array.from(
          { length: 2 + TESTDATA_GEN_LIMITS.STRESS_CASES }, () => detail(),
        ))
        .mockResolvedValueOnce([
          detail({ stdout: '2\n' }),
          detail({ stdout: '5\n' }),
          ...stressInputs.map(input => detail({ stdout: input })),
        ])
        .mockResolvedValueOnce([detail({ stdout: '2\n' }), detail({ stdout: '5\n' })])
        .mockResolvedValueOnce(stressInputs.map(input => detail({ stdout: input }))),
    };

    const res = await materializeSandboxBlueprint(bp, fnOpts, statement, runner);
    expect(res.verification?.sampleCheck).toEqual({ total: 1, passed: 1 });
    expect(res.verification?.templateCheck).toEqual({
      lang: 'py', total: 2, passed: 2, skippedTimeout: [],
    });
    expect(res.verification?.validator?.casesChecked).toBe(2 + TESTDATA_GEN_LIMITS.STRESS_CASES);
    expect(runner.runPythonBatchDetailed.mock.calls[0][2]).toEqual(expect.objectContaining({
      chunkConcurrency: 3,
    }));
    expect(runner.runPythonBatchDetailed.mock.calls[1][2]).toEqual(expect.objectContaining({
      chunkConcurrency: 3,
    }));
    expect(runner.runPythonBatchDetailed.mock.calls[2][2]).not.toHaveProperty('chunkConcurrency');
    expect(runner.runPythonBatchDetailed.mock.calls[3][2]).not.toHaveProperty('chunkConcurrency');
    expect(runner.runPythonBatchDetailed).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('def add(a, b):'),
      ['1 1\n', '2 3\n'],
      expect.anything(),
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
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn()
        .mockResolvedValueOnce([detail({ stdout: '5\n' })]) // ORACLE
        .mockResolvedValueOnce([detail({ stdout: '6\n' })]), // solution+template 实跑
    };
    await expect(materializeSandboxBlueprint(bp, fnOpts, '', runner))
      .rejects.toThrow(/template\.py 与标程在第 1 个测试点不一致/);
  });

  it('超过总时长预算时在阶段间报错', async () => {
    const bp = tradBlueprint();
    const runner = {
      isAvailable: jest.fn().mockResolvedValue(true),
      runPython: jest.fn().mockResolvedValue({ stdout: twoCaseGen(), stderr: '' }),
      runPythonBatch: jest.fn(),
      runPythonBatchDetailed: jest.fn().mockResolvedValue([]),
    };
    // 每次 Date.now 递增 40 万毫秒，任意两个阶段间隔都超 30 万预算
    let clock = 0;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => { clock += 400_000; return clock; });
    try {
      await expect(materializeSandboxBlueprint(bp, tradOpts, '', runner))
        .rejects.toThrow(/总时长超出预算/);
      expect(runner.runPythonBatchDetailed).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe('assemblePlan origin 矩阵与验证透传', () => {
  it('传统题 C++ ORACLE 生成 std.cc，教师 C++ 标程标记为 executed', () => {
    const response = {
      problemType: 'traditional',
      cases: [{ input: '1\n', output: '1\n' }],
      oracleCode: '#include <iostream>\nint main() {}',
      oracleLanguage: 'cpp',
      stdSolution: { language: 'cpp', code: '#include <iostream>\nint main() {}' },
      verification: { mode: 'sandbox', oracleKind: 'provided-std' },
    } as never;
    const opts: GenerateOptions = {
      problemKind: 'traditional',
      caseCount: 1,
      languages: [],
      providedStd: '```cpp\n#include <iostream>\nint main() {}\n```',
      providedStdSource: 'manual',
    };
    const plan = assemblePlan(response, opts, { mode: 'sandbox' });
    expect(plan.files.find(file => file.name === 'std.cc')).toMatchObject({
      kind: 'std',
      origin: 'executed',
    });
    expect(plan.files.find(file => file.name === 'std.py')).toBeUndefined();
  });

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
