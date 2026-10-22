import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getTestdataEditorRows, TestdataFilePreview } from '../../../frontend/testdataGen/TestdataFilePreview';

jest.mock('../../../frontend/utils/i18n', () => ({
  i18n: (key: string, ...args: unknown[]) => `${key}${args.length ? `:${args.join(',')}` : ''}`,
}));

function elements(node: React.ReactNode): React.ReactElement[] {
  if (!React.isValidElement(node)) return [];
  return [node, ...React.Children.toArray(node.props.children).flatMap(elements)];
}

const props = {
  files: [{ name: 'generator.py', kind: 'generator' as const },
    { name: '1.in', kind: 'case-in' as const }, { name: '1.out', kind: 'case-out' as const }],
  activeFile: null,
  selectedFiles: { '1.in': true, '1.out': false },
  fileContents: { '1.in': '1\n', '1.out': '2\n' },
  existingFiles: new Set(['1.in']),
  onOpen: jest.fn(), onToggle: jest.fn(), onEdit: jest.fn(),
};

describe('test data file preview', () => {
  beforeEach(() => jest.clearAllMocks());

  it('keeps short files compact and bounds editor height for large files', () => {
    expect(getTestdataEditorRows('1\n')).toBeLessThan(10);
    expect(getTestdataEditorRows('1\r\n'.repeat(12))).toBeGreaterThan(getTestdataEditorRows('1\n'));
    expect(getTestdataEditorRows('1\n'.repeat(100_000))).toBeLessThanOrEqual(24);
    expect(getTestdataEditorRows('1 '.repeat(200_000))).toBeLessThan(10);
  });

  it('opens test input first, distinguishes output, and retains edited contents on return', () => {
    const initial = elements(TestdataFilePreview(props));
    expect(initial.find(el => el.type === 'textarea')?.props.value).toBe('1\n');
    const edited = { ...props.fileContents, '1.in': '\t 123\r\n\n' };
    const output = renderToStaticMarkup(React.createElement(TestdataFilePreview, { ...props, activeFile: '1.out', fileContents: edited }));
    expect(output).toContain('ai_helper_testdata_kind_output');
    const returned = elements(TestdataFilePreview({ ...props, activeFile: '1.in', fileContents: edited }));
    expect(returned.find(el => el.type === 'textarea')?.props.value).toBe('\t 123\r\n\n');
    expect(returned.find(el => el.type === 'input' && el.props.checked === true)).toBeDefined();
  });

  it('keeps opening, selecting, and editing a file independent', () => {
    const tree = elements(TestdataFilePreview(props));
    tree.find(el => el.type === 'button' && el.props.title === '1.out')?.props.onClick();
    expect(props.onOpen).toHaveBeenCalledWith('1.out');
    expect(props.onToggle).not.toHaveBeenCalled();
    tree.find(el => el.type === 'input')?.props.onChange();
    expect(props.onToggle).toHaveBeenCalledWith('1.in');
    expect(props.onOpen).toHaveBeenCalledTimes(1);
    tree.find(el => el.type === 'textarea')?.props.onChange({ target: { value: '  7\n\n' } });
    expect(props.onEdit).toHaveBeenCalledWith('1.in', '  7\n\n');
  });

  it('escapes filenames and content while keeping overwrite warnings and accessible controls', () => {
    const name = '<script>file</script>.in';
    const markup = renderToStaticMarkup(React.createElement(TestdataFilePreview, {
      ...props, files: [{ name, kind: 'case-in' }], activeFile: name,
      fileContents: { [name]: '<img src=x onerror=alert(1)>' }, existingFiles: new Set([name]),
    }));
    expect(markup).not.toContain('<script>');
    expect(markup).not.toContain('<img');
    expect(markup).toContain('ai_helper_testdata_overwrite_badge');
    expect(markup).toContain('aria-current="true"');
    expect(markup).toContain('ai_helper_testdata_select_file:');
    expect(markup).toContain('ai_helper_testdata_edit_file:');
  });
});
