import { TestdataPipelineError } from './failures';

/** Existing apply and sandbox limits, shared by planning and materialization. */
export const GENERATOR_BYTE_LIMITS = {
  input: 256 * 1024,
  stdout: 1024 * 1024,
  plan: 1024 * 1024,
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
    suggestedInputBytesByCase: targets,
  })}
逐 CASE 建立规模与字节估算，再编写生成器。建议预算可在 CASE 间调配，不是新硬限制；为 .out、生成器、标程与模板预留总文件预算。字节数按 UTF-8 计算，不按字符数；JSON 中换行、反斜杠和引号的转义也占空间。
large 不等于把所有维度同时拉满：依据覆盖计划分别构造大 n 小 q、小 n 多操作等合法数据；保留要求的边界和复杂度特征，label 只描述实际达到的覆盖。不得截断 input、删测试点或把降低必要覆盖宣称为完成。
Python 生成器必须在 5 秒内完成：循环必须有界；去重前检查可用候选容量，优先直接构造或无放回采样，禁止无限拒绝采样。动态集合随机删除使用列表加位置索引和尾元素交换，避免每轮 list(set) 或重建全部边；不能通过省略合法性检查来提速。
在打印前执行以下字节检查（cases 是已经构造好的完整列表；不要打印中间结果）：
assert len(cases) == ${count}, f'GENERATOR_CASE_COUNT actual={len(cases)} expected=${count}'
for case_index, case in enumerate(cases, 1):
    input_text = case['input'].replace('\\r\\n', '\\n').replace('\\r', '\\n')
    if not input_text.endswith('\\n'):
        input_text += '\\n'
    case['input'] = input_text
    input_bytes = len(input_text.encode('utf-8'))
    assert input_bytes <= ${GENERATOR_BYTE_LIMITS.input}, f'GENERATOR_INPUT_BYTES case={case_index} actualBytes={input_bytes} maxBytes=${GENERATOR_BYTE_LIMITS.input}'
payload = json.dumps({'cases': cases}, ensure_ascii=False, separators=(',', ':'))
payload_bytes = len(payload.encode('utf-8'))
assert payload_bytes <= ${GENERATOR_BYTE_LIMITS.stdout}, f'GENERATOR_STDOUT_BYTES actualBytes={payload_bytes} maxBytes=${GENERATOR_BYTE_LIMITS.stdout}'
print(payload, end='')
若估算必要覆盖的最小输入或输出仍超硬上限，停止生成，仅返回 ${GENERATOR_BUDGET_CONFLICT_MARKER} 后跟严格 JSON {"scope":"input","minimumBytes":1200000}。scope 仅 input（单个 .in）、stdout（整批 JSON）或 plan（全部文件）；minimumBytes 必须为超过对应硬上限的整数。服务端会将模型估算交给人工复核，不视为已经执行验证的事实。不得混入 GENERATOR、GENERATOR_PLAN、TEMPLATE 或其他分节。`;
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
      { actualBytes: bytes, maxBytes: GENERATOR_BYTE_LIMITS.stdout },
    );
  }
}
