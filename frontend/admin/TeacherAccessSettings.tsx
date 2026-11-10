import React, { useState } from 'react';
import { i18n } from '../utils/i18n';
import { getDomainFromUrl } from '../utils/domainUtils';
import { COLORS, SPACING, TYPOGRAPHY, cardStyle } from '../utils/styles';
import { classTeacherPath } from '../teacher/classTeacherLogic';

interface TeacherAccessSettingsProps {
  enabled: boolean;
  /** 立即保存；返回 false 表示失败（开关回到原状态） */
  onChange: (enabled: boolean) => Promise<boolean>;
  disabled: boolean;
}

/**
 * “负责老师访问”开关（FR-058）。默认关闭；开启后，小组负责老师可只读查看本班学生在该域的 AI 对话与统计。
 * 与遥测开关一样立即生效，不随底部“保存配置”提交；服务端记审计。
 */
export const TeacherAccessSettings: React.FC<TeacherAccessSettingsProps> = ({ enabled, onChange, disabled }) => {
  const [saving, setSaving] = useState(false);
  const domainId = getDomainFromUrl();
  const path = domainId ? classTeacherPath(domainId) : '/d/<domainId>/ai-helper/class';

  const toggle = async (next: boolean) => {
    if (next && !window.confirm(i18n('ai_helper_teacher_access_confirm'))) return;
    setSaving(true);
    try {
      await onChange(next);
    } finally {
      setSaving(false);
    }
  };

  const busy = disabled || saving;
  return (
    <div style={cardStyle}>
      <h2 style={{ marginTop: 0, marginBottom: SPACING.sm, ...TYPOGRAPHY.md, color: COLORS.textPrimary }}>
        {i18n('ai_helper_teacher_access_title')}
      </h2>
      <p style={{ margin: `0 0 ${SPACING.base}`, color: COLORS.textMuted, fontSize: '13px', lineHeight: 1.6 }}>
        {i18n('ai_helper_teacher_access_desc')}
      </p>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: SPACING.sm, cursor: busy ? 'not-allowed' : 'pointer' }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => toggle(event.target.checked)}
          disabled={busy}
          style={{ width: '16px', height: '16px' }}
        />
        <span style={{ fontWeight: 500, fontSize: '14px', color: COLORS.textPrimary }}>
          {enabled ? i18n('ai_helper_teacher_access_on') : i18n('ai_helper_teacher_access_off')}
        </span>
      </label>
      <p style={{ margin: `${SPACING.sm} 0 0`, color: COLORS.textMuted, fontSize: '12px', lineHeight: 1.6, overflowWrap: 'anywhere' }}>
        {i18n('ai_helper_teacher_access_hint')} <code style={{ fontSize: '12px' }}>{path}</code>
      </p>
    </div>
  );
};
