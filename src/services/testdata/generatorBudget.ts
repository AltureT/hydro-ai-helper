import { TestdataPipelineError } from './failures';
import { TESTDATA_CODE_FILE_MAX_BYTES, TESTDATA_INPUT_MAX_BYTES, TESTDATA_PLAN_MAX_BYTES } from './fileBudget';

/** Bounded formal data transport; ordinary execution and stress limits are separate. */
export const GENERATOR_BYTE_LIMITS = {
  input: TESTDATA_INPUT_MAX_BYTES,
  output: TESTDATA_CODE_FILE_MAX_BYTES,
  stdout: 8 * 1024 * 1024,
  plan: TESTDATA_PLAN_MAX_BYTES,
} as const;

export const GENERATOR_BUDGET_CONFLICT_MARKER = '@@@GENERATOR_BUDGET_CONFLICT@@@';

export function buildGeneratorBudgetPrompt(
  caseCount: number,
  slots: ReadonlyArray<{ caseNumber: number; dataScale?: string }> = [],
): string {
  const count = Math.max(1, Math.min(30, Math.trunc(caseCount) || 1));
  const weights = Array.from({ length: count }, (_, index) => (
    slots[index]?.dataScale === 'small' ? 1 : slots[index]?.dataScale === 'large' ? 12 : 4
  ));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  // Planning targets only: leave room for outputs, replay code and JSON escaping.
  const targets = weights.map(weight => Math.min(
    GENERATOR_BYTE_LIMITS.input,
    Math.floor(GENERATOR_BYTE_LIMITS.plan / 2 * weight / totalWeight),
  ));
  return `【生成字节预算与有界构造】
GENERATOR_BUDGET: ${JSON.stringify({
    caseCount: count,
    maxInputBytes: GENERATOR_BYTE_LIMITS.input,
    maxStdoutBytes: GENERATOR_BYTE_LIMITS.stdout,
    maxPlanBytes: GENERATOR_BYTE_LIMITS.plan,
    maxOutputBytes: TESTDATA_CODE_FILE_MAX_BYTES,
    suggestedTotalInputBytes: targets.reduce((sum, bytes) => sum + bytes, 0),
    suggestedInputBytesByCase: targets,
  })}
逐 CASE 建立规模与字节估算，再编写生成器。建议预算可在 CASE 间调配，不是新硬限制；为 .out、生成器、标程与模板预留总文件预算。正式 GENERATOR 的 JSON 由沙箱缓存文件传输，上限 8 MiB；每个 .in 上限 4 MiB，.out 和代码仍各限 256 KiB。压力生成器仍为小数据，沿用每个输入 256 KiB、整批 stdout 1 MiB，不可套用正式大数据额度。字节数按 UTF-8 计算，不按字符数；JSON 中换行、反斜杠和引号的转义也占空间。
先建立完整 case_specs 规模表，再分配或构造大数组，禁止每个 large CASE 都独立用满单文件额度。最大规模边界放在覆盖计划要求它的 CASE；其他 CASE 按自己的覆盖目标分配预算。整数数组按元素个数 ×（最长十进制位数 + 符号 + 分隔符）估算，并为 JSON 转义留余量；不要把数组长度当作字节数。
每个 CASE 同时估算 outputBytes：例如查询题按会输出答案的查询数 ×（最长答案字节数 + 换行）计算，而不是按总操作数。如果输出会超 256 KiB，优先调整会产生输出的操作比例、值域等可调维度，保留必要的大规模和边界覆盖；不能仅更换标程语言或截断正确输出。全部输入 + 预计输出 + 辅助文件的字节数必须合计在 8 MiB 内。
large 不等于把所有维度同时拉满：依据覆盖计划分别构造大 n 小 q、小 n 多操作等合法数据；保留要求的边界和复杂度特征，label 只描述实际达到的覆盖。不得截断 input、删测试点或把降低必要覆盖宣称为完成。
Python 生成器必须在 5 秒内完成：循环必须有界；去重前检查可用候选容量，优先直接构造或无放回采样，禁止无限拒绝采样。动态集合随机删除使用列表加位置索引和尾元素交换，避免每轮 list(set) 或重建全部边；不能通过省略合法性检查来提速。
在打印前执行以下字节检查（cases 是已经构造好的完整列表；不要打印中间结果）：
assert len(cases) == ${count}, f'GENERATOR_CASE_COUNT actual={len(cases)} expected=${count}'
input_bytes_by_case = []
for case_index, case in enumerate(cases, 1):
    input_text = case['input'].replace('\\r\\n', '\\n').replace('\\r', '\\n')
    if not input_text.endswith('\\n'):
        input_text += '\\n'
    case['input'] = input_text
    input_bytes = len(input_text.encode('utf-8'))
    input_bytes_by_case.append(input_bytes)
    assert input_bytes <= ${GENERATOR_BYTE_LIMITS.input}, f'GENERATOR_INPUT_BYTES case={case_index} actualBytes={input_bytes} maxBytes=${GENERATOR_BYTE_LIMITS.input}'
payload = json.dumps({'cases': cases}, ensure_ascii=False, separators=(',', ':'))
payload_bytes = len(payload.encode('utf-8'))
assert payload_bytes <= ${GENERATOR_BYTE_LIMITS.stdout}, f'GENERATOR_STDOUT_BYTES actualBytes={payload_bytes} maxBytes=${GENERATOR_BYTE_LIMITS.stdout} inputBytesByCase={input_bytes_by_case}'
print(payload, end='')
若估算必要覆盖的最小输入或输出仍超硬上限，停止生成，仅返回 ${GENERATOR_BUDGET_CONFLICT_MARKER} 后跟严格 JSON {"scope":"input","minimumBytes":12000000}。scope 仅 input（单个 .in）、output（单个 .out，256 KiB）、stdout（整批 JSON）或 plan（全部文件）；minimumBytes 必须为超过对应硬上限的整数。服务端会将模型估算交给人工复核，不视为已经执行验证的事实。不得混入 GENERATOR、GENERATOR_PLAN、TEMPLATE 或其他分节。`;
}

/** Reported assertion sizes guide repair only; acceptance still requires measured output checks. */
export function parseGeneratorBudgetFailure(error: unknown): TestdataPipelineError | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/GENERATOR_(INPUT|STDOUT)_BYTES(?: case=(\d+))? actualBytes=(\d+) maxBytes=(\d+)/);
  if (!match) return undefined;
  const scope = match[1] === 'INPUT' ? 'input' : 'stdout';
  const actualBytes = Number(match[3]);
  const maxBytes = Number(match[4]);
  const caseIndex = match[2] ? Number(match[2]) : undefined;
  if (!Number.isSafeInteger(actualBytes) || actualBytes <= maxBytes
    || maxBytes !== GENERATOR_BYTE_LIMITS[scope]
    || (scope === 'input' && caseIndex === undefined)
    || (caseIndex !== undefined && (!Number.isSafeInteger(caseIndex) || caseIndex < 1 || caseIndex > 30))) return undefined;
  const sizes = message.match(/inputBytesByCase=(\[[\d,\s]{1,500}\])/);
  let indexes: string[] | undefined;
  if (sizes) {
    try {
      const values = JSON.parse(sizes[1]);
      if (Array.isArray(values) && values.length > 0 && values.length <= 30
        && values.every(bytes => Number.isSafeInteger(bytes) && bytes >= 0)) {
        indexes = values.map((bytes, index) => `${index + 1}:${bytes}`);
      }
    } catch { /* A malformed diagnostic does not replace the measured transport limits. */ }
  }
  return new TestdataPipelineError(
    `GENERATOR 运行时报告 ${scope} 预算超限：${actualBytes} / ${maxBytes} 字节。`
      + (caseIndex ? `测试点 ${caseIndex}。` : '')
      + (indexes ? `各 CASE 输入字节数（编号:字节）：${indexes.join(', ')}。` : '')
      + '请重新分配整批构造规模，保留全部测试点和必要覆盖；不要截断数据。',
    'GENERATOR_OUTPUT_TOO_LARGE', 'generator', 'generator', 'repair-artifact',
    { actualBytes, maxBytes, failureKind: `${scope}-budget`, ...(caseIndex ? { caseIndex } : {}), ...(indexes ? { indexes } : {}) },
  );
}

/** A model estimate is a review request, never evidence that data has been checked. */
export function throwIfGeneratorBudgetConflict(
  raw: string,
  sections: ReadonlyArray<{ header: string }>,
): void {
  const text = raw.trim();
  if (!sections.some(section => section.header.split(':')[0].trim().toUpperCase() === 'GENERATOR_BUDGET_CONFLICT')) return;
  if (sections.length !== 1 || !text.startsWith(GENERATOR_BUDGET_CONFLICT_MARKER)) {
    throw new Error('预算冲突必须使用独立的规范分节，不得与生成代码混合');
  }
  const body = text.slice(GENERATOR_BUDGET_CONFLICT_MARKER.length);
  if (!/^\r?\n/.test(body)) throw new Error('预算冲突标记必须独占一行');
  const value = JSON.parse(body);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2
    || typeof value.scope !== 'string'
    || !Object.prototype.hasOwnProperty.call(GENERATOR_BYTE_LIMITS, value.scope)
    || !Number.isSafeInteger(value.minimumBytes)
    || value.minimumBytes <= GENERATOR_BYTE_LIMITS[value.scope as keyof typeof GENERATOR_BYTE_LIMITS]) {
    throw new Error('预算冲突必须包含有效 scope 与超过硬上限的 minimumBytes');
  }
  const limit = GENERATOR_BYTE_LIMITS[value.scope as keyof typeof GENERATOR_BYTE_LIMITS];
  throw new TestdataPipelineError(
    `模型估算必要覆盖需要 ${value.minimumBytes} 字节，超过 ${value.scope} 的 ${limit} 字节上限；`
      + '此估算尚未经执行确认，请人工复核覆盖要求与预算。未缩减或生成测试数据。',
    'GENERATOR_OUTPUT_TOO_LARGE', 'generator', 'generator', 'manual-review',
    { failureKind: 'model-budget-estimate', maxBytes: limit },
  );
}

export function assertGeneratorStdoutBudget(cases: ReadonlyArray<{ label: string; input: string }>): void {
  const bytes = Buffer.byteLength(JSON.stringify({ cases }), 'utf8');
  if (bytes > GENERATOR_BYTE_LIMITS.stdout) {
    throw new TestdataPipelineError(
      'GeneratorPlan 物化后的整批 JSON 超过沙箱输出上限',
      'GENERATOR_OUTPUT_TOO_LARGE', 'generator', 'generator', 'repair-artifact',
      { actualBytes: bytes, maxBytes: GENERATOR_BYTE_LIMITS.stdout,
        indexes: cases.slice(0, 30).map((item, index) => `${index + 1}:${Buffer.byteLength(item.input, 'utf8')}`) },
    );
  }
}

/** Reject an already impossible file plan before further verification and assembly work. */
export function assertGeneratedDataBudget(cases: ReadonlyArray<{ input: string; output: string }>): void {
  const sizes = cases.map(item => [item.input, item.output].reduce((sum, content) => {
    const normalized = content.replace(/\r\n?/g, '\n');
    return sum + Buffer.byteLength(normalized, 'utf8') + (normalized.endsWith('\n') ? 0 : 1);
  }, 0));
  const total = sizes.reduce((sum, bytes) => sum + bytes, 0);
  if (total <= GENERATOR_BYTE_LIMITS.plan) return;
  throw new TestdataPipelineError(
    `仅 .in/.out 已合计 ${total} 字节，超过整批 ${GENERATOR_BYTE_LIMITS.plan} 字节上限。`
      + `各 CASE 输入与输出合计：${sizes.map((bytes, index) => `${index + 1}:${bytes}`).join(', ')}。`
      + '请重新分配输入构造规模，保留全部测试点及必要覆盖，并为辅助文件留出预算。',
    'GENERATOR_OUTPUT_TOO_LARGE', 'generator', 'generator', 'repair-artifact',
    { actualBytes: total, maxBytes: GENERATOR_BYTE_LIMITS.plan, failureKind: 'plan-budget',
      indexes: sizes.slice(0, 30).map((bytes, index) => `${index + 1}:${bytes}`) },
  );
}
