import React, { useState } from 'react';
import { i18n } from '@hydrooj/ui-default';
import {
  COLORS, SPACING, RADIUS, TYPOGRAPHY,
  getInputStyle, getButtonStyle,
} from '../utils/styles';

interface FeedbackFormProps {
  showToast: (msg: string, type: 'success' | 'error') => void;
}

const getTypes = () => [
  { value: 'bug', label: i18n('ai_helper_admin_feedback_type_bug') },
  { value: 'feature', label: i18n('ai_helper_admin_feedback_type_feature') },
  { value: 'other', label: i18n('ai_helper_admin_feedback_type_other') },
];

export const FeedbackForm: React.FC<FeedbackFormProps> = ({ showToast }) => {
  const [type, setType] = useState('bug');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!subject.trim()) {
      showToast(i18n('ai_helper_feedback_subject_required'), 'error');
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
        showToast(i18n('ai_helper_feedback_success'), 'success');
        setSubject('');
        setBody('');
        setEmail('');
      } else {
        showToast(data.error || i18n('ai_helper_feedback_submit_failed'), 'error');
      }
    } catch {
      showToast(i18n('ai_helper_admin_feedback_network_error'), 'error');
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
        {i18n('ai_helper_admin_feedback_title')}
      </h2>
      <p style={{ margin: '0 0 4px', color: COLORS.textMuted, fontSize: '13px' }}>
        {i18n('ai_helper_admin_feedback_desc')}
      </p>
      <p style={{ margin: '0 0 16px', color: COLORS.warning, fontSize: '12px', fontWeight: 500 }}>
        {i18n('ai_helper_admin_feedback_warning')}
      </p>

      <div style={{ display: 'flex', gap: SPACING.base, marginBottom: SPACING.base }}>
        <div style={{ flex: '0 0 140px' }}>
          <label style={{ display: 'block', marginBottom: SPACING.xs, fontWeight: 500, fontSize: '14px', color: COLORS.textPrimary }}>{i18n('ai_helper_admin_feedback_type_label')}</label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            disabled={submitting}
            style={{ ...getInputStyle(), width: '100%' }}
          >
            {getTypes().map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label style={{ display: 'block', marginBottom: SPACING.xs, fontWeight: 500, fontSize: '14px', color: COLORS.textPrimary }}>
            {i18n('ai_helper_admin_feedback_subject')} <span style={{ color: COLORS.textMuted, fontWeight: 400 }}>({subject.length}/200)</span>
          </label>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value.slice(0, 200))}
            placeholder={i18n('ai_helper_admin_feedback_subject_placeholder')}
            disabled={submitting}
            style={getInputStyle()}
          />
        </div>
      </div>

      <div style={{ marginBottom: SPACING.base }}>
        <label style={{ display: 'block', marginBottom: SPACING.xs, fontWeight: 500, fontSize: '14px', color: COLORS.textPrimary }}>
          {i18n('ai_helper_admin_feedback_body')} <span style={{ color: COLORS.textMuted, fontWeight: 400 }}>({body.length}/2000)</span>
        </label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value.slice(0, 2000))}
          placeholder={i18n('ai_helper_admin_feedback_body_placeholder')}
          disabled={submitting}
          rows={4}
          style={{ ...getInputStyle(), resize: 'vertical', minHeight: '80px' }}
        />
      </div>

      <div style={{ display: 'flex', gap: SPACING.base, alignItems: 'flex-end' }}>
        <div style={{ flex: '0 0 280px' }}>
          <label style={{ display: 'block', marginBottom: SPACING.xs, fontWeight: 500, fontSize: '14px', color: COLORS.textPrimary }}>
            {i18n('ai_helper_admin_feedback_email')} <span style={{ color: COLORS.textMuted, fontWeight: 400 }}>({i18n('ai_helper_admin_feedback_optional')})</span>
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={i18n('ai_helper_admin_feedback_email_placeholder')}
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
          {submitting ? i18n('ai_helper_admin_feedback_submitting') : i18n('ai_helper_admin_feedback_submit')}
        </button>
      </div>
    </div>
  );
};
