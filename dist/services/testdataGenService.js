"use strict";
/**
 * TestdataGenService - AI 测试数据生成服务
 *
 * 面向教师/出题人：根据 Markdown 题面生成一套可直接写入 HydroOJ
 * 题目文件（测试数据）的完整文件集，包括：
 * - N.in / N.out 测试点（由 AI 依据题面与标程逐点推演生成）
 * - 函数题（LeetCode 风格）所需的 template.py / template.java / template.cc
 * - compile.sh（服务端确定性生成，覆盖所选语言，非 AI 输出）
 * - config.yaml 评测配置（服务端用 js-yaml 确定性生成，写入后 Hydro
 *   会自动同步到题目的评测设置）
 * - std.py 参考标程（供教师人工校验与后续重造数据）
 *
 * 设计要点：AI 只负责「题目理解相关」的部分（模板、标程、测试点内容），
 * 所有结构性文件（compile.sh / config.yaml）由代码确定性拼装，降低幻觉面。
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TestdataGenService = exports.TEMPLATE_FILENAMES = exports.TESTDATA_GEN_LIMITS = exports.SUPPORTED_TEMPLATE_LANGS = void 0;
exports.isSafeTestdataFilename = isSafeTestdataFilename;
exports.validateGenerateOptions = validateGenerateOptions;
exports.detectStdFilename = detectStdFilename;
exports.buildCompileSh = buildCompileSh;
exports.buildConfigYaml = buildConfigYaml;
exports.buildTestdataSystemPrompt = buildTestdataSystemPrompt;
exports.buildTestdataUserPrompt = buildTestdataUserPrompt;
exports.extractJsonObject = extractJsonObject;
exports.normalizeFileContent = normalizeFileContent;
exports.normalizeGenerationObject = normalizeGenerationObject;
exports.parseGenerationResponse = parseGenerationResponse;
exports.parseDelimitedResponse = parseDelimitedResponse;
exports.parseAiResponse = parseAiResponse;
exports.assemblePlan = assemblePlan;
exports.buildSkeletonPlan = buildSkeletonPlan;
const js_yaml_1 = __importDefault(require("js-yaml"));
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
    if (options.dataScale !== undefined && !['small', 'medium', 'large'].includes(options.dataScale)) {
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
    const cases = Array.from({ length: caseCount }, (_, i) => ({
        input: `${i + 1}.in`,
        output: `${i + 1}.out`,
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

【测试数据设计原则】
1. 若题面含示例，前几个测试点必须先覆盖题面示例（输入输出与题面一字不差）。
2. 必须包含边界组，并在 label 中写明设计意图：
   - 最小规模：空输入、0、1、单元素（以题面约束允许的最小值为准）；
   - 规模上限：所选数据规模档位允许的上限附近；
   - 特殊值：相等、重复、负数、临界值（视题意选取，如闰年 2 月 29 日、恰好越界前后）；
   - 特殊结构：全相同、已排序、逆序、对称/回文等（视题意选取）。
3. 其余测试点使用多样化的中间规模数据，避免彼此雷同。
4. 输入输出必须与题面（或标程）的格式要求严格一致；.in 是评测输入文件内容，.out 是标准输出文件内容。
5. 数据规模档位（用户指定，默认 small）：
   - small：所有数据保持人工可快速验算的量级（数值一般 ≤ 100，单个 .in ≤ 30 行）；
   - medium：在题面约束内取中等量级（如 10^2~10^4，单个 .in ≤ 200 行），仍须保证输出可被可靠推演；
   - large：接近题面约束上限。此档必须使用【可解析构造】：用有规律的数据（全相同、等差、周期、对称等），使正确输出能由公式/推理直接得出，而不是逐条模拟；无法可靠推出输出时，宁可缩小该测试点规模，也绝不允许猜测输出。
6. 正确性最重要：先确定标程（教师已提供则以其为准），再对每个测试点逐步推演标程的运行得到 .out。宁可数据小，绝不允许输出错误。

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
- TEMPLATE 节只输出用户要求的语言；传统题省略全部 TEMPLATE 节与 functionName。
- 函数题的 STD 节只包含与学生提交形式一致的函数/类定义（教师可用 cat std.py template.py > check.py 本地验证）；传统题的 STD 节是完整的读写标准输入输出的程序；填空题的 STD 节是补全题面代码后的结果；教师已提供标准答案时省略 STD 节。
- CASE 编号从 1 开始连续递增，数量以用户要求为准；每个编号必须同时给出 IN 与 OUT 两节；IN 标记中最后一段冒号之后是该测试点的设计意图（label，简体中文）。
- 各节内容为原始文本：换行就是真实换行，引号、反斜杠等一律原样书写；除标记行外不要输出任何额外说明文字；正文行不得以 @@@ 开头。
- 所有说明性文字（ANALYSIS/NOTES/label）使用简体中文。`;
}
const DATA_SCALE_TEXT = {
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
        `- 测试点数量：${options.caseCount} 个`,
        `- 数据规模：${DATA_SCALE_TEXT[options.dataScale || 'small']}`,
        `- 函数题模板语言：${langText}`,
    ];
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
function normalizeGenerationObject(obj, options) {
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
                throw new Error(`AI 未返回 ${LANG_DISPLAY[lang]} 的评测模板`);
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
function parseGenerationResponse(raw, options) {
    let parsed;
    try {
        parsed = JSON.parse(extractJsonObject(raw));
    }
    catch (err) {
        throw new Error(`AI 返回内容不是有效的 JSON：${err instanceof Error ? err.message : String(err)}`);
    }
    return normalizeGenerationObject(parsed, options);
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
/**
 * 解析分节标记文本。未发现任何标记时返回 null（调用方回退到 JSON 解析）。
 *
 * 采用分节文本而非 JSON 的原因：AI 需要输出多段含引号/反斜杠/换行的代码，
 * 嵌入 JSON 字符串时转义极易出错（实测出现过 Expected ',' or '}' 一类的
 * 解析失败）；分节原文直出从根上消除了转义问题。
 * @throws Error 标记存在但结构非法时抛出（消息为中文，直接展示给教师）
 */
function parseDelimitedResponse(raw, options) {
    let text = raw.replace(/<think>[\s\S]*?<\/think>/g, '');
    // 模型偶尔会把整个响应包进代码围栏，剥掉最外层
    const fenced = text.match(/^\s*```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n```\s*$/);
    if (fenced)
        text = fenced[1];
    const lines = text.split(/\r?\n/);
    const sections = [];
    let current = null;
    for (const line of lines) {
        const m = line.match(SECTION_MARKER_RE);
        if (m) {
            current = { header: m[1].trim(), content: [] };
            sections.push(current);
        }
        else if (current) {
            // 疑似写坏的标记（如缺尾部 @@@）会静默混入上一节内容，直接报错更安全
            if (line.trimStart().startsWith('@@@')) {
                throw new Error(`AI 返回中存在疑似损坏的分节标记行：${line.trim().slice(0, 50)}，请重试`);
            }
            current.content.push(line);
        }
        // 首个标记之前的内容（模型寒暄）忽略
    }
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
        if (entry.input === undefined || entry.output === undefined) {
            throw new Error(`第 ${num} 个测试点缺少 ${entry.input === undefined ? 'IN' : 'OUT'} 节，请重试`);
        }
        cases.push({ label: entry.label, input: entry.input, output: entry.output });
    }
    obj.cases = cases;
    if (Object.keys(templates).length > 0)
        obj.templates = templates;
    return normalizeGenerationObject(obj, options);
}
/**
 * 解析 AI 响应：优先分节文本（当前契约），无标记时回退 JSON（兼容旧契约/
 * 忽略格式指令的模型）。两者都失败时抛出合并后的可读错误。
 */
function parseAiResponse(raw, options) {
    const delimited = parseDelimitedResponse(raw, options);
    if (delimited)
        return delimited;
    try {
        return parseGenerationResponse(raw, options);
    }
    catch (err) {
        throw new Error(`AI 返回格式无法解析（未找到分节标记，回退 JSON 也失败）。请重试一次；若持续失败，可减少测试点数量，或改用「生成骨架文件」手动填写。技术细节：${err instanceof Error ? err.message : String(err)}`);
    }
}
// ─── 计划组装 ─────────────────────────────────────────────────────────────────
/**
 * 将解析后的 AI 响应组装为完整的文件计划
 */
function assemblePlan(response, options) {
    const files = [];
    const caseCount = response.cases.length;
    response.cases.forEach((c, i) => {
        files.push({ name: `${i + 1}.in`, content: c.input, kind: 'case-in' });
        files.push({ name: `${i + 1}.out`, content: c.output, kind: 'case-out' });
    });
    if (response.problemType === 'function') {
        for (const lang of options.languages) {
            const content = response.templates?.[lang];
            if (content) {
                files.push({ name: exports.TEMPLATE_FILENAMES[lang], content, kind: 'template' });
            }
        }
        files.push({ name: 'compile.sh', content: buildCompileSh(options.languages), kind: 'compile' });
    }
    // 教师提供的标准答案是唯一权威：直接作为 std 文件写入（不使用 AI 复述的版本）
    const providedStd = options.providedStd?.trim();
    if (providedStd) {
        files.push({
            name: detectStdFilename(providedStd),
            content: normalizeFileContent(providedStd),
            kind: 'std',
        });
    }
    else if (response.stdSolution) {
        files.push({ name: 'std.py', content: response.stdSolution.code, kind: 'std' });
    }
    files.push({
        name: 'config.yaml',
        content: buildConfigYaml({
            problemType: response.problemType,
            caseCount,
            languages: options.languages,
        }),
        kind: 'config',
    });
    return {
        problemType: response.problemType,
        isFillIn: response.isFillIn,
        analysis: response.analysis,
        notes: response.notes,
        files,
        caseCount,
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
/**
 * 构建骨架计划：不调用 AI，确定性生成结构性文件与空白测试点。
 * 用作 AI 故障时的降级方案——保住最容易出错的 compile.sh / config.yaml /
 * 模板机制部分，测试数据内容由教师在预览中手动填写。
 */
function buildSkeletonPlan(options) {
    // 骨架模式无 AI 判断题型：auto 按传统题处理（函数题骨架需教师显式选择）
    const problemType = options.problemKind === 'function' ? 'function' : 'traditional';
    const files = [];
    for (let i = 1; i <= options.caseCount; i++) {
        files.push({ name: `${i}.in`, content: '\n', kind: 'case-in' });
        files.push({ name: `${i}.out`, content: '\n', kind: 'case-out' });
    }
    if (problemType === 'function') {
        for (const lang of options.languages) {
            files.push({ name: exports.TEMPLATE_FILENAMES[lang], content: SKELETON_TEMPLATES[lang], kind: 'template' });
        }
        files.push({ name: 'compile.sh', content: buildCompileSh(options.languages), kind: 'compile' });
    }
    const providedStd = options.providedStd?.trim();
    if (providedStd) {
        files.push({
            name: detectStdFilename(providedStd),
            content: normalizeFileContent(providedStd),
            kind: 'std',
        });
    }
    files.push({
        name: 'config.yaml',
        content: buildConfigYaml({ problemType, caseCount: options.caseCount, languages: options.languages }),
        kind: 'config',
    });
    const noteParts = [
        '骨架模式（未调用 AI）：请在预览中逐个填写各 N.in / N.out 的内容后再写入。',
    ];
    if (problemType === 'function') {
        noteParts.push('请按题目输入格式补全各语言评测模板中的 TODO 部分。');
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
    };
}
class TestdataGenService {
    constructor(aiClient) {
        this.aiClient = aiClient;
    }
    /**
     * 调用 AI 生成测试数据计划
     */
    async generate(params) {
        const systemPrompt = buildTestdataSystemPrompt();
        const userPrompt = buildTestdataUserPrompt(params);
        const result = await this.aiClient.chat([{ role: 'user', content: userPrompt }], systemPrompt, {
            signal: params.signal,
            // 正确性优先的长输出场景：不限制 max_tokens，超时放宽到 10 分钟/次
            maxTokens: null,
            timeoutMs: exports.TESTDATA_GEN_LIMITS.AI_TIMEOUT_MS,
        });
        const response = parseAiResponse(result.content, params.options);
        const plan = assemblePlan(response, params.options);
        plan.tokenUsage = result.usage;
        plan.usedModel = `${result.usedModel.endpointName}/${result.usedModel.modelName}`;
        return plan;
    }
}
exports.TestdataGenService = TestdataGenService;
//# sourceMappingURL=testdataGenService.js.map