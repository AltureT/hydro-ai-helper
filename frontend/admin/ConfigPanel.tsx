/**
 * AI 配置页面
 * 管理员配置 AI 学习助手相关参数
 */

import React, { useState, useEffect } from 'react';

/**
 * 配置状态接口
 */
interface ConfigState {
  apiBaseUrl: string;
  modelName: string;
  rateLimitPerMinute: number | '';
  timeoutSeconds: number | '';
  systemPromptTemplate: string;
  apiKeyMasked: string;  // 只读展示
  hasApiKey: boolean;
}

/**
 * ConfigPanel 组件
 */
export const ConfigPanel: React.FC = () => {
  // 状态管理
  const [config, setConfig] = useState<ConfigState | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [testing, setTesting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const [newApiKey, setNewApiKey] = useState<string>('');
  const [showApiKey, setShowApiKey] = useState<boolean>(false);

  /**
   * 初始化：加载配置
   */
  useEffect(() => {
    loadConfig();
  }, []);

  /**
   * 加载配置
   */
  const loadConfig = async () => {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/ai-helper/admin/config', {
        method: 'GET',
        credentials: 'include',
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `加载配置失败: ${res.status}`);
      }

      const json = await res.json();

      if (json.config == null) {
        // 使用默认值
        setConfig({
          apiBaseUrl: '',
          modelName: '',
          rateLimitPerMinute: 5,
          timeoutSeconds: 30,
          systemPromptTemplate: '',
          apiKeyMasked: '',
          hasApiKey: false,
        });
      } else {
        setConfig({
          apiBaseUrl: json.config.apiBaseUrl || '',
          modelName: json.config.modelName || '',
          rateLimitPerMinute: json.config.rateLimitPerMinute ?? 5,
          timeoutSeconds: json.config.timeoutSeconds ?? 30,
          systemPromptTemplate: json.config.systemPromptTemplate || '',
          apiKeyMasked: json.config.apiKeyMasked || '',
          hasApiKey: Boolean(json.config.hasApiKey),
        });
      }
    } catch (err: any) {
      console.error('Load config error:', err);
      setError(err.message || '加载配置失败');
    } finally {
      setLoading(false);
    }
  };

  /**
   * 保存配置
   */
  const saveConfig = async () => {
    if (!config) return;

    // 基本校验
    if (!config.apiBaseUrl.trim()) {
      setError('API Base URL 不能为空');
      return;
    }
    if (!config.modelName.trim()) {
      setError('模型名称不能为空');
      return;
    }
    if (typeof config.rateLimitPerMinute === 'number' && config.rateLimitPerMinute <= 0) {
      setError('每分钟最大请求数必须大于 0');
      return;
    }
    if (typeof config.timeoutSeconds === 'number' && config.timeoutSeconds <= 0) {
      setError('超时时间必须大于 0');
      return;
    }

    setError(null);
    setSuccessMessage(null);
    setSaving(true);

    try {
      const body: any = {
        apiBaseUrl: config.apiBaseUrl.trim(),
        modelName: config.modelName.trim(),
        rateLimitPerMinute: Number(config.rateLimitPerMinute) || 5,
        timeoutSeconds: Number(config.timeoutSeconds) || 30,
        systemPromptTemplate: config.systemPromptTemplate,
      };

      // 仅当 newApiKey 非空时才发送 apiKey 字段
      if (newApiKey.trim()) {
        body.apiKey = newApiKey.trim();
      }

      const res = await fetch('/ai-helper/admin/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error || `保存失败: ${res.status}`);
      }

      const json = await res.json();

      // 用返回的新 config 更新状态
      if (json.config) {
        setConfig((prev) => ({
          ...prev!,
          apiBaseUrl: json.config.apiBaseUrl || '',
          modelName: json.config.modelName || '',
          rateLimitPerMinute: json.config.rateLimitPerMinute ?? prev?.rateLimitPerMinute ?? 5,
          timeoutSeconds: json.config.timeoutSeconds ?? prev?.timeoutSeconds ?? 30,
          systemPromptTemplate: json.config.systemPromptTemplate || '',
          apiKeyMasked: json.config.apiKeyMasked || '',
          hasApiKey: Boolean(json.config.hasApiKey),
        }));
      }

      setNewApiKey(''); // 保存成功后清空输入框
      setSuccessMessage('配置已保存');

      // 3 秒后自动清除成功消息
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err: any) {
      console.error('Save config error:', err);
      setError(err.message || '保存配置失败');
    } finally {
      setSaving(false);
    }
  };

  /**
   * 测试连接
   */
  const testConnection = async () => {
    setError(null);
    setSuccessMessage(null);
    setTesting(true);

    try {
      const res = await fetch('/ai-helper/admin/test-connection', {
        method: 'POST',
        credentials: 'include',
      });

      const json = await res.json();

      if (json.success) {
        setSuccessMessage('连接成功，AI 服务可用');
        // 3 秒后自动清除成功消息
        setTimeout(() => setSuccessMessage(null), 3000);
      } else {
        setError(json.message || '连接失败，AI 服务不可用');
      }
    } catch (err: any) {
      console.error('Test connection error:', err);
      setError(err.message || '连接测试失败');
    } finally {
      setTesting(false);
    }
  };

  /**
   * 渲染加载状态
   */
  if (loading) {
    return (
      <div style={{ padding: '20px', fontFamily: 'sans-serif', maxWidth: '900px', margin: '40px auto 20px' }}>
        <h1>AI 学习助手配置</h1>
        <div style={{
          marginTop: '20px',
          padding: '20px',
          textAlign: 'center',
          color: '#6b7280',
          backgroundColor: '#f9fafb',
          borderRadius: '8px'
        }}>
          正在加载配置...
        </div>
      </div>
    );
  }

  if (!config) {
    return null;
  }

  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif', maxWidth: '900px', margin: '40px auto 20px' }}>
      <h1>AI 学习助手配置</h1>

      {/* 错误提示 */}
      {error && (
        <div style={{
          marginTop: '20px',
          padding: '15px',
          backgroundColor: '#fee2e2',
          border: '1px solid #ef4444',
          borderRadius: '8px',
          color: '#991b1b'
        }}>
          <strong>错误：</strong> {error}
        </div>
      )}

      {/* 成功提示 */}
      {successMessage && (
        <div style={{
          marginTop: '20px',
          padding: '15px',
          backgroundColor: '#d1fae5',
          border: '1px solid #10b981',
          borderRadius: '8px',
          color: '#065f46'
        }}>
          <strong>成功：</strong> {successMessage}
        </div>
      )}

      {/* 基础配置 */}
      <div style={{
        marginTop: '30px',
        padding: '20px',
        backgroundColor: '#f9fafb',
        borderRadius: '8px',
        border: '1px solid #e5e7eb'
      }}>
        <h2 style={{ marginTop: 0, marginBottom: '20px', fontSize: '18px' }}>基础配置</h2>

        <div style={{ marginBottom: '15px' }}>
          <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500 }}>
            API Base URL <span style={{ color: '#ef4444' }}>*</span>
          </label>
          <input
            type="text"
            value={config.apiBaseUrl}
            onChange={(e) => setConfig({ ...config, apiBaseUrl: e.target.value })}
            placeholder="https://api.openai.com/v1"
            disabled={saving || testing}
            style={{
              width: '100%',
              padding: '10px',
              borderRadius: '6px',
              border: '1px solid #d1d5db',
              fontSize: '14px',
              boxSizing: 'border-box'
            }}
          />
        </div>

        <div style={{ marginBottom: '15px' }}>
          <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500 }}>
            模型名称 <span style={{ color: '#ef4444' }}>*</span>
          </label>
          <input
            type="text"
            value={config.modelName}
            onChange={(e) => setConfig({ ...config, modelName: e.target.value })}
            placeholder="gpt-4o-mini"
            disabled={saving || testing}
            style={{
              width: '100%',
              padding: '10px',
              borderRadius: '6px',
              border: '1px solid #d1d5db',
              fontSize: '14px',
              boxSizing: 'border-box'
            }}
          />
        </div>

        <div style={{ marginBottom: '15px' }}>
          <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500 }}>
            超时时间（秒） <span style={{ color: '#ef4444' }}>*</span>
          </label>
          <input
            type="number"
            value={config.timeoutSeconds}
            onChange={(e) => {
              const value = e.target.value;
              setConfig({ ...config, timeoutSeconds: value === '' ? '' : Number(value) });
            }}
            placeholder="30"
            min="1"
            disabled={saving || testing}
            style={{
              width: '100%',
              padding: '10px',
              borderRadius: '6px',
              border: '1px solid #d1d5db',
              fontSize: '14px',
              boxSizing: 'border-box'
            }}
          />
        </div>
      </div>

      {/* 频率限制 */}
      <div style={{
        marginTop: '20px',
        padding: '20px',
        backgroundColor: '#f9fafb',
        borderRadius: '8px',
        border: '1px solid #e5e7eb'
      }}>
        <h2 style={{ marginTop: 0, marginBottom: '20px', fontSize: '18px' }}>频率限制</h2>

        <div style={{ marginBottom: '15px' }}>
          <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500 }}>
            每分钟最大请求数 <span style={{ color: '#ef4444' }}>*</span>
          </label>
          <input
            type="number"
            value={config.rateLimitPerMinute}
            onChange={(e) => {
              const value = e.target.value;
              setConfig({ ...config, rateLimitPerMinute: value === '' ? '' : Number(value) });
            }}
            placeholder="5"
            min="1"
            disabled={saving || testing}
            style={{
              width: '100%',
              padding: '10px',
              borderRadius: '6px',
              border: '1px solid #d1d5db',
              fontSize: '14px',
              boxSizing: 'border-box'
            }}
          />
          <div style={{ marginTop: '5px', fontSize: '13px', color: '#6b7280' }}>
            限制每个学生每分钟可发送的请求次数，防止滥用
          </div>
        </div>
      </div>

      {/* 高级设置 */}
      <div style={{
        marginTop: '20px',
        padding: '20px',
        backgroundColor: '#f9fafb',
        borderRadius: '8px',
        border: '1px solid #e5e7eb'
      }}>
        <h2 style={{ marginTop: 0, marginBottom: '20px', fontSize: '18px' }}>高级设置</h2>

        <div style={{ marginBottom: '15px' }}>
          <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500 }}>
            System Prompt 模板
          </label>
          <textarea
            value={config.systemPromptTemplate}
            onChange={(e) => setConfig({ ...config, systemPromptTemplate: e.target.value })}
            placeholder="你是一位耐心的算法学习导师..."
            disabled={saving || testing}
            rows={6}
            style={{
              width: '100%',
              padding: '10px',
              borderRadius: '6px',
              border: '1px solid #d1d5db',
              fontSize: '14px',
              fontFamily: 'monospace',
              resize: 'vertical',
              boxSizing: 'border-box'
            }}
          />
          <div style={{ marginTop: '5px', fontSize: '13px', color: '#6b7280' }}>
            AI 助手的系统提示词，定义其角色和行为规范
          </div>
        </div>
      </div>

      {/* API Key 设置 */}
      <div style={{
        marginTop: '20px',
        padding: '20px',
        backgroundColor: '#f9fafb',
        borderRadius: '8px',
        border: '1px solid #e5e7eb'
      }}>
        <h2 style={{ marginTop: 0, marginBottom: '20px', fontSize: '18px' }}>API Key 设置</h2>

        {/* 当前状态展示 */}
        <div style={{ marginBottom: '20px' }}>
          <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500 }}>
            当前 API Key 状态
          </label>
          <div style={{
            padding: '12px',
            backgroundColor: config.hasApiKey ? '#d1fae5' : '#fee2e2',
            borderRadius: '6px',
            fontSize: '14px',
            color: config.hasApiKey ? '#065f46' : '#991b1b'
          }}>
            {config.hasApiKey ? `已配置：${config.apiKeyMasked}` : '尚未配置 API Key'}
          </div>
        </div>

        {/* 新 API Key 输入 */}
        <div style={{ marginBottom: '15px' }}>
          <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500 }}>
            新的 API Key（留空则不修改）
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <input
              type={showApiKey ? 'text' : 'password'}
              value={newApiKey}
              onChange={(e) => setNewApiKey(e.target.value)}
              placeholder="sk-..."
              disabled={saving || testing}
              style={{
                flex: 1,
                padding: '10px',
                borderRadius: '6px',
                border: '1px solid #d1d5db',
                fontSize: '14px',
                fontFamily: 'monospace'
              }}
            />
            <button
              onClick={() => setShowApiKey(!showApiKey)}
              disabled={saving || testing}
              style={{
                padding: '10px 16px',
                backgroundColor: '#f3f4f6',
                border: '1px solid #d1d5db',
                borderRadius: '6px',
                fontSize: '14px',
                cursor: 'pointer',
                whiteSpace: 'nowrap'
              }}
            >
              {showApiKey ? '隐藏' : '显示'}
            </button>
          </div>
          <div style={{ marginTop: '5px', fontSize: '13px', color: '#6b7280' }}>
            出于安全考虑，无法查看已保存的完整 API Key。输入新值将覆盖原有密钥，留空则保持不变。
          </div>
        </div>
      </div>

      {/* 底部按钮区域 */}
      <div style={{
        marginTop: '30px',
        display: 'flex',
        justifyContent: 'space-between',
        gap: '15px'
      }}>
        {/* 测试连接按钮 */}
        <button
          onClick={testConnection}
          disabled={saving || testing || loading}
          style={{
            padding: '12px 24px',
            backgroundColor: testing || saving || loading ? '#9ca3af' : '#f3f4f6',
            color: testing || saving || loading ? '#ffffff' : '#374151',
            border: '1px solid #d1d5db',
            borderRadius: '6px',
            fontSize: '14px',
            fontWeight: 500,
            cursor: testing || saving || loading ? 'not-allowed' : 'pointer'
          }}
        >
          {testing ? '测试中...' : '测试连接'}
        </button>

        {/* 保存配置按钮 */}
        <button
          onClick={saveConfig}
          disabled={saving || testing || loading}
          style={{
            padding: '12px 32px',
            backgroundColor: saving || testing || loading ? '#9ca3af' : '#6366f1',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            fontSize: '14px',
            fontWeight: 500,
            cursor: saving || testing || loading ? 'not-allowed' : 'pointer'
          }}
        >
          {saving ? '保存中...' : '保存配置'}
        </button>
      </div>
    </div>
  );
};

export default ConfigPanel;
