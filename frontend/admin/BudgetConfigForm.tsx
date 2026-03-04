import React from 'react';
import type { BudgetConfigState } from './configTypes';

interface BudgetConfigFormProps {
  budgetConfig: BudgetConfigState;
  onChange: (updates: Partial<BudgetConfigState>) => void;
  disabled: boolean;
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px', borderRadius: '6px',
  border: '1px solid #d1d5db', fontSize: '14px', boxSizing: 'border-box'
};

export const BudgetConfigForm: React.FC<BudgetConfigFormProps> = ({ budgetConfig, onChange, disabled }) => (
  <div style={{
    marginTop: '20px', padding: '20px', backgroundColor: '#f9fafb',
    borderRadius: '8px', border: '1px solid #e5e7eb'
  }}>
    <h2 style={{ marginTop: 0, marginBottom: '8px', fontSize: '18px' }}>Token 预算控制</h2>
    <p style={{ margin: '0 0 16px', color: '#6b7280', fontSize: '13px' }}>
      限制 AI 调用的 Token 用量，防止成本失控。设为 0 或留空表示不限制。
    </p>

    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
      <div>
        <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500, fontSize: '14px' }}>每用户日 Token 上限</label>
        <input
          type="number"
          value={budgetConfig.dailyTokenLimitPerUser}
          onChange={(e) => onChange({ dailyTokenLimitPerUser: e.target.value === '' ? '' : Number(e.target.value) })}
          placeholder="0 = 不限制" min="0" disabled={disabled} style={inputStyle}
        />
      </div>
      <div>
        <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500, fontSize: '14px' }}>全站日 Token 上限</label>
        <input
          type="number"
          value={budgetConfig.dailyTokenLimitPerDomain}
          onChange={(e) => onChange({ dailyTokenLimitPerDomain: e.target.value === '' ? '' : Number(e.target.value) })}
          placeholder="0 = 不限制" min="0" disabled={disabled} style={inputStyle}
        />
      </div>
      <div>
        <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500, fontSize: '14px' }}>全站月 Token 上限</label>
        <input
          type="number"
          value={budgetConfig.monthlyTokenLimitPerDomain}
          onChange={(e) => onChange({ monthlyTokenLimitPerDomain: e.target.value === '' ? '' : Number(e.target.value) })}
          placeholder="0 = 不限制" min="0" disabled={disabled} style={inputStyle}
        />
      </div>
      <div>
        <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500, fontSize: '14px' }}>软限阈值 (%)</label>
        <input
          type="number"
          value={budgetConfig.softLimitPercent}
          onChange={(e) => onChange({ softLimitPercent: e.target.value === '' ? '' : Number(e.target.value) })}
          placeholder="80" min="0" max="100" disabled={disabled} style={inputStyle}
        />
        <span style={{ fontSize: '12px', color: '#9ca3af', marginTop: '4px', display: 'block' }}>
          达到此百分比时显示警告，100% 时硬拒绝
        </span>
      </div>
    </div>
  </div>
);
