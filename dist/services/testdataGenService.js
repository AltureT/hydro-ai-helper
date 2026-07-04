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
exports.buildCompileSh = buildCompileSh;
exports.buildConfigYaml = buildConfigYaml;
exports.buildTestdataSystemPrompt = buildTestdataSystemPrompt;
exports.buildTestdataUserPrompt = buildTestdataUserPrompt;
exports.extractJsonObject = extractJsonObject;
exports.normalizeFileContent = normalizeFileContent;
exports.parseGenerationResponse = parseGenerationResponse;
exports.assemblePlan = assemblePlan;
const js_yaml_1 = __importDefault(require("js-yaml"));
exports.SUPPORTED_TEMPLATE_LANGS = ['py', 'java', 'cc'];
// ─── 常量与校验 ───────────────────────────────────────────────────────────────
exports.TESTDATA_GEN_LIMITS = {
    MIN_CASES: 1,
    MAX_CASES: 30,
    MAX_EXTRA_REQUIREMENTS: 1000,
    MAX_STATEMENT_LENGTH: 20000,
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
    if ((options.extraRequirements || '').length > exports.TESTDATA_GEN_LIMITS.MAX_EXTRA_REQUIREMENTS) {
        return 'ai_helper_testdata_err_extra_too_long';
    }
    return null;
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
模板中的输入解析必须与你设计的 .in 文件格式严格一致；多语言模板之间的输入解析和输出格式必须完全等价，保证同一份 .in 在三种语言下输出一致。

【测试数据设计原则】
1. 若题面含示例，前几个测试点必须先覆盖题面示例（输入输出与题面一致）。
2. 覆盖边界情况：最小规模（如空输入、单元素、0、1）、最大规模附近、特殊结构（全相同、已排序、逆序、负数等，视题意选取）。
3. 其余测试点使用中小规模的多样化数据；除非教师明确要求大数据，单个 .in 文件不要超过 50 行、每行不超过 200 字符，确保人工可校验。
4. 输入输出必须与题面的格式要求严格一致；.in 是评测输入文件内容，.out 是标准输出文件内容。
5. 正确性最重要：先在心中写出标程（stdSolution），然后对每个测试点逐步模拟标程的运行，据此得到 .out 内容。宁可数据小，绝不允许输出错误。

【输出格式（严格 JSON）】
只输出一个 JSON 对象，不要输出任何解释文字，不要使用 Markdown 代码块围栏。JSON 结构如下：
{
  "problemType": "function" 或 "traditional",
  "analysis": "简要说明（不超过 200 字）：题意理解、输入输出格式、数据范围",
  "functionName": "函数题的函数名（传统题省略）",
  "templates": { "py": "template.py 内容", "java": "template.java 内容", "cc": "template.cc 内容" },
  "stdSolution": { "language": "python", "code": "Python 标程代码" },
  "cases": [ { "label": "样例1", "input": "1 4\\n2\\n", "output": "4\\n" } ],
  "notes": "给教师的注意事项（可选，如数据范围做了哪些裁剪）"
}
约定：
- templates 只需包含用户要求的语言；传统题省略 templates 与 functionName。
- 函数题的 stdSolution.code 只包含与学生提交形式一致的函数/类定义（教师可用 cat std.py template.py > check.py 本地验证）；传统题的 stdSolution.code 是完整的读写标准输入输出的程序。
- cases 数量以用户要求为准；input/output 中换行用 \\n 表示，文件末尾保留一个换行。
- 所有说明性文字（analysis/notes/label）使用简体中文。`;
}
/**
 * 构建 User Prompt
 */
function buildTestdataUserPrompt(params) {
    const { problemTitle, statementMarkdown, options, existingFiles } = params;
    const kindText = {
        auto: '自动判断（根据题面）',
        traditional: '传统题（标准输入输出）',
        function: '函数题（LeetCode 风格，学生只写函数）',
    }[options.problemKind];
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
        `- 测试点数量：${options.caseCount} 个`,
        `- 函数题模板语言：${langText}`,
    ];
    if (options.extraRequirements?.trim()) {
        lines.push(`- 教师补充要求：${options.extraRequirements.trim()}`);
    }
    if (existingFiles && existingFiles.length > 0) {
        lines.push('', `【题目已有文件（将可能被覆盖，仅供参考）】${existingFiles.join(', ')}`);
    }
    lines.push('', '请按照 System 中约定的 JSON 结构输出。');
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
 * 解析并校验 AI 返回的生成结果
 * @throws Error 结构非法时抛出（消息为中文，直接展示给教师）
 */
function parseGenerationResponse(raw, options) {
    let parsed;
    try {
        parsed = JSON.parse(extractJsonObject(raw));
    }
    catch (err) {
        throw new Error(`AI 返回内容不是有效的 JSON（可能因输出过长被截断，可尝试减少测试点数量或模板语言后重试）：${err instanceof Error ? err.message : String(err)}`);
    }
    const obj = parsed;
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
    return {
        problemType: effectiveType,
        analysis: typeof obj.analysis === 'string' ? obj.analysis : undefined,
        functionName: typeof obj.functionName === 'string' ? obj.functionName : undefined,
        templates,
        stdSolution,
        cases,
        notes: typeof obj.notes === 'string' ? obj.notes : undefined,
    };
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
    if (response.stdSolution) {
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
        analysis: response.analysis,
        notes: response.notes,
        files,
        caseCount,
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
        const result = await this.aiClient.chat([{ role: 'user', content: userPrompt }], systemPrompt, { signal: params.signal });
        const response = parseGenerationResponse(result.content, params.options);
        const plan = assemblePlan(response, params.options);
        plan.tokenUsage = result.usage;
        plan.usedModel = `${result.usedModel.endpointName}/${result.usedModel.modelName}`;
        return plan;
    }
}
exports.TestdataGenService = TestdataGenService;
//# sourceMappingURL=testdataGenService.js.map