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

/**
 * 版本检查响应接口
 */
interface VersionCheckResponse {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseUrl: string;
  releaseNotes?: string;
  checkedAt: string;
  fromCache: boolean;
  source?: string;  // 版本来源（Gitee/GitHub）
}

/**
 * 更新信息响应接口
 */
interface UpdateInfoResponse {
  path: string;
  isValid: boolean;
  message: string;
}

/**
 * 更新结果响应接口
 */
interface UpdateResultResponse {
  success: boolean;
  step: string;
  message: string;
  logs: string[];
  pluginPath?: string;
  error?: string;
}

/**
 * 更新进度响应接口（前端轮询用）
 */
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

/**
 * 组件状态
 */
type LoadingState = 'idle' | 'loading' | 'success' | 'error';
type UpdateState = 'idle' | 'confirming' | 'updating' | 'success' | 'error';

/**
 * VersionBadge 组件
 */
export const VersionBadge: React.FC = () => {
  const [state, setState] = useState<LoadingState>('idle');
  const [versionInfo, setVersionInfo] = useState<VersionCheckResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 更新相关状态
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

  /**
   * T054: 组件挂载时获取版本信息
   */
  useEffect(() => {
    fetchVersionInfo();
    return () => {
      stopPollingProgress();
    };
  }, []);

  /**
   * 获取版本信息
   */
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

  /**
   * 获取更新信息（检查路径有效性）
   */
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

  /**
   * 显示更新确认弹窗
   */
  const handleUpdateClick = async () => {
    const info = await fetchUpdateInfo();
    setUpdateInfo(info);
    setUpdateState('confirming');
    setUpdateLogs([]);
    setUpdateError(null);
  };

  /**
   * 取消更新
   */
  const handleCancelUpdate = () => {
    stopPollingProgress();
    setUpdateState('idle');
    setUpdateInfo(null);
    setUpdateLogs([]);
    setUpdateError(null);
  };

  /**
   * 获取更新进度
   */
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

  /**
   * 确认执行更新
   */
  const handleConfirmUpdate = async () => {
    setUpdateState('updating');
    setUpdateLogs(['等待服务器输出...']);
    setUpdateError(null);

    const startedAtMs = Date.now();
    let matchedThisRun = false;

    // 启动进度轮询（每秒）
    stopPollingProgress();
    const pollOnce = async () => {
      const progress = await fetchUpdateProgress();
      if (!progress) return;

      // 只处理本次更新启动后的进度，避免读到上一次更新的 completed/failed 而提前结束
      const progressStartedAt = progress.startedAt ? Date.parse(progress.startedAt) : NaN;
      if (!matchedThisRun && Number.isFinite(progressStartedAt)) {
        matchedThisRun = progressStartedAt >= startedAtMs - 5000;
      }

      if (!matchedThisRun) {
        if (progress.status === 'running') {
          // running 视为本次任务（即便 startedAt 缺失/解析失败）
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
        // 服务将在稍后重启，等待后自动刷新页面
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

    // 先拉一次，尽快显示当前阶段
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

      // 处理非 JSON 响应（如 502 错误）
      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        // 若更新已开始，优先继续轮询，避免因重启导致的短暂失败被误判为更新失败
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

      // POST 返回值保留兼容：最终结果以轮询进度为准
      const result: UpdateResultResponse = await response.json().catch(() => ({ success: true } as any));
      if (result && result.success === false) {
        stopPollingProgress();
        setUpdateState('error');
        setUpdateLogs(result.logs || []);
        setUpdateError(result.error || result.message || '更新失败');
      }
    } catch (err) {
      console.error('[VersionBadge] Update failed:', err);
      // 网络中断时（常见于服务重启），优先继续轮询一段时间
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

  /**
   * 格式化检查时间
   */
  const formatCheckedAt = (isoString: string): string => {
    const date = new Date(isoString);
    return date.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  /**
   * 渲染更新确认弹窗
   */
  const renderUpdateModal = () => {
    if (updateState === 'idle') return null;

    return (
      <div style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 9999
      }}>
        <div style={{
          background: 'white',
          borderRadius: '12px',
          padding: '24px',
          maxWidth: '600px',
          width: '90%',
          maxHeight: '80vh',
          overflow: 'auto',
          boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1)'
        }}>
          {/* 标题 */}
          <h3 style={{
            margin: '0 0 16px 0',
            fontSize: '18px',
            fontWeight: '600',
            color: '#374151'
          }}>
            {updateState === 'confirming' && '确认更新插件'}
            {updateState === 'updating' && '正在更新...'}
            {updateState === 'success' && '更新成功'}
            {updateState === 'error' && '更新失败'}
          </h3>

          {/* 确认阶段 */}
          {updateState === 'confirming' && (
            <>
              <div style={{
                background: '#fef3c7',
                border: '1px solid #f59e0b',
                borderRadius: '8px',
                padding: '16px',
                marginBottom: '16px'
              }}>
                <div style={{ fontWeight: '500', color: '#92400e', marginBottom: '8px' }}>
                  注意事项
                </div>
                <ul style={{
                  margin: 0,
                  paddingLeft: '20px',
                  color: '#78350f',
                  fontSize: '14px'
                }}>
                  <li>更新将执行 git pull、npm run build 和 pm2 restart</li>
                  <li>HydroOJ 服务将短暂重启，可能导致数秒服务中断</li>
                  <li>请确保当前没有重要操作正在进行</li>
                </ul>
              </div>

              {updateInfo && (
                <div style={{
                  background: '#f3f4f6',
                  borderRadius: '8px',
                  padding: '12px',
                  marginBottom: '16px',
                  fontSize: '14px'
                }}>
                  <div style={{ marginBottom: '4px' }}>
                    <span style={{ color: '#6b7280' }}>插件路径: </span>
                    <code style={{ color: '#374151' }}>{updateInfo.path}</code>
                  </div>
                  <div>
                    <span style={{ color: '#6b7280' }}>状态: </span>
                    <span style={{ color: updateInfo.isValid ? '#059669' : '#dc2626' }}>
                      {updateInfo.message}
                    </span>
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
                <button
                  onClick={handleCancelUpdate}
                  style={{
                    padding: '10px 20px',
                    border: '1px solid #d1d5db',
                    borderRadius: '6px',
                    background: 'white',
                    color: '#374151',
                    cursor: 'pointer',
                    fontSize: '14px'
                  }}
                >
                  取消
                </button>
                <button
                  onClick={handleConfirmUpdate}
                  disabled={!updateInfo?.isValid}
                  style={{
                    padding: '10px 20px',
                    border: 'none',
                    borderRadius: '6px',
                    background: updateInfo?.isValid ? '#f59e0b' : '#d1d5db',
                    color: 'white',
                    cursor: updateInfo?.isValid ? 'pointer' : 'not-allowed',
                    fontSize: '14px',
                    fontWeight: '500'
                  }}
                >
                  确认更新
                </button>
              </div>
            </>
          )}

          {/* 更新中 */}
          {updateState === 'updating' && (
            <div>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                marginBottom: '16px'
              }}>
                <div style={{
                  width: '24px',
                  height: '24px',
                  border: '3px solid #f3f4f6',
                  borderTop: '3px solid #f59e0b',
                  borderRadius: '50%',
                  animation: 'spin 1s linear infinite'
                }} />
                <span style={{ color: '#374151' }}>正在执行更新，请勿关闭页面...</span>
              </div>
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
              {renderLogs()}
            </div>
          )}

          {/* 成功 */}
          {updateState === 'success' && (
            <div>
              <div style={{
                background: '#dcfce7',
                border: '1px solid #22c55e',
                borderRadius: '8px',
                padding: '16px',
                marginBottom: '16px'
              }}>
                <div style={{ color: '#166534', fontWeight: '500' }}>
                  更新完成！页面将在 20 秒后自动刷新...
                </div>
              </div>
              {renderLogs()}
            </div>
          )}

          {/* 失败 */}
          {updateState === 'error' && (
            <div>
              <div style={{
                background: '#fee2e2',
                border: '1px solid #ef4444',
                borderRadius: '8px',
                padding: '16px',
                marginBottom: '16px'
              }}>
                <div style={{ color: '#dc2626', fontWeight: '500', marginBottom: '8px' }}>
                  更新失败
                </div>
                <div style={{ color: '#991b1b', fontSize: '14px' }}>
                  {updateError}
                </div>
              </div>
              {renderLogs()}
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '16px' }}>
                <button
                  onClick={handleCancelUpdate}
                  style={{
                    padding: '10px 20px',
                    border: '1px solid #d1d5db',
                    borderRadius: '6px',
                    background: 'white',
                    color: '#374151',
                    cursor: 'pointer',
                    fontSize: '14px'
                  }}
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

  /**
   * 渲染更新日志
   */
  const renderLogs = () => {
    if (updateLogs.length === 0) return null;

    return (
      <div style={{
        background: '#1f2937',
        borderRadius: '8px',
        padding: '12px',
        maxHeight: '200px',
        overflow: 'auto',
        fontFamily: 'monospace',
        fontSize: '12px'
      }}>
        {updateLogs.map((log, i) => (
          <div key={i} style={{ color: '#d1d5db', marginBottom: '4px' }}>
            {log}
          </div>
        ))}
      </div>
    );
  };

  return (
    <>
      <div style={{
        background: '#f9fafb',
        border: '1px solid #e5e7eb',
        borderRadius: '8px',
        padding: '16px',
        marginBottom: '20px'
      }}>
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '12px'
        }}>
          <h3 style={{
            margin: 0,
            fontSize: '16px',
            fontWeight: '600',
            color: '#374151'
          }}>
            插件版本
          </h3>
          <button
            onClick={() => fetchVersionInfo(true)}
            disabled={state === 'loading'}
            style={{
              background: 'none',
              border: '1px solid #d1d5db',
              borderRadius: '4px',
              padding: '4px 8px',
              fontSize: '12px',
              color: '#6b7280',
              cursor: state === 'loading' ? 'not-allowed' : 'pointer'
            }}
          >
            {state === 'loading' ? '检查中...' : '刷新'}
          </button>
        </div>

        {/* 加载状态 */}
        {state === 'loading' && !versionInfo && (
          <div style={{ color: '#6b7280', fontSize: '14px' }}>
            正在检查版本...
          </div>
        )}

        {/* 错误状态 */}
        {state === 'error' && (
          <div style={{
            color: '#dc2626',
            fontSize: '14px',
            padding: '8px',
            background: '#fee2e2',
            borderRadius: '4px'
          }}>
            版本检查失败: {error}
          </div>
        )}

        {/* 版本信息 */}
        {versionInfo && (
          <div>
            {/* 当前版本 */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              marginBottom: '8px'
            }}>
              <span style={{ fontSize: '14px', color: '#6b7280' }}>当前版本:</span>
              <span style={{
                fontSize: '14px',
                fontWeight: '600',
                color: '#374151',
                fontFamily: 'monospace'
              }}>
                v{versionInfo.currentVersion}
              </span>
            </div>

            {/* T055: 更新提示 */}
            {versionInfo.hasUpdate ? (
              <div style={{
                background: '#fef3c7',
                border: '1px solid #f59e0b',
                borderRadius: '6px',
                padding: '12px',
                marginTop: '12px'
              }}>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  marginBottom: '8px'
                }}>
                  <span style={{ fontSize: '16px' }}>🎉</span>
                  <span style={{
                    fontSize: '14px',
                    fontWeight: '600',
                    color: '#92400e'
                  }}>
                    有新版本可用!
                  </span>
                </div>
                <div style={{
                  fontSize: '14px',
                  color: '#78350f',
                  marginBottom: '10px'
                }}>
                  最新版本: <span style={{ fontFamily: 'monospace', fontWeight: '600' }}>
                    v{versionInfo.latestVersion}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    onClick={handleUpdateClick}
                    style={{
                      display: 'inline-block',
                      background: '#f59e0b',
                      color: 'white',
                      padding: '8px 16px',
                      borderRadius: '6px',
                      border: 'none',
                      fontSize: '13px',
                      fontWeight: '500',
                      cursor: 'pointer'
                    }}
                  >
                    一键更新
                  </button>
                  <a
                    href={versionInfo.releaseUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: 'inline-block',
                      background: 'white',
                      color: '#78350f',
                      padding: '8px 16px',
                      borderRadius: '6px',
                      border: '1px solid #f59e0b',
                      textDecoration: 'none',
                      fontSize: '13px'
                    }}
                  >
                    查看发布页
                  </a>
                </div>
              </div>
            ) : (
              <div style={{
                background: '#dcfce7',
                border: '1px solid #22c55e',
                borderRadius: '6px',
                padding: '10px 12px',
                marginTop: '12px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '14px' }}>✓</span>
                  <span style={{ fontSize: '14px', color: '#166534' }}>
                    已是最新版本
                  </span>
                </div>
                <button
                  onClick={handleUpdateClick}
                  style={{
                    background: 'transparent',
                    color: '#166534',
                    padding: '4px 10px',
                    borderRadius: '4px',
                    border: '1px solid #22c55e',
                    fontSize: '12px',
                    cursor: 'pointer'
                  }}
                >
                  覆盖更新
                </button>
              </div>
            )}

            {/* 检查时间 */}
            <div style={{
              fontSize: '12px',
              color: '#9ca3af',
              marginTop: '10px',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              flexWrap: 'wrap'
            }}>
              <span>上次检查: {formatCheckedAt(versionInfo.checkedAt)}</span>
              {versionInfo.source && (
                <span style={{
                  background: '#dbeafe',
                  color: '#1d4ed8',
                  padding: '2px 6px',
                  borderRadius: '4px',
                  fontSize: '11px'
                }}>
                  {versionInfo.source}
                </span>
              )}
              {versionInfo.fromCache && (
                <span style={{
                  background: '#e5e7eb',
                  padding: '2px 6px',
                  borderRadius: '4px',
                  fontSize: '11px'
                }}>
                  缓存
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 更新弹窗 */}
      {renderUpdateModal()}
    </>
  );
};

export default VersionBadge;
