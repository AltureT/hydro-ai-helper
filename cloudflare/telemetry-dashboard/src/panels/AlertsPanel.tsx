import { useState, useEffect } from 'react';
import { getAlerts, getAlertConfig, saveAlertConfig, testAlertConfig, removeAlertConfig } from '../api';
import type { Alert, TelegramConfig } from '../types';

const SEVERITY: Record<string, { label: string; bg: string; color: string; border: string }> = {
  critical: { label: '严重', bg: '#fef2f2', color: '#b91c1c', border: '#fecaca' },
  warning: { label: '警告', bg: '#fffbeb', color: '#b45309', border: '#fde68a' },
  info: { label: '提示', bg: '#eff6ff', color: '#1d4ed8', border: '#bfdbfe' },
};

const ERR_MSG: Record<string, string> = {
  rate_limited: '操作过于频繁，请几秒后再试',
  invalid_token: 'Bot Token 无效',
  chat_not_found: 'Chat ID 无效，或机器人尚未加入该会话',
  not_decryptable: '无法解密，请重新填写 Token',
  not_configured: '请先保存配置',
  upstream_failure: 'Telegram 暂时不可达，请稍后重试',
  invalid_chat_id: 'Chat ID 格式不对（应为数字或 @用户名）',
  token_required: '请填写 Bot Token',
};
const errText = (code?: string) => (code && ERR_MSG[code]) || code || '未知错误';

export function AlertsPanel() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <TelegramConfigCard />
      <AlertsList />
    </div>
  );
}

function AlertsList() {
  const [data, setData] = useState<Alert[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getAlerts()
      .then(r => setData(r.alerts))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p style={{ color: '#6b7280' }}>加载中...</p>;
  if (error) return <p style={{ color: '#ef4444' }}>加载失败: {error}</p>;
  if (data.length === 0) return <p style={{ color: '#16a34a', textAlign: 'center', padding: 40 }}>近 7 天无告警 ✓</p>;

  return (
    <div style={cardStyle}>
      <h3 style={{ margin: '0 0 4px', fontSize: '16px' }}>告警 ({data.length})</h3>
      <p style={{ margin: '0 0 16px', fontSize: '12px', color: '#6b7280' }}>
        近 7 天，worker 每小时基于错误 / 功能健康自动评估
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {data.map(a => {
          const sev = SEVERITY[a.severity] || SEVERITY.info;
          return (
            <div key={a.id} style={{ ...rowStyle, background: sev.bg, borderColor: sev.border }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{
                  padding: '2px 8px', borderRadius: 4, fontSize: '11px', fontWeight: 700,
                  background: '#fff', color: sev.color, border: `1px solid ${sev.border}`,
                }}>
                  {sev.label}
                </span>
                <span style={{ fontSize: '14px', fontWeight: 600, color: '#1f2937' }}>{a.title}</span>
                <span style={{ marginLeft: 'auto', fontSize: '12px', color: '#6b7280' }}>
                  {new Date(a.created_at).toLocaleString()}
                </span>
              </div>
              {a.detail && <div style={{ fontSize: '13px', color: '#374151', wordBreak: 'break-word' }}>{a.detail}</div>}
              <code style={{ fontSize: '11px', color: '#9ca3af' }}>{a.alert_key}</code>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TelegramConfigCard() {
  const [cfg, setCfg] = useState<TelegramConfig | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [chatId, setChatId] = useState('');
  const [token, setToken] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => {
    getAlertConfig()
      .then(r => { setCfg(r.telegram); setEnabled(r.telegram.enabled); setChatId(r.telegram.chat_id || ''); })
      .catch(e => setStatus('加载失败: ' + e.message));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, []);

  const save = async () => {
    setBusy(true); setStatus('');
    try {
      const res = await saveAlertConfig({ enabled, chat_id: chatId, token: token || undefined });
      if (res.success) { setStatus('已保存 ✓'); setToken(''); load(); }
      else setStatus('保存失败: ' + errText(res.error));
    } catch (e) { setStatus('保存失败: ' + (e as Error).message); }
    finally { setBusy(false); }
  };

  const test = async () => {
    setBusy(true); setStatus('发送测试中...');
    try {
      const res = await testAlertConfig();
      if (res.ok) setStatus('测试消息已发送 ✓');
      else if (res.error === 'rate_limited') setStatus('⏳ ' + errText('rate_limited'));
      else setStatus('测试失败: ' + errText(res.error));
    } catch (e) { setStatus('测试失败: ' + (e as Error).message); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    setBusy(true); setStatus('');
    try {
      await removeAlertConfig();
      setEnabled(false); setChatId(''); setToken(''); setStatus('已移除');
      load();
    } catch (e) { setStatus('移除失败: ' + (e as Error).message); }
    finally { setBusy(false); }
  };

  const placeholder = cfg?.configured
    ? `已配置 (bot ${cfg.bot_id || '?'})，留空保持不变`
    : '粘贴 Bot Token';

  return (
    <div style={cardStyle}>
      <h3 style={{ margin: '0 0 4px', fontSize: '16px' }}>Telegram 通知</h3>
      <p style={{ margin: '0 0 16px', fontSize: '12px', color: '#6b7280' }}>
        告警将推送到此 Telegram 会话。Token 加密存储、只写不回显。
        {cfg && cfg.configured && !cfg.decryptable && (
          <span style={{ color: '#dc2626' }}> ⚠ 无法解密(密钥可能已轮换),请重新填写 token。</span>
        )}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 480 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '14px' }}>
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> 启用
        </label>
        <label style={labelStyle}>Chat ID
          <input style={inputStyle} value={chatId} onChange={e => setChatId(e.target.value)} placeholder="-1001234567890 或 @channel" />
        </label>
        <label style={labelStyle}>Bot Token
          <input style={inputStyle} type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} placeholder={placeholder} />
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={btnPrimary} disabled={busy} onClick={save}>保存</button>
          <button style={btnSecondary} disabled={busy || !cfg?.configured} onClick={test}>发送测试</button>
          <button style={btnDanger} disabled={busy || !cfg?.configured} onClick={remove}>移除</button>
        </div>
        {status && <div style={{ fontSize: '13px', color: '#374151' }}>{status}</div>}
      </div>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  padding: '20px', background: '#fff', borderRadius: 12,
  boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
};
const rowStyle: React.CSSProperties = {
  padding: '14px 16px', borderRadius: 8, border: '1px solid #f3f4f6',
};
const labelStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 6, fontSize: '13px', fontWeight: 500, color: '#374151',
};
const inputStyle: React.CSSProperties = {
  padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: '14px', outline: 'none',
};
const btnPrimary: React.CSSProperties = {
  padding: '8px 16px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8,
  fontSize: '14px', fontWeight: 600, cursor: 'pointer',
};
const btnSecondary: React.CSSProperties = {
  padding: '8px 16px', background: '#fff', color: '#2563eb', border: '1px solid #2563eb', borderRadius: 8,
  fontSize: '14px', fontWeight: 600, cursor: 'pointer',
};
const btnDanger: React.CSSProperties = {
  padding: '8px 16px', background: '#fff', color: '#dc2626', border: '1px solid #fecaca', borderRadius: 8,
  fontSize: '14px', fontWeight: 600, cursor: 'pointer',
};
