/**
 * 信誉规则（设计稿“额度与信誉”下半部分，FR-035）
 * 每类违规的基础扣分、翻倍窗口、单次上限、下限、每日恢复；示例随设置实时更新。
 */

import React, { useEffect, useMemo, useState } from 'react';
import { i18n } from '../utils/i18n';
import { COLORS, RADIUS, SPACING, cardStyle, getAlertStyle, getButtonStyle, getInputStyle } from '../utils/styles';
import { labelStyle, mutedTextStyle } from './userManagementUi';
import {
  CREDIT_CATEGORIES,
  DEFAULT_CREDIT_RULES,
  creditExample,
  formatMultiplier,
  parseRulesForm,
  rulesToForm,
  sameRules,
  type CreditCategory,
  type CreditRules,
  type CreditRulesField,
  type CreditRulesForm,
} from './creditLogic';

const FIELD_INPUT_WIDTH = '96px';

function NumberField({
  id, label, hint, value, invalid, onChange, suffix,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  invalid: boolean;
  onChange: (value: string) => void;
  suffix?: string;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <label htmlFor={id} style={{ ...labelStyle, display: 'block' }}>{label}</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px' }}>
        <input
          id={id}
          inputMode="decimal"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={invalid}
          style={{ ...getInputStyle(), width: FIELD_INPUT_WIDTH, borderColor: invalid ? COLORS.error : COLORS.border }}
        />
        {suffix && <span style={mutedTextStyle}>{suffix}</span>}
      </div>
      {hint && <div style={{ ...mutedTextStyle, marginTop: '4px' }}>{hint}</div>}
    </div>
  );
}

export const CreditRulesSection: React.FC<{
  rules: CreditRules;
  /** 示例使用的基础次数（全局默认，不限时用 20） */
  exampleBase: number;
  guaranteeCount: number;
  onSave: (rules: CreditRules) => Promise<void>;
}> = ({ rules, exampleBase, guaranteeCount, onSave }) => {
  const [form, setForm] = useState<CreditRulesForm>(() => rulesToForm(rules));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setForm(rulesToForm(rules)); }, [rules]);

  const parsed = useMemo(() => parseRulesForm(form), [form]);
  const parsedRules = 'rules' in parsed ? parsed.rules : null;
  const invalid = new Set<CreditRulesField>('errors' in parsed ? parsed.errors : []);
  const dirty = parsedRules ? !sameRules(parsedRules, rules) : true;
  const example = parsedRules ? creditExample(parsedRules, exampleBase, guaranteeCount) : null;

  const setField = (field: Exclude<CreditRulesField, `weights.${CreditCategory}`>, value: string) => setForm((prev) => ({ ...prev, [field]: value }));
  const setWeight = (category: CreditCategory, value: string) => setForm((prev) => ({ ...prev, weights: { ...prev.weights, [category]: value } }));

  const save = async () => {
    if (!parsedRules) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(parsedRules);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : i18n('ai_helper_um_credit_rules_save_failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section style={{ ...cardStyle, padding: SPACING.lg }} aria-labelledby="ai-um-credit-rules-title">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: SPACING.sm, flexWrap: 'wrap', marginBottom: SPACING.base }}>
        <h3 id="ai-um-credit-rules-title" style={{ margin: 0, fontSize: '16px', fontWeight: 650, color: COLORS.textPrimary }}>{i18n('ai_helper_um_credit_rules_title')}</h3>
        <span style={mutedTextStyle}>{i18n('ai_helper_um_credit_rules_subtitle')}</span>
      </div>

      <div style={{ ...labelStyle, marginBottom: '6px' }}>{i18n('ai_helper_um_credit_weights_title')}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: SPACING.md, marginBottom: SPACING.lg }}>
        {CREDIT_CATEGORIES.map((category) => (
          <NumberField
            key={category}
            id={`ai-um-credit-weight-${category}`}
            label={i18n(`ai_helper_admin_jailbreak_category_${category}`)}
            value={form.weights[category]}
            invalid={invalid.has(`weights.${category}`)}
            onChange={(value) => setWeight(category, value)}
          />
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: SPACING.md }}>
        <NumberField
          id="ai-um-credit-window"
          label={i18n('ai_helper_um_credit_window')}
          hint={i18n('ai_helper_um_credit_window_hint')}
          value={form.escalationWindowMinutes}
          invalid={invalid.has('escalationWindowMinutes')}
          onChange={(value) => setField('escalationWindowMinutes', value)}
          suffix={i18n('ai_helper_um_credit_minutes')}
        />
        <NumberField
          id="ai-um-credit-max"
          label={i18n('ai_helper_um_credit_max')}
          value={form.maxDeduction}
          invalid={invalid.has('maxDeduction')}
          onChange={(value) => setField('maxDeduction', value)}
        />
        <NumberField
          id="ai-um-credit-floor"
          label={i18n('ai_helper_um_credit_floor')}
          value={form.floor}
          invalid={invalid.has('floor')}
          onChange={(value) => setField('floor', value)}
        />
        <NumberField
          id="ai-um-credit-recovery"
          label={i18n('ai_helper_um_credit_recovery')}
          hint={i18n('ai_helper_um_credit_recovery_hint')}
          value={form.recoveryPerDay}
          invalid={invalid.has('recoveryPerDay')}
          onChange={(value) => setField('recoveryPerDay', value)}
        />
      </div>

      {!parsedRules && <div style={{ ...mutedTextStyle, color: COLORS.errorText, marginTop: SPACING.sm }}>{i18n('ai_helper_um_credit_rules_invalid')}</div>}

      {example && (
        <div
          aria-live="polite"
          style={{ marginTop: SPACING.lg, padding: SPACING.md, borderRadius: RADIUS.md, background: COLORS.bgPage, fontSize: '14px', lineHeight: 1.7 }}
        >
          <div style={{ ...labelStyle, marginBottom: '4px' }}>{i18n('ai_helper_um_credit_example_title')}</div>
          <div style={{ display: 'flex', gap: SPACING.sm, flexWrap: 'wrap', alignItems: 'center', color: COLORS.textPrimary }}>
            <span>
              {i18n(
                'ai_helper_um_credit_example_events',
                example.base,
                parsedRules ? parsedRules.escalationWindowMinutes : 0,
                example.deductions.map((value) => `−${formatMultiplier(value)}`).join('、'),
              )}
            </span>
            <span aria-hidden="true" style={{ color: COLORS.textMuted }}>→</span>
            <strong>{i18n('ai_helper_um_credit_example_m', formatMultiplier(example.m))}</strong>
            <span aria-hidden="true" style={{ color: COLORS.textMuted }}>→</span>
            <strong>{i18n('ai_helper_um_credit_example_daily', example.daily)}</strong>
            <span aria-hidden="true" style={{ color: COLORS.textMuted }}>→</span>
            <span>
              {example.recoveryDays === null
                ? i18n('ai_helper_um_credit_example_no_recovery')
                : i18n('ai_helper_um_credit_example_recovery', example.recoveryDays)}
            </span>
          </div>
        </div>
      )}

      {error && <div style={{ ...getAlertStyle('error'), marginTop: SPACING.md }}>{error}</div>}

      <div style={{ display: 'flex', gap: SPACING.sm, marginTop: SPACING.lg, flexWrap: 'wrap' }}>
        <button type="button" style={getButtonStyle('primary')} disabled={!parsedRules || !dirty || saving} onClick={save}>
          {saving ? i18n('ai_helper_um_saving') : i18n('ai_helper_um_credit_rules_save')}
        </button>
        <button type="button" style={getButtonStyle('ghost')} disabled={saving} onClick={() => setForm(rulesToForm(DEFAULT_CREDIT_RULES))}>
          {i18n('ai_helper_um_credit_rules_defaults')}
        </button>
      </div>
    </section>
  );
};

export default CreditRulesSection;
