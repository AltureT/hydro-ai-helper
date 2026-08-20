"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildConstraintProbes = buildConstraintProbes;
const crypto_1 = require("crypto");
const MAX_PROBE_INPUT_BYTES = 256 * 1024;
const MAX_PROBE_RECIPES = 64;
function canonicalize(value) {
    if (Array.isArray(value))
        return value.map(item => canonicalize(item));
    if (value && typeof value === 'object') {
        const record = value;
        return Object.fromEntries(Object.keys(record)
            .filter(key => record[key] !== undefined)
            .sort()
            .map(key => [key, canonicalize(record[key])]));
    }
    return value;
}
function canonicalJson(value) {
    return JSON.stringify(canonicalize(value));
}
function sha256(value) {
    return (0, crypto_1.createHash)('sha256').update(value, 'utf8').digest('hex');
}
function normalizeInput(input) {
    const normalized = input.replace(/\r\n?/g, '\n');
    if (normalized.length === 0 || normalized.endsWith('\n'))
        return normalized;
    return `${normalized}\n`;
}
function compareStrings(left, right) {
    if (left < right)
        return -1;
    if (left > right)
        return 1;
    return 0;
}
function compareIndices(source, left, right) {
    if (source !== 'sample') {
        const leftNumber = typeof left === 'number' ? left : Number(left);
        const rightNumber = typeof right === 'number' ? right : Number(right);
        if (Number.isSafeInteger(leftNumber) && Number.isSafeInteger(rightNumber)) {
            return leftNumber - rightNumber;
        }
    }
    return compareStrings(String(left), String(right));
}
function orderedSeeds(seeds) {
    const sourceOrder = {
        formal: 0,
        sample: 1,
        stress: 2,
    };
    return seeds.map(seed => ({ ...seed }))
        .sort((left, right) => sourceOrder[left.source] - sourceOrder[right.source]
        || compareIndices(left.source, left.index, right.index)
        || (left.subtaskId ?? -1) - (right.subtaskId ?? -1)
        || compareStrings(normalizeInput(left.input), normalizeInput(right.input)));
}
function findTarget(spec, targetId) {
    const constraint = spec.constraints.find(item => item.id === targetId);
    if (constraint?.machineCheckable) {
        return {
            id: constraint.id,
            kind: 'constraint',
            expression: constraint.expression,
            ...(constraint.scope === 'global' ? {} : { subtaskId: constraint.scope.subtaskId }),
        };
    }
    const invariant = spec.invariants.find(item => item.id === targetId);
    if (invariant?.machineCheckable) {
        return { id: invariant.id, kind: 'invariant', expression: invariant.expression };
    }
    return undefined;
}
function selectSeed(seeds, target) {
    if (target.subtaskId !== undefined) {
        return seeds.find(seed => seed.source === 'formal' && seed.subtaskId === target.subtaskId);
    }
    return seeds[0];
}
function parseLocation(encoding) {
    const match = /^line:([1-9]\d*) token:([1-9]\d*)$/.exec(encoding);
    if (!match)
        return undefined;
    return { line: Number(match[1]), token: Number(match[2]) };
}
function scalarLocationIsUnambiguous(spec, fieldId, location) {
    return !spec.inputFields.some(field => {
        if (field.id === fieldId)
            return false;
        const otherLocation = parseLocation(field.encoding);
        if (otherLocation) {
            return otherLocation.line === location.line && otherLocation.token === location.token;
        }
        const otherRange = parseTokenRange(field.encoding);
        return otherRange?.line === location.line && location.token >= otherRange.startToken;
    });
}
function replaceToken(input, location, replacement) {
    const lines = input.split('\n');
    const line = lines[location.line - 1];
    if (line === undefined)
        return undefined;
    const tokens = [...line.matchAll(/\S+/g)];
    const token = tokens[location.token - 1];
    if (!token || token.index === undefined)
        return undefined;
    lines[location.line - 1] = `${line.slice(0, token.index)}${replacement}${line.slice(token.index + token[0].length)}`;
    return { input: lines.join('\n'), position: location };
}
function removeToken(input, location) {
    const lines = input.split('\n');
    const line = lines[location.line - 1];
    if (line === undefined)
        return undefined;
    const tokens = [...line.matchAll(/\S+/g)];
    const token = tokens[location.token - 1];
    if (!token || token.index === undefined)
        return undefined;
    const previous = tokens[location.token - 2];
    const start = previous && previous.index !== undefined
        ? previous.index + previous[0].length
        : token.index;
    const end = token.index + token[0].length;
    lines[location.line - 1] = `${line.slice(0, start)}${line.slice(end)}`;
    return { input: lines.join('\n'), position: location };
}
function parseTokenRange(encoding) {
    const match = /^line:([1-9]\d*) tokens:([1-9]\d*)\.\.([A-Za-z][A-Za-z0-9_.:-]{0,63})$/
        .exec(encoding);
    if (!match)
        return undefined;
    return {
        line: Number(match[1]),
        startToken: Number(match[2]),
        countFieldId: match[3],
    };
}
function tokenValuesAtLine(input, lineNumber) {
    const line = input.split('\n')[lineNumber - 1];
    return line === undefined ? undefined : [...line.matchAll(/\S+/g)].map(match => match[0]);
}
function integerBounds(expression, fieldId) {
    const escaped = fieldId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const range = new RegExp(`^(-?\\d+) <= ${escaped} <= (-?\\d+)$`).exec(expression);
    if (range)
        return { min: Number(range[1]), max: Number(range[2]) };
    const lower = new RegExp(`^${escaped} >= (-?\\d+)$`).exec(expression);
    if (lower)
        return { min: Number(lower[1]) };
    const upper = new RegExp(`^${escaped} <= (-?\\d+)$`).exec(expression);
    if (upper)
        return { max: Number(upper[1]) };
    return {};
}
function constructIntegerMutation(input, spec, target, fieldId, encoding, kind) {
    const location = parseLocation(encoding);
    if (!location)
        return 'UNPARSEABLE_ENCODING';
    if (!scalarLocationIsUnambiguous(spec, fieldId, location))
        return 'UNPARSEABLE_ENCODING';
    const bounds = integerBounds(target.expression, fieldId);
    const boundary = kind === 'integer-below-min' ? bounds.min : bounds.max;
    if (!Number.isSafeInteger(boundary))
        return 'UNSUPPORTED_TARGET';
    const replacement = kind === 'integer-below-min'
        ? boundary - 1
        : boundary + 1;
    if (!Number.isSafeInteger(replacement))
        return 'UNSUPPORTED_TARGET';
    return replaceToken(input, location, String(replacement)) || 'MUTATION_NOT_ISOLATED';
}
function resolveSequenceLayout(input, spec, fieldId) {
    const field = spec.inputFields.find(item => item.id === fieldId);
    if (!field)
        return 'INVALID_RECIPE';
    const range = parseTokenRange(field.encoding);
    if (!range)
        return 'UNPARSEABLE_ENCODING';
    if (!field.dependsOn?.includes(range.countFieldId))
        return 'DEPENDENCY_NOT_RESOLVED';
    const countField = spec.inputFields.find(item => item.id === range.countFieldId);
    if (!countField || countField.type !== 'integer')
        return 'DEPENDENCY_NOT_RESOLVED';
    const countLocation = parseLocation(countField.encoding);
    if (!countLocation)
        return 'DEPENDENCY_NOT_RESOLVED';
    if (!scalarLocationIsUnambiguous(spec, countField.id, countLocation)) {
        return 'UNPARSEABLE_ENCODING';
    }
    const countTokens = tokenValuesAtLine(input, countLocation.line);
    const countRaw = countTokens?.[countLocation.token - 1];
    if (!countRaw || !/^(0|[1-9]\d*)$/.test(countRaw))
        return 'DEPENDENCY_NOT_RESOLVED';
    const count = Number(countRaw);
    if (!Number.isSafeInteger(count))
        return 'DEPENDENCY_NOT_RESOLVED';
    const lineTokens = tokenValuesAtLine(input, range.line);
    if (!lineTokens || range.startToken + count - 1 !== lineTokens.length) {
        return 'MUTATION_NOT_ISOLATED';
    }
    const values = lineTokens.slice(range.startToken - 1);
    if (values.length !== count || values.length === 0)
        return 'MUTATION_NOT_ISOLATED';
    const finalToken = range.startToken + values.length - 1;
    const overlaps = spec.inputFields.some(other => {
        if (other.id === fieldId)
            return false;
        const otherLocation = parseLocation(other.encoding);
        if (otherLocation) {
            return otherLocation.line === range.line
                && otherLocation.token >= range.startToken
                && otherLocation.token <= finalToken;
        }
        const otherRange = parseTokenRange(other.encoding);
        return otherRange?.line === range.line;
    });
    if (overlaps)
        return 'UNPARSEABLE_ENCODING';
    return {
        line: range.line,
        startToken: range.startToken,
        values,
        countFieldId: range.countFieldId,
    };
}
function constructSequenceMutation(input, spec, target, fieldId, kind) {
    const layout = resolveSequenceLayout(input, spec, fieldId);
    if (typeof layout === 'string')
        return layout;
    const escapedField = fieldId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedCount = layout.countFieldId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (kind === 'array-length-mismatch') {
        if (!new RegExp(`^length\\(${escapedField}\\) = ${escapedCount}$`)
            .test(target.expression))
            return 'UNSUPPORTED_TARGET';
        return removeToken(input, {
            line: layout.line,
            token: layout.startToken + layout.values.length - 1,
        }) || 'MUTATION_NOT_ISOLATED';
    }
    if (layout.values.length < 2)
        return 'MUTATION_NOT_ISOLATED';
    if (kind === 'duplicate-element') {
        if (!new RegExp(`^allDistinct\\(${escapedField}\\)$`).test(target.expression)) {
            return 'UNSUPPORTED_TARGET';
        }
        if (new Set(layout.values).size !== layout.values.length
            || layout.values[0] === layout.values[1])
            return 'MUTATION_NOT_ISOLATED';
        return replaceToken(input, {
            line: layout.line,
            token: layout.startToken + 1,
        }, layout.values[0]) || 'MUTATION_NOT_ISOLATED';
    }
    if (!new RegExp(`^permutation\\(${escapedField}, 1\\.\\.${escapedCount}\\)$`)
        .test(target.expression))
        return 'UNSUPPORTED_TARGET';
    const replacement = layout.values[layout.values.length - 2];
    if (replacement === layout.values[layout.values.length - 1])
        return 'MUTATION_NOT_ISOLATED';
    return replaceToken(input, {
        line: layout.line,
        token: layout.startToken + layout.values.length - 1,
    }, replacement) || 'MUTATION_NOT_ISOLATED';
}
function parseNonNegativeInteger(value) {
    if (!value || !/^(0|[1-9]\d*)$/.test(value))
        return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
}
function structuralPredicate(expression, fieldId, vertexFieldId) {
    const escapedField = fieldId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedVertexField = vertexFieldId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`^(simpleGraph|connected|tree|dag)\\(${escapedField}, vertices=(0\\.\\.${escapedVertexField}-1|1\\.\\.${escapedVertexField})\\)$`).exec(expression);
    if (!match)
        return undefined;
    return {
        predicate: match[1],
        domainMin: match[2].startsWith('0') ? 0 : 1,
    };
}
function parseEdgeList(input, spec, target, fieldId, requireLegalTreeCount) {
    const field = spec.inputFields.find(item => item.id === fieldId);
    if (!field || (field.type !== 'graph' && field.type !== 'tree'))
        return 'INVALID_RECIPE';
    const graphEncoding = /^lines:2\.\.([A-Za-z][A-Za-z0-9_.:-]{0,63})\+1 tokens:1,2$/
        .exec(field.encoding);
    const treeEncoding = /^lines:2\.\.([A-Za-z][A-Za-z0-9_.:-]{0,63}) tokens:1,2$/
        .exec(field.encoding);
    if ((field.type === 'graph' && !graphEncoding) || (field.type === 'tree' && !treeEncoding)) {
        return 'UNPARSEABLE_ENCODING';
    }
    const edgeCountFieldId = graphEncoding?.[1];
    const vertexFieldId = treeEncoding?.[1]
        || field.dependsOn?.find(dependency => dependency !== edgeCountFieldId);
    if (!vertexFieldId || !field.dependsOn?.includes(vertexFieldId)
        || (edgeCountFieldId && !field.dependsOn.includes(edgeCountFieldId))) {
        return 'DEPENDENCY_NOT_RESOLVED';
    }
    const vertexField = spec.inputFields.find(item => item.id === vertexFieldId);
    const vertexLocation = vertexField && parseLocation(vertexField.encoding);
    if (!vertexField || vertexField.type !== 'integer' || !vertexLocation
        || vertexLocation.line !== 1 || vertexLocation.token !== 1) {
        return 'DEPENDENCY_NOT_RESOLVED';
    }
    if (!scalarLocationIsUnambiguous(spec, vertexField.id, vertexLocation)) {
        return 'UNPARSEABLE_ENCODING';
    }
    let edgeCountLocation;
    if (edgeCountFieldId) {
        const edgeCountField = spec.inputFields.find(item => item.id === edgeCountFieldId);
        edgeCountLocation = edgeCountField && parseLocation(edgeCountField.encoding);
        if (!edgeCountField || edgeCountField.type !== 'integer' || !edgeCountLocation
            || edgeCountLocation.line !== 1 || edgeCountLocation.token !== 2) {
            return 'DEPENDENCY_NOT_RESOLVED';
        }
        if (!scalarLocationIsUnambiguous(spec, edgeCountField.id, edgeCountLocation)) {
            return 'UNPARSEABLE_ENCODING';
        }
    }
    const declaredPredicate = structuralPredicate(target.expression, fieldId, vertexFieldId);
    if (!declaredPredicate)
        return 'UNSUPPORTED_TARGET';
    const lines = input.endsWith('\n') ? input.slice(0, -1).split('\n') : input.split('\n');
    const header = lines[0] === undefined ? [] : [...lines[0].matchAll(/\S+/g)].map(item => item[0]);
    if (header.length !== (edgeCountFieldId ? 2 : 1))
        return 'MUTATION_NOT_ISOLATED';
    const vertexCount = parseNonNegativeInteger(header[0]);
    const edgeCount = edgeCountFieldId ? parseNonNegativeInteger(header[1]) : undefined;
    if (vertexCount === undefined || vertexCount === 0
        || (edgeCountFieldId && edgeCount === undefined))
        return 'MUTATION_NOT_ISOLATED';
    const edgeLines = lines.slice(1);
    if (edgeCount !== undefined && edgeLines.length !== edgeCount) {
        return 'MUTATION_NOT_ISOLATED';
    }
    if (field.type === 'tree' && requireLegalTreeCount && edgeLines.length !== vertexCount - 1) {
        return 'MUTATION_NOT_ISOLATED';
    }
    const maxVertex = declaredPredicate.domainMin === 0 ? vertexCount - 1 : vertexCount;
    const edges = [];
    for (const line of edgeLines) {
        const tokens = [...line.matchAll(/\S+/g)].map(item => item[0]);
        if (tokens.length !== 2)
            return 'MUTATION_NOT_ISOLATED';
        const left = /^-?(0|[1-9]\d*)$/.test(tokens[0]) ? Number(tokens[0]) : NaN;
        const right = /^-?(0|[1-9]\d*)$/.test(tokens[1]) ? Number(tokens[1]) : NaN;
        if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)
            || left < declaredPredicate.domainMin || right < declaredPredicate.domainMin
            || left > maxVertex || right > maxVertex)
            return 'MUTATION_NOT_ISOLATED';
        edges.push([left, right]);
    }
    return {
        vertexCount,
        ...(edgeCount === undefined ? {} : { edgeCount }),
        domainMin: declaredPredicate.domainMin,
        edges,
        lines,
    };
}
function undirectedEdgeKey(edge) {
    return edge[0] < edge[1] ? `${edge[0]}:${edge[1]}` : `${edge[1]}:${edge[0]}`;
}
function hasSelfLoop(edges) {
    return edges.some(([left, right]) => left === right);
}
function hasDuplicateEdge(edges, directed) {
    const keys = edges.map(edge => directed ? `${edge[0]}:${edge[1]}` : undirectedEdgeKey(edge));
    return new Set(keys).size !== keys.length;
}
function isConnected(layout) {
    const start = layout.domainMin;
    const seen = new Set([start]);
    const pending = [start];
    while (pending.length > 0) {
        const vertex = pending.pop();
        for (const [left, right] of layout.edges) {
            const next = left === vertex ? right : right === vertex ? left : undefined;
            if (next !== undefined && !seen.has(next)) {
                seen.add(next);
                pending.push(next);
            }
        }
    }
    return seen.size === layout.vertexCount;
}
function hasUndirectedCycle(layout) {
    const parent = new Map();
    const find = (vertex) => {
        const current = parent.get(vertex);
        if (current === undefined) {
            parent.set(vertex, vertex);
            return vertex;
        }
        if (current === vertex)
            return vertex;
        const root = find(current);
        parent.set(vertex, root);
        return root;
    };
    for (const [left, right] of layout.edges) {
        const leftRoot = find(left);
        const rightRoot = find(right);
        if (leftRoot === rightRoot)
            return true;
        parent.set(leftRoot, rightRoot);
    }
    return false;
}
function hasDirectedCycle(layout) {
    const adjacency = new Map();
    for (const [left, right] of layout.edges) {
        const neighbours = adjacency.get(left) || [];
        neighbours.push(right);
        adjacency.set(left, neighbours);
    }
    const visiting = new Set();
    const visited = new Set();
    const visit = (vertex) => {
        if (visiting.has(vertex))
            return true;
        if (visited.has(vertex))
            return false;
        visiting.add(vertex);
        for (const neighbour of adjacency.get(vertex) || []) {
            if (visit(neighbour))
                return true;
        }
        visiting.delete(vertex);
        visited.add(vertex);
        return false;
    };
    for (let offset = 0; offset < layout.vertexCount; offset++) {
        if (visit(layout.domainMin + offset))
            return true;
    }
    return false;
}
function isSimpleUndirected(layout) {
    return !hasSelfLoop(layout.edges) && !hasDuplicateEdge(layout.edges, false);
}
function isTree(layout) {
    return layout.edges.length === layout.vertexCount - 1
        && isSimpleUndirected(layout)
        && isConnected(layout)
        && !hasUndirectedCycle(layout);
}
function replaceEdgeLine(input, line, replacement) {
    const first = replaceToken(input, { line, token: 1 }, String(replacement[0]));
    const second = first && replaceToken(first.input, { line, token: 2 }, String(replacement[1]));
    return second && { input: second.input, position: { line, token: 1 } };
}
function removeLine(input, line) {
    const lines = input.split('\n');
    if (line < 1 || line >= lines.length)
        return undefined;
    lines.splice(line - 1, 1);
    return { input: lines.join('\n'), position: { line, token: 1 } };
}
function appendEdgeLine(input, edge, line) {
    const lines = input.split('\n');
    lines.splice(lines.length - 1, 0, `${edge[0]} ${edge[1]}`);
    return { input: lines.join('\n'), position: { line, token: 1 } };
}
function constructStructuralMutation(input, spec, target, fieldId, kind) {
    const source = parseEdgeList(input, spec, target, fieldId, true);
    if (typeof source === 'string')
        return source;
    const expectedPredicate = kind === 'graph-self-loop' || kind === 'graph-duplicate-edge'
        ? 'simpleGraph'
        : kind === 'graph-disconnected' ? 'connected'
            : kind === 'tree-missing-edge' || kind === 'tree-cycle' ? 'tree' : 'dag';
    const field = spec.inputFields.find(item => item.id === fieldId);
    const vertexFieldId = field.type === 'tree'
        ? /^lines:2\.\.([A-Za-z][A-Za-z0-9_.:-]{0,63}) tokens:1,2$/.exec(field.encoding)?.[1]
        : field.dependsOn?.find(dependency => dependency
            !== /^lines:2\.\.([A-Za-z][A-Za-z0-9_.:-]{0,63})\+1 tokens:1,2$/
                .exec(field.encoding)?.[1]);
    const declared = vertexFieldId
        && structuralPredicate(target.expression, fieldId, vertexFieldId);
    if (!declared || declared.predicate !== expectedPredicate)
        return 'UNSUPPORTED_TARGET';
    const sourceValid = expectedPredicate === 'simpleGraph' ? isSimpleUndirected(source)
        : expectedPredicate === 'connected' ? isSimpleUndirected(source) && isConnected(source)
            : expectedPredicate === 'tree' ? isTree(source)
                : !hasSelfLoop(source.edges) && !hasDuplicateEdge(source.edges, true)
                    && !hasDirectedCycle(source);
    if (!sourceValid)
        return 'MUTATION_NOT_ISOLATED';
    let mutation;
    if (kind === 'graph-self-loop') {
        const first = source.edges[0];
        mutation = first && replaceToken(input, { line: 2, token: 2 }, String(first[0]));
    }
    else if (kind === 'graph-duplicate-edge') {
        mutation = source.edges.length >= 2 ? replaceEdgeLine(input, 3, source.edges[0]) : undefined;
    }
    else if (kind === 'graph-disconnected') {
        const removed = removeLine(input, source.lines.length);
        const decremented = source.edgeCount !== undefined
            && replaceToken(input, { line: 1, token: 2 }, String(source.edgeCount - 1));
        mutation = removed && decremented && removeLine(decremented.input, source.lines.length);
    }
    else if (kind === 'tree-missing-edge') {
        mutation = removeLine(input, source.lines.length);
    }
    else if (kind === 'tree-cycle') {
        const lastEdge = source.edges[source.edges.length - 1];
        mutation = lastEdge && replaceEdgeLine(input, source.lines.length, [lastEdge[0], source.domainMin]);
    }
    else {
        const lastVertex = source.domainMin + source.vertexCount - 1;
        const incremented = source.edgeCount !== undefined
            && replaceToken(input, { line: 1, token: 2 }, String(source.edgeCount + 1));
        mutation = incremented
            ? appendEdgeLine(incremented.input, [lastVertex, source.domainMin], source.lines.length + 1)
            : undefined;
    }
    if (!mutation)
        return 'MUTATION_NOT_ISOLATED';
    const mutated = parseEdgeList(mutation.input, spec, target, fieldId, kind !== 'tree-missing-edge');
    if (typeof mutated === 'string')
        return 'MUTATION_NOT_ISOLATED';
    const isolated = kind === 'graph-self-loop'
        ? hasSelfLoop(mutated.edges) && !hasDuplicateEdge(mutated.edges, false)
        : kind === 'graph-duplicate-edge'
            ? !hasSelfLoop(mutated.edges) && hasDuplicateEdge(mutated.edges, false)
            : kind === 'graph-disconnected'
                ? isSimpleUndirected(mutated) && !isConnected(mutated)
                : kind === 'tree-missing-edge'
                    ? mutated.edges.length === mutated.vertexCount - 2
                        && isSimpleUndirected(mutated) && !hasUndirectedCycle(mutated)
                    : kind === 'tree-cycle'
                        ? mutated.edges.length === mutated.vertexCount - 1
                            && isSimpleUndirected(mutated) && hasUndirectedCycle(mutated)
                        : !hasSelfLoop(mutated.edges) && !hasDuplicateEdge(mutated.edges, true)
                            && hasDirectedCycle(mutated);
    return isolated ? mutation : 'MUTATION_NOT_ISOLATED';
}
function expressionReferencesField(expression, fieldId) {
    const escaped = fieldId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9_.:-])${escaped}($|[^A-Za-z0-9_.:-])`)
        .test(expression);
}
function intersectBounds(current, next) {
    const min = next.min === undefined
        ? current.min : current.min === undefined ? next.min : Math.max(current.min, next.min);
    const max = next.max === undefined
        ? current.max : current.max === undefined ? next.max : Math.min(current.max, next.max);
    if ((min !== undefined && !Number.isSafeInteger(min))
        || (max !== undefined && !Number.isSafeInteger(max))
        || (min !== undefined && max !== undefined && min > max))
        return undefined;
    return {
        ...(min === undefined ? {} : { min }),
        ...(max === undefined ? {} : { max }),
    };
}
function resolveArgumentBounds(spec, target, fieldId) {
    let all = {};
    let nonTarget = {};
    let targetBounds;
    let recognizedCount = 0;
    for (const constraint of spec.constraints) {
        const applicable = constraint.scope === 'global'
            || (target.subtaskId !== undefined
                && constraint.scope.subtaskId === target.subtaskId);
        if (!applicable)
            continue;
        const bounds = integerBounds(constraint.expression, fieldId);
        const recognized = bounds.min !== undefined || bounds.max !== undefined;
        if (!recognized) {
            if (expressionReferencesField(constraint.expression, fieldId)) {
                return 'MUTATION_NOT_ISOLATED';
            }
            continue;
        }
        recognizedCount += 1;
        const nextAll = intersectBounds(all, bounds);
        if (!nextAll)
            return 'MUTATION_NOT_ISOLATED';
        all = nextAll;
        if (target.kind === 'constraint' && constraint.id === target.id) {
            if (targetBounds)
                return 'MUTATION_NOT_ISOLATED';
            targetBounds = bounds;
        }
        else {
            const nextNonTarget = intersectBounds(nonTarget, bounds);
            if (!nextNonTarget)
                return 'MUTATION_NOT_ISOLATED';
            nonTarget = nextNonTarget;
        }
    }
    if (recognizedCount === 0)
        return 'UNSUPPORTED_TARGET';
    if (target.kind === 'constraint' && !targetBounds)
        return 'UNSUPPORTED_TARGET';
    return {
        all,
        nonTarget,
        ...(targetBounds ? { target: targetBounds } : {}),
    };
}
function valueSatisfiesBounds(value, bounds) {
    return Number.isSafeInteger(value)
        && (bounds.min === undefined || value >= bounds.min)
        && (bounds.max === undefined || value <= bounds.max);
}
function findMissingValue(present, original, bounds) {
    const preferred = [original + 1, original - 1, bounds.min, bounds.max, 0]
        .filter((value) => Number.isSafeInteger(value));
    const direct = preferred.find(value => valueSatisfiesBounds(value, bounds)
        && !present.has(value));
    if (direct !== undefined)
        return direct;
    const orderedPresent = [...present]
        .filter(value => valueSatisfiesBounds(value, bounds))
        .sort((left, right) => left - right);
    if (bounds.min !== undefined) {
        let candidate = bounds.min;
        for (const value of orderedPresent) {
            if (value < candidate)
                continue;
            if (value > candidate)
                break;
            candidate += 1;
            if (!Number.isSafeInteger(candidate))
                return undefined;
        }
        if (valueSatisfiesBounds(candidate, bounds) && !present.has(candidate))
            return candidate;
    }
    if (bounds.max !== undefined) {
        let candidate = bounds.max;
        for (let index = orderedPresent.length - 1; index >= 0; index--) {
            const value = orderedPresent[index];
            if (value > candidate)
                continue;
            if (value < candidate)
                break;
            candidate -= 1;
            if (!Number.isSafeInteger(candidate))
                return undefined;
        }
        if (valueSatisfiesBounds(candidate, bounds) && !present.has(candidate))
            return candidate;
    }
    return undefined;
}
function findTargetViolation(target, nonTarget) {
    if (target.max !== undefined && target.max < Number.MAX_SAFE_INTEGER) {
        const candidate = Math.max(target.max + 1, nonTarget.min ?? Number.MIN_SAFE_INTEGER);
        if (valueSatisfiesBounds(candidate, nonTarget)
            && !valueSatisfiesBounds(candidate, target))
            return candidate;
    }
    if (target.min !== undefined && target.min > Number.MIN_SAFE_INTEGER) {
        const candidate = Math.min(target.min - 1, nonTarget.max ?? Number.MAX_SAFE_INTEGER);
        if (valueSatisfiesBounds(candidate, nonTarget)
            && !valueSatisfiesBounds(candidate, target))
            return candidate;
    }
    return undefined;
}
function parseOperations(input, spec) {
    const operationFields = spec.inputFields.filter(field => field.type === 'operations');
    if (operationFields.length !== 1)
        return 'UNPARSEABLE_ENCODING';
    const operationField = operationFields[0];
    const encoding = /^lines:2\.\.([A-Za-z][A-Za-z0-9_.:-]{0,63})\+1 operations$/
        .exec(operationField.encoding);
    if (!encoding)
        return 'UNPARSEABLE_ENCODING';
    const countFieldId = encoding[1];
    if (!operationField.dependsOn?.includes(countFieldId))
        return 'DEPENDENCY_NOT_RESOLVED';
    const countField = spec.inputFields.find(field => field.id === countFieldId);
    const countLocation = countField && parseLocation(countField.encoding);
    if (!countField || countField.type !== 'integer' || !countLocation
        || countLocation.line !== 1 || countLocation.token !== 1) {
        return 'DEPENDENCY_NOT_RESOLVED';
    }
    if (!scalarLocationIsUnambiguous(spec, countField.id, countLocation)) {
        return 'UNPARSEABLE_ENCODING';
    }
    const definitions = spec.operations || [];
    if (new Set(definitions.map(operation => operation.name)).size !== definitions.length) {
        return 'UNPARSEABLE_ENCODING';
    }
    const byName = new Map(definitions.map(operation => [operation.name, operation]));
    const lines = input.endsWith('\n') ? input.slice(0, -1).split('\n') : input.split('\n');
    const header = lines[0] === undefined ? [] : [...lines[0].matchAll(/\S+/g)].map(item => item[0]);
    const count = header.length === 1 ? parseNonNegativeInteger(header[0]) : undefined;
    if (count === undefined || lines.length !== count + 1)
        return 'MUTATION_NOT_ISOLATED';
    const parsed = [];
    for (let index = 1; index < lines.length; index++) {
        const tokens = [...lines[index].matchAll(/\S+/g)].map(item => item[0]);
        const definition = byName.get(tokens[0]);
        if (!definition || (definition.name !== 'ADD' && definition.name !== 'DEL')
            || tokens.length !== definition.arguments.length + 1)
            return 'MUTATION_NOT_ISOLATED';
        const argumentsList = tokens.slice(1).map(token => /^-?(0|[1-9]\d*)$/.test(token)
            ? Number(token) : NaN);
        if (argumentsList.some(value => !Number.isSafeInteger(value))) {
            return 'MUTATION_NOT_ISOLATED';
        }
        parsed.push({
            name: definition.name,
            arguments: argumentsList,
            line: index + 1,
        });
    }
    return parsed;
}
function operationArgumentIndex(spec, operationName, fieldId) {
    const field = spec.inputFields.find(item => item.id === fieldId);
    if (!field || field.type !== 'integer' || field.encoding !== `operation-argument:${fieldId}`) {
        return undefined;
    }
    const operation = (spec.operations || []).find(item => item.name === operationName);
    const index = operation?.arguments.indexOf(fieldId) ?? -1;
    return index >= 0 ? index : undefined;
}
function operationSupportsSetPresence(spec, operationName, fieldId) {
    const operation = (spec.operations || []).find(item => item.name === operationName);
    if (!operation || !operation.arguments.includes(fieldId))
        return false;
    const expectedPrecondition = operationName === 'ADD'
        ? `absent(${fieldId})` : `present(${fieldId})`;
    const expectedEffect = operationName === 'ADD' ? `add(${fieldId})` : `delete(${fieldId})`;
    return operation.preconditions.length === 1
        && operation.preconditions[0] === expectedPrecondition
        && operation.effects.length === 1
        && operation.effects[0] === expectedEffect;
}
function statefulViolations(spec, operations, fieldId) {
    const present = new Set();
    const violations = [];
    for (const operation of operations) {
        const argumentIndex = operationArgumentIndex(spec, operation.name, fieldId);
        if (argumentIndex === undefined || !operationSupportsSetPresence(spec, operation.name, fieldId)) {
            return undefined;
        }
        const value = operation.arguments[argumentIndex];
        if (operation.name === 'ADD') {
            if (present.has(value))
                violations.push({ line: operation.line, name: operation.name });
            else
                present.add(value);
        }
        else if (!present.has(value)) {
            violations.push({ line: operation.line, name: operation.name });
        }
        else {
            present.delete(value);
        }
    }
    return violations;
}
function presentBefore(spec, operations, beforeIndex, fieldId) {
    const present = new Set();
    for (let index = 0; index < beforeIndex; index++) {
        const operation = operations[index];
        const argumentIndex = operationArgumentIndex(spec, operation.name, fieldId);
        if (argumentIndex === undefined || !operationSupportsSetPresence(spec, operation.name, fieldId)) {
            return undefined;
        }
        const value = operation.arguments[argumentIndex];
        if (operation.name === 'ADD') {
            if (present.has(value))
                return undefined;
            present.add(value);
        }
        else {
            if (!present.has(value))
                return undefined;
            present.delete(value);
        }
    }
    return present;
}
function constructOperationMutation(input, spec, target, fieldId, operationName, kind) {
    const operations = parseOperations(input, spec);
    if (typeof operations === 'string')
        return operations;
    const selectedName = operationName
        || (kind === 'delete-missing-object' ? 'DEL' : 'ADD');
    if (selectedName !== 'ADD' && selectedName !== 'DEL')
        return 'INVALID_RECIPE';
    const argumentIndex = operationArgumentIndex(spec, selectedName, fieldId);
    if (argumentIndex === undefined)
        return 'INVALID_RECIPE';
    const resolvedBounds = resolveArgumentBounds(spec, target, fieldId);
    if (typeof resolvedBounds === 'string')
        return resolvedBounds;
    const bounds = resolvedBounds.all;
    const inBounds = (value) => valueSatisfiesBounds(value, bounds);
    if (operations.some(operation => {
        const index = operationArgumentIndex(spec, operation.name, fieldId);
        return index === undefined || !inBounds(operation.arguments[index]);
    })) {
        return 'MUTATION_NOT_ISOLATED';
    }
    let targetIndex = -1;
    let replacement;
    if (kind === 'add-existing-object') {
        if (selectedName !== 'ADD'
            || target.expression !== `${selectedName} requires absent(${fieldId})`) {
            return 'UNSUPPORTED_TARGET';
        }
        const sourceViolations = statefulViolations(spec, operations, fieldId);
        if (!sourceViolations || sourceViolations.length !== 0)
            return 'MUTATION_NOT_ISOLATED';
        for (let index = 0; index < operations.length; index++) {
            if (operations[index].name !== selectedName)
                continue;
            const before = presentBefore(spec, operations, index, fieldId);
            const existing = before && [...before].sort((left, right) => left - right)[0];
            if (existing !== undefined && inBounds(existing)) {
                targetIndex = index;
                replacement = existing;
                break;
            }
        }
    }
    else if (kind === 'delete-missing-object') {
        if (selectedName !== 'DEL'
            || target.expression !== `${selectedName} requires present(${fieldId})`) {
            return 'UNSUPPORTED_TARGET';
        }
        const sourceViolations = statefulViolations(spec, operations, fieldId);
        if (!sourceViolations || sourceViolations.length !== 0)
            return 'MUTATION_NOT_ISOLATED';
        for (let index = 0; index < operations.length; index++) {
            if (operations[index].name !== selectedName)
                continue;
            const before = presentBefore(spec, operations, index, fieldId);
            if (!before)
                continue;
            const original = operations[index].arguments[argumentIndex];
            const missing = findMissingValue(before, original, bounds);
            if (missing !== undefined) {
                targetIndex = index;
                replacement = missing;
                break;
            }
        }
    }
    else {
        const targetBounds = resolvedBounds.target;
        if (!targetBounds)
            return 'UNSUPPORTED_TARGET';
        targetIndex = operations.findIndex(operation => operation.name === selectedName);
        if (targetIndex >= 0) {
            replacement = findTargetViolation(targetBounds, resolvedBounds.nonTarget);
        }
    }
    if (targetIndex < 0 || replacement === undefined)
        return 'MUTATION_NOT_ISOLATED';
    const selected = operations[targetIndex];
    const mutation = replaceToken(input, { line: selected.line, token: argumentIndex + 2 }, String(replacement));
    if (!mutation)
        return 'MUTATION_NOT_ISOLATED';
    const mutatedOperations = parseOperations(mutation.input, spec);
    if (typeof mutatedOperations === 'string')
        return 'MUTATION_NOT_ISOLATED';
    if (kind === 'operation-argument-out-of-range') {
        const mutatedValue = mutatedOperations[targetIndex]?.arguments[argumentIndex];
        const targetBounds = resolvedBounds.target;
        const violatesTarget = (targetBounds.min !== undefined && mutatedValue < targetBounds.min)
            || (targetBounds.max !== undefined && mutatedValue > targetBounds.max);
        return violatesTarget && valueSatisfiesBounds(mutatedValue, resolvedBounds.nonTarget)
            ? mutation : 'MUTATION_NOT_ISOLATED';
    }
    const violations = statefulViolations(spec, mutatedOperations, fieldId);
    return violations && violations.length === 1
        && violations[0].line === selected.line
        && violations[0].name === selectedName
        ? mutation : 'MUTATION_NOT_ISOLATED';
}
function constructSubtaskUpperBoundMutation(input, spec, target, fieldId, encoding) {
    if (target.subtaskId === undefined)
        return 'UNSUPPORTED_TARGET';
    return constructIntegerMutation(input, spec, target, fieldId, encoding, 'integer-above-max');
}
function constructStringMutation(input, spec, target, fieldId, encoding) {
    const location = parseLocation(encoding);
    if (!location)
        return 'UNPARSEABLE_ENCODING';
    if (!scalarLocationIsUnambiguous(spec, fieldId, location))
        return 'UNPARSEABLE_ENCODING';
    const escapedField = fieldId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`^characters\\(${escapedField}\\) in \\[a-z\\]$`)
        .test(target.expression))
        return 'UNSUPPORTED_TARGET';
    const lineTokens = tokenValuesAtLine(input, location.line);
    const value = lineTokens?.[location.token - 1];
    if (!value || !/^[a-z]+$/.test(value))
        return 'MUTATION_NOT_ISOLATED';
    return replaceToken(input, location, `${value.slice(0, -1)}#`)
        || 'MUTATION_NOT_ISOLATED';
}
function gap(target, reasonCode) {
    return {
        targetId: target.id,
        targetKind: target.kind,
        reasonCode,
        ...(target.subtaskId === undefined ? {} : { subtaskId: target.subtaskId }),
    };
}
function buildConstraintProbes(input) {
    const seeds = orderedSeeds(input.seeds);
    const legalSeedHash = sha256(canonicalJson(seeds.map(seed => ({
        source: seed.source,
        index: seed.index,
        subtaskId: seed.subtaskId,
        input: normalizeInput(seed.input),
    }))));
    const effectiveSeed = sha256(`constraint-probes-v1\0${input.statementHash}\0${input.specHash}\0${legalSeedHash}`);
    const probes = [];
    const gaps = [];
    const recipes = input.recipes || [];
    if (recipes.length > MAX_PROBE_RECIPES) {
        return {
            probes,
            gaps: [{
                    targetId: 'recipes',
                    targetKind: 'constraint',
                    reasonCode: 'INVALID_RECIPE',
                }],
            legalSeedHash,
            effectiveSeed,
        };
    }
    for (const recipe of recipes) {
        const target = findTarget(input.spec, recipe.targetId);
        if (!target) {
            gaps.push({
                targetId: recipe.targetId,
                targetKind: 'constraint',
                reasonCode: 'INVALID_RECIPE',
            });
            continue;
        }
        const seed = selectSeed(seeds, target);
        if (!seed) {
            gaps.push(gap(target, 'NO_MATCHING_LEGAL_SEED'));
            continue;
        }
        const normalizedInput = normalizeInput(seed.input);
        if (normalizedInput.length === 0) {
            gaps.push(gap(target, 'MUTATION_NOT_ISOLATED'));
            continue;
        }
        const field = recipe.fieldId
            ? input.spec.inputFields.find(item => item.id === recipe.fieldId)
            : undefined;
        if (!field) {
            gaps.push(gap(target, 'INVALID_RECIPE'));
            continue;
        }
        let mutation;
        if (recipe.constructionKind === 'integer-below-min'
            || recipe.constructionKind === 'integer-above-max') {
            mutation = field.type === 'integer'
                ? constructIntegerMutation(normalizedInput, input.spec, target, field.id, field.encoding, recipe.constructionKind)
                : 'INVALID_RECIPE';
        }
        else if (recipe.constructionKind === 'array-length-mismatch'
            || recipe.constructionKind === 'duplicate-element'
            || recipe.constructionKind === 'permutation-duplicate-or-missing') {
            const expectedType = recipe.constructionKind === 'permutation-duplicate-or-missing'
                ? 'permutation'
                : 'array';
            mutation = field.type === expectedType
                ? constructSequenceMutation(normalizedInput, input.spec, target, field.id, recipe.constructionKind)
                : 'INVALID_RECIPE';
        }
        else if (recipe.constructionKind === 'illegal-string-character') {
            mutation = field.type === 'string'
                ? constructStringMutation(normalizedInput, input.spec, target, field.id, field.encoding)
                : 'INVALID_RECIPE';
        }
        else if (recipe.constructionKind === 'graph-self-loop'
            || recipe.constructionKind === 'graph-duplicate-edge'
            || recipe.constructionKind === 'graph-disconnected'
            || recipe.constructionKind === 'tree-missing-edge'
            || recipe.constructionKind === 'tree-cycle'
            || recipe.constructionKind === 'dag-cycle') {
            mutation = constructStructuralMutation(normalizedInput, input.spec, target, field.id, recipe.constructionKind);
        }
        else if (recipe.constructionKind === 'add-existing-object'
            || recipe.constructionKind === 'delete-missing-object'
            || recipe.constructionKind === 'operation-argument-out-of-range') {
            mutation = constructOperationMutation(normalizedInput, input.spec, target, field.id, recipe.operationName, recipe.constructionKind);
        }
        else if (recipe.constructionKind === 'subtask-upper-bound') {
            mutation = field.type === 'integer'
                ? constructSubtaskUpperBoundMutation(normalizedInput, input.spec, target, field.id, field.encoding)
                : 'INVALID_RECIPE';
        }
        else {
            mutation = 'UNSUPPORTED_TARGET';
        }
        if (typeof mutation === 'string') {
            gaps.push(gap(target, mutation));
            continue;
        }
        if (Buffer.byteLength(mutation.input, 'utf8') > MAX_PROBE_INPUT_BYTES) {
            gaps.push(gap(target, 'PROBE_TOO_LARGE'));
            continue;
        }
        const id = sha256(canonicalJson({
            statementHash: input.statementHash,
            specHash: input.specHash,
            targetKind: target.kind,
            targetId: target.id,
            subtaskId: target.subtaskId,
            constructionKind: recipe.constructionKind,
            effectiveSeed,
            mutationPosition: mutation.position,
        })).slice(0, 32);
        probes.push({
            id,
            targetId: target.id,
            targetKind: target.kind,
            input: mutation.input,
            ...(target.subtaskId === undefined ? {} : { subtaskId: target.subtaskId }),
            constructionKind: recipe.constructionKind,
        });
    }
    const seenProbeIds = new Set();
    const deduplicatedProbes = probes.filter(probe => {
        if (seenProbeIds.has(probe.id))
            return false;
        seenProbeIds.add(probe.id);
        return true;
    });
    const publicGapKey = (item) => canonicalJson({
        targetId: item.targetId,
        targetKind: item.targetKind,
        subtaskId: item.subtaskId,
        reasonCode: item.reasonCode,
    });
    const seenGapKeys = new Set();
    const deduplicatedGaps = gaps.filter(item => {
        const key = publicGapKey(item);
        if (seenGapKeys.has(key))
            return false;
        seenGapKeys.add(key);
        return true;
    });
    const coveredTargets = new Set([
        ...deduplicatedProbes.map(probe => canonicalJson({
            targetId: probe.targetId,
            targetKind: probe.targetKind,
            subtaskId: probe.subtaskId,
        })),
        ...deduplicatedGaps.map(item => canonicalJson({
            targetId: item.targetId,
            targetKind: item.targetKind,
            subtaskId: item.subtaskId,
        })),
    ]);
    const machineTargets = [
        ...input.spec.constraints
            .filter(constraint => constraint.machineCheckable)
            .map(constraint => ({
            id: constraint.id,
            kind: 'constraint',
            expression: constraint.expression,
            ...(constraint.scope === 'global'
                ? {} : { subtaskId: constraint.scope.subtaskId }),
        })),
        ...input.spec.invariants
            .filter(invariant => invariant.machineCheckable)
            .map(invariant => ({
            id: invariant.id,
            kind: 'invariant',
            expression: invariant.expression,
        })),
    ];
    for (const target of machineTargets) {
        const targetKey = canonicalJson({
            targetId: target.id,
            targetKind: target.kind,
            subtaskId: target.subtaskId,
        });
        if (!coveredTargets.has(targetKey)) {
            const uncovered = gap(target, 'UNSUPPORTED_TARGET');
            const key = publicGapKey(uncovered);
            if (!seenGapKeys.has(key)) {
                seenGapKeys.add(key);
                deduplicatedGaps.push(uncovered);
            }
            coveredTargets.add(targetKey);
        }
    }
    return {
        probes: deduplicatedProbes,
        gaps: deduplicatedGaps,
        legalSeedHash,
        effectiveSeed,
    };
}
//# sourceMappingURL=constraintProbes.js.map