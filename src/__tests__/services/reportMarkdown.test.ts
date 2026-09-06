import { normalizeHomeworkMarkdown, normalizeReportMarkdown } from '../../utils/reportMarkdown';
import { reportContent } from '../../services/reportContent';
import MarkdownIt from 'markdown-it';

describe('report metadata normalization', () => {
  const heading = '### 一句话诊断\n观察到的事实';
  it.each([
    '<think>(thinking…)</think>',
    String.raw`\<think>(thinking…)\</think>`,
    String.raw`\<think\>(thinking…)<\/think\>`,
    '&lt;think&gt;(thinking…)&lt;/think&gt;',
    '&#60;think&#62;(thinking…)&#60;/think&#62;',
    '&#x3c;think&#x3e;(thinking…)&#x3c;/think&#x3e;',
  ])('removes a leading wrapper before decoding heading spacing (%#)', wrapper => {
    expect(reportContent(wrapper + '###&#x20;一句话诊断\n观察到的事实')).toBe(heading);
  });

  it('removes repeated wrappers and withholds incomplete metadata', () => {
    expect(reportContent('<think>one</think>\n&lt;think&gt;two&lt;/think&gt;\n' + heading)).toBe(heading);
    expect(normalizeReportMarkdown(String.raw`\<think>unfinished`)).toBe('');
    expect(() => reportContent('&lt;think&gt;unfinished')).toThrow();
  });

  it.each([
    '```html\n<think>literal</think>\n###&#x20;literal\n```',
    '~~~text\n\\<think>literal\\</think>\n###&#32;literal\n~~~',
    '    <think>literal</think>\n    ###&#x20;literal',
    '`<think>literal</think>` and `###&#x20;literal`',
    '`x\n###&#x20;y\n`',
    '正文中的 <think>字面标签</think> 和 &lt;script&gt; 不变',
  ])('preserves literal examples and non-structural entities (%#)', content => {
    expect(normalizeReportMarkdown(content)).toBe(content);
  });

  it('preserves the first fence indentation after an escaped metadata wrapper', () => {
    const source = '  ```python\n  for i in range(3):\n      pass\n  ```';
    const normalized = normalizeReportMarkdown(String.raw`\<think>hidden\</think>` + '\n' + source);
    expect(normalized).toBe(source);
    const md = new MarkdownIt();
    expect(md.parse(normalized, {})[0].content).toBe('for i in range(3):\n    pass\n');
  });
});

describe('Python worksheet placeholder normalization', () => {
  const broken = 'for i in range(/* [空1] _____ (提示：外层循环需要执行多少趟？) */):\n    print(i)';
  const fence = (code: string, lang = 'python') => '```' + lang + '\n' + code + '\n```';

  it.each(['python', 'python3', 'py.py3'])('moves hints out of range arguments for %s', lang => {
    const normalized = normalizeHomeworkMarkdown(fence(broken, lang));
    expect(normalized).toContain('# [空1] _____ (提示：外层循环需要执行多少趟？)\nfor i in range(__BLANK_1__):\n    print(i)');
    expect(normalized).not.toContain('/*');
    expect(normalizeHomeworkMarkdown(normalized)).toBe(normalized);
  });

  it('handles Markdown-escaped worksheet markers without globally unescaping code', () => {
    const code = String.raw`for i in range(/\* [空1] \_\_\_\_\_ (提示：次数) \*/):` + '\n    pass';
    expect(normalizeHomeworkMarkdown(fence(code))).toContain('for i in range(__BLANK_1__):');
  });

  it('preserves valid Python comments in multiline expressions and trailing hints', () => {
    const code = 'for i in range(# [空1] _____ (提示：次数)\n    3\n):\n    pass\nx = 1 # [空2] _____ (提示：已填写)';
    expect(normalizeHomeworkMarkdown(fence(code))).toBe(fence(code));
  });

  it('preserves string literals, documentation strings, comments and C++ source', () => {
    const marker = '/* [空1] _____ (提示：literal) */';
    const literalCode = `text = "${marker}"\ndoc = '''\n${marker}\n'''\n# ${marker}\nprint(text)`;
    expect(normalizeHomeworkMarkdown(fence(literalCode))).toBe(fence(literalCode));
    expect(normalizeHomeworkMarkdown(fence(broken, 'cpp'))).toBe(fence(broken, 'cpp'));
    expect(normalizeReportMarkdown(fence(broken))).toBe(fence(broken));
  });

  it('preserves fence indentation and supports longer or tilde fences', () => {
    for (const marker of ['~~~', '````']) {
      const text = `  ${marker}python\n  ${broken.replace(/\n/g, '\n  ')}\n  ${marker}`;
      const result = normalizeHomeworkMarkdown(text);
      expect(result).toContain('  # [空1]');
      expect(result).toContain('  for i in range(__BLANK_1__):\n      print(i)');
    }
  });

  it('uses fallback language only for unlabelled fences', () => {
    expect(normalizeHomeworkMarkdown(fence(broken, ''), 'python')).toContain('__BLANK_1__');
    expect(normalizeHomeworkMarkdown(fence(broken, 'cpp'), 'python')).not.toContain('__BLANK_1__');
  });

  it('leaves nested list fences unchanged instead of detaching their code', () => {
    const nested = '- ```python\n  ' + broken.replace(/\n/g, '\n  ') + '\n  ```';
    expect(normalizeHomeworkMarkdown(nested)).toBe(nested);
    const md = new MarkdownIt();
    expect(md.parse(nested, {}).find(token => token.type === 'fence')?.content).toContain('for i in range');
  });
});
