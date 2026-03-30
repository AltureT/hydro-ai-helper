import React from 'react';
import {
  COLORS, SPACING, RADIUS, TYPOGRAPHY,
} from '../utils/styles';
import type { TelemetryStatus } from './configTypes';

interface TelemetrySettingsProps {
  telemetry: TelemetryStatus | null;
  onToggle: (enabled: boolean) => void;
  disabled: boolean;
}

export const TelemetrySettings: React.FC<TelemetrySettingsProps> = ({ telemetry, onToggle, disabled }) => {
  if (!telemetry) return null;

  return (
    <div style={{
      marginTop: '20px', padding: '20px', backgroundColor: COLORS.bgPage,
      borderRadius: RADIUS.md, border: `1px solid ${COLORS.border}`
    }}>
      <h2 style={{ marginTop: 0, marginBottom: SPACING.sm, ...TYPOGRAPHY.md, color: COLORS.textPrimary }}>
        遥测设置
      </h2>
      <p style={{ margin: '0 0 16px', color: COLORS.textMuted, fontSize: '13px' }}>
        匿名使用数据帮助开发者改进插件。不采集学生对话内容、个人信息或 API 密钥。
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: SPACING.base, marginBottom: SPACING.base }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: disabled ? 'not-allowed' : 'pointer' }}>
          <input
            type="checkbox"
            checked={telemetry.enabled}
            onChange={(e) => onToggle(e.target.checked)}
            disabled={disabled}
            style={{ width: '16px', height: '16px' }}
          />
          <span style={{ fontWeight: 500, fontSize: '14px', color: COLORS.textPrimary }}>
            {telemetry.enabled ? '已启用' : '已禁用'}
          </span>
        </label>
      </div>

      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: SPACING.sm,
        padding: SPACING.sm, backgroundColor: COLORS.bgCard, borderRadius: RADIUS.sm,
        fontSize: '13px', color: COLORS.textMuted
      }}>
        <div>
          <span style={{ fontWeight: 500 }}>实例 ID: </span>
          <code style={{ fontSize: '12px' }}>...{telemetry.instanceId}</code>
        </div>
        <div>
          <span style={{ fontWeight: 500 }}>版本: </span>
          v{telemetry.version}
        </div>
        <div>
          <span style={{ fontWeight: 500 }}>最后上报: </span>
          {telemetry.lastReportAt
            ? new Date(telemetry.lastReportAt).toLocaleString()
            : '从未'}
        </div>
      </div>

      <details style={{ marginTop: SPACING.sm }}>
        <summary style={{ cursor: 'pointer', fontSize: '13px', color: COLORS.textMuted }}>
          采集了哪些数据？
        </summary>
        <ul style={{ margin: '8px 0 0', paddingLeft: '20px', fontSize: '13px', color: COLORS.textMuted, lineHeight: 1.6 }}>
          <li>活跃用户数（7天内）、对话总数</li>
          <li>API 成功/失败率、平均响应时间</li>
          <li>插件版本、运行环境（Node.js 版本、操作系统）</li>
          <li>启用的功能（预算限制、多端点等）</li>
          <li>错误类型和频率（不含具体内容）</li>
        </ul>
      </details>
    </div>
  );
};
