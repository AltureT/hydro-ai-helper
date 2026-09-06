import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FindingCodeSample } from '../../../frontend/teachingSummary/FindingCodeSample';

function render(samples: any) {
  return renderToStaticMarkup(React.createElement(FindingCodeSample, {
    finding: { evidence: { samples } } as any, domainId: 'class-one',
  }));
}

it('shows failure provenance, subsequent acceptance, truncation and the original record link', () => {
  const html = render({ code: ['print("<student-source>")'], codeSources: [{
    recordId: '0123456789abcdef01234567', uid: 1, pid: 1, status: 2,
    resolved: true, truncated: true, submittedAt: '2026-01-01T09:00:00Z', lang: 'py.py3',
  }] });
  expect(html).toContain('历史失败提交示例');
  expect(html).toContain('WA');
  expect(html).toContain('该生本题已有通过记录');
  expect(html).toContain('代码已截断');
  expect(html).toContain('/d/class-one/record/0123456789abcdef01234567');
  expect(html).toContain('&lt;student-source&gt;');
});

it('marks saved legacy samples as unverified instead of asserting they are common errors', () => {
  const html = render({ code: ['accepted-looking-source'] });
  expect(html).toContain('旧报告样本来源未校验，请重新生成');
  expect(html).not.toContain('历史失败提交示例');
});
