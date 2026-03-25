import React from 'react';
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
    <h2 style={{ marginTop: 0, marginBottom: SPACING.sm, ...TYPOGRAPHY.md, color: COLORS.textPrimary }}>Token 预算控制</h2>
    <p style={{ margin: '0 0 16px', color: COLORS.textMuted, fontSize: '13px' }}>
      限制 AI 调用的 Token 用量，防止成本失控。设为 0 或留空表示不限制。
    </p>

    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SPACING.base }}>
      <div>
        <label style={{ display: 'block', marginBottom: SPACING.xs, fontWeight: 500, fontSize: '14px', color: COLORS.textPrimary }}>每用户日 Token 上限</label>
        <input
          type="number"
          value={budgetConfig.dailyTokenLimitPerUser}
          onChange={(e) => onChange({ dailyTokenLimitPerUser: e.target.value === '' ? '' : Number(e.target.value) })}
          placeholder="0 = 不限制" min="0" disabled={disabled} style={getInputStyle()}
        />
      </div>
      <div>
        <label style={{ display: 'block', marginBottom: SPACING.xs, fontWeight: 500, fontSize: '14px', color: COLORS.textPrimary }}>全站日 Token 上限</label>
        <input
          type="number"
          value={budgetConfig.dailyTokenLimitPerDomain}
          onChange={(e) => onChange({ dailyTokenLimitPerDomain: e.target.value === '' ? '' : Number(e.target.value) })}
          placeholder="0 = 不限制" min="0" disabled={disabled} style={getInputStyle()}
        />
      </div>
      <div>
        <label style={{ display: 'block', marginBottom: SPACING.xs, fontWeight: 500, fontSize: '14px', color: COLORS.textPrimary }}>全站月 Token 上限</label>
        <input
          type="number"
          value={budgetConfig.monthlyTokenLimitPerDomain}
          onChange={(e) => onChange({ monthlyTokenLimitPerDomain: e.target.value === '' ? '' : Number(e.target.value) })}
          placeholder="0 = 不限制" min="0" disabled={disabled} style={getInputStyle()}
        />
      </div>
      <div>
        <label style={{ display: 'block', marginBottom: SPACING.xs, fontWeight: 500, fontSize: '14px', color: COLORS.textPrimary }}>软限阈值 (%)</label>
        <input
          type="number"
          value={budgetConfig.softLimitPercent}
          onChange={(e) => onChange({ softLimitPercent: e.target.value === '' ? '' : Number(e.target.value) })}
          placeholder="80" min="0" max="100" disabled={disabled} style={getInputStyle()}
        />
        <span style={{ fontSize: '12px', color: COLORS.textMuted, marginTop: SPACING.xs, display: 'block' }}>
          达到此百分比时显示警告，100% 时硬拒绝
        </span>
      </div>
    </div>
  </div>
);
