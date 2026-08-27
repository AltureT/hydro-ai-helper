import type { Context } from 'hydrooj';
import {
  AIConfigModel,
  type AIConfig,
  type SelectedModel,
  type TestdataModelRole,
} from '../../models/aiConfig';
import { decrypt } from '../../lib/crypto';
import { MultiModelClient, type ResolvedModelConfig } from '../openaiClient';

export interface TestdataModelIdentity {
  endpointId: string;
  endpointName: string;
  modelName: string;
}

export type TestdataRoleChainSource = 'role' | 'scenario' | 'global' | 'legacy';

export interface ResolvedTestdataRoleChain {
  role: TestdataModelRole;
  source: TestdataRoleChainSource;
  chain: TestdataModelIdentity[];
}

export interface TestdataRoleClient extends ResolvedTestdataRoleChain {
  client: MultiModelClient;
  identity: TestdataModelIdentity;
  identities: TestdataModelIdentity[];
}

export type TestdataRoleClients = Partial<Record<TestdataModelRole, TestdataRoleClient>>;

export interface TestdataRoleIdentityConflict {
  pair: 'spec' | 'oracle-verifier';
  roles: [TestdataModelRole, TestdataModelRole];
  identity: TestdataModelIdentity;
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const parsed = new URL(value.trim());
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !!parsed.hostname;
  } catch {
    return false;
  }
}

function usableEndpoint(endpoint: AIConfig['endpoints'][number] | undefined): boolean {
  return !!endpoint
    && endpoint.enabled !== false
    && isHttpUrl(endpoint.apiBaseUrl)
    && typeof endpoint.apiKeyEncrypted === 'string'
    && !!endpoint.apiKeyEncrypted.trim();
}

function validChain(config: AIConfig, chain: SelectedModel[] | undefined): TestdataModelIdentity[] {
  if (!Array.isArray(chain) || chain.length === 0) return [];
  const identities: TestdataModelIdentity[] = [];
  for (const selected of chain) {
    if (!selected || typeof selected.endpointId !== 'string'
      || typeof selected.modelName !== 'string' || !selected.modelName.trim()) continue;
    const endpoint = (config.endpoints || []).find(item => (
      item.id === selected.endpointId && item.enabled !== false
    ));
    if (!usableEndpoint(endpoint)) continue;
    identities.push({
      endpointId: endpoint.id,
      endpointName: endpoint.name,
      modelName: selected.modelName,
    });
  }
  return identities;
}

function candidates(config: AIConfig, role: TestdataModelRole): ResolvedTestdataRoleChain[] {
  const values: ResolvedTestdataRoleChain[] = [
    { role, source: 'role', chain: validChain(config, config.testdataRoleModels?.[role]) },
    {
      role,
      source: 'scenario',
      chain: validChain(config, config.scenarioModels?.testdataGeneration),
    },
    { role, source: 'global', chain: validChain(config, config.selectedModels) },
  ];
  if (isHttpUrl(config.apiBaseUrl)
    && config.modelName?.trim()
    && config.apiKeyEncrypted?.trim()) {
    values.push({
      role,
      source: 'legacy',
      chain: [{
        endpointId: 'legacy',
        endpointName: 'Default Endpoint',
        modelName: config.modelName,
      }],
    });
  }
  return values;
}

export function resolveTestdataRoleChain(
  config: AIConfig,
  role: TestdataModelRole,
): ResolvedTestdataRoleChain {
  return candidates(config, role).find(candidate => candidate.chain.length > 0)
    || { role, source: 'global', chain: [] };
}

function materializeModels(
  config: AIConfig,
  resolution: ResolvedTestdataRoleChain,
): ResolvedModelConfig[] {
  const models: ResolvedModelConfig[] = [];
  for (const identity of resolution.chain) {
    if (resolution.source === 'legacy') {
      try {
        const apiKey = decrypt(config.apiKeyEncrypted || '');
        if (!apiKey.trim()) continue;
        models.push({
          ...identity,
          apiBaseUrl: config.apiBaseUrl?.trim() || '',
          apiKey,
          timeoutSeconds: config.timeoutSeconds || 30,
        });
      } catch {
        // Continue to the next compatible source.
      }
      continue;
    }
    const endpoint = (config.endpoints || []).find(item => item.id === identity.endpointId);
    if (!usableEndpoint(endpoint)) continue;
    try {
      const apiKey = decrypt(endpoint.apiKeyEncrypted);
      if (!apiKey.trim()) continue;
      models.push({
        ...identity,
        apiBaseUrl: endpoint.apiBaseUrl.trim(),
        apiKey,
        timeoutSeconds: config.timeoutSeconds || 30,
      });
    } catch {
      console.warn(`[TestdataModelRoles] 角色 ${resolution.role} 的端点密钥无法解密，继续兼容回退`);
    }
  }
  return models;
}

export async function createTestdataRoleClientFromConfig(
  ctx: Context,
  role: TestdataModelRole,
  existingConfig?: AIConfig | null,
): Promise<TestdataRoleClient> {
  const aiConfigModel: AIConfigModel = ctx.get('aiConfigModel');
  const config = existingConfig ?? await aiConfigModel.getConfig();
  if (!config) throw new Error('AI 服务尚未配置，请联系管理员在控制面板中完成配置。');

  for (const resolution of candidates(config, role)) {
    if (resolution.chain.length === 0) continue;
    const models = materializeModels(config, resolution);
    if (models.length === 0) continue;
    const identities = models.map(({ endpointId, endpointName, modelName }) => ({
      endpointId, endpointName, modelName,
    }));
    return {
      ...resolution,
      chain: identities,
      client: new MultiModelClient(models),
      identity: identities[0],
      identities,
    };
  }
  throw new Error('AI 服务配置不完整，请联系管理员检查测试数据角色模型配置。');
}

export async function createTestdataRoleClientsFromConfig(
  ctx: Context,
  existingConfig?: AIConfig | null,
): Promise<TestdataRoleClients> {
  const aiConfigModel: AIConfigModel = ctx.get('aiConfigModel');
  const config = existingConfig ?? await aiConfigModel.getConfig();
  if (!config) throw new Error('AI 服务尚未配置，请联系管理员在控制面板中完成配置。');
  const roles: TestdataModelRole[] = [
    'specPrimary', 'specCritic', 'oracle', 'artifacts', 'verifier', 'adjudicator',
  ];
  const entries = await Promise.all(roles.map(async role => [
    role,
    await createTestdataRoleClientFromConfig(ctx, role, config),
  ] as const));
  return Object.fromEntries(entries) as TestdataRoleClients;
}

function sameIdentity(left: TestdataModelIdentity | undefined, right: TestdataModelIdentity | undefined): boolean {
  return !!left && !!right
    && left.endpointId === right.endpointId
    && left.modelName === right.modelName;
}

export function findTestdataRoleIdentityConflicts(
  identities: Partial<Record<TestdataModelRole,
    TestdataModelIdentity | readonly TestdataModelIdentity[] | undefined>>,
): TestdataRoleIdentityConflict[] {
  const pairs: Array<{
    pair: TestdataRoleIdentityConflict['pair'];
    roles: TestdataRoleIdentityConflict['roles'];
  }> = [
    { pair: 'spec', roles: ['specPrimary', 'specCritic'] },
    { pair: 'oracle-verifier', roles: ['oracle', 'verifier'] },
  ];
  return pairs.flatMap(({ pair, roles }) => {
    const values = roles.map(role => {
      const value = identities[role];
      return Array.isArray(value) ? value : value ? [value] : [];
    });
    const shared = values[0].find(left => values[1].some(right => sameIdentity(left, right)));
    return shared
      ? [{ pair, roles, identity: shared }]
      : [];
  });
}
