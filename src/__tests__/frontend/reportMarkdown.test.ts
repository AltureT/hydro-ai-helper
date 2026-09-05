jest.mock('dompurify', () => ({ sanitize: (html: string) => html }));

import { createReportMarkdownRenderer, getLearningSummaryPreview } from '../../../frontend/utils/reportMarkdown';

describe('report presentation', () => {
  const md = createReportMarkdownRenderer();

  it('replaces known result markers while preserving their labels and table content', () => {
    const html = md.render('| 题目 | 完成情况 |\n|---|---|\n| 示例 | ✅ 一次通过 |\n| 另一题 | ⬜ 未提交 |');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('一次通过');
    expect(html).toContain('未提交');
    expect(html).not.toContain('✅');
    expect(html).toContain('<table>');
  });

  it('only removes recognized decorative heading prefixes', () => {
    expect(md.render('### 📝 课后巩固作业')).toContain('<h3>课后巩固作业</h3>');
    expect(md.render('### 🔶 题目中的符号')).toContain('🔶 题目中的符号');
    expect(md.render('正文中的 ✅ 和 💡 保持不变')).toContain('✅ 和 💡');
    expect(md.render('✅')).toContain('✅');
  });

  it('does not rewrite code, math, links or image labels', () => {
    const html = md.render('```text\n✅ 一次通过\n```\n\n`💡 下一步：print()`\n\n[✅ 链接](https://example.com)\n\n![✅ 图片](https://example.com/a.png)\n\n$x + 1$');
    expect(html).toContain('✅ 一次通过');
    expect(html).toContain('<code>💡 下一步：print()</code>');
    expect(html).toContain('>✅ 链接</a>');
    expect(html).toContain('alt="✅ 图片"');
    expect(html).toContain('katex');
    expect(html).not.toContain('class="ai-icon"');
  });

  it('keeps untrusted source text escaped beside the fixed SVG', () => {
    const html = md.render('⚠️ <script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('class="ai-icon"');
  });

  it('extracts the next action for collapsed rows without using code as the preview', () => {
    expect(getLearningSummaryPreview('```\n下一步：错误来源\n```\n\n💡 下一步：用 `n = 0` 检查边界。')).toBe('用 n = 0 检查边界。');
    expect(getLearningSummaryPreview('💡 Next step: **Trace** the loop.')).toBe('Trace the loop.');
    expect(getLearningSummaryPreview('💡 下一步：用 $n = 0$ 检查边界。')).toBe('用 n = 0 检查边界。');
    expect(getLearningSummaryPreview('💡 Next step: Compare $O(n)$ and $O(n^2)$.')).toBe('Compare O(n) and O(n^2).');
    expect(getLearningSummaryPreview('只有逐题回顾')).toBe('');
  });
});
