import { excerpt, excerptTail } from '../../lib/textTruncate';

describe('excerpt（字节安全头部摘录）', () => {
  it('短文本原样返回并规范化换行', () => {
    expect(excerpt('a\r\nb\r')).toBe('a\nb');
  });

  it('超限时按字节截断，最终字节数不超过 maxBytes', () => {
    const out = excerpt('好'.repeat(200), 300);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(300);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('excerptTail（字节安全尾部摘录）', () => {
  it('短文本原样返回', () => {
    expect(excerptTail('IndexError: boom', 1000)).toBe('IndexError: boom');
  });

  it('超限时保留尾部（traceback 关键行在最后）', () => {
    const trace = `${'x'.repeat(2000)}\nIndexError: string index out of range`;
    const out = excerptTail(trace, 100);
    expect(out).toContain('IndexError: string index out of range');
    expect(out.startsWith('…')).toBe(true);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(100);
  });

  it('CJK 文本按字节而非字符截断', () => {
    const out = excerptTail('好'.repeat(1000), 100);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(100);
    expect(out.length).toBeLessThan(100);
  });
});
