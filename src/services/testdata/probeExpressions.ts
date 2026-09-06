import type { ProblemSpecV1 } from './problemSpec';

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Names are aliases only when one field owns the name and no other field owns that id. */
function symbols(spec: ProblemSpecV1, field: ProblemSpecV1['inputFields'][number]): string[] {
  const uniqueName = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(field.name)
    && !spec.inputFields.some(other => other !== field
      && (other.name === field.name || other.id === field.name));
  return [...new Set([field.id, ...(uniqueName ? [field.name] : [])])];
}

function bounds(expression: string, symbol: string, canonical: string): string | undefined {
  const escaped = escapePattern(symbol);
  const range = new RegExp(`^(-?\\d+)\\s*<=\\s*${escaped}\\s*<=\\s*(-?\\d+)$`).exec(expression);
  if (range) return `${range[1]} <= ${canonical} <= ${range[2]}`;
  const one = new RegExp(`^${escaped}\\s*(>=|<=)\\s*(-?\\d+)$`).exec(expression);
  return one ? `${canonical} ${one[1]} ${one[2]}` : undefined;
}

/** A closed spelling adapter, never an evaluator or a natural-language constraint interpreter. */
function canonicalExpression(spec: ProblemSpecV1, expression: string): string {
  const trimmed = expression.trim();
  for (const field of spec.inputFields) {
    for (const symbol of symbols(spec, field)) {
      if (field.type === 'integer') {
        const normalized = bounds(trimmed, symbol, field.id);
        if (normalized) return normalized;
      }
      if (field.type === 'string') {
        const alphabet = new RegExp(`^characters\\(\\s*${escapePattern(symbol)}\\s*\\) in (\\[a-z\\]|\\[01\\])$`).exec(trimmed);
        if (alphabet) return `characters(${field.id}) in ${alphabet[1]}`;
      }
      if (field.type !== 'array' && field.type !== 'string') continue;
      const quantified = /^forall\s+([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(trimmed);
      const normalized = field.type === 'array' && bounds(quantified?.[2] ?? trimmed,
        `${symbol}[${quantified?.[1] ?? 'i'}]`, `${field.id}[i]`);
      if (normalized) return normalized;
      for (const dependency of field.dependsOn || []) {
        const count = spec.inputFields.find(item => item.id === dependency && item.type === 'integer');
        if (!count) continue;
        for (const countSymbol of symbols(spec, count)) {
          if (new RegExp(`^(?:len|length)\\(\\s*${escapePattern(symbol)}\\s*\\)\\s*={1,2}\\s*${escapePattern(countSymbol)}$`)
            .test(trimmed)) return `length(${field.id}) = ${count.id}`;
          if (field.type === 'string' && trimmed === `${symbol}[i] == '0' or ${symbol}[i] == '1' for 1 <= i <= ${countSymbol}`) {
            return `characters(${field.id}[1..${count.id}]) in [01]`;
          }
        }
      }
    }
  }
  return expression;
}

/** Probe-local interpretation only: the frozen spec, evidence and hashes remain untouched. */
export function specForConstraintProbes(spec: ProblemSpecV1): ProblemSpecV1 {
  return {
    ...spec,
    constraints: spec.constraints.map(item => ({ ...item, expression: canonicalExpression(spec, item.expression) })),
    invariants: spec.invariants.map(item => ({ ...item, expression: canonicalExpression(spec, item.expression) })),
  };
}
