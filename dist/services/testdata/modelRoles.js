"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveTestdataRoleChain = resolveTestdataRoleChain;
exports.createTestdataRoleClientFromConfig = createTestdataRoleClientFromConfig;
exports.createTestdataRoleClientsFromConfig = createTestdataRoleClientsFromConfig;
exports.findTestdataRoleIdentityConflicts = findTestdataRoleIdentityConflicts;
const crypto_1 = require("../../lib/crypto");
const openaiClient_1 = require("../openaiClient");
function isHttpUrl(value) {
    if (typeof value !== 'string' || !value.trim())
        return false;
    try {
        const parsed = new URL(value.trim());
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !!parsed.hostname;
    }
    catch {
        return false;
    }
}
function usableEndpoint(endpoint) {
    return !!endpoint
        && endpoint.enabled !== false
        && isHttpUrl(endpoint.apiBaseUrl)
        && typeof endpoint.apiKeyEncrypted === 'string'
        && !!endpoint.apiKeyEncrypted.trim();
}
function validChain(config, chain) {
    if (!Array.isArray(chain) || chain.length === 0)
        return [];
    const identities = [];
    for (const selected of chain) {
        if (!selected || typeof selected.endpointId !== 'string'
            || typeof selected.modelName !== 'string' || !selected.modelName.trim())
            continue;
        const endpoint = (config.endpoints || []).find(item => (item.id === selected.endpointId && item.enabled !== false));
        if (!usableEndpoint(endpoint))
            continue;
        identities.push({
            endpointId: endpoint.id,
            endpointName: endpoint.name,
            modelName: selected.modelName,
        });
    }
    return identities;
}
function candidates(config, role) {
    const values = [
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
function resolveTestdataRoleChain(config, role) {
    return candidates(config, role).find(candidate => candidate.chain.length > 0)
        || { role, source: 'global', chain: [] };
}
function materializeModels(config, resolution) {
    const models = [];
    for (const identity of resolution.chain) {
        if (resolution.source === 'legacy') {
            try {
                const apiKey = (0, crypto_1.decrypt)(config.apiKeyEncrypted || '');
                if (!apiKey.trim())
                    continue;
                models.push({
                    ...identity,
                    apiBaseUrl: config.apiBaseUrl?.trim() || '',
                    apiKey,
                    timeoutSeconds: config.timeoutSeconds || 30,
                });
            }
            catch {
                // Continue to the next compatible source.
            }
            continue;
        }
        const endpoint = (config.endpoints || []).find(item => item.id === identity.endpointId);
        if (!usableEndpoint(endpoint))
            continue;
        try {
            const apiKey = (0, crypto_1.decrypt)(endpoint.apiKeyEncrypted);
            if (!apiKey.trim())
                continue;
            models.push({
                ...identity,
                apiBaseUrl: endpoint.apiBaseUrl.trim(),
                apiKey,
                timeoutSeconds: config.timeoutSeconds || 30,
            });
        }
        catch {
            console.warn(`[TestdataModelRoles] 角色 ${resolution.role} 的端点密钥无法解密，继续兼容回退`);
        }
    }
    return models;
}
async function createTestdataRoleClientFromConfig(ctx, role, existingConfig) {
    const aiConfigModel = ctx.get('aiConfigModel');
    const config = existingConfig ?? await aiConfigModel.getConfig();
    if (!config)
        throw new Error('AI 服务尚未配置，请联系管理员在控制面板中完成配置。');
    for (const resolution of candidates(config, role)) {
        if (resolution.chain.length === 0)
            continue;
        const models = materializeModels(config, resolution);
        if (models.length === 0)
            continue;
        const identities = models.map(({ endpointId, endpointName, modelName }) => ({
            endpointId, endpointName, modelName,
        }));
        return {
            ...resolution,
            chain: identities,
            client: new openaiClient_1.MultiModelClient(models),
            identity: identities[0],
            identities,
        };
    }
    throw new Error('AI 服务配置不完整，请联系管理员检查测试数据角色模型配置。');
}
async function createTestdataRoleClientsFromConfig(ctx, existingConfig) {
    const aiConfigModel = ctx.get('aiConfigModel');
    const config = existingConfig ?? await aiConfigModel.getConfig();
    if (!config)
        throw new Error('AI 服务尚未配置，请联系管理员在控制面板中完成配置。');
    const roles = [
        'specPrimary', 'specCritic', 'oracle', 'artifacts', 'verifier', 'adjudicator',
    ];
    const entries = await Promise.all(roles.map(async (role) => [
        role,
        await createTestdataRoleClientFromConfig(ctx, role, config),
    ]));
    return Object.fromEntries(entries);
}
function sameIdentity(left, right) {
    return !!left && !!right
        && left.endpointId === right.endpointId
        && left.modelName === right.modelName;
}
function findTestdataRoleIdentityConflicts(identities) {
    const pairs = [
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
//# sourceMappingURL=modelRoles.js.map