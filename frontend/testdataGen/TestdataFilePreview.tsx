import React from 'react';
import { i18n } from '../utils/i18n';
import { COLORS, SPACING, RADIUS, getBadgeStyle, getButtonStyle, getInputStyle } from '../utils/styles';

const MONO_FONT = 'SFMono-Regular, Consolas, "Liberation Mono", monospace';
const KIND_KEYS = {
  'case-in': 'ai_helper_testdata_kind_input',
  'case-out': 'ai_helper_testdata_kind_output',
  template: 'ai_helper_testdata_kind_template',
  compile: 'ai_helper_testdata_kind_compile',
  config: 'ai_helper_testdata_kind_config',
  std: 'ai_helper_testdata_kind_std',
  generator: 'ai_helper_testdata_kind_generator',
  brute: 'ai_helper_testdata_kind_generator',
  validator: 'ai_helper_testdata_kind_generator',
};

interface PreviewFile {
  name: string;
  kind: keyof typeof KIND_KEYS;
}

interface TestdataFilePreviewProps {
  files: PreviewFile[];
  activeFile: string | null;
  selectedFiles: Record<string, boolean>;
  fileContents: Record<string, string>;
  existingFiles: ReadonlySet<string>;
  onOpen: (name: string) => void;
  onToggle: (name: string) => void;
  onEdit: (name: string, content: string) => void;
}

/** Bound both editor height and line scanning for large generated files. */
export function getTestdataEditorRows(content: string): number {
  let rows = 1;
  let offset = 0;
  while (rows < 22) {
    const next = content.indexOf('\n', offset);
    if (next < 0) break;
    rows += 1;
    offset = next + 1;
  }
  return Math.max(8, rows);
}

export function TestdataFilePreview({ files, activeFile, selectedFiles, fileContents,
  existingFiles, onOpen, onToggle, onEdit }: TestdataFilePreviewProps) {
  const orderedFiles = [
    ...files.filter(file => file.kind === 'case-in' || file.kind === 'case-out'),
    ...files.filter(file => file.kind !== 'case-in' && file.kind !== 'case-out'),
  ];
  const active = orderedFiles.find(file => file.name === activeFile) || orderedFiles[0];
  const content = active ? fileContents[active.name] ?? '' : '';
  const rows = getTestdataEditorRows(content);

  return (
    <div className="ai-testdata-file-preview">
      <style>{`
        .ai-testdata-file-preview { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 16px; align-items: start; }
        .ai-testdata-file-preview__list { max-height: ${rows * 20 + 48}px; overflow-y: auto; }
        .ai-testdata-file-preview button:focus-visible,
        .ai-testdata-file-preview input:focus-visible,
        .ai-testdata-file-preview textarea:focus { outline: 2px solid ${COLORS.primary}; outline-offset: 2px; }
        @media (max-width: 720px) {
          .ai-testdata-file-preview { grid-template-columns: minmax(0, 1fr); }
          .ai-testdata-file-preview__list { max-height: 180px; }
        }
      `}</style>
      <div className="ai-testdata-file-preview__list" style={{
        minWidth: 0, border: `1px solid ${COLORS.border}`, borderRadius: RADIUS.md,
      }}>
        {orderedFiles.map(file => {
          const isActive = file.name === active?.name;
          return (
            <div key={file.name} style={{
              display: 'flex', alignItems: 'center', gap: SPACING.xs,
              padding: `3px ${SPACING.sm}`,
              backgroundColor: isActive ? COLORS.primaryLight : 'transparent',
              borderBottom: `1px solid ${COLORS.border}`,
            }}>
              <input type="checkbox"
                aria-label={i18n('ai_helper_testdata_select_file', file.name)}
                checked={!!selectedFiles[file.name]}
                onChange={() => onToggle(file.name)}
                style={{ flexShrink: 0 }}
              />
              <button type="button" onClick={() => onOpen(file.name)}
                aria-current={isActive ? 'true' : undefined} title={file.name}
                style={{ ...getButtonStyle('ghost'), fontFamily: MONO_FONT, fontSize: '13px',
                  flex: 1, minWidth: 0, minHeight: '36px', padding: '2px 0', display: 'block',
                  textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  color: isActive ? COLORS.primary : COLORS.textPrimary }}>
                {file.name}
              </button>
              {existingFiles.has(file.name) && (
                <span style={{ ...getBadgeStyle('warning'), flexShrink: 0 }} title={i18n('ai_helper_testdata_overwrite_hint')}>
                  {i18n('ai_helper_testdata_overwrite_badge')}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ minWidth: 0 }}>
        {active && (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: SPACING.sm, marginBottom: SPACING.sm }}>
              <span style={{ fontFamily: MONO_FONT, fontSize: '13px', fontWeight: 600, overflowWrap: 'anywhere', minWidth: 0 }}>
                {active.name}
              </span>
              <span style={getBadgeStyle('info')}>{i18n(KIND_KEYS[active.kind])}</span>
            </div>
            <textarea key={active.name}
              aria-label={i18n('ai_helper_testdata_edit_file', active.name)}
              value={content} onChange={event => onEdit(active.name, event.target.value)}
              rows={rows} spellCheck={false} wrap="off"
              style={{ ...getInputStyle(), display: 'block', boxSizing: 'border-box',
                fontFamily: MONO_FONT, fontSize: '13px', lineHeight: '20px',
                minHeight: '100px', resize: 'vertical', whiteSpace: 'pre', outline: undefined,
                transition: 'none' }}
            />
          </>
        )}
      </div>
    </div>
  );
}
