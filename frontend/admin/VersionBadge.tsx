/**
 * VersionBadge - 版本徽章组件
 *
 * T053-T055: 显示插件版本信息和更新提示
 * - 显示当前安装版本
 * - 自动检测是否有新版本
 * - 提供跳转到发布页面的链接
 */

import React, { useState, useEffect } from 'react';
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
}

/**
 * 组件状态
 */
type LoadingState = 'idle' | 'loading' | 'success' | 'error';

/**
 * VersionBadge 组件
 */
export const VersionBadge: React.FC = () => {
  const [state, setState] = useState<LoadingState>('idle');
  const [versionInfo, setVersionInfo] = useState<VersionCheckResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * T054: 组件挂载时获取版本信息
   */
  useEffect(() => {
    fetchVersionInfo();
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

  return (
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
              <a
                href={versionInfo.releaseUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'inline-block',
                  background: '#f59e0b',
                  color: 'white',
                  padding: '8px 16px',
                  borderRadius: '6px',
                  textDecoration: 'none',
                  fontSize: '13px',
                  fontWeight: '500'
                }}
              >
                前往下载
              </a>
            </div>
          ) : (
            <div style={{
              background: '#dcfce7',
              border: '1px solid #22c55e',
              borderRadius: '6px',
              padding: '10px 12px',
              marginTop: '12px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px'
            }}>
              <span style={{ fontSize: '14px' }}>✓</span>
              <span style={{ fontSize: '14px', color: '#166534' }}>
                已是最新版本
              </span>
            </div>
          )}

          {/* 检查时间 */}
          <div style={{
            fontSize: '12px',
            color: '#9ca3af',
            marginTop: '10px',
            display: 'flex',
            alignItems: 'center',
            gap: '4px'
          }}>
            <span>上次检查: {formatCheckedAt(versionInfo.checkedAt)}</span>
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
  );
};

export default VersionBadge;
