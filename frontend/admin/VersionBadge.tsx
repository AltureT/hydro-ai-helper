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
      setError(err instanceof Error ? err.message : '检查失败');
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
    setUpdateLogs(['等待服务器输出...']);
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
        setUpdateError(progress.error || progress.message || '更新失败');
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
            `服务器响应异常（HTTP ${response.status}），但更新仍在进行，继续等待...`
          ]);
          return;
        }

        stopPollingProgress();
        setUpdateState('error');
        setUpdateLogs([`服务器错误: ${response.status} ${response.statusText}`]);
        setUpdateError(errorText || `HTTP ${response.status}`);
        return;
      }

      const result: UpdateResultResponse = await response.json().catch(() => ({ success: true } as any));
      if (result && result.success === false) {
        stopPollingProgress();
        setUpdateState('error');
        setUpdateLogs(result.logs || []);
        setUpdateError(result.error || result.message || '更新失败');
      }
    } catch (err) {
      console.error('[VersionBadge] Update failed:', err);
      const progress = await fetchUpdateProgress();
      if (progress?.status === 'running') {
        setUpdateLogs((prev) => [...prev, '连接中断（可能正在重启中），继续等待...']);
        return;
      }

      stopPollingProgress();
      setUpdateState('error');
      setUpdateError(err instanceof Error ? err.message : '更新请求失败');
    }
  };

  const formatCheckedAt = (isoString: string): string => {
    const date = new Date(isoString);
    return date.toLocaleString('zh-CN', {
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
            {updateState === 'confirming' && '确认更新插件'}
            {updateState === 'updating' && '正在更新...'}
            {updateState === 'success' && '更新成功'}
            {updateState === 'error' && '更新失败'}
          </h3>

          {updateState === 'confirming' && (
            <>
              <div style={{
                ...getAlertStyle('warning'),
                marginBottom: SPACING.base,
              }}>
                <div style={{ fontWeight: 500, marginBottom: SPACING.sm }}>
                  注意事项
                </div>
                <ul style={{
                  margin: 0,
                  paddingLeft: '20px',
                  fontSize: '14px'
                }}>
                  <li>更新将执行 git pull、npm run build 和 pm2 restart</li>
                  <li>HydroOJ 服务将短暂重启，可能导致数秒服务中断</li>
                  <li>请确保当前没有重要操作正在进行</li>
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
                    <span style={{ color: COLORS.textMuted }}>插件路径: </span>
                    <code style={{ color: COLORS.textPrimary }}>{updateInfo.path}</code>
                  </div>
                  <div>
                    <span style={{ color: COLORS.textMuted }}>状态: </span>
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
                  取消
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
                  确认更新
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
                <span style={{ color: COLORS.textPrimary }}>正在执行更新，请勿关闭页面...</span>
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
                  更新完成！页面将在 20 秒后自动刷新...
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
                  更新失败
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
                  关闭
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
            插件版本
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
            {state === 'loading' ? '检查中...' : '刷新'}
          </button>
        </div>

        {state === 'loading' && !versionInfo && (
          <div style={{ color: COLORS.textMuted, fontSize: '14px' }}>
            正在检查版本...
          </div>
        )}

        {state === 'error' && (
          <div style={getAlertStyle('error')}>
            版本检查失败: {error}
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
              <span style={{ fontSize: '14px', color: COLORS.textMuted }}>当前版本:</span>
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
                    有新版本可用!
                  </span>
                </div>
                <div style={{
                  fontSize: '14px',
                  marginBottom: '10px'
                }}>
                  最新版本: <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>
                    v{versionInfo.latestVersion}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: SPACING.sm }}>
                  <button
                    onClick={handleUpdateClick}
                    style={getButtonStyle('primary')}
                  >
                    一键更新
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
                    查看发布页
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
                    已是最新版本
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
                  覆盖更新
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
              <span>上次检查: {formatCheckedAt(versionInfo.checkedAt)}</span>
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
                  缓存
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
