/**
 * 额度与信誉（设计稿“额度与信誉”）
 * 全局设置（每日默认次数、重置时区、保底次数）、额度组、个人覆盖、信誉规则。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { i18n } from '../utils/i18n';
import {
  COLORS,
  SPACING,
  cardStyle,
  getAlertStyle,
  getButtonStyle,
  getInputStyle,
} from '../utils/styles';
import { errorMessage, getJson } from './userManagementApi';
import { LoadingState, labelStyle, mutedTextStyle } from './userManagementUi';
import { QuotaGroupsSection } from './QuotaGroupsSection';
import { QuotaOverridesSection } from './QuotaOverridesSection';
import { CreditRulesSection } from './CreditRulesSection';
import { DEFAULT_CREDIT_RULES, type CreditRules } from './creditLogic';

interface QuotaConfigView {
  dailyMessageLimit: number;
  timezone: string;
  guaranteeCount: number;
  credit?: CreditRules;
}

/** 写入 quotaConfig 的部分字段，返回保存后的完整配置 */
async function putQuotaConfig(patch: Record<string, unknown>): Promise<QuotaConfigView | undefined> {
  const res = await fetch('/ai-helper/admin/config', {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: JSON.stringify({ quotaConfig: patch }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.code === 'INVALID_TIMEZONE'
      ? i18n('ai_helper_um_quota_tz_invalid')
      : body?.error || i18n('ai_helper_um_quota_save_failed'));
  }
  return body?.config?.quotaConfig as QuotaConfigView | undefined;
}

interface ConfigResponse {
  config: { quotaConfig?: QuotaConfigView } | null;
}

const COMMON_TIMEZONES = ['Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Singapore', 'Asia/Tokyo', 'UTC'];

function supportedTimezones(): string[] {
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    const all = intl.supportedValuesOf?.('timeZone');
    if (all?.length) return [...new Set([...COMMON_TIMEZONES, ...all])];
  } catch { /* 旧浏览器 */ }
  return COMMON_TIMEZONES;
}

/** 该时区下一次 00:00 在浏览器本地时间的表示，用于提示 */
function localMidnightHint(timezone: string): string | null {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    return null;
  }
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (local === timezone) return null;
  return i18n('ai_helper_um_quota_tz_local_hint', local);
}

export const QuotaPanel: React.FC<{
  domainId: string;
  showToast: (text: string, type?: 'success' | 'warning' | 'error' | 'info') => void;
}> = ({ domainId, showToast }) => {
  const [saved, setSaved] = useState<QuotaConfigView | null>(null);
  const [limitText, setLimitText] = useState('0');
  const [timezone, setTimezone] = useState('Asia/Shanghai');
  const [guaranteeText, setGuaranteeText] = useState('3');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const timezones = useMemo(supportedTimezones, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await getJson<ConfigResponse>('/ai-helper/admin/config', i18n('ai_helper_um_quota_load_failed'));
      const quota = res.config?.quotaConfig || { dailyMessageLimit: 0, timezone: 'Asia/Shanghai', guaranteeCount: 3 };
      setSaved(quota);
      setLimitText(String(quota.dailyMessageLimit));
      setTimezone(quota.timezone);
      setGuaranteeText(String(quota.guaranteeCount ?? 3));
    } catch (err) {
      setLoadError(errorMessage(err, i18n('ai_helper_um_quota_load_failed')));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const limitValue = /^\d+$/.test(limitText.trim()) ? Number(limitText.trim()) : NaN;
  const limitInvalid = !Number.isInteger(limitValue) || limitValue < 0 || limitValue > 100000;
  const guaranteeValue = /^\d+$/.test(guaranteeText.trim()) ? Number(guaranteeText.trim()) : NaN;
  const guaranteeInvalid = !Number.isInteger(guaranteeValue) || guaranteeValue < 0 || guaranteeValue > 1000;
  const dirty = !!saved && (
    limitValue !== saved.dailyMessageLimit || timezone.trim() !== saved.timezone || guaranteeValue !== saved.guaranteeCount
  );

  const applySaved = (quota: QuotaConfigView | undefined) => {
    if (!quota) return;
    setSaved(quota);
    setLimitText(String(quota.dailyMessageLimit));
    setTimezone(quota.timezone);
    setGuaranteeText(String(quota.guaranteeCount ?? 3));
  };

  const saveCreditRules = async (rules: CreditRules) => {
    applySaved(await putQuotaConfig({ credit: rules }));
    showToast(i18n('ai_helper_um_credit_rules_saved'), 'success');
  };

  const save = async () => {
    if (limitInvalid || guaranteeInvalid) return;
    setSaving(true);
    setSaveError(null);
    try {
      applySaved(await putQuotaConfig({ dailyMessageLimit: limitValue, timezone: timezone.trim(), guaranteeCount: guaranteeValue }));
      showToast(i18n('ai_helper_um_quota_saved'), 'success');
    } catch (err) {
      setSaveError(errorMessage(err, i18n('ai_helper_um_quota_save_failed')));
    } finally {
      setSaving(false);
    }
  };

  const tzHint = localMidnightHint(timezone.trim());

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: SPACING.base }}>
      <section style={{ ...cardStyle, padding: SPACING.lg }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: SPACING.sm, flexWrap: 'wrap', marginBottom: SPACING.base }}>
          <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 650, color: COLORS.textPrimary }}>{i18n('ai_helper_um_quota_global_title')}</h3>
          <span style={mutedTextStyle}>{i18n('ai_helper_um_quota_global_subtitle')}</span>
        </div>

        {loadError && (
          <div style={{ ...getAlertStyle('error'), marginBottom: SPACING.md, display: 'flex', gap: SPACING.sm, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ flex: 1 }}>{loadError}</span>
            <button type="button" style={getButtonStyle('secondary')} onClick={load}>{i18n('ai_helper_um_retry')}</button>
          </div>
        )}

        {loading && !saved && <LoadingState label={i18n('ai_helper_um_loading')} />}

        {saved && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: SPACING.lg }}>
              <div>
                <label style={{ ...labelStyle, display: 'block' }} htmlFor="ai-um-quota-limit">{i18n('ai_helper_um_quota_daily_limit')}</label>
                <input
                  id="ai-um-quota-limit"
                  type="number"
                  min={0}
                  max={100000}
                  step={1}
                  inputMode="numeric"
                  value={limitText}
                  onChange={(event) => setLimitText(event.target.value)}
                  aria-invalid={limitInvalid}
                  style={{ ...getInputStyle(), marginTop: '6px', maxWidth: '160px', borderColor: limitInvalid ? COLORS.error : COLORS.border }}
                />
                <div style={{ ...mutedTextStyle, marginTop: '4px', color: limitInvalid ? COLORS.errorText : COLORS.textMuted }}>
                  {limitInvalid ? i18n('ai_helper_um_quota_limit_invalid') : i18n('ai_helper_um_quota_daily_limit_hint')}
                </div>
              </div>
              <div>
                <label style={{ ...labelStyle, display: 'block' }} htmlFor="ai-um-quota-tz">{i18n('ai_helper_um_quota_timezone')}</label>
                <input
                  id="ai-um-quota-tz"
                  list="ai-um-quota-tz-list"
                  value={timezone}
                  onChange={(event) => setTimezone(event.target.value)}
                  style={{ ...getInputStyle(), marginTop: '6px', maxWidth: '260px' }}
                />
                <datalist id="ai-um-quota-tz-list">
                  {timezones.map((tz) => <option key={tz} value={tz} />)}
                </datalist>
                <div style={{ ...mutedTextStyle, marginTop: '4px' }}>
                  {i18n('ai_helper_um_quota_timezone_hint')}{tzHint ? ` ${tzHint}` : ''}
                </div>
              </div>
              <div>
                <label style={{ ...labelStyle, display: 'block' }} htmlFor="ai-um-quota-guarantee">{i18n('ai_helper_um_quota_guarantee')}</label>
                <input
                  id="ai-um-quota-guarantee"
                  type="number"
                  min={0}
                  max={1000}
                  step={1}
                  inputMode="numeric"
                  value={guaranteeText}
                  onChange={(event) => setGuaranteeText(event.target.value)}
                  aria-invalid={guaranteeInvalid}
                  style={{ ...getInputStyle(), marginTop: '6px', maxWidth: '160px', borderColor: guaranteeInvalid ? COLORS.error : COLORS.border }}
                />
                <div style={{ ...mutedTextStyle, marginTop: '4px', color: guaranteeInvalid ? COLORS.errorText : COLORS.textMuted }}>
                  {guaranteeInvalid ? i18n('ai_helper_um_quota_guarantee_invalid') : i18n('ai_helper_um_quota_guarantee_hint')}
                </div>
              </div>
            </div>

            <div style={{ ...getAlertStyle('info'), marginTop: SPACING.lg }}>
              {saved.dailyMessageLimit > 0
                ? i18n('ai_helper_um_quota_current_limited', saved.dailyMessageLimit, saved.timezone)
                : i18n('ai_helper_um_quota_current_unlimited')}
              {saved.dailyMessageLimit === 0 && (
                <div style={{ marginTop: '4px' }}>{i18n('ai_helper_um_quota_unlimited_grant_hint')}</div>
              )}
            </div>

            {saveError && <div style={{ ...getAlertStyle('error'), marginTop: SPACING.md }}>{saveError}</div>}

            <div style={{ display: 'flex', gap: SPACING.sm, marginTop: SPACING.lg, flexWrap: 'wrap' }}>
              <button type="button" disabled={!dirty || limitInvalid || guaranteeInvalid || saving} onClick={save} style={getButtonStyle('primary')}>
                {saving ? i18n('ai_helper_um_saving') : i18n('ai_helper_um_save')}
              </button>
              {dirty && (
                <button
                  type="button"
                  style={getButtonStyle('ghost')}
                  onClick={() => { applySaved(saved); setSaveError(null); }}
                >
                  {i18n('ai_helper_um_cancel')}
                </button>
              )}
            </div>
          </>
        )}
      </section>
      <QuotaGroupsSection domainId={domainId} showToast={showToast} />
      <QuotaOverridesSection domainId={domainId} showToast={showToast} />
      {saved && (
        <CreditRulesSection
          rules={saved.credit || DEFAULT_CREDIT_RULES}
          exampleBase={saved.dailyMessageLimit > 0 ? saved.dailyMessageLimit : 20}
          guaranteeCount={saved.guaranteeCount ?? 3}
          onSave={saveCreditRules}
        />
      )}
    </div>
  );
};

export default QuotaPanel;
