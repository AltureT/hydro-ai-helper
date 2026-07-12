"use strict";
/**
 * TestdataGenService - AI 测试数据生成服务
 *
 * 面向教师/出题人：根据 Markdown 题面生成一套可直接写入 HydroOJ
 * 题目文件（测试数据）的完整文件集，包括：
 * - N.in / N.out 测试点（AI 编写输入生成器与标程，Hydro 沙箱实跑得到输出）
 * - 函数题（LeetCode 风格）所需的 template.py / template.java / template.cc
 * - compile.sh（服务端确定性生成，覆盖所选语言，非 AI 输出）
 * - config.yaml 评测配置（服务端用 js-yaml 确定性生成，写入后 Hydro
 *   会自动同步到题目的评测设置）
 * - std.py 参考标程（供教师人工校验与后续重造数据）
 *
 * 设计要点：AI 负责题目理解相关的生成器、标程与模板；AI 代码只进入 Hydro
 * go-judge 沙箱执行。结构性文件由服务端确定性拼装，兼容模式才接受 AI 直出数据。
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TestdataGenService = exports.TEMPLATE_FILENAMES = exports.TESTDATA_GEN_LIMITS = exports.SUPPORTED_TEMPLATE_LANGS = void 0;
exports.isSafeTestdataFilename = isSafeTestdataFilename;
exports.validateGenerateOptions = validateGenerateOptions;
exports.buildCoveragePlan = buildCoveragePlan;
exports.getExistingNumericCases = getExistingNumericCases;
exports.allocateCaseNumbers = allocateCaseNumbers;
exports.detectStdFilename = detectStdFilename;
exports.buildCompileSh = buildCompileSh;
exports.buildConfigYaml = buildConfigYaml;
exports.buildTestdataSystemPrompt = buildTestdataSystemPrompt;
exports.buildTestdataUserPrompt = buildTestdataUserPrompt;
exports.buildSandboxBlueprintSystemPrompt = buildSandboxBlueprintSystemPrompt;
exports.buildSandboxBlueprintUserPrompt = buildSandboxBlueprintUserPrompt;
exports.extractJsonObject = extractJsonObject;
exports.normalizeFileContent = normalizeFileContent;
exports.normalizeGenerationObject = normalizeGenerationObject;
exports.parseGenerationResponse = parseGenerationResponse;
exports.parseSandboxBlueprint = parseSandboxBlueprint;
exports.parseDelimitedResponse = parseDelimitedResponse;
exports.parseAiResponse = parseAiResponse;
exports.getMissingTemplateLanguages = getMissingTemplateLanguages;
exports.findAssignmentStyleCaseInput = findAssignmentStyleCaseInput;
exports.extractStatementSamples = extractStatementSamples;
exports.parseGeneratorOutput = parseGeneratorOutput;
exports.isCancellation = isCancellation;
exports.materializeSandboxBlueprint = materializeSandboxBlueprint;
exports.parseTemplateSections = parseTemplateSections;
exports.assemblePlan = assemblePlan;
exports.isLikelyFunctionProblem = isLikelyFunctionProblem;
exports.buildSkeletonPlan = buildSkeletonPlan;
exports.classifySandboxRepairScope = classifySandboxRepairScope;
exports.buildSandboxRepairPrompt = buildSandboxRepairPrompt;
exports.mergeSandboxBlueprintRepair = mergeSandboxBlueprintRepair;
const js_yaml_1 = __importDefault(require("js-yaml"));
const goJudgeSandboxService_1 = require("./goJudgeSandboxService");
const textTruncate_1 = require("../lib/textTruncate");
exports.SUPPORTED_TEMPLATE_LANGS = ['py', 'java', 'cc'];
// ─── 常量与校验 ───────────────────────────────────────────────────────────────
exports.TESTDATA_GEN_LIMITS = {
    MIN_CASES: 1,
    MAX_CASES: 30,
    MAX_EXTRA_REQUIREMENTS: 1000,
    MAX_PROVIDED_STD: 10000,
    MAX_STATEMENT_LENGTH: 20000,
    /**
     * AI 单次尝试超时（毫秒）。测试数据生成正确性优先、允许长思考，
     * 故显著高于普通对话；且本次调用不发送 max_tokens（输出长度不设限）。
     */
    AI_TIMEOUT_MS: 600000,
    /** apply 时单文件内容上限（字节） */
    MAX_FILE_SIZE: 256 * 1024,
    /** apply 时文件数量上限 */
    MAX_FILE_COUNT: 80,
    /** apply 时所有文件总大小上限（字节） */
    MAX_TOTAL_SIZE: 1024 * 1024,
    /** 沙箱生成器 stdout（JSON）上限。 */
    MAX_GENERATOR_OUTPUT_SIZE: 1024 * 1024,
};
/** 合法测试数据文件名：字母数字、点、下划线、连字符，不允许路径分隔符 */
const SAFE_FILENAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
function isSafeTestdataFilename(name) {
    if (!SAFE_FILENAME_RE.test(name))
        return false;
    // 防御 "..": 虽然正则不允许 "/"，仍显式排除路径穿越形态
    if (name.includes('..'))
        return false;
    return true;
}
/** 校验生成选项，返回错误 key（用于 i18n）或 null */
function validateGenerateOptions(options) {
    if (!['auto', 'traditional', 'function'].includes(options.problemKind)) {
        return 'ai_helper_testdata_err_invalid_kind';
    }
    if (!Number.isInteger(options.caseCount)
        || options.caseCount < exports.TESTDATA_GEN_LIMITS.MIN_CASES
        || options.caseCount > exports.TESTDATA_GEN_LIMITS.MAX_CASES) {
        return 'ai_helper_testdata_err_invalid_case_count';
    }
    if (!Array.isArray(options.languages) || options.languages.some(l => !exports.SUPPORTED_TEMPLATE_LANGS.includes(l))) {
        return 'ai_helper_testdata_err_invalid_languages';
    }
    // auto 模式下 AI 可能判定为函数题，同样需要模板语言
    if (options.problemKind !== 'traditional' && options.languages.length === 0) {
        return 'ai_helper_testdata_err_no_languages';
    }
    if (options.fillInMode !== undefined && !['auto', 'yes', 'no'].includes(options.fillInMode)) {
        return 'ai_helper_testdata_err_invalid_fill_in';
    }
    if (options.dataScale !== undefined && !['auto', 'small', 'medium', 'large'].includes(options.dataScale)) {
        return 'ai_helper_testdata_err_invalid_scale';
    }
    if ((options.providedStd || '').length > exports.TESTDATA_GEN_LIMITS.MAX_PROVIDED_STD) {
        return 'ai_helper_testdata_err_std_too_long';
    }
    if ((options.extraRequirements || '').length > exports.TESTDATA_GEN_LIMITS.MAX_EXTRA_REQUIREMENTS) {
        return 'ai_helper_testdata_err_extra_too_long';
    }
    return null;
}
const COVERAGE_GUIDANCE = {
    small: '合法最小值、题面样例或可人工验算的简单结构；不得为了取 0/空输入而违反题面下界',
    medium: '约束范围的中间量级，并交叉变化不同约束，避免所有维度同时按同一比例缩放',
    large: '至少一个关键约束接近上下界或临界值；使用可解析结构并控制输出体积与沙箱耗时',
};
/**
 * 为一次生成建立确定性的规模计划。auto 在 caseCount>=3 时保证三个档位均出现，
 * 其余名额按 30%/40%/30% 的目标比例用最大缺口法分配。
 */
function buildCoveragePlan(caseCount, strategy = 'auto') {
    if (!Number.isInteger(caseCount) || caseCount <= 0)
        return [];
    let scales;
    if (strategy !== 'auto') {
        scales = Array.from({ length: caseCount }, () => strategy);
    }
    else if (caseCount === 1) {
        scales = ['small'];
    }
    else if (caseCount === 2) {
        scales = ['small', 'large'];
    }
    else {
        const desired = {
            small: caseCount * 0.3,
            medium: caseCount * 0.4,
            large: caseCount * 0.3,
        };
        const counts = {
            small: Math.max(1, Math.floor(desired.small)),
            medium: Math.max(1, Math.floor(desired.medium)),
            large: Math.max(1, Math.floor(desired.large)),
        };
        const priority = ['medium', 'small', 'large'];
        while (counts.small + counts.medium + counts.large < caseCount) {
            const next = priority.reduce((best, scale) => (desired[scale] - counts[scale] > desired[best] - counts[best] ? scale : best), priority[0]);
            counts[next]++;
        }
        while (counts.small + counts.medium + counts.large > caseCount) {
            const next = [...priority].reverse().reduce((best, scale) => (counts[scale] > 1 && counts[scale] - desired[scale] > counts[best] - desired[best] ? scale : best), counts.large > 1 ? 'large' : counts.medium > 1 ? 'medium' : 'small');
            counts[next]--;
        }
        scales = [
            ...Array.from({ length: counts.small }, () => 'small'),
            ...Array.from({ length: counts.medium }, () => 'medium'),
            ...Array.from({ length: counts.large }, () => 'large'),
        ];
    }
    return scales.map((dataScale, index) => ({
        caseNumber: index + 1,
        dataScale,
        guidance: COVERAGE_GUIDANCE[dataScale],
    }));
}
/** 提取数字测试点状态：任一侧存在即保留编号，只有 in/out 成对才进入 config。 */
function getExistingNumericCases(existingFiles = []) {
    const sides = new Map();
    for (const name of existingFiles) {
        const match = name.match(/^(\d+)\.(in|out)$/i);
        if (!match)
            continue;
        const number = Number(match[1]);
        if (!Number.isSafeInteger(number) || number <= 0)
            continue;
        if (!sides.has(number))
            sides.set(number, new Set());
        sides.get(number)?.add(match[2].toLowerCase());
    }
    const reserved = new Set(sides.keys());
    const complete = [...sides.entries()]
        .filter(([, value]) => value.has('in') && value.has('out'))
        .map(([number]) => number)
        .sort((a, b) => a - b);
    return { reserved, complete };
}
/** 分配不与任何现有 .in/.out 冲突的最小正整数编号。 */
function allocateCaseNumbers(existingFiles = [], count) {
    const { reserved } = getExistingNumericCases(existingFiles);
    const allocated = [];
    for (let candidate = 1; allocated.length < count; candidate++) {
        if (reserved.has(candidate))
            continue;
        allocated.push(candidate);
        reserved.add(candidate);
    }
    return allocated;
}
/** 根据标准答案代码猜测 std 文件扩展名（教师多用 Python，启发式足够） */
function detectStdFilename(code) {
    if (/#include\s*[<"]/.test(code))
        return 'std.cc';
    if (/\bpublic\s+(static\s+)?class\b|\bpublic\s+class\b|\bSystem\.out\./.test(code))
        return 'std.java';
    return 'std.py';
}
// ─── 确定性文件生成（不经过 AI） ──────────────────────────────────────────────
/** HydroOJ 语言族 → config.yaml langs 白名单条目 */
const LANG_FAMILY_CODES = {
    py: ['py', 'py.py3'],
    java: ['java'],
    cc: ['cc', 'cc.cc14o2'],
};
/** 语言族 → 模板文件名 */
exports.TEMPLATE_FILENAMES = {
    py: 'template.py',
    java: 'template.java',
    cc: 'template.cc',
};
/**
 * 生成 compile.sh
 *
 * HydroOJ 评测机制：user_extra_files 中的文件会与学生代码一起放入编译目录，
 * 若存在 compile.sh 则用 `/bin/bash compile.sh` 取代默认编译命令，
 * 环境变量 HYDRO_LANG 为语言键（如 py.py3 / java / cc.cc14o2）。
 * 各语言编译产物需与默认执行命令匹配：
 * - py*:   学生代码为 foo.py，模板追加其后，py_compile 产出 /w/foo
 * - java:  学生代码为 Main.java（类名 Solution），换名后与模板 Main 一起编译进 Main.jar
 * - cc*:   学生代码为 foo.cc，模板 template.cc 通过 #include "foo.cc" 引入，产出 foo
 */
function buildCompileSh(languages) {
    if (languages.length === 0) {
        throw new Error('生成 compile.sh 至少需要一种模板语言');
    }
    const branches = [];
    if (languages.includes('py')) {
        branches.push(`if [[ "$HYDRO_LANG" == py* ]]; then
  cat template.py >>foo.py
  python3 -c "import py_compile; py_compile.compile('/w/foo.py', '/w/foo', doraise=True)"`);
    }
    if (languages.includes('java')) {
        branches.push(`if [[ "$HYDRO_LANG" == java* ]]; then
  mv Main.java Solution.java
  mv template.java Main.java
  javac -d /w -encoding utf8 ./Main.java ./Solution.java
  jar cvf Main.jar *.class >/dev/null`);
    }
    if (languages.includes('cc')) {
        branches.push(`if [[ "$HYDRO_LANG" == cc* ]]; then
  g++ -x c++ template.cc -o foo -lm -fno-stack-limit -std=c++14 -O2 -I/include`);
    }
    // 将多个 if 块拼成 if/elif 链
    const chain = branches
        .map((b, i) => (i === 0 ? b : b.replace(/^if /, 'elif ')))
        .join('\n');
    return `#!/bin/bash

set -e
${chain}
else
  echo "Unsupported language: $HYDRO_LANG" >&2
  exit 1
fi
`;
}
/**
 * 生成 config.yaml（评测设置）
 *
 * 写入名为 config.yaml 的测试数据后，HydroOJ 会自动将其内容同步到
 * 题目的评测设置（pdoc.config），无需再手动到「评测设置」页保存。
 */
function buildConfigYaml(options) {
    const { problemType, caseCount, languages } = options;
    const caseNumbers = options.caseNumbers?.length
        ? [...new Set(options.caseNumbers)].sort((a, b) => a - b)
        : Array.from({ length: caseCount }, (_, i) => i + 1);
    const cases = caseNumbers.map(number => ({
        input: `${number}.in`,
        output: `${number}.out`,
    }));
    const config = {
        type: 'default',
    };
    if (problemType === 'function') {
        const userExtraFiles = languages.map(l => exports.TEMPLATE_FILENAMES[l]);
        userExtraFiles.push('compile.sh');
        config.user_extra_files = userExtraFiles;
    }
    config.subtasks = [{
            score: 100,
            if: [],
            id: 1,
            type: 'sum',
            cases,
        }];
    if (problemType === 'function') {
        config.langs = languages.flatMap(l => LANG_FAMILY_CODES[l]);
    }
    return js_yaml_1.default.dump(config, { lineWidth: 120, noRefs: true });
}
// ─── 提示词构建 ───────────────────────────────────────────────────────────────
/** 函数题参考模板：普通函数题（Python 驱动） */
const REF_TEMPLATE_PY_FUNCTION = `
timeSeries = list(map(int, input().split()))
duration = int(input())
print(findPoisonedDuration(timeSeries, duration))
`;
/** 函数题参考模板：类实现链表题（Python 驱动） */
const REF_TEMPLATE_PY_LINKEDLIST = `
class ListNode:
    def __init__(self, val=0, next=None):
        self.val = val
        self.next = next

def build_linked_list(values):
    if not values:
        return None
    head = ListNode(values[0])
    current = head
    for val in values[1:]:
        current.next = ListNode(val)
        current = current.next
    return head

def linked_list_to_array(head):
    values = []
    current = head
    while current:
        values.append(current.val)
        current = current.next
    return values

line = input().strip()
values = list(map(int, line.split())) if line else []
head = build_linked_list(values)
result_head = reverseList(head)
print(' '.join(map(str, linked_list_to_array(result_head))))
`;
/** 函数题参考模板：Java 驱动（学生提交 class Solution） */
const REF_TEMPLATE_JAVA = `
import java.util.*;

public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        int[] timeSeries = Arrays.stream(sc.nextLine().trim().split("\\\\s+"))
                .mapToInt(Integer::parseInt).toArray();
        int duration = Integer.parseInt(sc.nextLine().trim());
        Solution sol = new Solution();
        System.out.println(sol.findPoisonedDuration(timeSeries, duration));
    }
}
`;
/** 函数题参考模板：C++ 驱动（通过 #include "foo.cc" 引入学生代码） */
const REF_TEMPLATE_CC = `
#include <bits/stdc++.h>
using namespace std;
#include "foo.cc"

int main() {
    string line;
    getline(cin, line);
    istringstream iss(line);
    vector<int> timeSeries;
    int x;
    while (iss >> x) timeSeries.push_back(x);
    int duration;
    cin >> duration;
    cout << findPoisonedDuration(timeSeries, duration) << endl;
    return 0;
}
`;
const LANG_DISPLAY = {
    py: 'Python (template.py)',
    java: 'Java (template.java)',
    cc: 'C++ (template.cc)',
};
/**
 * 构建 System Prompt
 */
function buildTestdataSystemPrompt() {
    return `你是一位资深的 OJ（在线评测系统）出题与测试数据专家，服务对象是高中信息技术教师。你的任务是根据 Markdown 题面，为 HydroOJ 生成一套完整、正确的测试数据。

【题型判定】
- traditional（传统题）：学生编写完整程序，从标准输入读取、向标准输出打印。
- function（函数题，LeetCode 风格）：题面通常包含"代码写到函数内部"或给出函数签名（如 def xxx(...)），学生只提交函数/类实现，由评测模板负责读输入、调用函数、打印结果。
若用户指定了题型则以用户为准；用户选择 auto 时由你根据题面判断。

【填空题（完善代码）判定】
填空题与传统/函数题正交：题面中给出一段待完善的代码，学生补全空缺处后提交完整代码。
- 判定特征：题面代码含下划线空位（如 ________1________）、"完善代码/补全/代码段自己写/your code here/TODO" 等标记，或标题含"完善代码/填空"。
- isFillIn 为 true 时的铁律：标程 stdSolution 必须是【将题面代码原样补全】得到的代码——保持题面代码的整体结构、变量名、读入方式与所有 print 语句的格式【完全不变】，只填补空缺处。测试点的 .out 必须与该补全代码的真实输出一致（学生按题面补全后必须能通过全部测试点）。严禁自行改写输出格式、增删打印内容、调整打印顺序。
- 填空题的题型判定看题面代码本身：是读 stdin 的完整程序 → traditional；只是函数定义、由模板调用 → function。
- 若题面代码中有注释形式的提示文字（如 print(c)  #"共有...个"），以实际代码为准（该例只输出 c 的值，注释不属于输出）。
若用户明确指定了是否填空题，以用户为准；否则由你判断并在 isFillIn 字段中给出结论。

【教师提供的标准答案】
若用户消息中提供了标准答案代码，它就是唯一权威：
- 每个测试点的 .out 必须通过对该代码的逐行推演得到；输出格式（内容、分隔、行数、顺序）完全以该代码为准，严禁按你自己的理解改写。
- 此时可省略 stdSolution 字段（系统会直接使用教师提供的代码）。
- 函数题的模板必须与该标准答案中的函数签名、调用方式兼容。

【函数题评测机制（HydroOJ）】
- Python：学生代码保存为 foo.py，评测时把 template.py 追加到学生代码末尾后整体运行。因此 template.py 只包含"读输入 → 调用学生函数 → 打印结果"的驱动代码，不包含函数实现本身。
- Java：学生提交 class Solution（不含 public 修饰的文件级要求），模板 template.java 为 public class Main，负责读输入并调用 new Solution().方法(...)。
- C++：学生代码保存为 foo.cc，template.cc 以 #include "foo.cc" 引入学生代码并实现 main()。
参考模板（普通函数题，题目为"提莫攻击"，函数 findPoisonedDuration(timeSeries, duration)）：
--- template.py ---${REF_TEMPLATE_PY_FUNCTION}
--- template.java ---${REF_TEMPLATE_JAVA}
--- template.cc ---${REF_TEMPLATE_CC}
链表类函数题的 Python 模板参考（题目为"反转链表"，学生实现 reverseList(head)，链表用类实现）：
--- template.py（链表） ---${REF_TEMPLATE_PY_LINKEDLIST}
若题面或教师要求"链表用列表（数组）实现"，模板则直接以 Python 列表传参，不构建节点类。
若题面给出的是类方法签名（LeetCode 常见形式，如 class Solution: def xxx(self, s, k)），学生提交的是完整的 Solution 类：Python 模板通过 Solution().xxx(...) 调用；Java 模板本就调用 new Solution().xxx(...)；C++ 模板相应以 Solution().xxx(...) 调用。此时标程也必须写成同样的类形式。
模板中的输入解析必须与你设计的 .in 文件格式严格一致；多语言模板之间的输入解析和输出格式必须完全等价，保证同一份 .in 在三种语言下输出一致。

【.in 文件是原始标准输入，不是代码】
- CASE:IN 节必须只包含程序运行时真正从 stdin 读到的字符。严禁写变量名、赋值号、语言字面量或说明文字。
- 例如参数 s="1010101"、k=2，正确的 .in 是两行原始值：第一行 1010101，第二行 2；严禁写成 s = "1010101" / k = 2。
- 数组按模板约定写成空格分隔的元素。例如 timeSeries=[1,4]、duration=2，正确的 .in 是第一行 1 4、第二行 2；严禁保留方括号、逗号、变量名和等号。
- 字符串输入通常不带源码中的引号；只有当引号本身就是题目要求的输入字符时才保留。
- 先确定唯一、语言无关的 stdin 文本格式，再让每一种模板都解析这一格式；不得让不同语言使用不同的 .in。

【按题型确定唯一 I/O 编码】
- Hydro 测试点数量是独立的 N.in/N.out 文件对数量，不是单个输入文件首行的 T。
- ACM/传统题：每个 CASE 是一份可独立运行的完整 stdin/stdout。题面含 T 时默认每个 Hydro 测试点取 T=1，并放入恰好一组完整数据；只有教师明确要求批处理时才使用 T>1。
- LeetCode/函数题：每个 CASE 只表示一次函数调用，不额外添加 T。默认每个参数占一行；一维数组用空格分隔，字符串不用源码引号。矩阵、图、树、链表等结构先确定带尺寸/哨兵的无歧义文本编码，再让所有语言模板严格共用这一编码。
- 任何输出都必须来自标程逐组推演；一个输入文件含多组数据时，不能只输出第一组答案。

【测试数据设计原则】
1. 若题面含示例，优先覆盖示例表达的场景；仍须遵守上面的“一文件一组”默认规则。
2. 必须包含边界组，并在 label 中写明设计意图：
   - 最小规模：空输入、0、1、单元素（以题面约束允许的最小值为准）；
   - 规模上限：对应 CASE 覆盖计划允许的上限附近；
   - 特殊值：相等、重复、负数、临界值（视题意选取，如闰年 2 月 29 日、恰好越界前后）；
   - 特殊结构：全相同、已排序、逆序、对称/回文等（视题意选取）。
3. 其余测试点使用多样化的中间规模数据，避免彼此雷同。
4. 输入输出必须与题面（或标程）的格式要求严格一致；.in 是评测输入文件内容，.out 是标准输出文件内容。
5. 数据规模策略（默认 auto 自动混合）：
   - auto：严格遵守用户消息中的逐 CASE 覆盖计划，在同一次生成中同时包含小规模、中等规模和临界规模；
   - small：所有数据保持人工可快速验算的量级（数值一般 ≤ 100，单个 .in ≤ 30 行）；
   - medium：在题面约束内取中等量级（如 10^2~10^4，单个 .in ≤ 200 行），仍须保证输出可被可靠推演；
   - large：接近题面约束上限。此档必须使用【可解析构造】：用有规律的数据（全相同、等差、周期、对称等），使正确输出能由公式/推理直接得出，而不是逐条模拟；无法可靠推出输出时，宁可缩小该测试点规模，也绝不允许猜测输出。
6. 若题面存在多个独立约束，不得把所有维度一起机械放大。应交叉覆盖，例如“小规模结构 + 临界元素值”“大规模结构 + 简单/稀疏取值”“某一参数取上下界而其余参数取中间值”。
7. 若题面未给出明确范围，使用保守、可被 VALIDATOR 验证的构造，不得臆造违反题意的 0、空输入或极端值。
8. 正确性最重要：先确定标程（教师已提供则以其为准），再对每个测试点逐步推演标程的运行得到 .out。宁可数据小，绝不允许输出错误。

【输出格式（分节文本，禁止 JSON）】
代码与数据必须以原文直出，因此使用分节标记格式，不要输出 JSON、不要做任何转义、不要用代码围栏包裹任何内容。标记行独占一行、顶格书写，形如 @@@标记@@@。整体结构如下（不适用的节直接省略）：

@@@META@@@
problemType: function
isFillIn: false
functionName: countKConstraintSubstrings
@@@ANALYSIS@@@
简要说明（不超过 200 字）：题意理解、输入输出格式、数据范围
@@@NOTES@@@
给教师的注意事项（可选节，如数据范围裁剪说明、填空题输出格式依据）
@@@TEMPLATE:py@@@
template.py 原文
@@@TEMPLATE:java@@@
template.java 原文
@@@TEMPLATE:cc@@@
template.cc 原文
@@@STD@@@
标程代码原文
@@@CASE:1:IN:样例1@@@
10101
1
@@@CASE:1:OUT@@@
12
@@@CASE:2:IN:边界-最小规模@@@
0
1
@@@CASE:2:OUT@@@
1

规则：
- TEMPLATE 节必须逐一输出用户要求的全部语言，一个也不能遗漏；传统题省略全部 TEMPLATE 节与 functionName。
- 函数题的 STD 节只包含与学生提交形式一致的函数/类定义（教师可用 cat std.py template.py > check.py 本地验证）；传统题的 STD 节是完整的读写标准输入输出的程序；填空题的 STD 节是补全题面代码后的结果；教师已提供标准答案时省略 STD 节。
- CASE 编号从 1 开始连续递增，数量以用户要求的 Hydro 测试点数为准；每个编号必须同时给出 IN 与 OUT 两节；IN 标记中最后一段冒号之后是该测试点的设计意图（label，简体中文）。题目内部的 T 与 CASE 数量相互独立。
- CASE:IN 再次强调：只写原始 stdin，禁止出现 s =、k =、arr = [1, 2] 等源码赋值写法。
- 各节内容为原始文本：换行就是真实换行，引号、反斜杠等一律原样书写；除标记行外不要输出任何额外说明文字；正文行不得以 @@@ 开头。
- 所有说明性文字（ANALYSIS/NOTES/label）使用简体中文。`;
}
const DATA_SCALE_TEXT = {
    auto: 'auto（自动混合：按题面约束一次覆盖小/中/临界规模）',
    small: 'small（小规模，人工可快速验算）',
    medium: 'medium（中等规模，题面约束内取中位量级）',
    large: 'large（接近题面约束上限，必须使用可解析构造保证输出正确）',
};
/**
 * 构建 User Prompt
 */
function buildTestdataUserPrompt(params) {
    const { problemTitle, statementMarkdown, options, existingFiles, fillInDetected } = params;
    const kindText = {
        auto: '自动判断（根据题面）',
        traditional: '传统题（标准输入输出）',
        function: '函数题（LeetCode 风格，学生只写函数）',
    }[options.problemKind];
    const fillInText = {
        auto: fillInDetected
            ? '自动判断（系统规则初判：题面疑似含待完善代码，请你复核）'
            : '自动判断（根据题面）',
        yes: '是（题面含待完善代码，标程必须是补全后的题面代码）',
        no: '否',
    }[options.fillInMode || 'auto'];
    const langText = options.languages.map(l => LANG_DISPLAY[l]).join('、') || '（无）';
    const requiredTemplateSections = options.languages.map(l => `@@@TEMPLATE:${l}@@@`).join('、');
    const coveragePlan = buildCoveragePlan(options.caseCount, options.dataScale || 'auto');
    const statement = statementMarkdown.length > exports.TESTDATA_GEN_LIMITS.MAX_STATEMENT_LENGTH
        ? `${statementMarkdown.slice(0, exports.TESTDATA_GEN_LIMITS.MAX_STATEMENT_LENGTH)}\n...（题面过长已截断）`
        : statementMarkdown;
    const lines = [
        `【题目标题】${problemTitle}`,
        '',
        '【题面（Markdown）】',
        statement,
        '',
        '【生成要求】',
        `- 题型：${kindText}`,
        `- 填空题（完善代码）：${fillInText}`,
        `- Hydro 测试点数量：${options.caseCount} 个独立的 .in/.out 文件对（这不是单个输入文件首行的 T）`,
        `- 数据规模策略：${DATA_SCALE_TEXT[options.dataScale || 'auto']}`,
        `- 函数题模板语言：${langText}`,
    ];
    lines.push('', '【逐测试点覆盖计划（必须按 CASE 编号执行，并把实际覆盖目标写进 label）】', ...coveragePlan.map(slot => `- CASE ${slot.caseNumber}: ${slot.dataScale} — ${slot.guidance}`));
    if (options.problemKind !== 'traditional') {
        lines.push(`- 若判定/指定为函数题，必须完整输出这些模板节：${requiredTemplateSections}（不得遗漏）`);
    }
    if (options.extraRequirements?.trim()) {
        lines.push(`- 教师补充要求：${options.extraRequirements.trim()}`);
    }
    if (options.providedStd?.trim()) {
        lines.push('', '【教师提供的标准答案（唯一权威，所有 .out 必须由它推演得到，输出格式以它为准）】', '```', options.providedStd.trim(), '```');
    }
    if (existingFiles && existingFiles.length > 0) {
        lines.push('', `【题目已有文件（将可能被覆盖，仅供参考）】${existingFiles.join(', ')}`);
    }
    lines.push('', '请严格按照 System 中约定的分节标记格式（@@@标记@@@）输出，不要输出 JSON。');
    return lines.join('\n');
}
/**
 * 沙箱模式只让 AI 编写“生成输入的程序”和“可执行标程”。所有 .out 随后由
 * Hydro go-judge 实跑标程得到，避免模型在长回复中手算或漏算输出。
 */
function buildSandboxBlueprintSystemPrompt() {
    return `你是一位资深 OJ 出题与测试数据专家。请根据题面输出一份可在 Hydro go-judge 中执行的测试数据生成蓝图。

核心规则：
1. GENERATOR 是自包含 Python 3 程序，不读 stdin，向 stdout 只打印一个 JSON 对象：{"cases":[{"label":"设计意图","input":"原始标准输入"}]}。cases 数量必须与用户要求完全一致；不得打印日志或 Markdown。
2. GENERATOR 只生成 .in，不生成答案。input 必须是程序真实读取的原始 stdin，禁止 s = "101"、k = 2、arr = [1,2] 等源码赋值写法。
3. ACM/传统题：每个 input 是一份独立完整的输入文件。若题面首行是 T，默认每个文件固定 T=1，并紧跟恰好一组完整数据；只有教师明确要求批处理时才使用 T>1。
4. LeetCode/函数题：每个 input 只表示一次函数调用，不额外添加 T。默认每个参数占一行；一维数组用空格分隔，字符串不带源码引号。所有模板与 ORACLE 必须使用完全相同的输入编码。
5. ORACLE 是自包含、可直接运行的 Python 3 完整程序：读取一份 input 的 stdin，严格按题面输出 stdout。不得硬编码测试用例或答案表。函数题也必须在 ORACLE 内包含函数实现和 stdin 驱动。
6. BRUTE 是与 ORACLE 相互独立的第二实现（对拍用）：用最朴素的暴力/枚举/模拟写法，宁慢勿错，只需在生成数据规模内跑完即可；它同样是自包含、读同一 stdin 编码、按题面输出的完整 Python 3 程序。严禁 BRUTE 与 ORACLE 共享核心函数或互相调用——它们的一致性是数据正确性的机器证据。
7. 函数题必须输出 SOLUTION 节：与学生提交形式完全一致的函数/类定义（只含实现，不含读输入或打印），它将与 template.py 拼接后在沙箱实跑，用于验证模板与输入编码。传统题省略 SOLUTION。
8. 鼓励输出 VALIDATOR 节：Python 3 程序，从 stdin 读一份 .in，校验格式与题面约束（数量范围、数值边界、结构合法性）；合法则静默 exit 0，非法则向 stderr 打印原因并 exit 1（可用 sys.exit(1)）。
9. 数据必须严格遵守用户消息中的逐 CASE 覆盖计划，并根据题面真实约束交叉变化不同维度；所有生成过程必须确定性，固定随机种子。
10. GENERATOR 必须使用紧凑 JSON（Python json.dumps(..., ensure_ascii=False, separators=(',', ':'))），stdout 总量必须小于 1MB；若临界输入会导致输出过大或超时，应使用仍能触发复杂度/边界行为的可解析构造并适当缩小，而不是打印海量数据。
11. 若教师提供标准答案，它是算法和输出格式的唯一权威；ORACLE 必须忠实实现它。
12. 函数题必须输出用户要求的每一个 TEMPLATE 节：Python 追加到学生代码末尾；Java 为 public class Main 并调用 class Solution；C++ 用 #include "foo.cc"。传统题省略 TEMPLATE。

输出必须使用以下原文分节，禁止代码围栏、JSON 外壳或额外说明（不适用的可选节直接省略）：
@@@META@@@
problemType: traditional 或 function
isFillIn: false
functionName: 函数题函数名（传统题省略）
@@@ANALYSIS@@@
简要说明输入编码与覆盖策略（不超过 200 字）
@@@GENERATOR@@@
完整 Python 3 输入生成器
@@@ORACLE@@@
完整 Python 3 标程（stdin → stdout，正解算法）
@@@SOLUTION@@@
函数题：学生提交形式的函数/类实现（传统题省略）
@@@BRUTE@@@
与 ORACLE 独立的暴力解完整 Python 3 程序（对拍用）
@@@VALIDATOR@@@
可选：输入合法性校验器（合法 exit 0，非法 stderr+exit 1）
@@@TEMPLATE:py@@@
函数题 Python 驱动模板
@@@TEMPLATE:java@@@
函数题 Java 驱动模板
@@@TEMPLATE:cc@@@
函数题 C++ 驱动模板
@@@NOTES@@@
给教师的可选注意事项

各节内容按原文输出，正文行不得以 @@@ 开头。所有说明文字与 label 使用简体中文。`;
}
function buildSandboxBlueprintUserPrompt(params) {
    return buildTestdataUserPrompt(params).replace('请严格按照 System 中约定的分节标记格式（@@@标记@@@）输出，不要输出 JSON。', '请严格按照 System 中约定的蓝图分节格式输出 GENERATOR、ORACLE 与所需 TEMPLATE；不要直接输出 CASE 或 .out。');
}
// ─── AI 响应解析 ──────────────────────────────────────────────────────────────
/**
 * 从 AI 返回文本中提取 JSON（容忍 <think> 标签、代码围栏、前后缀说明文字）
 */
function extractJsonObject(raw) {
    let text = raw;
    // 去除 openaiClient 注入的思考占位标签
    text = text.replace(/<think>[\s\S]*?<\/think>/g, '');
    // 去除代码围栏
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch)
        text = fenceMatch[1];
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
        throw new Error('AI 响应中未找到 JSON 对象');
    }
    return text.slice(start, end + 1);
}
/** 规范化文本文件内容：统一 LF，保证以单个换行结尾 */
function normalizeFileContent(content) {
    const lf = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (lf === '')
        return '\n';
    return lf.endsWith('\n') ? lf : `${lf}\n`;
}
/**
 * 校验并规范化「已解析为对象」的生成结果（JSON 与分节文本两条解析路径共用）
 * @throws Error 结构非法时抛出（消息为中文，直接展示给教师）
 */
function normalizeGenerationObject(obj, options, parseOptions = {}) {
    const problemType = obj.problemType === 'function' ? 'function'
        : obj.problemType === 'traditional' ? 'traditional'
            : null;
    if (!problemType)
        throw new Error('AI 返回的 problemType 非法（应为 function 或 traditional）');
    if (options.problemKind !== 'auto' && problemType !== options.problemKind) {
        // 用户显式指定题型时以用户为准（AI 偶尔忽略指令）
        console.warn(`[TestdataGen] AI 返回题型 ${problemType} 与指定 ${options.problemKind} 不符，以指定为准`);
    }
    const effectiveType = options.problemKind === 'auto' ? problemType : options.problemKind;
    if (!Array.isArray(obj.cases) || obj.cases.length === 0) {
        throw new Error('AI 未返回任何测试点（cases 为空）');
    }
    const cases = obj.cases.map((c, i) => {
        const cc = c;
        if (typeof cc.input !== 'string' || typeof cc.output !== 'string') {
            throw new Error(`第 ${i + 1} 个测试点缺少 input/output 字符串`);
        }
        return {
            label: typeof cc.label === 'string' ? cc.label : undefined,
            input: normalizeFileContent(cc.input),
            output: normalizeFileContent(cc.output),
        };
    });
    let templates;
    if (effectiveType === 'function') {
        const rawTemplates = (obj.templates || {});
        templates = {};
        for (const lang of options.languages) {
            const t = rawTemplates[lang];
            if (typeof t !== 'string' || !t.trim()) {
                if (!parseOptions.allowMissingTemplates) {
                    throw new Error(`AI 未返回 ${LANG_DISPLAY[lang]} 的评测模板`);
                }
                continue;
            }
            templates[lang] = normalizeFileContent(t);
        }
    }
    let stdSolution;
    const rawStd = obj.stdSolution;
    if (rawStd && typeof rawStd.code === 'string' && rawStd.code.trim()) {
        stdSolution = {
            language: typeof rawStd.language === 'string' ? rawStd.language : 'python',
            code: normalizeFileContent(rawStd.code),
        };
    }
    // 填空题判定：用户显式指定时以用户为准，auto 时采纳 AI 结论
    const fillInMode = options.fillInMode || 'auto';
    const isFillIn = fillInMode === 'yes' ? true
        : fillInMode === 'no' ? false
            : obj.isFillIn === true;
    return {
        problemType: effectiveType,
        isFillIn,
        analysis: typeof obj.analysis === 'string' ? obj.analysis : undefined,
        functionName: typeof obj.functionName === 'string' ? obj.functionName : undefined,
        templates,
        stdSolution,
        cases,
        notes: typeof obj.notes === 'string' ? obj.notes : undefined,
    };
}
/**
 * JSON 解析路径（旧契约，作为分节文本失败时的回退保留）
 * @throws Error 结构非法时抛出
 */
function parseGenerationResponse(raw, options, parseOptions = {}) {
    let parsed;
    try {
        parsed = JSON.parse(extractJsonObject(raw));
    }
    catch (err) {
        throw new Error(`AI 返回内容不是有效的 JSON：${err instanceof Error ? err.message : String(err)}`);
    }
    return normalizeGenerationObject(parsed, options, parseOptions);
}
// ─── 分节文本解析（当前主契约） ──────────────────────────────────────────────
/** 分节标记：独占一行、顶格，形如 @@@META@@@ / @@@CASE:1:IN:标签@@@ */
const SECTION_MARKER_RE = /^\s*@@@(.+?)@@@\s*$/;
/** 去除段落首尾的空行（保留内部空行），供代码/数据节使用 */
function trimBlankEdges(lines) {
    let start = 0;
    let end = lines.length;
    while (start < end && lines[start].trim() === '')
        start++;
    while (end > start && lines[end - 1].trim() === '')
        end--;
    return lines.slice(start, end).join('\n');
}
function splitDelimitedSections(raw) {
    let text = raw.replace(/<think>[\s\S]*?<\/think>/g, '');
    const fenced = text.match(/^\s*```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n```\s*$/);
    if (fenced)
        text = fenced[1];
    const sections = [];
    let current = null;
    for (const line of text.split(/\r?\n/)) {
        const marker = line.match(SECTION_MARKER_RE);
        if (marker) {
            current = { header: marker[1].trim(), content: [] };
            sections.push(current);
        }
        else if (current) {
            if (line.trimStart().startsWith('@@@')) {
                throw new Error(`AI 返回中存在疑似损坏的分节标记行：${line.trim().slice(0, 50)}，请重试`);
            }
            current.content.push(line);
        }
    }
    return sections;
}
function parseSandboxBlueprint(raw, options, parseOptions = {}) {
    const sections = splitDelimitedSections(raw);
    if (sections.length === 0)
        throw new Error('AI 未返回蓝图分节标记');
    const meta = {};
    const templates = {};
    let analysis;
    let notes;
    let generatorCode = '';
    let oracleCode = '';
    let solutionCode = '';
    let bruteCode = '';
    let validatorCode = '';
    for (const section of sections) {
        const parts = section.header.split(':');
        const kind = parts[0].trim().toUpperCase();
        const content = trimBlankEdges(section.content);
        if (kind === 'META') {
            for (const line of section.content) {
                const index = line.indexOf(':');
                if (index > 0)
                    meta[line.slice(0, index).trim()] = line.slice(index + 1).trim();
            }
        }
        else if (kind === 'ANALYSIS')
            analysis = content;
        else if (kind === 'NOTES')
            notes = content;
        else if (kind === 'GENERATOR')
            generatorCode = content;
        else if (kind === 'ORACLE')
            oracleCode = content;
        else if (kind === 'SOLUTION')
            solutionCode = content;
        else if (kind === 'BRUTE')
            bruteCode = content;
        else if (kind === 'VALIDATOR')
            validatorCode = content;
        else if (kind === 'TEMPLATE') {
            const lang = (parts[1] || '').trim().toLowerCase();
            if (exports.SUPPORTED_TEMPLATE_LANGS.includes(lang) && content.trim()) {
                templates[lang] = normalizeFileContent(content);
            }
        }
    }
    const returnedType = meta.problemType === 'function' ? 'function'
        : meta.problemType === 'traditional' ? 'traditional'
            : null;
    if (!returnedType)
        throw new Error('AI 返回的 problemType 非法（应为 function 或 traditional）');
    const problemType = options.problemKind === 'auto' ? returnedType : options.problemKind;
    if (!generatorCode.trim())
        throw new Error('AI 未返回可执行的 GENERATOR');
    if (!oracleCode.trim())
        throw new Error('AI 未返回可执行的 ORACLE');
    if (problemType === 'function' && !parseOptions.allowMissingTemplates) {
        const missing = options.languages.filter(lang => !templates[lang]?.trim());
        if (missing.length > 0) {
            throw new Error(`AI 未返回 ${missing.map(lang => LANG_DISPLAY[lang]).join('、')} 的评测模板`);
        }
    }
    const fillInMode = options.fillInMode || 'auto';
    const isFillIn = fillInMode === 'yes' ? true
        : fillInMode === 'no' ? false
            : meta.isFillIn?.toLowerCase() === 'true';
    return {
        problemType,
        isFillIn,
        analysis,
        functionName: meta.functionName || undefined,
        templates: problemType === 'function' ? templates : undefined,
        generatorCode: normalizeFileContent(generatorCode),
        oracleCode: normalizeFileContent(oracleCode),
        // SOLUTION/BRUTE/VALIDATOR 均可缺失（宽容）；缺失后果在 verification 中体现
        solutionCode: solutionCode.trim() ? normalizeFileContent(solutionCode) : undefined,
        bruteCode: bruteCode.trim() ? normalizeFileContent(bruteCode) : undefined,
        validatorCode: validatorCode.trim() ? normalizeFileContent(validatorCode) : undefined,
        notes,
    };
}
/**
 * 解析分节标记文本。未发现任何标记时返回 null（调用方回退到 JSON 解析）。
 *
 * 采用分节文本而非 JSON 的原因：AI 需要输出多段含引号/反斜杠/换行的代码，
 * 嵌入 JSON 字符串时转义极易出错（实测出现过 Expected ',' or '}' 一类的
 * 解析失败）；分节原文直出从根上消除了转义问题。
 * @throws Error 标记存在但结构非法时抛出（消息为中文，直接展示给教师）
 */
function parseDelimitedResponse(raw, options, parseOptions = {}) {
    const sections = splitDelimitedSections(raw);
    if (sections.length === 0)
        return null;
    const obj = {};
    const templates = {};
    const caseMap = new Map();
    for (const section of sections) {
        const parts = section.header.split(':');
        const kind = parts[0].trim().toUpperCase();
        if (kind === 'META') {
            for (const line of section.content) {
                const idx = line.indexOf(':');
                if (idx <= 0)
                    continue;
                const key = line.slice(0, idx).trim();
                const value = line.slice(idx + 1).trim();
                if (key === 'problemType')
                    obj.problemType = value;
                else if (key === 'isFillIn')
                    obj.isFillIn = value.toLowerCase() === 'true';
                else if (key === 'functionName')
                    obj.functionName = value;
            }
        }
        else if (kind === 'ANALYSIS') {
            obj.analysis = trimBlankEdges(section.content);
        }
        else if (kind === 'NOTES') {
            obj.notes = trimBlankEdges(section.content);
        }
        else if (kind === 'TEMPLATE') {
            const lang = (parts[1] || '').trim().toLowerCase();
            if (lang)
                templates[lang] = trimBlankEdges(section.content);
        }
        else if (kind === 'STD') {
            const code = trimBlankEdges(section.content);
            if (code)
                obj.stdSolution = { language: 'python', code };
        }
        else if (kind === 'CASE') {
            const num = parseInt((parts[1] || '').trim(), 10);
            const direction = (parts[2] || '').trim().toUpperCase();
            if (!Number.isInteger(num) || num < 1 || (direction !== 'IN' && direction !== 'OUT')) {
                throw new Error(`AI 返回中存在无法识别的 CASE 标记：@@@${section.header}@@@`);
            }
            const entry = caseMap.get(num) || {};
            if (direction === 'IN') {
                entry.input = trimBlankEdges(section.content);
                const label = parts.slice(3).join(':').trim();
                if (label)
                    entry.label = label;
            }
            else {
                entry.output = trimBlankEdges(section.content);
            }
            caseMap.set(num, entry);
        }
        // 未知节名：忽略（向前兼容）
    }
    const caseNumbers = [...caseMap.keys()].sort((a, b) => a - b);
    const cases = [];
    for (const num of caseNumbers) {
        const entry = caseMap.get(num);
        if (!entry)
            continue;
        if (entry.input === undefined || entry.output === undefined) {
            throw new Error(`第 ${num} 个测试点缺少 ${entry.input === undefined ? 'IN' : 'OUT'} 节，请重试`);
        }
        cases.push({ label: entry.label, input: entry.input, output: entry.output });
    }
    obj.cases = cases;
    if (Object.keys(templates).length > 0)
        obj.templates = templates;
    return normalizeGenerationObject(obj, options, parseOptions);
}
/**
 * 解析 AI 响应：优先分节文本（当前契约），无标记时回退 JSON（兼容旧契约/
 * 忽略格式指令的模型）。两者都失败时抛出合并后的可读错误。
 */
function parseAiResponse(raw, options, parseOptions = {}) {
    const delimited = parseDelimitedResponse(raw, options, parseOptions);
    if (delimited)
        return delimited;
    try {
        return parseGenerationResponse(raw, options, parseOptions);
    }
    catch (err) {
        throw new Error(`AI 返回格式无法解析（未找到分节标记，回退 JSON 也失败）。请重试一次；若持续失败，可减少测试点数量，或改用「生成骨架文件」手动填写。技术细节：${err instanceof Error ? err.message : String(err)}`);
    }
}
/** 返回函数题仍缺少的模板语言。 */
function getMissingTemplateLanguages(response, options) {
    if (response.problemType !== 'function')
        return [];
    return options.languages.filter(lang => !response.templates?.[lang]?.trim());
}
/**
 * 检测把函数参数写成源码赋值语句的伪 stdin，例如 `s = "101"`。
 * 要求等号至少一侧有空白，避免把题目本来就允许的原始字符串 `a=1`
 * 误判为赋值语句。
 */
const ASSIGNMENT_STYLE_INPUT_RE = /^\s*(?:(?:const|let|var)\s+)?[A-Za-z_][A-Za-z0-9_]*(?:\s*:\s*[^=]+)?(?:\s+=\s*|\s*=\s+).+?;?\s*$/;
function findAssignmentStyleCaseInput(cases) {
    for (let i = 0; i < cases.length; i++) {
        for (const line of cases[i].input.split(/\r?\n/)) {
            if (ASSIGNMENT_STYLE_INPUT_RE.test(line)) {
                return { caseNumber: i + 1, line: line.trim() };
            }
        }
    }
    return null;
}
/** 提取 Hydro Markdown 中成对的 ```inputN / ```outputN 样例。 */
function extractStatementSamples(statementMarkdown) {
    const inputs = [];
    const outputs = [];
    const fenceRe = /```(input|output)(\d*)[^\n]*\r?\n([\s\S]*?)```/gi;
    let match;
    while ((match = fenceRe.exec(statementMarkdown)) !== null) {
        let content = match[3].replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        if (content.endsWith('\n'))
            content = content.slice(0, -1);
        const entry = { id: match[2], content: normalizeFileContent(content) };
        if (match[1].toLowerCase() === 'input')
            inputs.push(entry);
        else
            outputs.push(entry);
    }
    return inputs.flatMap((input, index) => {
        const output = input.id
            ? outputs.find(candidate => candidate.id === input.id)
            : outputs[index];
        return output ? [{ id: input.id || String(index + 1), input: input.content, output: output.content }] : [];
    });
}
function comparableFileContent(content) {
    return content
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n')
        .map(line => line.trimEnd())
        .join('\n')
        .trimEnd();
}
/** 解析沙箱中 GENERATOR 的 stdout，只接受固定、简单的 JSON 契约。 */
function parseGeneratorOutput(stdout, expectedCount) {
    if (Buffer.byteLength(stdout, 'utf8') > exports.TESTDATA_GEN_LIMITS.MAX_GENERATOR_OUTPUT_SIZE) {
        throw new Error('GENERATOR 输出超过 1MB 上限');
    }
    let parsed;
    try {
        parsed = JSON.parse(stdout.trim());
    }
    catch (err) {
        throw new Error(`GENERATOR stdout 不是有效 JSON：${err instanceof Error ? err.message : String(err)}`);
    }
    const rawCases = Array.isArray(parsed)
        ? parsed
        : (parsed && typeof parsed === 'object' ? parsed.cases : undefined);
    if (!Array.isArray(rawCases))
        throw new Error('GENERATOR JSON 缺少 cases 数组');
    if (rawCases.length !== expectedCount) {
        throw new Error(`GENERATOR 生成 ${rawCases.length} 个测试点，期望 ${expectedCount} 个`);
    }
    return rawCases.map((item, index) => {
        if (!item || typeof item !== 'object' || typeof item.input !== 'string') {
            throw new Error(`GENERATOR 的第 ${index + 1} 个测试点缺少 input 字符串`);
        }
        const input = normalizeFileContent(item.input);
        if (Buffer.byteLength(input, 'utf8') > exports.TESTDATA_GEN_LIMITS.MAX_FILE_SIZE) {
            throw new Error(`GENERATOR 的第 ${index + 1} 个 .in 超过 256KB 上限`);
        }
        const label = item.label;
        return {
            input,
            label: typeof label === 'string' ? label.slice(0, 200) : undefined,
        };
    });
}
/**
 * 用户中止/请求取消类错误：必须原样上抛，包装成阶段失败会误导修复回路重试。
 * 覆盖 DOM/axios 取消形态与 openaiClient 的 AIServiceError(category='aborted')。
 */
function isCancellation(err) {
    const e = err;
    return !!e && (e.name === 'AbortError' || e.name === 'CanceledError'
        || e.code === 'ERR_CANCELED' || e.category === 'aborted');
}
/**
 * 双重验证管线（对拍 + 模板实跑 + 输入校验），执行序 a→f。
 * 各阶段间累计校验总时长预算，避免大批量挤兑沙箱 RAM 盘。
 */
async function materializeSandboxBlueprint(blueprint, options, statementMarkdown, runner, signal) {
    const startedAt = Date.now();
    const coveragePlan = buildCoveragePlan(options.caseCount, options.dataScale || 'auto');
    const checkBudget = () => {
        if (Date.now() - startedAt > goJudgeSandboxService_1.SANDBOX_TOTAL_BUDGET_MS) {
            throw new Error('沙箱执行总时长超出预算，请减少测试点数量后重试');
        }
    };
    // a. GENERATOR 实跑 → 解析出全部 .in
    let generatorResult;
    try {
        generatorResult = await runner.runPython(blueprint.generatorCode, '', signal);
    }
    catch (err) {
        if (isCancellation(err))
            throw err;
        throw new Error(`GENERATOR 实跑失败：${err instanceof Error ? err.message : String(err)}`);
    }
    const generatedInputs = parseGeneratorOutput(generatorResult.stdout, options.caseCount);
    const inputs = generatedInputs.map(item => item.input);
    // b. 函数题伪 stdin 检查（源码赋值写法拦截）
    if (blueprint.problemType === 'function') {
        const placeholderCases = generatedInputs.map(item => ({ ...item, output: '' }));
        const assignment = findAssignmentStyleCaseInput(placeholderCases);
        if (assignment) {
            throw new Error(`第 ${assignment.caseNumber} 个 .in 仍是源码赋值写法：${assignment.line}`);
        }
    }
    // c. VALIDATOR（可选）：逐份 .in 校验输入合法性，任一不合法即硬失败
    let validatorRan = false;
    if (blueprint.validatorCode) {
        checkBudget();
        const validatorResults = await runner.runPythonBatchDetailed(blueprint.validatorCode, inputs, { signal });
        for (let i = 0; i < validatorResults.length; i++) {
            const detail = validatorResults[i];
            if (!detail.accepted) {
                throw new Error(`第 ${i + 1} 个 .in 未通过输入校验：${(0, textTruncate_1.excerpt)(detail.stderr || detail.error || detail.status, 300)}`);
            }
        }
        validatorRan = true;
    }
    // d. ORACLE：实跑所有 .in + 传统题题面样例 → 产 .out 并做样例回归
    checkBudget();
    const samples = blueprint.problemType === 'traditional'
        ? extractStatementSamples(statementMarkdown)
        : [];
    const allInputs = [...inputs, ...samples.map(sample => sample.input)];
    let oracleResults;
    try {
        oracleResults = await runner.runPythonBatchDetailed(blueprint.oracleCode, allInputs, { signal });
    }
    catch (err) {
        if (isCancellation(err))
            throw err;
        throw new Error(`ORACLE（标程）实跑失败：${err instanceof Error ? err.message : String(err)}`);
    }
    for (let i = 0; i < oracleResults.length; i++) {
        const detail = oracleResults[i];
        if (detail.accepted)
            continue;
        // 直接点名失败位置：生成的测试点或题面样例，附输入与 traceback 尾部，供修复回路与教师定位
        const target = i < inputs.length ? `第 ${i + 1} 个测试点` : `题面样例 ${samples[i - inputs.length].id} `;
        throw new Error(`ORACLE（标程）在${target}上执行失败（${detail.status || 'Unknown'}）\n`
            + `输入：${(0, textTruncate_1.excerpt)(allInputs[i] ?? '', 300) || '（空）'}\n`
            + `错误：${(0, textTruncate_1.excerptTail)(detail.stderr || detail.error || `exitStatus=${detail.exitStatus ?? 'unknown'}`, 1000)}`);
    }
    const cases = generatedInputs.map((item, index) => {
        const output = normalizeFileContent(oracleResults[index].stdout);
        if (Buffer.byteLength(output, 'utf8') > exports.TESTDATA_GEN_LIMITS.MAX_FILE_SIZE) {
            throw new Error(`ORACLE 为第 ${index + 1} 个测试点生成的 .out 超过 256KB 上限`);
        }
        return { ...item, output, dataScale: coveragePlan[index]?.dataScale };
    });
    for (let i = 0; i < samples.length; i++) {
        const actual = oracleResults[inputs.length + i]?.stdout || '';
        if (comparableFileContent(actual) !== comparableFileContent(samples[i].output)) {
            throw new Error(`ORACLE 未通过题面样例 ${samples[i].id}：期望 ${JSON.stringify(comparableFileContent(samples[i].output))}`
                + `，实际 ${JSON.stringify(comparableFileContent(actual))}`);
        }
    }
    // e. 函数题：solution + template.py 组合实跑，验证模板与输入编码
    let pyTemplateExecuted = false;
    let templateCheck;
    if (blueprint.problemType === 'function'
        && options.languages.includes('py')
        && blueprint.solutionCode
        && blueprint.templates?.py) {
        checkBudget();
        const combined = `${blueprint.solutionCode}\n${blueprint.templates.py}`;
        const templateResults = await runner.runPythonBatchDetailed(combined, inputs, { signal });
        let passed = 0;
        const skippedTimeout = [];
        for (let i = 0; i < templateResults.length; i++) {
            const detail = templateResults[i];
            const caseNo = i + 1;
            if (detail.timedOut) {
                skippedTimeout.push(caseNo);
                continue;
            }
            if (detail.accepted && comparableFileContent(detail.stdout) === comparableFileContent(cases[i].output)) {
                passed++;
                continue;
            }
            throw new Error(`template.py 与标程在第 ${caseNo} 个测试点不一致\n`
                + `输入：${(0, textTruncate_1.excerpt)(inputs[i], 300)}\n`
                + `模板输出：${(0, textTruncate_1.excerpt)(detail.stdout || detail.stderr || detail.status, 300)}\n`
                + `标程输出：${(0, textTruncate_1.excerpt)(cases[i].output, 300)}`);
        }
        pyTemplateExecuted = true;
        templateCheck = { lang: 'py', total: inputs.length, passed, skippedTimeout };
    }
    // f. BRUTE（可选）：只跑生成的 .in，与 ORACLE 输出对拍
    const providedStd = options.providedStd?.trim();
    const oracleIsProvidedStd = !!(providedStd
        && blueprint.problemType === 'traditional'
        && detectStdFilename(providedStd) === 'std.py'
        && comparableFileContent(blueprint.oracleCode) === comparableFileContent(normalizeFileContent(providedStd)));
    let bruteCheck;
    if (blueprint.bruteCode) {
        checkBudget();
        const bruteResults = await runner.runPythonBatchDetailed(blueprint.bruteCode, inputs, { signal });
        let agreed = 0;
        const skippedTimeout = [];
        const disagreed = [];
        for (let i = 0; i < bruteResults.length; i++) {
            const detail = bruteResults[i];
            const caseNo = i + 1;
            if (detail.timedOut) {
                skippedTimeout.push(caseNo);
                continue;
            }
            if (!detail.accepted) {
                throw new Error(`暴力解在第 ${caseNo} 个测试点执行失败：${(0, textTruncate_1.excerpt)(detail.stderr || detail.error || detail.status, 300)}`);
            }
            if (comparableFileContent(detail.stdout) === comparableFileContent(cases[i].output)) {
                agreed++;
                continue;
            }
            // 不一致：教师 std 为唯一权威时仅记录复核，不拦截；AI 自产标程时硬失败走修复回路
            if (oracleIsProvidedStd) {
                disagreed.push(caseNo);
                continue;
            }
            throw new Error(`暴力解与标程在第 ${caseNo} 个测试点不一致（${generatedInputs[i].label || ''}）\n`
                + `输入：${(0, textTruncate_1.excerpt)(inputs[i], 300)}\n`
                + `标程输出：${(0, textTruncate_1.excerpt)(cases[i].output, 300)}\n`
                + `暴力输出：${(0, textTruncate_1.excerpt)(detail.stdout, 300)}`);
        }
        bruteCheck = { compared: inputs.length, agreed, skippedTimeout, disagreed };
    }
    const verification = {
        mode: 'sandbox',
        oracleKind: oracleIsProvidedStd ? 'provided-std' : 'ai-solution',
        validator: { ran: validatorRan, casesChecked: validatorRan ? inputs.length : 0 },
    };
    if (blueprint.problemType === 'traditional') {
        // 样例不一致已在上面抛出，走到这里即全部通过
        verification.sampleCheck = { total: samples.length, passed: samples.length };
    }
    if (bruteCheck)
        verification.bruteCheck = bruteCheck;
    if (templateCheck)
        verification.templateCheck = templateCheck;
    const noteParts = [
        blueprint.notes,
        '测试输入由生成器产生，所有 .out 已在 Hydro 沙箱中实际运行 Python 标程生成。',
    ];
    if (bruteCheck && bruteCheck.disagreed.length > 0) {
        noteParts.push(`暴力解与教师标准答案在测试点 ${bruteCheck.disagreed.join('、')} 不一致，已按教师 std 输出为准，请人工复核。`);
    }
    if (bruteCheck && bruteCheck.skippedTimeout.length > 0) {
        noteParts.push(`暴力解在测试点 ${bruteCheck.skippedTimeout.join('、')} 超时，已跳过对拍。`);
    }
    if (templateCheck && templateCheck.skippedTimeout.length > 0) {
        noteParts.push(`模板实跑在测试点 ${templateCheck.skippedTimeout.join('、')} 超时，已跳过。`);
    }
    return {
        problemType: blueprint.problemType,
        isFillIn: blueprint.isFillIn,
        analysis: blueprint.analysis,
        functionName: blueprint.functionName,
        templates: blueprint.templates,
        stdSolution: { language: 'python', code: blueprint.oracleCode },
        generatorCode: blueprint.generatorCode,
        oracleCode: blueprint.oracleCode,
        solutionCode: blueprint.solutionCode,
        bruteCode: blueprint.bruteCode,
        validatorCode: blueprint.validatorCode,
        verification,
        pyTemplateExecuted,
        cases,
        notes: noteParts.filter(Boolean).join('\n'),
    };
}
/**
 * 解析“仅补模板”的 AI 响应。该响应无需重复 META/CASE，避免因完整重生成
 * 再次截断而丢失 Java 等排在后面的模板。
 */
function parseTemplateSections(raw) {
    let text = raw.replace(/<think>[\s\S]*?<\/think>/g, '');
    const fenced = text.match(/^\s*```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n```\s*$/);
    if (fenced)
        text = fenced[1];
    const templates = {};
    let currentLang = null;
    let currentLines = [];
    const flush = () => {
        if (!currentLang)
            return;
        const content = trimBlankEdges(currentLines);
        if (content.trim())
            templates[currentLang] = normalizeFileContent(content);
    };
    for (const line of text.split(/\r?\n/)) {
        const marker = line.match(SECTION_MARKER_RE);
        if (marker) {
            flush();
            const match = marker[1].trim().match(/^TEMPLATE:(py|java|cc)$/i);
            currentLang = match ? match[1].toLowerCase() : null;
            currentLines = [];
        }
        else if (currentLang) {
            currentLines.push(line);
        }
    }
    flush();
    return templates;
}
// ─── 计划组装 ─────────────────────────────────────────────────────────────────
/**
 * 将解析后的 AI 响应组装为完整的文件计划
 */
/**
 * 将解析后的 AI 响应组装为完整的文件计划。
 * context.mode 决定各文件的 origin 徽章：sandbox（实跑）/ direct（AI 直出）；
 * 缺省视为 direct（保持旧 2 参调用行为不变）。
 */
/**
 * AI 生成代码文件的首行用途注释（.py 用 #，.cc/.java 用 //），供教师快速识别文件职责。
 * 教师提供的 std 是唯一权威，原样写入不加注释。
 */
function prependPurposeComment(name, content, purpose) {
    const marker = /\.(cc|cpp|java)$/i.test(name) ? '//' : '#';
    return `${marker} ${purpose}\n${content}`;
}
const FILE_PURPOSES = {
    generator: '数据生成器（AI 生成）：运行后向 stdout 输出 JSON，cases[].input 即各测试点 .in，可重跑重造数据',
    brute: '暴力对拍解（AI 生成）：与标程相互独立的第二实现，用于与 .out 交叉验证',
    validator: '输入校验器（AI 生成）：从 stdin 读取单个 .in 校验题面约束，不合法时非零退出',
    oracle: '完整标程 ORACLE（AI 生成）：读取 .in 输出 .out，本次测试数据的输出由它实跑产出',
    stdSolutionForm: '参考解（学生提交形式，AI 生成）：可与 template.* 组合后本地运行复验',
    stdProgram: '参考标程（AI 生成）：读取 stdin 输出答案，用于人工复验与重造数据',
    template: '函数题评测模板（AI 生成）：读取 stdin、调用学生实现并输出结果，学生代码与本文件组合评测',
};
function assemblePlan(response, options, context = {}) {
    const sandbox = context.mode === 'sandbox';
    const dataOrigin = sandbox ? 'executed' : 'ai-only';
    const files = [];
    const caseCount = response.cases.length;
    const coveragePlan = buildCoveragePlan(caseCount, options.dataScale || 'auto');
    const newCaseNumbers = allocateCaseNumbers(context.existingFiles, caseCount);
    const existingComplete = getExistingNumericCases(context.existingFiles).complete;
    const configCaseNumbers = [...new Set([...existingComplete, ...newCaseNumbers])].sort((a, b) => a - b);
    /** AI 生成代码文件统一入口：文件名只写一处，注释符由文件名推导。 */
    const pushCode = (name, code, kind, origin, purpose) => files.push({ name, content: prependPurposeComment(name, code, purpose), kind, origin });
    response.cases.forEach((c, i) => {
        const fileNumber = newCaseNumbers[i];
        files.push({ name: `${fileNumber}.in`, content: c.input, kind: 'case-in', origin: dataOrigin });
        files.push({ name: `${fileNumber}.out`, content: c.output, kind: 'case-out', origin: dataOrigin });
    });
    if (response.problemType === 'function') {
        for (const lang of options.languages) {
            const content = response.templates?.[lang];
            if (content) {
                // template.py 走过步骤 e（solution+模板实跑）才算 executed，其余语言维持 AI 自证
                const origin = lang === 'py' && sandbox && response.pyTemplateExecuted
                    ? 'executed'
                    : 'ai-only';
                pushCode(exports.TEMPLATE_FILENAMES[lang], content, 'template', origin, FILE_PURPOSES.template);
            }
        }
        files.push({ name: 'compile.sh', content: buildCompileSh(options.languages), kind: 'compile', origin: 'deterministic' });
    }
    if (response.generatorCode?.trim()) {
        pushCode('generator.py', response.generatorCode, 'generator', 'executed', FILE_PURPOSES.generator);
    }
    if (sandbox && response.bruteCode?.trim()) {
        pushCode('brute.py', response.bruteCode, 'brute', 'executed', FILE_PURPOSES.brute);
    }
    if (sandbox && response.validatorCode?.trim()) {
        pushCode('validator.py', response.validatorCode, 'validator', 'executed', FILE_PURPOSES.validator);
    }
    // 教师提供的标准答案是唯一权威：原样写入（deterministic，非实跑制品）
    const providedStd = options.providedStd?.trim();
    if (providedStd) {
        files.push({
            name: detectStdFilename(providedStd),
            content: normalizeFileContent(providedStd),
            kind: 'std',
            origin: 'deterministic',
        });
        if (response.oracleCode?.trim()
            && normalizeFileContent(response.oracleCode) !== normalizeFileContent(providedStd)) {
            pushCode('oracle.py', response.oracleCode, 'std', sandbox ? 'executed' : 'ai-only', FILE_PURPOSES.oracle);
        }
    }
    else {
        // 函数题沙箱模式：std.py 用学生提交形式（solutionCode），完整 ORACLE 另存 oracle.py 以闭环重造
        const useSolutionForm = sandbox && response.problemType === 'function' && response.solutionCode?.trim();
        const stdContent = useSolutionForm ? response.solutionCode : response.stdSolution?.code;
        if (stdContent) {
            pushCode('std.py', stdContent, 'std', sandbox ? 'executed' : 'ai-only', useSolutionForm ? FILE_PURPOSES.stdSolutionForm : FILE_PURPOSES.stdProgram);
            if (sandbox
                && response.oracleCode?.trim()
                && normalizeFileContent(response.oracleCode) !== normalizeFileContent(stdContent)) {
                pushCode('oracle.py', response.oracleCode, 'std', 'executed', FILE_PURPOSES.oracle);
            }
        }
    }
    files.push({
        name: 'config.yaml',
        content: buildConfigYaml({
            problemType: response.problemType,
            caseCount: configCaseNumbers.length,
            languages: options.languages,
            caseNumbers: configCaseNumbers,
        }),
        kind: 'config',
        origin: 'deterministic',
    });
    return {
        problemType: response.problemType,
        isFillIn: response.isFillIn,
        analysis: response.analysis,
        notes: response.notes,
        files,
        caseCount,
        totalCaseCount: configCaseNumbers.length,
        caseCoverage: response.cases.map((item, index) => ({
            caseNumber: index + 1,
            fileNumber: newCaseNumbers[index],
            dataScale: item.dataScale || coveragePlan[index]?.dataScale || 'small',
            target: item.label || coveragePlan[index]?.guidance || '',
        })),
        ...(response.verification ? { verification: response.verification } : {}),
    };
}
// ─── 骨架模式（AI 故障降级，不调用 AI） ──────────────────────────────────────
/** 骨架模板：可直接编译/运行，教师按 TODO 补全输入输出部分 */
const SKELETON_TEMPLATES = {
    py: `# 评测模板（骨架）：请按题目输入格式补全本文件。
# 评测时本文件会被追加到学生代码末尾：读取输入 → 调用学生函数 → 打印结果。
# 示例（提莫攻击）：
# timeSeries = list(map(int, input().split()))
# duration = int(input())
# print(findPoisonedDuration(timeSeries, duration))
`,
    java: `import java.util.*;

// 评测模板（骨架）：请按题目输入格式补全 main 方法。
// 学生提交 class Solution；在 main 中读取输入、调用 new Solution().方法(...) 并打印结果。
public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        // TODO: 例如：
        // int[] arr = Arrays.stream(sc.nextLine().trim().split("\\\\s+"))
        //         .mapToInt(Integer::parseInt).toArray();
        // System.out.println(new Solution().yourMethod(arr));
    }
}
`,
    cc: `#include <bits/stdc++.h>
using namespace std;
#include "foo.cc"

// 评测模板（骨架）：请按题目输入格式补全 main 函数。
// 学生代码通过上方 #include "foo.cc" 引入。
int main() {
    // TODO: 例如：
    // int x; cin >> x;
    // cout << yourFunction(x) << endl;
    return 0;
}
  `,
};
/** 骨架模式不调用 AI，仅用高置信题面标记判断是否为函数题。 */
function isLikelyFunctionProblem(statementMarkdown) {
    return /代码写到函数内部|LeetCode\s*(?:风格|style)|class\s+Solution\b[\s\S]{0,1000}\b(?:def|public|private|protected)\b/i
        .test(statementMarkdown);
}
/**
 * 构建骨架计划：不调用 AI，确定性生成结构性文件与空白测试点。
 * 用作 AI 故障时的降级方案——保住最容易出错的 compile.sh / config.yaml /
 * 模板机制部分，测试数据内容由教师在预览中手动填写。
 */
function buildSkeletonPlan(options, statementMarkdown = '', existingFiles = []) {
    const autoDetectedFunction = options.problemKind === 'auto' && isLikelyFunctionProblem(statementMarkdown);
    const problemType = options.problemKind === 'function' || autoDetectedFunction
        ? 'function'
        : 'traditional';
    const files = [];
    const caseNumbers = allocateCaseNumbers(existingFiles, options.caseCount);
    const existingComplete = getExistingNumericCases(existingFiles).complete;
    const configCaseNumbers = [...new Set([...existingComplete, ...caseNumbers])].sort((a, b) => a - b);
    const coveragePlan = buildCoveragePlan(options.caseCount, options.dataScale || 'auto');
    // 骨架模式全部为确定性生成/空占位，无沙箱实跑制品
    for (const number of caseNumbers) {
        files.push({ name: `${number}.in`, content: '\n', kind: 'case-in', origin: 'deterministic' });
        files.push({ name: `${number}.out`, content: '\n', kind: 'case-out', origin: 'deterministic' });
    }
    if (problemType === 'function') {
        for (const lang of options.languages) {
            files.push({ name: exports.TEMPLATE_FILENAMES[lang], content: SKELETON_TEMPLATES[lang], kind: 'template', origin: 'deterministic' });
        }
        files.push({ name: 'compile.sh', content: buildCompileSh(options.languages), kind: 'compile', origin: 'deterministic' });
    }
    const providedStd = options.providedStd?.trim();
    if (providedStd) {
        files.push({
            name: detectStdFilename(providedStd),
            content: normalizeFileContent(providedStd),
            kind: 'std',
            origin: 'deterministic',
        });
    }
    files.push({
        name: 'config.yaml',
        content: buildConfigYaml({
            problemType,
            caseCount: configCaseNumbers.length,
            languages: options.languages,
            caseNumbers: configCaseNumbers,
        }),
        kind: 'config',
        origin: 'deterministic',
    });
    const noteParts = [
        '骨架模式（未调用 AI）：请在预览中逐个填写各 N.in / N.out 的内容后再写入。',
    ];
    if (problemType === 'function') {
        noteParts.push('请按题目输入格式补全各语言评测模板中的 TODO 部分。');
        if (autoDetectedFunction)
            noteParts.push('已根据题面中的函数题标记自动生成函数题骨架。');
    }
    else if (options.problemKind === 'auto') {
        noteParts.push('题型未指定，已按传统题生成；如需函数题骨架（模板 + compile.sh），请将题目类型选为"函数题"后重新生成。');
    }
    return {
        problemType,
        analysis: '骨架模式：仅生成结构性文件（评测配置、编译脚本、模板骨架）与空白测试点，不含 AI 生成的数据。',
        notes: noteParts.join(''),
        files,
        caseCount: options.caseCount,
        totalCaseCount: configCaseNumbers.length,
        caseCoverage: coveragePlan.map((slot, index) => ({
            caseNumber: slot.caseNumber,
            fileNumber: caseNumbers[index],
            dataScale: slot.dataScale,
            target: slot.guidance,
        })),
    };
}
function buildCaseInputRepairPrompt(issue, options) {
    const requiredTemplates = options.languages.map(lang => `@@@TEMPLATE:${lang}@@@`).join('、');
    return `你上一条结果中的第 ${issue.caseNumber} 个 CASE:IN 含有源码赋值写法：${issue.line}
这不是合法的评测输入文件。请重新输出【完整的分节结果】，并修正所有测试点及模板：
1. 每个 CASE:IN 只保留程序从 stdin 实际读取的原始值，禁止变量名、等号、方括号/逗号等语言字面量包装和说明文字。
2. 例如 s="1010101"、k=2 必须写成两行 1010101 和 2；数组 [1,4] 必须按模板写成 1 4。
3. 同步修改所有语言模板，使其解析修正后的同一份原始 stdin。
4. 函数题必须包含全部所选模板节：${requiredTemplates}，一个也不能遗漏。
5. 仍使用 @@@ 标记格式，不要输出 JSON 或代码围栏。`;
}
function buildTemplateRepairPrompt(missing) {
    const sections = missing.map(lang => `@@@TEMPLATE:${lang}@@@`).join('、');
    return `你上一条函数题结果缺少这些必需模板节：${sections}。
请只补充上述缺失模板，不要重复 META、GENERATOR、ORACLE、STD、CASE 或其他模板。要求：
1. 每个模板节都必须出现且包含完整可编译/可运行的驱动代码。
2. 模板必须读取你上一条结果中 GENERATOR 定义的原始 stdin 格式，调用题面要求的学生函数/类，并打印与 ORACLE 一致的结果。
3. Java 模板必须是 public class Main，并调用学生提交的 class Solution；C++ 模板通过 #include "foo.cc" 引入学生代码；Python 模板只含驱动代码。
4. 只使用 @@@TEMPLATE:语言@@@ 标记和源码原文，不要输出 JSON、代码围栏或解释文字。`;
}
function classifySandboxRepairScope(error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/GENERATOR|未通过输入校验|\.in 超过|生成\s*\d+\s*个测试点/.test(detail))
        return 'generator';
    if (/ORACLE|题面样例/.test(detail))
        return 'oracle';
    if (/暴力解/.test(detail))
        return 'brute';
    if (/template\.py|模板输出|SOLUTION/.test(detail))
        return 'template-py';
    return 'full';
}
function buildSandboxRepairPrompt(error, options, scope = classifySandboxRepairScope(error)) {
    const templates = options.languages.map(lang => `@@@TEMPLATE:${lang}@@@`).join('、') || '（传统题无需模板）';
    const detail = (error instanceof Error ? error.message : String(error)).slice(0, 1600);
    if (scope === 'generator') {
        return `你上一条蓝图的输入生成阶段未通过 Hydro 沙箱验证：
${detail}

请只输出修复后的 @@@GENERATOR@@@；如果必须同步修改输入约束校验，再额外输出 @@@VALIDATOR@@@。不要重复 META、ORACLE、BRUTE、SOLUTION、TEMPLATE 或说明文字。要求：
1. stdout 只能是包含恰好 ${options.caseCount} 个 cases 的紧凑 JSON，使用 json.dumps(..., ensure_ascii=False, separators=(',', ':'))。
2. stdout 必须小于 1MB，程序必须在 5 秒内结束；不要打印日志，不要构造超长字符串或无界循环。
3. 每个 input 必须合法且符合逐 CASE 覆盖计划；若临界数据过大，使用能保留边界/复杂度特征的可解析构造。
4. 只使用请求的分节标记和源码原文，不要代码围栏。`;
    }
    if (scope === 'oracle') {
        return `你上一条蓝图的标程阶段未通过 Hydro 沙箱验证：
${detail}

请只输出修复后的 @@@ORACLE@@@，并额外输出与其独立的 @@@BRUTE@@@ 以便重新对拍。不要重复 META、GENERATOR、VALIDATOR、SOLUTION、TEMPLATE 或说明文字。ORACLE 必须通过题面样例、处理所有合法边界且在 5 秒内结束；BRUTE 不得调用或复制 ORACLE 的核心实现。`;
    }
    if (scope === 'brute') {
        return `你上一条蓝图的暴力对拍阶段未通过验证：
${detail}

请只输出修复后的 @@@BRUTE@@@。它必须读取原有 GENERATOR 的同一 stdin 编码，独立实现题意，不得调用或复制 ORACLE 的核心函数。不要输出其他分节或代码围栏。`;
    }
    if (scope === 'template-py') {
        return `你上一条蓝图的 Python 学生解与模板组合未通过验证：
${detail}

请只输出同步修复后的 @@@SOLUTION@@@ 与 @@@TEMPLATE:py@@@。两者必须沿用原有 GENERATOR 的 stdin 编码，拼接运行后的输出与 ORACLE 完全一致。不要输出其他分节或代码围栏。`;
    }
    return `你上一条生成蓝图未通过 Hydro 沙箱验证：
${detail}

请重新输出【完整蓝图】（所有节，不得省略上次已有的节），并针对上述失败修正：
1. GENERATOR stdout 必须只有合法 JSON，cases 恰好 ${options.caseCount} 个；每个 input 是原始 stdin。
2. ACM 题若题面有 T，默认每个 input 使用 T=1 并包含恰好一组完整数据；函数题每个 input 只对应一次调用。
3. ORACLE 必须是可直接运行的 Python 3 完整程序，不得硬编码用例答案，并应通过题面样例。
4. BRUTE 必须继续输出，并保持与 ORACLE 相互独立的暴力实现。若失败原因是对拍不一致，先推断 ORACLE 与 BRUTE 谁错并修正错的一方；严禁通过删除 BRUTE 或让两者共享实现来绕过对拍。
5. 上次输出过 VALIDATOR 的必须继续输出；若失败原因是输入未通过校验，修正 GENERATOR 或 VALIDATOR 中错误的一方。
6. 函数题必须完整包含 SOLUTION（学生提交形式）与全部模板：${templates}。
7. 使用 @@@META@@@、@@@GENERATOR@@@、@@@ORACLE@@@、@@@SOLUTION@@@、@@@BRUTE@@@、@@@VALIDATOR@@@、@@@TEMPLATE:语言@@@ 分节原文，不要代码围栏。`;
}
function repairSectionContent(sections, header) {
    const section = sections.find(item => item.header.trim().toUpperCase() === header.toUpperCase());
    if (!section)
        return undefined;
    const content = trimBlankEdges(section.content);
    return content.trim() ? normalizeFileContent(content) : undefined;
}
/** 将定向修复结果合并进已解析蓝图；缺少必需节时抛错并由调用方回退完整修复。 */
function mergeSandboxBlueprintRepair(original, raw, scope) {
    const sections = splitDelimitedSections(raw);
    if (sections.length === 0)
        throw new Error('AI 定向修复未返回分节标记');
    const merged = {
        ...original,
        templates: original.templates ? { ...original.templates } : undefined,
    };
    if (scope === 'generator') {
        const generatorCode = repairSectionContent(sections, 'GENERATOR');
        if (!generatorCode)
            throw new Error('AI 定向修复未返回 GENERATOR');
        merged.generatorCode = generatorCode;
        const validatorCode = repairSectionContent(sections, 'VALIDATOR');
        if (validatorCode)
            merged.validatorCode = validatorCode;
    }
    else if (scope === 'oracle') {
        const oracleCode = repairSectionContent(sections, 'ORACLE');
        if (!oracleCode)
            throw new Error('AI 定向修复未返回 ORACLE');
        merged.oracleCode = oracleCode;
        const bruteCode = repairSectionContent(sections, 'BRUTE');
        if (bruteCode)
            merged.bruteCode = bruteCode;
    }
    else if (scope === 'brute') {
        const bruteCode = repairSectionContent(sections, 'BRUTE');
        if (!bruteCode)
            throw new Error('AI 定向修复未返回 BRUTE');
        merged.bruteCode = bruteCode;
    }
    else {
        const solutionCode = repairSectionContent(sections, 'SOLUTION');
        const templatePy = repairSectionContent(sections, 'TEMPLATE:py');
        if (!solutionCode || !templatePy)
            throw new Error('AI 定向修复必须同时返回 SOLUTION 与 TEMPLATE:py');
        merged.solutionCode = solutionCode;
        merged.templates = { ...merged.templates, py: templatePy };
    }
    return merged;
}
function mergeTokenUsage(usages) {
    const present = usages.filter((usage) => Boolean(usage));
    if (present.length === 0)
        return undefined;
    return present.reduce((sum, usage) => ({
        promptTokens: sum.promptTokens + usage.promptTokens,
        completionTokens: sum.completionTokens + usage.completionTokens,
        totalTokens: sum.totalTokens + usage.totalTokens,
    }), { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
}
class TestdataGenService {
    constructor(aiClient, serviceOptions = {}) {
        this.aiClient = aiClient;
        this.sandboxRunner = serviceOptions.sandboxRunner;
        this.mode = serviceOptions.mode || (serviceOptions.sandboxRunner ? 'auto' : 'direct');
    }
    async generate(params) {
        if (this.mode !== 'direct' && this.sandboxRunner) {
            const available = await this.sandboxRunner.isAvailable(params.signal);
            if (available)
                return this.generateWithSandbox(params, this.sandboxRunner);
            if (this.mode === 'sandbox') {
                throw new Error('Hydro 沙箱不可用，无法安全执行 AI 生成器。请检查 hydrojudge.sandbox_host 或改用骨架模式。');
            }
        }
        else if (this.mode === 'sandbox') {
            throw new Error('未配置 Hydro 沙箱执行器，无法安全执行 AI 生成器。');
        }
        const plan = await this.generateDirect(params);
        if (this.mode === 'auto') {
            plan.notes = [
                plan.notes,
                'Hydro 沙箱当前不可达，本次使用兼容直出模式；写入前请重点核对 .out。',
            ].filter(Boolean).join('\n');
        }
        return plan;
    }
    getCallOptions(signal) {
        return {
            signal,
            maxTokens: null,
            timeoutMs: exports.TESTDATA_GEN_LIMITS.AI_TIMEOUT_MS,
        };
    }
    applyResultMetadata(plan, results) {
        plan.tokenUsage = mergeTokenUsage(results.map(result => result.usage));
        plan.usedModel = [...new Set(results.map(result => `${result.usedModel.endpointName}/${result.usedModel.modelName}`))].join(' → ');
        return plan;
    }
    useProvidedPythonOracle(blueprint, options) {
        const provided = options.providedStd?.trim();
        if (blueprint.problemType === 'traditional' && provided && detectStdFilename(provided) === 'std.py') {
            return { ...blueprint, oracleCode: normalizeFileContent(provided) };
        }
        return blueprint;
    }
    async generateDirect(params) {
        const systemPrompt = buildTestdataSystemPrompt();
        const userPrompt = buildTestdataUserPrompt(params);
        const callOptions = this.getCallOptions(params.signal);
        const initialResult = await this.aiClient.chat([{ role: 'user', content: userPrompt }], systemPrompt, callOptions);
        const results = [initialResult];
        let response = parseAiResponse(initialResult.content, params.options, { allowMissingTemplates: true });
        const assignmentIssue = response.problemType === 'function'
            ? findAssignmentStyleCaseInput(response.cases)
            : null;
        if (assignmentIssue) {
            let repairResult;
            try {
                repairResult = await this.aiClient.chat([
                    { role: 'user', content: userPrompt },
                    { role: 'assistant', content: initialResult.content },
                    { role: 'user', content: buildCaseInputRepairPrompt(assignmentIssue, params.options) },
                ], systemPrompt, callOptions);
            }
            catch (err) {
                throw new Error('AI 生成的 .in 使用了“变量名 = 值”的错误格式，自动修复请求又失败了。'
                    + `请重试；若 AI 服务持续不可用，可用「生成骨架文件（不调用 AI）」手动填写。技术细节：${err instanceof Error ? err.message : String(err)}`);
            }
            results.push(repairResult);
            try {
                response = parseAiResponse(repairResult.content, params.options);
                const remainingIssue = response.problemType === 'function'
                    ? findAssignmentStyleCaseInput(response.cases)
                    : null;
                if (remainingIssue) {
                    throw new Error(`第 ${remainingIssue.caseNumber} 个 .in 仍含错误写法：${remainingIssue.line}`);
                }
            }
            catch (err) {
                throw new Error(`AI 自动修复 .in 格式后仍未返回可用的完整文件计划。请重试；若持续失败，可用「生成骨架文件（不调用 AI）」手动填写。技术细节：${err instanceof Error ? err.message : String(err)}`);
            }
        }
        else {
            const missingTemplates = getMissingTemplateLanguages(response, params.options);
            if (missingTemplates.length > 0) {
                let repairResult;
                try {
                    repairResult = await this.aiClient.chat([
                        { role: 'user', content: userPrompt },
                        { role: 'assistant', content: initialResult.content },
                        { role: 'user', content: buildTemplateRepairPrompt(missingTemplates) },
                    ], systemPrompt, callOptions);
                }
                catch (err) {
                    throw new Error(`AI 未返回 ${missingTemplates.map(lang => LANG_DISPLAY[lang]).join('、')}，自动补全请求又失败了。`
                        + `请重试；若 AI 服务持续不可用，可用「生成骨架文件（不调用 AI）」手动填写。技术细节：${err instanceof Error ? err.message : String(err)}`);
                }
                results.push(repairResult);
                const repairedTemplates = parseTemplateSections(repairResult.content);
                response.templates = { ...response.templates };
                for (const lang of missingTemplates) {
                    if (repairedTemplates[lang])
                        response.templates[lang] = repairedTemplates[lang];
                }
                const stillMissing = getMissingTemplateLanguages(response, params.options);
                if (stillMissing.length > 0) {
                    throw new Error(`AI 补全后仍缺少 ${stillMissing.map(lang => LANG_DISPLAY[lang]).join('、')}。`
                        + '请重试；若持续失败，可用「生成骨架文件（不调用 AI）」手动填写。');
                }
            }
        }
        const plan = assemblePlan(response, params.options, {
            mode: 'direct',
            existingFiles: params.existingFiles,
        });
        // 直出模式未经沙箱验证：给出 direct 验证元数据，前端据此渲染「未验证」提示
        plan.verification = {
            mode: 'direct',
            oracleKind: params.options.providedStd?.trim() ? 'provided-std' : 'ai-solution',
        };
        return this.applyResultMetadata(plan, results);
    }
    async generateWithSandbox(params, runner) {
        const systemPrompt = buildSandboxBlueprintSystemPrompt();
        const userPrompt = buildSandboxBlueprintUserPrompt(params);
        const callOptions = this.getCallOptions(params.signal);
        const initialResult = await this.aiClient.chat([{ role: 'user', content: userPrompt }], systemPrompt, callOptions);
        const results = [initialResult];
        let blueprintSourceContent = initialResult.content;
        let blueprint;
        try {
            blueprint = this.useProvidedPythonOracle(parseSandboxBlueprint(initialResult.content, params.options, { allowMissingTemplates: true }), params.options);
        }
        catch (parseError) {
            if (isCancellation(parseError))
                throw parseError;
            const repairResult = await this.aiClient.chat([
                { role: 'user', content: userPrompt },
                { role: 'assistant', content: initialResult.content },
                { role: 'user', content: buildSandboxRepairPrompt(parseError, params.options, 'full') },
            ], systemPrompt, callOptions);
            results.push(repairResult);
            blueprintSourceContent = repairResult.content;
            blueprint = this.useProvidedPythonOracle(parseSandboxBlueprint(repairResult.content, params.options, { allowMissingTemplates: true }), params.options);
        }
        if (blueprint.problemType === 'function') {
            const missing = params.options.languages.filter(lang => !blueprint.templates?.[lang]?.trim());
            if (missing.length > 0) {
                const repairResult = await this.aiClient.chat([
                    { role: 'user', content: userPrompt },
                    { role: 'assistant', content: blueprintSourceContent },
                    { role: 'user', content: buildTemplateRepairPrompt(missing) },
                ], systemPrompt, callOptions);
                results.push(repairResult);
                const repairedTemplates = parseTemplateSections(repairResult.content);
                blueprint.templates = { ...blueprint.templates, ...repairedTemplates };
                blueprintSourceContent = `${blueprintSourceContent}\n${repairResult.content}`;
                const stillMissing = params.options.languages.filter(lang => !blueprint.templates?.[lang]?.trim());
                if (stillMissing.length > 0) {
                    throw new Error(`AI 补全后仍缺少 ${stillMissing.map(lang => LANG_DISPLAY[lang]).join('、')}。`);
                }
            }
        }
        let response;
        try {
            response = await materializeSandboxBlueprint(blueprint, params.options, params.statementMarkdown, runner, params.signal);
        }
        catch (firstError) {
            if (isCancellation(firstError))
                throw firstError;
            const repairScope = classifySandboxRepairScope(firstError);
            let repairResult;
            try {
                repairResult = await this.aiClient.chat([
                    { role: 'user', content: userPrompt },
                    { role: 'assistant', content: blueprintSourceContent },
                    { role: 'user', content: buildSandboxRepairPrompt(firstError, params.options, repairScope) },
                ], systemPrompt, callOptions);
            }
            catch (err) {
                if (isCancellation(err))
                    throw err;
                throw new Error(`AI 生成蓝图未通过 Hydro 沙箱验证，自动修复请求又失败了。技术细节：${err instanceof Error ? err.message : String(err)}`);
            }
            results.push(repairResult);
            try {
                try {
                    blueprint = repairScope === 'full'
                        ? parseSandboxBlueprint(repairResult.content, params.options)
                        : mergeSandboxBlueprintRepair(blueprint, repairResult.content, repairScope);
                    blueprintSourceContent = repairScope === 'full' ? repairResult.content : blueprintSourceContent;
                }
                catch (targetedParseError) {
                    if (repairScope === 'full')
                        throw targetedParseError;
                    const fullRepairResult = await this.aiClient.chat([
                        { role: 'user', content: userPrompt },
                        { role: 'assistant', content: blueprintSourceContent },
                        {
                            role: 'user',
                            content: buildSandboxRepairPrompt(new Error(`定向修复结果不可用：${targetedParseError instanceof Error ? targetedParseError.message : String(targetedParseError)}`), params.options, 'full'),
                        },
                    ], systemPrompt, callOptions);
                    results.push(fullRepairResult);
                    blueprint = parseSandboxBlueprint(fullRepairResult.content, params.options);
                    blueprintSourceContent = fullRepairResult.content;
                }
                blueprint = this.useProvidedPythonOracle(blueprint, params.options);
                response = await materializeSandboxBlueprint(blueprint, params.options, params.statementMarkdown, runner, params.signal);
            }
            catch (err) {
                if (isCancellation(err))
                    throw err;
                throw new Error(`AI 自动修复后仍未通过 Hydro 沙箱验证。请重试或使用骨架模式。技术细节：${err instanceof Error ? err.message : String(err)}`);
            }
        }
        return this.applyResultMetadata(assemblePlan(response, params.options, {
            mode: 'sandbox',
            existingFiles: params.existingFiles,
        }), results);
    }
}
exports.TestdataGenService = TestdataGenService;
//# sourceMappingURL=testdataGenService.js.map