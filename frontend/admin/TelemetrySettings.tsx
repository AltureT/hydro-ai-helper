import React from 'react';
import { i18n } from 'vj/utils';
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
        {i18n('ai_helper_admin_telemetry_title')}
      </h2>
      <p style={{ margin: '0 0 16px', color: COLORS.textMuted, fontSize: '13px' }}>
        {i18n('ai_helper_admin_telemetry_desc')}
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
            {telemetry.enabled ? i18n('ai_helper_admin_telemetry_enabled') : i18n('ai_helper_admin_telemetry_disabled')}
          </span>
        </label>
      </div>

      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: SPACING.sm,
        padding: SPACING.sm, backgroundColor: COLORS.bgCard, borderRadius: RADIUS.sm,
        fontSize: '13px', color: COLORS.textMuted
      }}>
        <div>
          <span style={{ fontWeight: 500 }}>{i18n('ai_helper_admin_telemetry_instance_id')}: </span>
          <code style={{ fontSize: '12px' }}>...{telemetry.instanceId}</code>
        </div>
        <div>
          <span style={{ fontWeight: 500 }}>{i18n('ai_helper_admin_telemetry_version')}: </span>
          v{telemetry.version}
        </div>
        <div>
          <span style={{ fontWeight: 500 }}>{i18n('ai_helper_admin_telemetry_last_report')}: </span>
          {telemetry.lastReportAt
            ? new Date(telemetry.lastReportAt).toLocaleString()
            : i18n('ai_helper_admin_telemetry_never')}
        </div>
      </div>

      <details style={{ marginTop: SPACING.sm }}>
        <summary style={{ cursor: 'pointer', fontSize: '13px', color: COLORS.textMuted }}>
          {i18n('ai_helper_admin_telemetry_what_collected')}
        </summary>
        <ul style={{ margin: '8px 0 0', paddingLeft: '20px', fontSize: '13px', color: COLORS.textMuted, lineHeight: 1.6 }}>
          <li>{i18n('ai_helper_admin_telemetry_data_1')}</li>
          <li>{i18n('ai_helper_admin_telemetry_data_2')}</li>
          <li>{i18n('ai_helper_admin_telemetry_data_3')}</li>
          <li>{i18n('ai_helper_admin_telemetry_data_4')}</li>
          <li>{i18n('ai_helper_admin_telemetry_data_5')}</li>
        </ul>
      </details>
    </div>
  );
};
