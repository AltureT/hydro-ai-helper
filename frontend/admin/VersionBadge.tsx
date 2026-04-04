/**
 * VersionBadge - 版本徽章组件
 *
 * T053-T055: 显示插件版本信息和更新提示
 * - 显示当前安装版本
 * - 自动检测是否有新版本
 * - 提供跳转到发布页面的链接
 * - 支持一键更新功能
 */

import React, { useState, useEffect, useRef } from 'react';
import { i18n } from 'vj/utils';
import { buildApiUrl } from '../utils/domainUtils';
import {
  COLORS, SPACING, RADIUS, SHADOWS, TRANSITIONS, ANIMATIONS, TYPOGRAPHY, FONT_FAMILY,
  cardStyle, getButtonStyle, getAlertStyle, getBadgeStyle,
  modalOverlayStyle, modalContentStyle,
} from '../utils/styles';

interface VersionCheckResponse {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseUrl: string;
  releaseNotes?: string;
  checkedAt: string;
  fromCache: boolean;
  source?: string;
}

interface UpdateInfoResponse {
  path: string;
  isValid: boolean;
  message: string;
}

interface UpdateResultResponse {
  success: boolean;
  step: string;
  message: string;
  logs: string[];
  pluginPath?: string;
  error?: string;
}

interface UpdateProgressResponse {
  status: 'idle' | 'running' | 'completed' | 'failed';
  step: string;
  message: string;
  logs: string[];
  pluginPath: string;
  startedAt?: string;
  updatedAt: string;
  error?: string;
}

type LoadingState = 'idle' | 'loading' | 'success' | 'error';
type UpdateState = 'idle' | 'confirming' | 'updating' | 'success' | 'error';

export const VersionBadge: React.FC = () => {
  const [state, setState] = useState<LoadingState>('idle');
  const [versionInfo, setVersionInfo] = useState<VersionCheckResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [updateState, setUpdateState] = useState<UpdateState>('idle');
  const [updateInfo, setUpdateInfo] = useState<UpdateInfoResponse | null>(null);
  const [updateLogs, setUpdateLogs] = useState<string[]>([]);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const pollTimerRef = useRef<number | null>(null);

  const stopPollingProgress = () => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  useEffect(() => {
    fetchVersionInfo();
    return () => {
      stopPollingProgress();
    };
  }, []);

  const fetchVersionInfo = async (forceRefresh = false) => {
    setState('loading');
    setError(null);

    try {
      const url = buildApiUrl(`/ai-helper/version/check${forceRefresh ? '?refresh=true' : ''}`);
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data: VersionCheckResponse = await response.json();
      setVersionInfo(data);
      setState('success');
    } catch (err) {
      console.error('[VersionBadge] Failed to fetch version info:', err);
      setError(err instanceof Error ? err.message : i18n('ai_helper_version_check_failed'));
      setState('error');
    }
  };

  const fetchUpdateInfo = async (): Promise<UpdateInfoResponse | null> => {
    try {
      const url = buildApiUrl('/ai-helper/admin/update/info');
      const response = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        credentials: 'include'
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return await response.json();
    } catch (err) {
      console.error('[VersionBadge] Failed to fetch update info:', err);
      return null;
    }
  };

  const handleUpdateClick = async () => {
    const info = await fetchUpdateInfo();
    setUpdateInfo(info);
    setUpdateState('confirming');
    setUpdateLogs([]);
    setUpdateError(null);
  };

  const handleCancelUpdate = () => {
    stopPollingProgress();
    setUpdateState('idle');
    setUpdateInfo(null);
    setUpdateLogs([]);
    setUpdateError(null);
  };

  const fetchUpdateProgress = async (): Promise<UpdateProgressResponse | null> => {
    try {
      const url = buildApiUrl('/ai-helper/admin/update');
      const response = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        credentials: 'include'
      });

      if (!response.ok) {
        return null;
      }

      return await response.json();
    } catch (err) {
      return null;
    }
  };

  const handleConfirmUpdate = async () => {
    setUpdateState('updating');
    setUpdateLogs([i18n('ai_helper_admin_version_waiting_output')]);
    setUpdateError(null);

    const startedAtMs = Date.now();
    let matchedThisRun = false;

    stopPollingProgress();
    const pollOnce = async () => {
      const progress = await fetchUpdateProgress();
      if (!progress) return;

      const progressStartedAt = progress.startedAt ? Date.parse(progress.startedAt) : NaN;
      if (!matchedThisRun && Number.isFinite(progressStartedAt)) {
        matchedThisRun = progressStartedAt >= startedAtMs - 5000;
      }

      if (!matchedThisRun) {
        if (progress.status === 'running') {
          matchedThisRun = true;
        } else {
          return;
        }
      }

      if (progress.logs && progress.logs.length > 0) {
        setUpdateLogs(progress.logs);
      } else if (progress.status === 'running') {
        setUpdateLogs([`[${progress.step}] ${progress.message}`]);
      }

      if (progress.status === 'completed') {
        stopPollingProgress();
        setUpdateState('success');
        setUpdateLogs(progress.logs || []);
        setTimeout(() => {
          window.location.reload();
        }, 20000);
      } else if (progress.status === 'failed') {
        stopPollingProgress();
        setUpdateState('error');
        setUpdateLogs(progress.logs || []);
        setUpdateError(progress.error || progress.message || i18n('ai_helper_update_failed'));
      }
    };

    void pollOnce();
    pollTimerRef.current = window.setInterval(pollOnce, 1000);

    try {
      const url = buildApiUrl('/ai-helper/admin/update');
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest'
        },
        credentials: 'include'
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        const progress = await fetchUpdateProgress();
        if (progress?.status === 'running') {
          setUpdateLogs((prev) => [
            ...prev,
            i18n('ai_helper_admin_version_server_error_continuing', response.status)
          ]);
          return;
        }

        stopPollingProgress();
        setUpdateState('error');
        setUpdateLogs([`${i18n('ai_helper_admin_version_server_error')}: ${response.status} ${response.statusText}`]);
        setUpdateError(errorText || `HTTP ${response.status}`);
        return;
      }

      const result: UpdateResultResponse = await response.json().catch(() => ({ success: true } as any));
      if (result && result.success === false) {
        stopPollingProgress();
        setUpdateState('error');
        setUpdateLogs(result.logs || []);
        setUpdateError(result.error || result.message || i18n('ai_helper_update_failed'));
      }
    } catch (err) {
      console.error('[VersionBadge] Update failed:', err);
      const progress = await fetchUpdateProgress();
      if (progress?.status === 'running') {
        setUpdateLogs((prev) => [...prev, i18n('ai_helper_admin_version_connection_lost')]);
        return;
      }

      stopPollingProgress();
      setUpdateState('error');
      setUpdateError(err instanceof Error ? err.message : i18n('ai_helper_admin_version_update_request_failed'));
    }
  };

  const formatCheckedAt = (isoString: string): string => {
    const date = new Date(isoString);
    const locale = (typeof window !== 'undefined' && (window as any).LOCALES?.__id) || 'zh';
    return date.toLocaleString(locale, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const renderUpdateModal = () => {
    if (updateState === 'idle') return null;

    return (
      <div style={modalOverlayStyle}>
        <div style={{
          ...modalContentStyle,
          maxWidth: '600px',
          maxHeight: '80vh',
          overflow: 'auto',
        }}>
          <h3 style={{
            margin: `0 0 ${SPACING.base} 0`,
            ...TYPOGRAPHY.md,
            color: COLORS.textPrimary,
          }}>
            {updateState === 'confirming' && i18n('ai_helper_admin_version_confirm_title')}
            {updateState === 'updating' && i18n('ai_helper_admin_version_updating')}
            {updateState === 'success' && i18n('ai_helper_admin_version_update_success')}
            {updateState === 'error' && i18n('ai_helper_admin_version_update_failed_title')}
          </h3>

          {updateState === 'confirming' && (
            <>
              <div style={{
                ...getAlertStyle('warning'),
                marginBottom: SPACING.base,
              }}>
                <div style={{ fontWeight: 500, marginBottom: SPACING.sm }}>
                  {i18n('ai_helper_admin_version_notice_title')}
                </div>
                <ul style={{
                  margin: 0,
                  paddingLeft: '20px',
                  fontSize: '14px'
                }}>
                  <li>{i18n('ai_helper_admin_version_notice_1')}</li>
                  <li>{i18n('ai_helper_admin_version_notice_2')}</li>
                  <li>{i18n('ai_helper_admin_version_notice_3')}</li>
                </ul>
              </div>

              {updateInfo && (
                <div style={{
                  background: COLORS.bgPage,
                  borderRadius: RADIUS.md,
                  padding: SPACING.md,
                  marginBottom: SPACING.base,
                  fontSize: '14px'
                }}>
                  <div style={{ marginBottom: SPACING.xs }}>
                    <span style={{ color: COLORS.textMuted }}>{i18n('ai_helper_admin_version_plugin_path')}: </span>
                    <code style={{ color: COLORS.textPrimary }}>{updateInfo.path}</code>
                  </div>
                  <div>
                    <span style={{ color: COLORS.textMuted }}>{i18n('ai_helper_admin_version_status')}: </span>
                    <span style={{ color: updateInfo.isValid ? COLORS.success : COLORS.error }}>
                      {updateInfo.message}
                    </span>
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', gap: SPACING.md, justifyContent: 'flex-end' }}>
                <button
                  onClick={handleCancelUpdate}
                  style={getButtonStyle('secondary')}
                >
                  {i18n('ai_helper_admin_version_cancel')}
                </button>
                <button
                  onClick={handleConfirmUpdate}
                  disabled={!updateInfo?.isValid}
                  style={{
                    ...getButtonStyle('primary'),
                    opacity: updateInfo?.isValid ? 1 : 0.5,
                    cursor: updateInfo?.isValid ? 'pointer' : 'not-allowed',
                  }}
                >
                  {i18n('ai_helper_admin_version_confirm')}
                </button>
              </div>
            </>
          )}

          {updateState === 'updating' && (
            <div>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: SPACING.md,
                marginBottom: SPACING.base,
              }}>
                <div style={{
                  width: '24px',
                  height: '24px',
                  border: `3px solid ${COLORS.border}`,
                  borderTop: `3px solid ${COLORS.primary}`,
                  borderRadius: '50%',
                  animation: ANIMATIONS.spin,
                }} />
                <span style={{ color: COLORS.textPrimary }}>{i18n('ai_helper_admin_version_do_not_close')}</span>
              </div>
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
              {renderLogs()}
            </div>
          )}

          {updateState === 'success' && (
            <div>
              <div style={{
                ...getAlertStyle('success'),
                marginBottom: SPACING.base,
              }}>
                <div style={{ fontWeight: 500 }}>
                  {i18n('ai_helper_admin_version_success_message')}
                </div>
              </div>
              {renderLogs()}
            </div>
          )}

          {updateState === 'error' && (
            <div>
              <div style={{
                ...getAlertStyle('error'),
                marginBottom: SPACING.base,
              }}>
                <div style={{ fontWeight: 500, marginBottom: SPACING.sm }}>
                  {i18n('ai_helper_admin_version_update_failed_title')}
                </div>
                <div style={{ fontSize: '14px' }}>
                  {updateError}
                </div>
              </div>
              {renderLogs()}
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: SPACING.base }}>
                <button
                  onClick={handleCancelUpdate}
                  style={getButtonStyle('secondary')}
                >
                  {i18n('ai_helper_admin_version_close')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderLogs = () => {
    if (updateLogs.length === 0) return null;

    return (
      <div style={{
        background: '#1f2937',
        borderRadius: RADIUS.md,
        padding: SPACING.md,
        maxHeight: '200px',
        overflow: 'auto',
        fontFamily: 'monospace',
        fontSize: '12px'
      }}>
        {updateLogs.map((log, i) => (
          <div key={i} style={{ color: '#d1d5db', marginBottom: SPACING.xs }}>
            {log}
          </div>
        ))}
      </div>
    );
  };

  return (
    <>
      <div style={{
        ...cardStyle,
        marginBottom: '20px',
      }}>
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: SPACING.md,
        }}>
          <h3 style={{
            margin: 0,
            fontSize: '16px',
            fontWeight: 600,
            color: COLORS.textPrimary,
          }}>
            {i18n('ai_helper_admin_version_title')}
          </h3>
          <button
            onClick={() => fetchVersionInfo(true)}
            disabled={state === 'loading'}
            style={{
              ...getButtonStyle('ghost'),
              padding: `${SPACING.xs} ${SPACING.sm}`,
              fontSize: '12px',
              border: `1px solid ${COLORS.border}`,
              cursor: state === 'loading' ? 'not-allowed' : 'pointer',
            }}
          >
            {state === 'loading' ? i18n('ai_helper_admin_version_checking') : i18n('ai_helper_admin_version_refresh')}
          </button>
        </div>

        {state === 'loading' && !versionInfo && (
          <div style={{ color: COLORS.textMuted, fontSize: '14px' }}>
            {i18n('ai_helper_admin_version_checking_full')}
          </div>
        )}

        {state === 'error' && (
          <div style={getAlertStyle('error')}>
            {i18n('ai_helper_version_check_failed')}: {error}
          </div>
        )}

        {versionInfo && (
          <div>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: SPACING.sm,
              marginBottom: SPACING.sm,
            }}>
              <span style={{ fontSize: '14px', color: COLORS.textMuted }}>{i18n('ai_helper_admin_version_current')}:</span>
              <span style={{
                fontSize: '14px',
                fontWeight: 600,
                color: COLORS.textPrimary,
                fontFamily: 'monospace'
              }}>
                v{versionInfo.currentVersion}
              </span>
            </div>

            {versionInfo.hasUpdate ? (
              <div style={{
                ...getAlertStyle('warning'),
                marginTop: SPACING.md,
              }}>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: SPACING.sm,
                  marginBottom: SPACING.sm,
                }}>
                  <span style={{
                    fontSize: '14px',
                    fontWeight: 600,
                  }}>
                    {i18n('ai_helper_admin_version_new_available')}
                  </span>
                </div>
                <div style={{
                  fontSize: '14px',
                  marginBottom: '10px'
                }}>
                  {i18n('ai_helper_admin_version_latest')}: <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>
                    v{versionInfo.latestVersion}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: SPACING.sm }}>
                  <button
                    onClick={handleUpdateClick}
                    style={getButtonStyle('primary')}
                  >
                    {i18n('ai_helper_admin_version_one_click_update')}
                  </button>
                  <a
                    href={versionInfo.releaseUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      ...getButtonStyle('secondary'),
                      textDecoration: 'none',
                    }}
                  >
                    {i18n('ai_helper_admin_version_view_release')}
                  </a>
                </div>
              </div>
            ) : (
              <div style={{
                ...getAlertStyle('success'),
                marginTop: SPACING.md,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: SPACING.sm }}>
                  <span style={{ fontSize: '14px' }}>{'\u2713'}</span>
                  <span style={{ fontSize: '14px' }}>
                    {i18n('ai_helper_admin_version_up_to_date')}
                  </span>
                </div>
                <button
                  onClick={handleUpdateClick}
                  style={{
                    ...getButtonStyle('ghost'),
                    padding: `${SPACING.xs} ${SPACING.sm}`,
                    fontSize: '12px',
                    border: `1px solid ${COLORS.successBorder}`,
                    color: COLORS.successText,
                  }}
                >
                  {i18n('ai_helper_admin_version_force_update')}
                </button>
              </div>
            )}

            <div style={{
              fontSize: '12px',
              color: COLORS.textMuted,
              marginTop: '10px',
              display: 'flex',
              alignItems: 'center',
              gap: SPACING.xs,
              flexWrap: 'wrap'
            }}>
              <span>{i18n('ai_helper_admin_version_last_checked')}: {formatCheckedAt(versionInfo.checkedAt)}</span>
              {versionInfo.source && (
                <span style={getBadgeStyle('info')}>
                  {versionInfo.source}
                </span>
              )}
              {versionInfo.fromCache && (
                <span style={{
                  background: COLORS.bgHover,
                  color: COLORS.textSecondary,
                  padding: '2px 6px',
                  borderRadius: RADIUS.sm,
                  fontSize: '11px'
                }}>
                  {i18n('ai_helper_admin_version_cached')}
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {renderUpdateModal()}
    </>
  );
};

export default VersionBadge;
