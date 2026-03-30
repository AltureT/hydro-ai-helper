import React, { useState } from 'react';
import {
  COLORS, SPACING, RADIUS, TYPOGRAPHY,
  getInputStyle, getButtonStyle,
} from '../utils/styles';

interface FeedbackFormProps {
  showToast: (msg: string, type: 'success' | 'error') => void;
}

const TYPES = [
  { value: 'bug', label: 'Bug 报告' },
  { value: 'feature', label: '功能建议' },
  { value: 'other', label: '其他' },
];

export const FeedbackForm: React.FC<FeedbackFormProps> = ({ showToast }) => {
  const [type, setType] = useState('bug');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!subject.trim()) {
      showToast('请填写反馈主题', 'error');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/ai-helper/admin/feedback', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({
          type,
          subject: subject.trim(),
          body: body.trim(),
          contactEmail: email.trim() || undefined,
        }),
      });

      const data = await res.json();
      if (data.success) {
        showToast('反馈已提交，感谢您的意见！', 'success');
        setSubject('');
        setBody('');
        setEmail('');
      } else {
        showToast(data.error || '提交失败', 'error');
      }
    } catch {
      showToast('网络错误，请稍后再试', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{
      marginTop: '20px', padding: '20px', backgroundColor: COLORS.bgPage,
      borderRadius: RADIUS.md, border: `1px solid ${COLORS.border}`
    }}>
      <h2 style={{ marginTop: 0, marginBottom: SPACING.sm, ...TYPOGRAPHY.md, color: COLORS.textPrimary }}>
        问题反馈
      </h2>
      <p style={{ margin: '0 0 4px', color: COLORS.textMuted, fontSize: '13px' }}>
        向开发者提交 Bug 报告或功能建议。
      </p>
      <p style={{ margin: '0 0 16px', color: COLORS.warning, fontSize: '12px', fontWeight: 500 }}>
        请勿包含学生信息、API Key 或原始日志内容。
      </p>

      <div style={{ display: 'flex', gap: SPACING.base, marginBottom: SPACING.base }}>
        <div style={{ flex: '0 0 140px' }}>
          <label style={{ display: 'block', marginBottom: SPACING.xs, fontWeight: 500, fontSize: '14px', color: COLORS.textPrimary }}>类型</label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            disabled={submitting}
            style={{ ...getInputStyle(), width: '100%' }}
          >
            {TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label style={{ display: 'block', marginBottom: SPACING.xs, fontWeight: 500, fontSize: '14px', color: COLORS.textPrimary }}>
            主题 <span style={{ color: COLORS.textMuted, fontWeight: 400 }}>({subject.length}/200)</span>
          </label>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value.slice(0, 200))}
            placeholder="简要描述问题或建议"
            disabled={submitting}
            style={getInputStyle()}
          />
        </div>
      </div>

      <div style={{ marginBottom: SPACING.base }}>
        <label style={{ display: 'block', marginBottom: SPACING.xs, fontWeight: 500, fontSize: '14px', color: COLORS.textPrimary }}>
          详细描述 <span style={{ color: COLORS.textMuted, fontWeight: 400 }}>({body.length}/2000)</span>
        </label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value.slice(0, 2000))}
          placeholder="详细描述遇到的问题、复现步骤或功能需求..."
          disabled={submitting}
          rows={4}
          style={{ ...getInputStyle(), resize: 'vertical', minHeight: '80px' }}
        />
      </div>

      <div style={{ display: 'flex', gap: SPACING.base, alignItems: 'flex-end' }}>
        <div style={{ flex: '0 0 280px' }}>
          <label style={{ display: 'block', marginBottom: SPACING.xs, fontWeight: 500, fontSize: '14px', color: COLORS.textPrimary }}>
            联系邮箱 <span style={{ color: COLORS.textMuted, fontWeight: 400 }}>(可选)</span>
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="方便开发者联系您"
            disabled={submitting}
            style={getInputStyle()}
          />
        </div>
        <button
          onClick={handleSubmit}
          disabled={submitting || !subject.trim()}
          style={{
            ...getButtonStyle('primary'),
            opacity: (submitting || !subject.trim()) ? 0.5 : 1,
            cursor: (submitting || !subject.trim()) ? 'not-allowed' : 'pointer',
          }}
        >
          {submitting ? '提交中...' : '提交反馈'}
        </button>
      </div>
    </div>
  );
};
