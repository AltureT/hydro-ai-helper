import {
  generateMutationCandidates,
  getMutationGateMode,
  mergeMutationCandidates,
  normalizeMutationLanguage,
  type HistoricalMutationCandidate,
  type MutationCandidate,
  type MutationLanguage,
  type MutationOperatorId,
} from '../../services/testdata/mutation';

describe('testdata mutation contracts', () => {
  it.each([
    ['py', 'python'],
    ['py.py3', 'python'],
    ['py.pypy3', 'python'],
    ['python3', 'python'],
    ['cc', 'cpp'],
    ['cc.cc17', 'cpp'],
    ['cpp17', 'cpp'],
    ['c++17', 'cpp'],
    ['java', undefined],
    ['cc.cc20', undefined],
    ['', undefined],
  ] as const)('normalizes the allowlisted language %s', (input, expected) => {
    expect(normalizeMutationLanguage(input)).toBe(expected);
  });

  it.each([
    [undefined, 'observe'],
    ['', 'observe'],
    ['invalid', 'observe'],
    ['OFF', 'observe'],
    ['off', 'off'],
    ['observe', 'observe'],
    ['enforce', 'enforce'],
  ] as const)('normalizes mutation gate %s to %s', (input, expected) => {
    expect(getMutationGateMode(input)).toBe(expected);
  });

  it('changes a Python code operator without touching comments or strings', () => {
    const source = [
      '# ignored < operator',
      'message = "ignored <= operator"',
      "other = 'ignored > operator'",
      'if left < right:',
      '    pass',
    ].join('\n');

    const candidates = generateMutationCandidates(source, 'python');

    expect(candidates).toEqual([{
      origin: 'generated',
      language: 'python',
      operatorId: 'comparison-boundary',
      source: source.replace('if left < right:', 'if left <= right:'),
    }]);
  });

  it('changes a C++ code operator without touching preprocessor text, comments, strings, or chars', () => {
    const source = [
      '#define KEEP(x) ((x) < 2)',
      '// ignored < operator',
      'const char* text = "ignored <= operator";',
      "const char symbol = '<';",
      'if (left < right) {}',
    ].join('\n');

    const candidates = generateMutationCandidates(source, 'cpp');

    expect(candidates).toEqual([{
      origin: 'generated',
      language: 'cpp',
      operatorId: 'comparison-boundary',
      source: source.replace('if (left < right)', 'if (left <= right)'),
    }]);
  });

  it('skips every standard C++ raw-string prefix before scanning numbers or operators', () => {
    const source = [
      'const char* plain = R"(plain < 3)";',
      'const char8_t* utf8 = u8R"tag(utf8 " <= 41)tag";',
      'const char16_t* utf16 = uR"tag(utf16 > 5)tag";',
      'const char32_t* utf32 = UR"tag(utf32 == 7)tag";',
      'const wchar_t* wide = LR"tag(wide + 11)tag";',
      'if (left < right) {}',
    ].join('\n');

    expect(generateMutationCandidates(source, 'cpp')).toEqual([{
      origin: 'generated',
      language: 'cpp',
      operatorId: 'comparison-boundary',
      source: source.replace('if (left < right)', 'if (left <= right)'),
    }]);
  });

  it.each([
    ['python', 'if left < right:\n    pass', 'comparison-boundary', 'if left <= right:\n    pass'],
    ['python', 'if left == right:\n    pass', 'equality-negation', 'if left != right:\n    pass'],
    ['python', 'if left and right:\n    pass', 'logical-connector', 'if left or right:\n    pass'],
    ['python', 'value = left + right', 'arithmetic-operator', 'value = left - right'],
    ['python', 'value = 41', 'constant-off-by-one', 'value = 40'],
    ['cpp', 'if (left >= right) {}', 'comparison-boundary', 'if (left > right) {}'],
    ['cpp', 'if (left != right) {}', 'equality-negation', 'if (left == right) {}'],
    ['cpp', 'if (left && right) {}', 'logical-connector', 'if (left || right) {}'],
    ['cpp', 'auto value = left - right;', 'arithmetic-operator', 'auto value = left + right;'],
    ['cpp', 'auto value = 40;', 'constant-off-by-one', 'auto value = 41;'],
  ] as const)(
    'applies one %s mutation for %s source',
    (language, source, operatorId, expectedSource) => {
      expect(generateMutationCandidates(source, language)).toEqual([{
        origin: 'generated',
        language,
        operatorId,
        source: expectedSource,
      }]);
    },
  );

  it('caps each operator at three stable source positions', () => {
    const source = [
      'if a < b:',
      '    pass',
      'if c < d:',
      '    pass',
      'if e < f:',
      '    pass',
      'if g < h:',
      '    pass',
    ].join('\n');

    const candidates = generateMutationCandidates(source, 'python');

    expect(candidates).toHaveLength(3);
    expect(candidates.map(candidate => candidate.source)).toEqual([
      source.replace('a < b', 'a <= b'),
      source.replace('c < d', 'c <= d'),
      source.replace('e < f', 'e <= f'),
    ]);
  });

  it('caps generated candidates at twelve in fixed operator and token order', () => {
    const source = [
      'if a < b or c < d or e < f or g < h:',
      '    value = a + b + c + d + 11 + 13 + 15 + 17',
      'if a == b or c == d or e == f or g == h:',
      '    pass',
    ].join('\n');

    const first = generateMutationCandidates(source, 'python');
    const second = generateMutationCandidates(source, 'python');

    expect(first).toHaveLength(12);
    expect(second).toEqual(first);
    expect(first.map(candidate => candidate.operatorId)).toEqual([
      'comparison-boundary', 'comparison-boundary', 'comparison-boundary',
      'equality-negation', 'equality-negation', 'equality-negation',
      'logical-connector', 'logical-connector', 'logical-connector',
      'arithmetic-operator', 'arithmetic-operator', 'arithmetic-operator',
    ]);
    expect(new Set(first.map(candidate => candidate.source)).size).toBe(12);
  });

  it('rejects unsafe and noncanonical integer literals from off-by-one mutation', () => {
    const source = [
      'hex_value = 0x10',
      'float_value = 1.5',
      'unsafe_value = 9007199254740992',
    ].join('\n');

    expect(generateMutationCandidates(source, 'python')).toEqual([]);
  });

  it('never mutates signed integer literals across deterministic Python variants', () => {
    for (let value = 1; value <= 100; value++) {
      const source = `if current < -${value}:\n    pass`;
      const candidates = generateMutationCandidates(source, 'python');
      expect(candidates).toEqual([{
        origin: 'generated',
        language: 'python',
        operatorId: 'comparison-boundary',
        source: `if current <= -${value}:\n    pass`,
      }]);
    }
  });

  it('never mutates C++ template argument tokens across deterministic variants', () => {
    for (let size = 1; size <= 100; size++) {
      const source = `std::array<int,${size}> values; if (left < right) {}`;
      const candidates = generateMutationCandidates(source, 'cpp');
      expect(candidates).toEqual([{
        origin: 'generated',
        language: 'cpp',
        operatorId: 'comparison-boundary',
        source: `std::array<int,${size}> values; if (left <= right) {}`,
      }]);
    }
  });

  it('limits and deduplicates merged generated and historical candidates', () => {
    const operatorIds: MutationOperatorId[] = [
      'comparison-boundary',
      'equality-negation',
      'logical-connector',
      'arithmetic-operator',
      'constant-off-by-one',
    ];
    const generated: MutationCandidate[] = Array.from({ length: 12 }, (_, index) => ({
      origin: 'generated',
      language: 'python',
      operatorId: operatorIds[index % operatorIds.length],
      source: `print(${index})`,
    }));
    const historical: HistoricalMutationCandidate[] = Array.from({ length: 10 }, (_, index) => ({
      language: index % 2 === 0 ? 'python' : 'cpp',
      source: index === 0 ? 'print(0)' : `historical-${index}`,
      expectedStatus: 'wrong-answer',
    }));

    const merged = mergeMutationCandidates(generated, historical);

    expect(merged).toHaveLength(20);
    expect(merged.filter(candidate => candidate.origin === 'generated')).toHaveLength(12);
    expect(merged.filter(candidate => candidate.origin === 'historical')).toHaveLength(8);
    expect(merged.filter(candidate => candidate.source === 'print(0)')).toHaveLength(1);
    expect(merged.slice(12).every(candidate => (
      candidate.operatorId === 'historical-submission'
    ))).toBe(true);
  });

  it.each(['python', 'cpp'] as MutationLanguage[])(
    'returns non-empty deterministic single-site candidates for %s',
    language => {
      const source = language === 'python'
        ? 'if value < 41:\n    print(value + 1)'
        : 'int main() { if (value < 41) return value + 1; }';
      const first = generateMutationCandidates(source, language);
      const second = generateMutationCandidates(source, language);

      expect(first.length).toBeGreaterThan(0);
      expect(second).toEqual(first);
      for (const candidate of first) {
        expect(candidate.source).not.toBe(source);
        expect(candidate.source.trim()).not.toBe('');
      }
    },
  );
});
