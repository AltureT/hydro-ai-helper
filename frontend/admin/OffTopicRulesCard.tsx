/**
 * 安全治理 → 规则与关键词：偏题规则（US5）
 * 自定义偏题关键词（与内置表合并，题面中出现的仍视为白名单）、附带代码的最小有效长度、偏题计数窗口。
 * 第 1 次偏题只提醒，窗口内第 2 次起记为偏题违规并扣信誉。配置为全局设置，仅系统管理员可修改。
 */

import React, { useCallback, useEffect, useState } from 'react';
import { i18n } from '../utils/i18n';
import { COLORS, RADIUS, SPACING, TYPOGRAPHY, cardStyle, getButtonStyle, getInputStyle } from '../utils/styles';
import {
  DEFAULT_TOPIC_GUARD,
  MAX_OFF_TOPIC_KEYWORDS,
  MAX_OFF_TOPIC_KEYWORD_LENGTH,
  parseTopicGuardForm,
  sameTopicGuard,
  type TopicGuardError,
  type TopicGuardSettings,
} from './offTopicLogic';

type ShowToast = (message: string, type?: 'success' | 'error' | 'warning' | 'info') => void;

const ERROR_KEYS: Record<TopicGuardError, string> = {
  too_many: 'ai_helper_safety_offtopic_err_too_many',
  too_long: 'ai_helper_safety_offtopic_err_too_long',
  code_chars: 'ai_helper_safety_offtopic_err_code_chars',
  window: 'ai_helper_safety_offtopic_err_window',
};

export const OffTopicRulesCard: React.FC<{ showToast: ShowToast }> = ({ showToast }) => {
  const [saved, setSaved] = useState<TopicGuardSettings | null>(null);
  const [keywordsText, setKeywordsText] = useState('');
  const [codeChars, setCodeChars] = useState('30');
  const [windowHours, setWindowHours] = useState('24');
  const [saving, setSaving] = useState(false);
  const [hidden, setHidden] = useState(false);

  const apply = (settings: TopicGuardSettings) => {
    setSaved(settings);
    setKeywordsText(settings.customOffTopicKeywords.join('\n'));
    setCodeChars(String(settings.codeExemptMinChars));
    setWindowHours(String(settings.strikeWindowHours));
  };

  const load = useCallback(async () => {
    try {
      const res = await fetch('/ai-helper/admin/config', { credentials: 'include', headers: { Accept: 'application/json' } });
      if (res.status === 403) { setHidden(true); return; }
      if (!res.ok) throw new Error(i18n('ai_helper_safety_offtopic_load_failed'));
      const json = await res.json();
      apply({ ...DEFAULT_TOPIC_GUARD, ...(json?.config?.topicGuardConfig || {}) });
    } catch (err) {
      showToast(err instanceof Error && err.message ? err.message : i18n('ai_helper_safety_offtopic_load_failed'), 'error');
    }
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  if (hidden) return null;

  const parsed = parseTopicGuardForm({ keywordsText, codeChars, windowHours });
  const dirty = !!saved && !sameTopicGuard(parsed.settings, saved);
  const blocked = parsed.errors.length > 0;

  const save = async () => {
    if (blocked) return;
    setSaving(true);
    try {
      const res = await fetch('/ai-helper/admin/config', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify({ topicGuardConfig: parsed.settings }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || i18n('ai_helper_safety_offtopic_save_failed'));
      apply({ ...DEFAULT_TOPIC_GUARD, ...(json?.config?.topicGuardConfig || parsed.settings) });
      showToast(i18n('ai_helper_safety_offtopic_saved'), 'success');
    } catch (err) {
      showToast(err instanceof Error && err.message ? err.message : i18n('ai_helper_safety_offtopic_save_failed'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const numberInput = (id: string, value: string, onChange: (value: string) => void, invalid: boolean) => (
    <input
      id={id}
      type="number"
      inputMode="numeric"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      aria-invalid={invalid}
      disabled={!saved || saving}
      style={{ ...getInputStyle(), width: '110px', borderColor: invalid ? COLORS.error : COLORS.border }}
    />
  );

  return (
    <div style={cardStyle}>
      <div style={{ marginBottom: SPACING.base }}>
        <h2 style={{ ...TYPOGRAPHY.md, color: COLORS.textPrimary, margin: 0 }}>{i18n('ai_helper_safety_offtopic_title')}</h2>
        <p style={{ ...TYPOGRAPHY.xs, color: COLORS.textMuted, margin: `${SPACING.xs} 0 0` }}>{i18n('ai_helper_safety_offtopic_desc')}</p>
      </div>

      <label htmlFor="ai-safety-offtopic-keywords" style={{ ...TYPOGRAPHY.sm, fontWeight: 600, color: COLORS.textSecondary, display: 'block', marginBottom: SPACING.xs }}>
        {i18n('ai_helper_safety_offtopic_keywords')}
      </label>
      <textarea
        id="ai-safety-offtopic-keywords"
        value={keywordsText}
        onChange={(event) => setKeywordsText(event.target.value)}
        placeholder={i18n('ai_helper_safety_offtopic_keywords_placeholder')}
        disabled={!saved || saving}
        rows={6}
        style={{ ...getInputStyle(), resize: 'vertical' }}
      />
      <div style={{ ...TYPOGRAPHY.xs, color: COLORS.textMuted, marginTop: SPACING.xs }}>
        {i18n('ai_helper_safety_offtopic_keywords_hint', parsed.settings.customOffTopicKeywords.length, MAX_OFF_TOPIC_KEYWORDS, MAX_OFF_TOPIC_KEYWORD_LENGTH)}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: SPACING.base, marginTop: SPACING.base }}>
        <div>
          <label htmlFor="ai-safety-offtopic-code" style={{ ...TYPOGRAPHY.sm, fontWeight: 600, color: COLORS.textSecondary, display: 'block', marginBottom: SPACING.xs }}>
            {i18n('ai_helper_safety_offtopic_code_chars')}
          </label>
          {numberInput('ai-safety-offtopic-code', codeChars, setCodeChars, parsed.errors.includes('code_chars'))}
          <div style={{ ...TYPOGRAPHY.xs, color: COLORS.textMuted, marginTop: SPACING.xs }}>{i18n('ai_helper_safety_offtopic_code_chars_hint')}</div>
        </div>
        <div>
          <label htmlFor="ai-safety-offtopic-window" style={{ ...TYPOGRAPHY.sm, fontWeight: 600, color: COLORS.textSecondary, display: 'block', marginBottom: SPACING.xs }}>
            {i18n('ai_helper_safety_offtopic_window')}
          </label>
          {numberInput('ai-safety-offtopic-window', windowHours, setWindowHours, parsed.errors.includes('window'))}
          <div style={{ ...TYPOGRAPHY.xs, color: COLORS.textMuted, marginTop: SPACING.xs }}>{i18n('ai_helper_safety_offtopic_window_hint')}</div>
        </div>
      </div>

      {parsed.errors.length > 0 && (
        <div style={{ marginTop: SPACING.md, padding: SPACING.sm, borderRadius: RADIUS.md, background: COLORS.errorBg, color: COLORS.errorText, fontSize: '13px' }}>
          {parsed.errors.map((error) => i18n(ERROR_KEYS[error], MAX_OFF_TOPIC_KEYWORDS, MAX_OFF_TOPIC_KEYWORD_LENGTH)).join('；')}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: SPACING.sm, flexWrap: 'wrap', marginTop: SPACING.base }}>
        <button type="button" onClick={() => saved && apply(saved)} disabled={!dirty || saving} style={getButtonStyle('secondary')}>
          {i18n('ai_helper_safety_rules_discard')}
        </button>
        <button type="button" onClick={save} disabled={!dirty || blocked || saving} style={getButtonStyle('primary')}>
          {saving ? i18n('ai_helper_safety_rules_saving') : i18n('ai_helper_safety_rules_save')}
        </button>
      </div>
    </div>
  );
};

export default OffTopicRulesCard;
