import React from 'react';
import { i18n } from '@hydrooj/ui-default';
import {
  COLORS, SPACING, RADIUS, TYPOGRAPHY,
  getInputStyle,
} from '../utils/styles';
import type { BudgetConfigState } from './configTypes';

interface BudgetConfigFormProps {
  budgetConfig: BudgetConfigState;
  onChange: (updates: Partial<BudgetConfigState>) => void;
  disabled: boolean;
}

export const BudgetConfigForm: React.FC<BudgetConfigFormProps> = ({ budgetConfig, onChange, disabled }) => (
  <div style={{
    marginTop: '20px', padding: '20px', backgroundColor: COLORS.bgPage,
    borderRadius: RADIUS.md, border: `1px solid ${COLORS.border}`
  }}>
    <h2 style={{ marginTop: 0, marginBottom: SPACING.sm, ...TYPOGRAPHY.md, color: COLORS.textPrimary }}>{i18n('ai_helper_admin_budget_title')}</h2>
    <p style={{ margin: '0 0 16px', color: COLORS.textMuted, fontSize: '13px' }}>
      {i18n('ai_helper_admin_budget_desc')}
    </p>

    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SPACING.base }}>
      <div>
        <label style={{ display: 'block', marginBottom: SPACING.xs, fontWeight: 500, fontSize: '14px', color: COLORS.textPrimary }}>{i18n('ai_helper_admin_budget_daily_user')}</label>
        <input
          type="number"
          value={budgetConfig.dailyTokenLimitPerUser}
          onChange={(e) => onChange({ dailyTokenLimitPerUser: e.target.value === '' ? '' : Number(e.target.value) })}
          placeholder={i18n('ai_helper_admin_budget_no_limit')} min="0" disabled={disabled} style={getInputStyle()}
        />
      </div>
      <div>
        <label style={{ display: 'block', marginBottom: SPACING.xs, fontWeight: 500, fontSize: '14px', color: COLORS.textPrimary }}>{i18n('ai_helper_admin_budget_daily_domain')}</label>
        <input
          type="number"
          value={budgetConfig.dailyTokenLimitPerDomain}
          onChange={(e) => onChange({ dailyTokenLimitPerDomain: e.target.value === '' ? '' : Number(e.target.value) })}
          placeholder={i18n('ai_helper_admin_budget_no_limit')} min="0" disabled={disabled} style={getInputStyle()}
        />
      </div>
      <div>
        <label style={{ display: 'block', marginBottom: SPACING.xs, fontWeight: 500, fontSize: '14px', color: COLORS.textPrimary }}>{i18n('ai_helper_admin_budget_monthly_domain')}</label>
        <input
          type="number"
          value={budgetConfig.monthlyTokenLimitPerDomain}
          onChange={(e) => onChange({ monthlyTokenLimitPerDomain: e.target.value === '' ? '' : Number(e.target.value) })}
          placeholder={i18n('ai_helper_admin_budget_no_limit')} min="0" disabled={disabled} style={getInputStyle()}
        />
      </div>
      <div>
        <label style={{ display: 'block', marginBottom: SPACING.xs, fontWeight: 500, fontSize: '14px', color: COLORS.textPrimary }}>{i18n('ai_helper_admin_budget_soft_limit')}</label>
        <input
          type="number"
          value={budgetConfig.softLimitPercent}
          onChange={(e) => onChange({ softLimitPercent: e.target.value === '' ? '' : Number(e.target.value) })}
          placeholder="80" min="0" max="100" disabled={disabled} style={getInputStyle()}
        />
        <span style={{ fontSize: '12px', color: COLORS.textMuted, marginTop: SPACING.xs, display: 'block' }}>
          {i18n('ai_helper_admin_budget_soft_limit_hint')}
        </span>
      </div>
    </div>
  </div>
);
