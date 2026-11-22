/**
 * Agent 工具层：供 ChatHandler 以 OpenAI function calling 方式暴露给模型。
 *
 * 工具结果只回传给模型用于引导式讲解，不改变「严禁输出可执行代码」的核心原则。
 * 所有输出严格截断，控制单次对话的内存占用。
 */
import type { Context } from 'hydrooj';
import * as hydrooj from 'hydrooj';
import { ProblemModel, RecordModel, STATUS, StorageModel } from 'hydrooj';

// SettingModel.langs 在 hydrooj 5.x 运行时可用；类型面可能滞后，运行时安全访问
const SettingModel: any = (hydrooj as any).SettingModel;
import { KnowledgeService } from './knowledgeService';

// hydrooj 插件 API 对 RecordModel 的类型面只暴露部分方法，运行时完整可用
const Records = RecordModel as any;

// ─── 截断常量（内存控制） ────────────────────────────────
const MAX_PROBLEM_CONTENT = 30000;
const MAX_CODE_LENGTH = 60000;
const MAX_INPUTS = 5;
const MAX_INPUT_LENGTH = 20000;
const MAX_CASE_MESSAGE = 4000;
const MAX_COMPILER_TEXT = 2000;
const PRETEST_POLL_MS = 1000;
const PRETEST_TIMEOUT_MS = 30000;
const NON_TERMINAL = [
  STATUS.STATUS_WAITING, STATUS.STATUS_FETCHED,
  STATUS.STATUS_COMPILING, STATUS.STATUS_JUDGING,
];

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_problem_detail',
      description: '获取当前题目的完整信息：完整题面、数据范围、时间/空间限制、以及解析出的样例输入输出。当需要题面细节来定位问题时使用。无需参数。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_pretest',
      description: '在服务器沙箱中实际运行一段代码（使用样例输入），返回真实的编译输出、运行输出与错误。用于验证你对学生代码行为的具体猜测。只能运行当前学生提交的代码，不能访问网络。',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '要运行的完整源代码' },
          lang: { type: 'string', description: '语言标识，如 cpp、java、python3' },
          inputs: { type: 'array', items: { type: 'string' }, description: `可选：自定义测试输入（最多 ${MAX_INPUTS} 组）。省略时自动使用题面中的样例输入。` },
        },
        required: ['code', 'lang'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_knowledge',
      description: '搜索管理员维护的知识库（题解思路、常见错误、知识点讲解），返回最相关的参考内容。回答概念性或本题思路类问题时优先使用。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词或问题描述' },
        },
        required: ['query'],
      },
    },
  },
];

export interface AgentToolContext {
  ctx: Context;
  domainId: string;
  problemId: string;
  userId: number;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// 从题面 markdown 解析样例输入块（支持中英文标题）
function extractSampleInputs(content: string): string[] {
  const inputs: string[] = [];
  const re = /#{2,3}\s*(?:样例输入|示例输入|Sample Input)[^\n]*\n+```[^\n]*\n([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) && inputs.length < MAX_INPUTS) {
    const val = m[1].trim();
    if (val) inputs.push(truncate(val, MAX_INPUT_LENGTH));
  }
  return inputs;
}

async function getProblemDetail(tc: AgentToolContext): Promise<string> {
  const pdoc = await ProblemModel.get(tc.domainId, tc.problemId, [...ProblemModel.PROJECTION_PUBLIC, 'pid']);
  if (!pdoc) return '题目不存在或无权访问。';
  let content = '';
  try {
    const statements = await ProblemModel.getStatements(pdoc);
    content = statements.map((s) => String(s.content || '')).join('\n');
  } catch {
    content = String(pdoc.content || '');
  }
  const fullContent = truncate(content, MAX_PROBLEM_CONTENT);
  const samples = extractSampleInputs(content);
  const imageRefs = extractImageRefs(content);
  const externalImages = imageRefs.filter((r) => /^https?:\/\//i.test(r.url)).length;
  return JSON.stringify({
    title: pdoc.title,
    content: fullContent,
    timeLimit: pdoc.time,
    memoryLimit: pdoc.memory,
    sampleInputsFound: samples.length,
    samples: samples.map((s) => truncate(s, 500)),
    statementImageCount: imageRefs.length,
    externalImageNote: externalImages ? `题面含 ${externalImages} 张外链图片，无法直接查看，请让学生描述图片内容。` : '',
  }, null, 0);
}

async function runPretest(tc: AgentToolContext, args: { code?: string; lang?: string; inputs?: unknown }): Promise<string> {
  const code = String(args.code || '');
  const lang = String(args.lang || '').trim();
  if (!code || code.length > MAX_CODE_LENGTH) return '代码为空或过长，无法运行。';
  if (!lang) return '缺少语言参数。';

  // 语言映射到可自测的语言（与提交入口逻辑一致：hydrooj 的模块级 langs 实时表）
  const langConfig = SettingModel?.langs?.[lang];
  if (!langConfig) return `不支持的语言: ${lang}`;
  const pretestLang = langConfig.pretest || lang;

  // 输入：优先模型提供的，否则解析题面样例
  let inputs: string[] = Array.isArray(args.inputs)
    ? (args.inputs as unknown[]).filter((i) => typeof i === 'string' && (i as string).length).slice(0, MAX_INPUTS).map((i) => truncate(String(i), MAX_INPUT_LENGTH))
    : [];
  if (!inputs.length) {
    const pdoc = await ProblemModel.get(tc.domainId, tc.problemId, ProblemModel.PROJECTION_PUBLIC);
    if (pdoc) {
      try {
        const statements = await ProblemModel.getStatements(pdoc);
        inputs = extractSampleInputs(statements.map((s) => String(s.content || '')).join('\n'));
      } catch { /* ignore */ }
    }
  }
  if (!inputs.length) return '没有可用的样例输入，且模型未提供输入，无法运行。';

  const pdoc = await ProblemModel.get(tc.domainId, tc.problemId, ['docId']);
  if (!pdoc) return '题目不存在，无法评测。';

  const rid = await Records.add(
    tc.domainId, pdoc.docId, tc.userId, pretestLang, code, true,
    { input: inputs, type: 'pretest' },
  );

  // 轮询等待终态；评测机缺失时超时降级
  const deadline = Date.now() + PRETEST_TIMEOUT_MS;
  // eslint-disable-next-line no-await-in-loop
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const rdoc = await Records.get(tc.domainId, rid);
    if (rdoc && !NON_TERMINAL.includes(rdoc.status)) {
      return formatPretestResult(rdoc);
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, PRETEST_POLL_MS));
  }
  await Records.update(tc.domainId, rid, { status: STATUS.STATUS_SYSTEM_ERROR }).catch(() => undefined);
  return '评测超时（20 秒未返回结果）。服务器评测机可能未运行或繁忙，请基于题面与代码静态分析继续引导。';
}

function formatPretestResult(rdoc: any): string {
  const statusNames: Record<number, string> = {
    1: 'Accepted', 2: 'WrongAnswer', 3: 'TLE', 4: 'MLE', 5: 'OLE',
    6: 'RE', 7: 'CE', 8: 'SE', 9: 'Cancelled', 13: 'InternalError', 14: 'ExceededSkillLimit',
  };
  const cases = (rdoc.testCases || []).map((c: any, i: number) => ({
    index: i + 1,
    status: statusNames[c.status] || String(c.status),
    time: c.time,
    memory: c.memory,
    message: truncate(String(c.message || ''), MAX_CASE_MESSAGE),
  }));
  const compilerText = truncate((rdoc.compilerTexts || []).join('\n'), MAX_COMPILER_TEXT);
  return JSON.stringify({
    status: statusNames[rdoc.status] || `status=${rdoc.status}`,
    time: rdoc.time,
    memory: rdoc.memory,
    cases,
    compilerText,
    note: 'message 字段包含该组输入的 stdout+stderr。pretest 不比对输出正确性，仅展示程序实际行为。',
  });
}

async function searchKnowledge(tc: AgentToolContext, args: { query?: string }): Promise<string> {
  const query = String(args.query || '').trim();
  if (!query) return '缺少搜索关键词。';
  const service = new KnowledgeService(tc.ctx);
  const block = await service.retrieveBlock(query, { problemPid: tc.problemId });
  return block || '知识库中没有与该问题相关的内容。';
}


// ─── 题面图片支持（多模态） ─────────────────────────────
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
};

export interface ProblemImage {
  dataUrl: string;
  alt: string;
}

function extractImageRefs(content: string): Array<{ alt: string; url: string }> {
  const refs: Array<{ alt: string; url: string }> = [];
  const re = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) && refs.length < MAX_IMAGES) {
    refs.push({ alt: m[1] || '图片', url: m[2] });
  }
  return refs;
}

function isStatementImage(url: string): boolean {
  if (/^https?:\/\//i.test(url)) return true; // 外链图片交给模型侧处理，本地不抓取
  const clean = url.split('?')[0].split('#')[0];
  return !!IMAGE_MIME[clean.split('.').pop()?.toLowerCase() || ''];
}

async function loadImageBuffer(rawUrl: string, pdoc: any, domainId: string): Promise<Buffer | null> {
  try {
    if (/^https?:\/\//i.test(rawUrl)) return null; // 不代抓外链，避免 SSRF 与超时
    const clean = decodeURIComponent(rawUrl.split('?')[0].split('#')[0]);
    const fname = clean.split('/').pop() || '';
    if (!fname) return null;
    const mimeKey = (fname.split('.').pop() || '').toLowerCase();
    if (!IMAGE_MIME[mimeKey]) return null;
    const pid = pdoc.pid || `P${pdoc.docId}`;
    const buf = await StorageModel.get(`problem/${domainId}/${pid}/additional_file/${fname}`);
    if (!buf || (buf as Buffer).length > MAX_IMAGE_BYTES) return null;
    return Buffer.isBuffer(buf) ? buf : Buffer.from(buf as any);
  } catch {
    return null;
  }
}

/** 从题面 markdown 收集可注入的多模态图片（本地 additional_file，最多 4 张、单张 ≤3MB）。 */
export async function collectStatementImages(
  domainId: string,
  pdoc: any,
  statementContent: string,
): Promise<ProblemImage[]> {
  const refs = extractImageRefs(statementContent).filter((r) => isStatementImage(r.url));
  const out: ProblemImage[] = [];
  for (const ref of refs) {
    const buf = await loadImageBuffer(ref.url, pdoc, domainId);
    if (!buf) continue;
    const mime = IMAGE_MIME[(ref.url.split('?')[0].split('.').pop() || '').toLowerCase()] || 'image/png';
    out.push({ dataUrl: `data:${mime};base64,${buf.toString('base64')}`, alt: ref.alt });
    if (out.length >= MAX_IMAGES) break;
  }
  return out;
}

export async function executeAgentTool(
  name: string,
  argsJson: string,
  tc: AgentToolContext,
): Promise<string> {
  let args: any = {};
  try {
    args = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    return '工具参数解析失败（非法 JSON）。';
  }
  try {
    switch (name) {
      case 'get_problem_detail':
        return await getProblemDetail(tc);
      case 'run_pretest':
        return await runPretest(tc, args);
      case 'search_knowledge':
        return await searchKnowledge(tc, args);
      default:
        return `未知工具: ${name}`;
    }
  } catch (err: any) {
    return `工具执行出错: ${String(err?.message || err).substring(0, 300)}`;
  }
}
