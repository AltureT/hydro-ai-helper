jest.mock('../../lib/crypto', () => ({
  decrypt: jest.fn((value: string) => `plain:${value}`),
}));

import type { AIConfig, TestdataModelRole } from '../../models/aiConfig';
import {
  createTestdataRoleClientFromConfig,
  findTestdataRoleIdentityConflicts,
  resolveTestdataRoleChain,
  type TestdataModelIdentity,
} from '../../services/testdata/modelRoles';

const ROLES: readonly TestdataModelRole[] = [
  'specPrimary', 'specCritic', 'oracle', 'artifacts', 'verifier', 'adjudicator',
];

function config(overrides: Partial<AIConfig> = {}): AIConfig {
  return {
    _id: 'default',
    configVersion: 3,
    endpoints: [
      {
        id: 'ep-role', name: 'Role Endpoint', apiBaseUrl: 'https://role.invalid/v1',
        apiKeyEncrypted: 'role-key', models: ['role-model'], enabled: true,
      },
      {
        id: 'ep-scenario', name: 'Scenario Endpoint', apiBaseUrl: 'https://scenario.invalid/v1',
        apiKeyEncrypted: 'scenario-key', models: ['scenario-model'], enabled: true,
      },
      {
        id: 'ep-global', name: 'Global Endpoint', apiBaseUrl: 'https://global.invalid/v1',
        apiKeyEncrypted: 'global-key', models: ['global-model'], enabled: true,
      },
    ],
    selectedModels: [{ endpointId: 'ep-global', modelName: 'global-model' }],
    scenarioModels: {
      testdataGeneration: [{ endpointId: 'ep-scenario', modelName: 'scenario-model' }],
    },
    testdataRoleModels: {},
    apiBaseUrl: 'https://legacy.invalid/v1',
    apiKeyEncrypted: 'legacy-key',
    modelName: 'legacy-model',
    rateLimitPerMinute: 5,
    timeoutSeconds: 30,
    updatedAt: new Date('2026-08-20T00:00:00.000Z'),
    ...overrides,
  };
}

describe('test-data model role resolution', () => {
  it.each(ROLES)('uses the configured %s role chain before every fallback', role => {
    const value = config({
      testdataRoleModels: {
        [role]: [{ endpointId: 'ep-role', modelName: 'role-model' }],
      },
    });

    expect(resolveTestdataRoleChain(value, role)).toEqual({
      role,
      source: 'role',
      chain: [{
        endpointId: 'ep-role', endpointName: 'Role Endpoint', modelName: 'role-model',
      }],
    });
  });

  it('falls through role, scenario, global, then legacy without making old configs unusable', () => {
    expect(resolveTestdataRoleChain(config(), 'oracle').source).toBe('scenario');
    expect(resolveTestdataRoleChain(config({
      testdataRoleModels: { oracle: [] },
    }), 'oracle').source).toBe('scenario');
    expect(resolveTestdataRoleChain(config({
      testdataRoleModels: { oracle: [{ endpointId: 'missing', modelName: 'x' }] },
      scenarioModels: { testdataGeneration: [{ endpointId: 'missing', modelName: 'x' }] },
    }), 'oracle').source).toBe('global');
    expect(resolveTestdataRoleChain(config({
      endpoints: [], selectedModels: [], scenarioModels: {}, testdataRoleModels: {},
    }), 'oracle')).toEqual({
      role: 'oracle',
      source: 'legacy',
      chain: [{
        endpointId: 'legacy', endpointName: 'Default Endpoint', modelName: 'legacy-model',
      }],
    });
  });

  it('creates a role client while exposing only the local control-flow identity', async () => {
    const value = config({
      testdataRoleModels: {
        specPrimary: [{ endpointId: 'ep-role', modelName: 'role-model' }],
      },
    });
    const ctx = { get: jest.fn(() => ({ getConfig: jest.fn().mockResolvedValue(value) })) } as never;

    const resolved = await createTestdataRoleClientFromConfig(ctx, 'specPrimary');

    expect(resolved.identity).toEqual({
      endpointId: 'ep-role', endpointName: 'Role Endpoint', modelName: 'role-model',
    });
    expect(resolved.identities).toEqual([resolved.identity]);
    expect(JSON.stringify(resolved.identity)).not.toContain('https://');
    expect(JSON.stringify(resolved.identity)).not.toContain('role-key');
  });

  it.each([
    ['blank URL', { apiBaseUrl: '   ', apiKeyEncrypted: 'role-key' }],
    ['non-HTTP URL', { apiBaseUrl: 'ftp://private.invalid/v1', apiKeyEncrypted: 'role-key' }],
    ['blank encrypted key', { apiBaseUrl: 'https://private.invalid/v1', apiKeyEncrypted: '   ' }],
  ])('falls through a statically invalid role endpoint with %s', async (_label, invalid) => {
    const value = config({
      endpoints: config().endpoints.map(endpoint => endpoint.id === 'ep-role'
        ? { ...endpoint, ...invalid }
        : endpoint),
      testdataRoleModels: {
        oracle: [{ endpointId: 'ep-role', modelName: 'role-model' }],
      },
    });
    const ctx = { get: jest.fn(() => ({ getConfig: jest.fn().mockResolvedValue(value) })) } as never;

    expect(resolveTestdataRoleChain(value, 'oracle').source).toBe('scenario');
    await expect(createTestdataRoleClientFromConfig(ctx, 'oracle')).resolves.toMatchObject({
      source: 'scenario',
      identity: { endpointId: 'ep-scenario', modelName: 'scenario-model' },
    });
  });
});

describe('exact role identity independence', () => {
  const identity = (endpointId: string, modelName: string): TestdataModelIdentity => ({
    endpointId,
    endpointName: `${endpointId}-name`,
    modelName,
  });

  it('flags exact spec and oracle/verifier identity collisions only', () => {
    expect(findTestdataRoleIdentityConflicts({
      specPrimary: identity('ep-a', 'same'),
      specCritic: identity('ep-a', 'same'),
      oracle: identity('ep-b', 'same'),
      verifier: identity('ep-b', 'same'),
    })).toEqual([
      { pair: 'spec', roles: ['specPrimary', 'specCritic'], identity: identity('ep-a', 'same') },
      { pair: 'oracle-verifier', roles: ['oracle', 'verifier'], identity: identity('ep-b', 'same') },
    ]);
  });

  it('does not guess provider family when endpoint or exact model differs', () => {
    expect(findTestdataRoleIdentityConflicts({
      specPrimary: identity('ep-a', 'family-pro'),
      specCritic: identity('ep-b', 'family-pro'),
      oracle: identity('ep-c', 'family-v1'),
      verifier: identity('ep-c', 'family-v2'),
    })).toEqual([]);
  });

});
