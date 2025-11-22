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
  extraJailbreakPatternsText: string;
  apiKeyMasked: string;  // 只读展示
  hasApiKey: boolean;
}

interface JailbreakLogEntry {
  id: string;
  userId?: number;
  problemId?: string;
  conversationId?: string;
  questionType?: string;
  matchedPattern: string;
  matchedText: string;
  createdAt: string;
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
  const [builtinJailbreakPatterns, setBuiltinJailbreakPatterns] = useState<string[]>([]);
  const [jailbreakLogs, setJailbreakLogs] = useState<JailbreakLogEntry[]>([]);

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

      const builtinPatterns: string[] = json.builtinJailbreakPatterns || [];
      const logs: JailbreakLogEntry[] = json.recentJailbreakLogs || [];
      setBuiltinJailbreakPatterns(builtinPatterns);
      setJailbreakLogs(logs);

      if (json.config == null) {
        // 使用默认值
        setConfig({
          apiBaseUrl: '',
          modelName: '',
          rateLimitPerMinute: 5,
          timeoutSeconds: 30,
          systemPromptTemplate: '',
          extraJailbreakPatternsText: '',
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
          extraJailbreakPatternsText: json.config.extraJailbreakPatternsText || '',
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
        extraJailbreakPatternsText: config.extraJailbreakPatternsText,
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
          extraJailbreakPatternsText: json.config.extraJailbreakPatternsText || '',
          apiKeyMasked: json.config.apiKeyMasked || '',
          hasApiKey: Boolean(json.config.hasApiKey),
        }));
      }

      if (json.builtinJailbreakPatterns) {
        setBuiltinJailbreakPatterns(json.builtinJailbreakPatterns);
      }
      if (json.recentJailbreakLogs) {
        setJailbreakLogs(json.recentJailbreakLogs);
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

  const copyToClipboard = async (text: string) => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        setSuccessMessage('已复制到剪贴板');
        setTimeout(() => setSuccessMessage(null), 2000);
      } else {
        window.prompt('请复制以下内容', text);
      }
    } catch (err) {
      console.error('Copy to clipboard failed:', err);
      window.prompt('复制失败，请手动复制：', text);
    }
  };

  const appendPatternToCustomRules = (pattern: string) => {
    setConfig((prev) => {
      if (!prev) return prev;
      const existing = prev.extraJailbreakPatternsText || '';
      const normalizedPattern = pattern.trim();
      if (!normalizedPattern) {
        return prev;
      }
      const prefix = existing.length > 0 ? `${existing}${existing.endsWith('\n') ? '' : '\n'}` : '';
      const updated = `${prefix}${normalizedPattern}`;
      return {
        ...prev,
        extraJailbreakPatternsText: updated,
      };
    });
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

        <div style={{ marginBottom: '15px' }}>
          <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500 }}>
            内置越狱规则（只读）
          </label>
          <div style={{
            maxHeight: '200px',
            overflowY: 'auto',
            padding: '12px',
            borderRadius: '6px',
            border: '1px solid #d1d5db',
            backgroundColor: '#fff'
          }}>
            {builtinJailbreakPatterns.length === 0 ? (
              <div style={{ color: '#6b7280', fontSize: '13px' }}>暂无内置规则</div>
            ) : (
              <ul style={{ margin: 0, paddingLeft: '20px' }}>
                {builtinJailbreakPatterns.map((pattern, index) => (
                  <li key={`${pattern}-${index}`} style={{ marginBottom: '6px', fontFamily: 'monospace', fontSize: '13px' }}>
                    {pattern}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div style={{ marginTop: '5px', fontSize: '13px', color: '#6b7280' }}>
            系统内置的越狱检测规则，供管理员参考，无法直接修改。
          </div>
        </div>

        <div style={{ marginBottom: '15px' }}>
          <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500 }}>
            自定义越狱规则（每行一个正则表达式）
          </label>
          <textarea
            value={config.extraJailbreakPatternsText}
            onChange={(e) => setConfig({ ...config, extraJailbreakPatternsText: e.target.value })}
            placeholder="忽略.*提示词"
            disabled={saving || testing}
            rows={5}
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
            支持 JavaScript 正则表达式语法。保存后立即生效，解析失败的规则会在后端日志中记录并自动忽略。
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

      {/* 越狱尝试记录 */}
      <div style={{
        marginTop: '20px',
        padding: '20px',
        backgroundColor: '#f9fafb',
        borderRadius: '8px',
        border: '1px solid #e5e7eb'
      }}>
        <h2 style={{ marginTop: 0, marginBottom: '20px', fontSize: '18px' }}>越狱尝试记录</h2>

        {jailbreakLogs.length === 0 ? (
          <div style={{
            padding: '15px',
            backgroundColor: '#fff',
            borderRadius: '6px',
            border: '1px dashed #d1d5db',
            color: '#6b7280',
            fontSize: '14px'
          }}>
            暂无命中记录，说明最近没有学生尝试修改系统提示词。
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
            {jailbreakLogs.map((log) => {
              const contextPieces: string[] = [];
              if (log.userId !== undefined) {
                contextPieces.push(`用户 ID：${log.userId}`);
              }
              if (log.problemId) {
                contextPieces.push(`题目 ID：${log.problemId}`);
              }
              if (log.conversationId) {
                contextPieces.push(`会话 ID：${log.conversationId}`);
              }
              if (log.questionType) {
                contextPieces.push(`问题类型：${log.questionType}`);
              }
              const contextText = contextPieces.join(' · ');
              return (
                <div key={log.id} style={{
                  padding: '15px',
                  backgroundColor: '#fff',
                  borderRadius: '8px',
                  border: '1px solid #e5e7eb'
                }}>
                  <div style={{ fontSize: '14px', color: '#111827', fontWeight: 500 }}>
                    时间：{new Date(log.createdAt).toLocaleString()}
                  </div>
                  <div style={{ marginTop: '6px', fontSize: '13px', color: '#4b5563' }}>
                    命中规则：<code style={{ fontFamily: 'monospace' }}>{log.matchedPattern}</code>
                  </div>
                  <pre style={{
                    marginTop: '10px',
                    padding: '12px',
                    backgroundColor: '#1f2937',
                    color: '#f9fafb',
                    borderRadius: '6px',
                    fontSize: '13px',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word'
                  }}>
                    {log.matchedText}
                  </pre>
                  {contextText && (
                    <div style={{ marginTop: '6px', fontSize: '12px', color: '#6b7280' }}>
                      {contextText}
                    </div>
                  )}
                  <div style={{
                    marginTop: '10px',
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '10px'
                  }}>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(log.matchedText)}
                      style={{
                        padding: '8px 12px',
                        backgroundColor: '#e5e7eb',
                        border: '1px solid #d1d5db',
                        borderRadius: '6px',
                        fontSize: '13px',
                        cursor: 'pointer'
                      }}
                    >
                      复制命中文本
                    </button>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(log.matchedPattern)}
                      style={{
                        padding: '8px 12px',
                        backgroundColor: '#e5e7eb',
                        border: '1px solid #d1d5db',
                        borderRadius: '6px',
                        fontSize: '13px',
                        cursor: 'pointer'
                      }}
                    >
                      复制命中正则
                    </button>
                    <button
                      type="button"
                      onClick={() => appendPatternToCustomRules(log.matchedPattern)}
                      style={{
                        padding: '8px 12px',
                        backgroundColor: '#eef2ff',
                        border: '1px solid #c7d2fe',
                        borderRadius: '6px',
                        fontSize: '13px',
                        cursor: 'pointer'
                      }}
                    >
                      追加到自定义规则
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
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
