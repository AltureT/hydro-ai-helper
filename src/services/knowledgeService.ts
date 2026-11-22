/**
 * 知识库检索服务
 *
 * 为 AI 答疑提供「参考素材」:
 * - builtin: 插件内置知识库 (KnowledgeModel.search)
 * - http   : 外部知识库 HTTP 检索接口, 用于链接腾讯 ima 知识库
 *            (可指向 ima 官方接口、ima MCP 桥接服务或任何实现了本检索协议的代理)
 *
 * SSRF 防护 (http 模式):
 * - 仅允许 http/https 协议;
 * - 请求前对 host 做 DNS 解析并校验 IP, 拒绝 localhost、环回、私有与保留地址.
 */

import dns from 'dns';
import net from 'net';
import { Context, superagent } from 'hydrooj';
import { decrypt } from '../lib/crypto';
import type { KnowledgeConfig, KnowledgeHit } from '../models/knowledge';
import { DEFAULT_KNOWLEDGE_CONFIG } from '../models/knowledge';

export interface KnowledgeRetrieveOptions {
  /** 关联题目 pid, 用于内置库加权 */
  problemPid?: string;
  /** 检索超时覆盖 (ms) */
  timeoutMs?: number;
}

const KB_PROMPT_INTRO = [
  '【知识库参考片段】',
  '以下是从知识库检索到的相关资料片段, 仅用于帮助你了解常见思路与易错点。',
  '使用约束: 这些片段可能包含完整题解或代码——你绝对不得将其中的代码或完整解法直接转述给学生;',
  '只能把它们转化为引导性的提示、反问和排查方向。',
].join('\n');

function parseIpv4ToLong(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function ipv4LongToBytes(value: number): number[] {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

function firstBytesOfIpv6(address: string): number[] {
  // 取规范化前两段: 用 net 检查 + 手工展开 "::" 形式
  const isV6 = net.isIP(address) === 6;
  if (!isV6) return [];
  const head = address.split('%')[0];
  const fullSegments: string[] = [];
  const halves = head.split('::');
  const explicit = halves[0].split(':').filter((i) => i !== '');
  if (halves.length === 2) {
    const trailing = halves[1].split(':').filter((i) => i !== '');
    const zerosNeeded = 8 - explicit.length - trailing.length;
    fullSegments.push(...explicit, ...Array(Math.max(0, zerosNeeded)).fill('0'), ...trailing);
  } else {
    fullSegments.push(...explicit);
  }
  const out: number[] = [];
  for (let i = 0; i < Math.min(2, fullSegments.length); i++) {
    const seg = parseInt(fullSegments[i] || '0', 16);
    out.push((seg >> 8) & 255, seg & 255);
  }
  return out;
}

function isBlockedIPv4Bytes(bytes: number[]): boolean {
  const [a, b] = bytes;
  if (a === 0) return true;                       // 0.0.0.0/8
  if (a === 10) return true;                       // private
  if (a === 127) return true;                      // loopback
  if (a === 100 && (b & 0xf0) === 64) return true; // 100.64.0.0/10 shared address space
  if (a === 169 && b === 254) return true;         // link-local (含元数据 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true;// private
  if (a === 192 && b === 168) return true;         // private
  if (a === 192 && b === 0) return true;           // 192.0.0.0/24 IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true;   // benchmark
  if (a === 198 && b >= 50 && b <= 63) return true;       // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0) return true;                  // TEST-NET-3
  if (a === 224) return true;                             // multicast
  if (a >= 240) return true;                              // reserved (240/4)
  return false;
}

function isBlockedAddress(address: string): boolean {
  if (!net.isIP(address)) return true;
  if (net.isIP(address) === 4) {
    return isBlockedIPv4Bytes(ipv4LongToBytes(parseIpv4ToLong(address)!));
  }
  const bytes = firstBytesOfIpv6(address);
  if (bytes.length < 2) return true;
  if (bytes[0] === 0 && bytes[1] === 0) return true;          // unspecified
  if (bytes[0] === 0 && (bytes[1] & 0xf0) === 0x20) return true; // 2002::/16 6to4 (bytes 0x20,0x02)
  if (bytes[0] === 0x20 && bytes[1] === 0x01) return true;    // 2001:db8::/32 TEST-NET-3 / Teredo 等按段粗判
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (bytes[0] === 0xfc || bytes[0] === 0xfd) return true;    // fc00::/7 unique-local
  if (bytes[0] >= 0xff) return true;                          // multicast/reserved
  // v4-mapped ::ffff:x:x
  if (bytes[0] === 0 && bytes[1] === 0) {
    const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]);
  }
  return false;
}

function assertPublicHttpUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('知识库 URL 解析失败');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`知识库 URL 协议不允许: ${parsed.protocol} (仅支持 http/https)`);
  }
  return parsed;
}

async function assertSafeUrl(url: string): Promise<void> {
  const parsed = assertPublicHttpUrl(url);
  const { hostname } = parsed;
  const ipKind = net.isIP(hostname);
  if (ipKind) {
    if (isBlockedAddress(hostname)) throw new Error(`知识库主机地址不允许: ${hostname}`);
    return;
  }
  if (hostname === 'localhost' || hostname.toLowerCase().endsWith('.localhost')) {
    throw new Error('知识库主机不允许指向 localhost');
  }
  let records: dns.LookupAddress[];
  try {
    records = await dns.promises.lookup(hostname, { all: true });
  } catch {
    throw new Error(`知识库主机无法解析: ${hostname}`);
  }
  if (!records.length) throw new Error(`知识库主机无法解析: ${hostname}`);
  for (const record of records) {
    if (isBlockedAddress(record.address)) {
      throw new Error(`知识库主机解析到受限地址: ${record.address}`);
    }
  }
}

/**
 * 从外部 HTTP 知识库检索 (通用检索协议, 可对接 ima 知识库或其桥接服务).
 * 请求: POST url  Authorization: Bearer <apiKey>
 *       body: { query, kb_id?, top_k }
 * 期望响应: { results: [{ title?, content, score? }] } 或 [{ content }] 数组
 */
async function retrieveFromHttp(
  config: KnowledgeConfig,
  query: string,
  options: KnowledgeRetrieveOptions,
): Promise<KnowledgeHit[]> {
  const http = config.http;
  if (!http?.url) throw new Error('外部知识库未配置 URL');
  const timeoutMs = options.timeoutMs || http.timeoutMs || 8000;
  await assertSafeUrl(http.url);
  const payload: Record<string, unknown> = {
    query,
    top_k: config.topK || 3,
  };
  if (http.kbId) payload.kb_id = http.kbId;
  const request = superagent.post(http.url)
    .timeout({ response: timeoutMs, deadline: timeoutMs })
    .send(payload);
  if (http.apiKeyEncrypted) {
    const apiKey = decrypt(http.apiKeyEncrypted);
    if (apiKey) request.set('Authorization', `Bearer ${apiKey}`);
  }
  const res = await request;
  const body: any = res.body;
  const list: any[] = Array.isArray(body)
    ? body
    : (body?.results || body?.data?.results || body?.data || body?.hits || body?.chunks || []);
  if (!Array.isArray(list)) return [];
  const hits: KnowledgeHit[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const content = String(item.content ?? item.text ?? item.passage ?? item.snippet ?? '');
    if (!content.trim()) continue;
    hits.push({
      title: String(item.title || item.name || '') || '外部知识库片段',
      content: content.trim(),
      score: typeof item.score === 'number' ? item.score : 0,
      source: 'http',
    });
  }
  return hits;
}

export class KnowledgeService {
  constructor(private ctx: Context) {}

  private get model() {
    return this.ctx.get('knowledgeModel') as import('../models/knowledge').KnowledgeModel;
  }

  /**
   * 统一检索入口: 读配置 → 检索 → 渲染成可注入 System Prompt 的参考块.
   * 任何失败都以「无结果」静默降级, 不影响正常对话链路.
   */
  async retrieveBlock(query: string, options: KnowledgeRetrieveOptions = {}): Promise<string> {
    try {
      let config: KnowledgeConfig;
      try {
        config = await this.model.getConfig();
      } catch {
        config = { ...DEFAULT_KNOWLEDGE_CONFIG };
      }
      if (!config.enabled) return '';
      const topK = config.topK || 3;
      const maxChars = config.maxChars || 2000;
      let hits: KnowledgeHit[] = [];
      if (config.mode === 'http') {
        hits = await retrieveFromHttp(config, query, options);
      } else {
        hits = await this.model.search(query, { topK, problemPid: options.problemPid });
      }
      if (!hits.length) return '';
      hits = hits.slice(0, topK);
      const blocks: string[] = [];
      let used = 0;
      for (const hit of hits) {
        const remain = maxChars - used;
        if (remain <= 64) break;
        const excerpt = hit.content.length > remain ? `${hit.content.slice(0, remain)}…` : hit.content;
        blocks.push(`### ${hit.title}\n${excerpt}`);
        used += excerpt.length;
      }
      if (!blocks.length) return '';
      return `${KB_PROMPT_INTRO}\n${blocks.join('\n\n')}`;
    } catch (err) {
      console.warn('[AI-Helper] 知识库检索失败（已降级为无参考）:', err instanceof Error ? err.message : String(err));
      return '';
    }
  }
}
