/**
 * 知识库管理面板 (Hydro 原生 UI 风格)
 * - 连接配置: builtin 内置库 / http 外部知识库 (链接 ima 知识库或其代理)
 * - 内置条目管理: 新增/编辑/删除/启停
 * - 检索测试: 模拟一次检索并查看将注入 Prompt 的参考块
 */

import React, { useState, useEffect, useCallback } from 'react';
import { confirm, Dialog, Notification, prompt, $ } from '@hydrooj/ui-default';
import { i18n } from '../utils/i18n';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface HttpConfigState {
  url: string;
  kbId: string;
  apiKey: string;
  hasApiKey: boolean;
  timeoutMs: number;
}

interface KbConfigState {
  enabled: boolean;
  mode: 'builtin' | 'http';
  topK: number;
  maxChars: number;
  http?: HttpConfigState;
}

interface Entry {
  id: string;
  title: string;
  content: string;
  tags: string[];
  problemPid?: string;
  enabled: boolean;
}

async function callApi(payload: Record<string, any>) {
  const res = await fetch('/ai-helper/admin/knowledge', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!res.ok || json.ok === false) {
    throw new Error(json.error || `HTTP ${res.status}`);
  }
  return json;
}

export function KnowledgePanel() {
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<KbConfigState | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');

  const loadEntries = useCallback(async (query = search) => {
    try {
      const json = await callApi({ op: 'list', search: query || undefined, page: 1, pageSize: 50 });
      setEntries(json.entries || []);
      setTotal(json.total || 0);
    } catch (err: any) {
      Notification.error(err.message);
    }
  }, [search]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/ai-helper/admin/knowledge', { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const http = json.config.http || {};
      setConfig({
        enabled: !!json.config.enabled,
        mode: json.config.mode || 'builtin',
        topK: json.config.topK || 3,
        maxChars: json.config.maxChars || 2000,
        http: {
          url: http.url || '',
          kbId: http.kbId || '',
          apiKey: '',
          hasApiKey: !!http.hasApiKey,
          timeoutMs: http.timeoutMs || 8000,
        },
      });
      setEntries(json.entries || []);
      setTotal(json.total || 0);
    } catch (err: any) {
      Notification.error(err.message || i18n('ai_helper_kb_error_load', String(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const saveConfig = async () => {
    if (!config) return;
    try {
      const payload: Record<string, any> = {
        op: 'saveConfig',
        config: {
          enabled: config.enabled,
          mode: config.mode,
          topK: config.topK,
          maxChars: config.maxChars,
          http: {
            url: config.http?.url || '',
            kbId: config.http?.kbId || '',
            timeoutMs: config.http?.timeoutMs || 8000,
          },
        },
      };
      if (config.http?.apiKey) (payload.config.http as any).apiKey = config.http.apiKey;
      await callApi(payload);
      Notification.success(i18n('ai_helper_kb_saved'));
      loadAll();
    } catch (err: any) {
      Notification.error(err.message);
    }
  };

  const editEntry = async (entry?: Entry) => {
    const res = await prompt(entry ? i18n('ai_helper_kb_edit') : i18n('ai_helper_kb_add'), {
      title: { type: 'text', label: i18n('ai_helper_kb_col_title'), default: entry?.title || '', required: true },
      tags: { type: 'text', label: i18n('ai_helper_kb_tags', ''), default: (entry?.tags || []).join(','), columns: 6 },
      problemPid: { type: 'text', label: i18n('ai_helper_kb_col_pid'), default: entry?.problemPid || '', columns: 6 },
      content: { type: 'textarea', label: i18n('ai_helper_kb_content'), default: entry?.content || '', rows: 8 },
      enabled: { type: 'checkbox', label: i18n('ai_helper_kb_col_enabled'), default: entry ? String(entry.enabled) : 'true' },
    });
    if (!res) return;
    try {
      const tags = String(res.tags).split(/[,，]/).map((t: string) => t.trim()).filter((t: string) => t);
      if (entry) {
        await callApi({ op: 'update', id: entry.id, title: res.title, content: res.content, tags, problemPid: res.problemPid || undefined, enabled: !!res.enabled });
      } else {
        await callApi({ op: 'create', title: res.title, content: res.content, tags, problemPid: res.problemPid || undefined, enabled: !!res.enabled });
      }
      Notification.success(i18n('ai_helper_kb_saved'));
      loadEntries();
    } catch (err: any) {
      Notification.error(err.message);
    }
  };

  const deleteEntry = async (id: string) => {
    if (!(await confirm(i18n('ai_helper_kb_confirm_delete')))) return;
    try {
      await callApi({ op: 'delete', id });
      loadEntries();
    } catch (err: any) {
      Notification.error(err.message);
    }
  };

  const toggleEntry = async (entry: Entry) => {
    try {
      await callApi({ op: 'update', id: entry.id, enabled: !entry.enabled });
      loadEntries();
    } catch (err: any) {
      Notification.error(err.message);
    }
  };

  const runTest = async () => {
    const res = await prompt(i18n('ai_helper_kb_test'), {
      query: { type: 'text', label: i18n('ai_helper_kb_test_placeholder'), default: '', required: true },
    });
    if (!res) return;
    try {
      const json = await callApi({ op: 'test', query: res.query });
      await new Dialog({
        $body: $(`<pre class="help-text">${escapeHtml(json.block || '(empty)')}</pre>`),
        cancelByClickingBack: true,
      }).open();
    } catch (err: any) {
      Notification.error(err.message);
    }
  };

  if (loading) return <p>{i18n('ai_helper_kb_loading')}</p>;

  return (
    <div>
      {config && (
        <div className="section visible">
          <div className="section__header">
            <h1 className="section__title">{i18n('ai_helper_kb_config')}</h1>
            <div className="section__tools">
              <button type="button" className="primary rounded button" onClick={saveConfig}>{i18n('ai_helper_kb_save_config')}</button>
            </div>
          </div>
          <div className="section__body">
            <div className="row">
              <div className="columns medium-12">
                <label className="checkbox">
                  <input type="checkbox" checked={config.enabled} onChange={(e) => setConfig({ ...config, enabled: e.target.checked })} />
                  {i18n('ai_helper_kb_enable')}
                </label>
              </div>
            </div>
            <div className="row">
              <div className="columns medium-4 form__item">
                <label>{i18n('ai_helper_kb_mode')}</label>
                <select className="select" value={config.mode} onChange={(e) => setConfig({ ...config, mode: e.target.value as any })}>
                  <option value="builtin">{i18n('ai_helper_kb_mode_builtin')}</option>
                  <option value="http">{i18n('ai_helper_kb_mode_http')}</option>
                </select>
              </div>
              <div className="columns medium-4 form__item">
                <label>{i18n('ai_helper_kb_topk')}</label>
                <input type="number" className="textbox" min={1} max={10} value={config.topK} onChange={(e) => setConfig({ ...config, topK: Number(e.target.value) })} />
              </div>
              <div className="columns medium-4 form__item">
                <label>{i18n('ai_helper_kb_maxchars')}</label>
                <input type="number" className="textbox" min={200} max={8000} step={200} value={config.maxChars} onChange={(e) => setConfig({ ...config, maxChars: Number(e.target.value) })} />
              </div>
            </div>
            {config.mode === 'http' && config.http && (
              <div className="row">
                <p className="help-text">{i18n('ai_helper_kb_http_hint')}</p>
                <div className="columns medium-8 form__item">
                  <label>URL</label>
                  <input type="text" className="textbox" value={config.http.url} onChange={(e) => setConfig({ ...config, http: { ...config.http!, url: e.target.value } })} />
                </div>
                <div className="columns medium-4 form__item">
                  <label>API Key</label>
                  <input type="password" className="textbox" value={config.http.apiKey} placeholder={config.http.hasApiKey ? i18n('ai_helper_kb_key_saved') : ''} onChange={(e) => setConfig({ ...config, http: { ...config.http!, apiKey: e.target.value } })} />
                </div>
                <div className="columns medium-4 form__item">
                  <label>{i18n('ai_helper_kb_kbid')}</label>
                  <input type="text" className="textbox" value={config.http.kbId} onChange={(e) => setConfig({ ...config, http: { ...config.http!, kbId: e.target.value } })} />
                </div>
                <div className="columns medium-4 form__item">
                  <label>{i18n('ai_helper_kb_timeout')}</label>
                  <input type="number" className="textbox" min={1000} max={60000} step={500} value={config.http.timeoutMs} onChange={(e) => setConfig({ ...config, http: { ...config.http!, timeoutMs: Number(e.target.value) } })} />
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="section visible">
        <div className="section__header">
          <h1 className="section__title">{i18n('ai_helper_kb_entries')} ({total})</h1>
          <div className="section__tools">
            <button type="button" className="primary rounded button" onClick={() => editEntry()}>{i18n('ai_helper_kb_add')}</button>
          </div>
        </div>
        <div className="section__body">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              loadEntries();
            }}
            name="filter-form"
          >
            <input type="text" className="inline compact textbox" value={search} placeholder={i18n('ai_helper_kb_search')} onChange={(e) => setSearch(e.target.value)} />
            <button type="submit" className="primary rounded button">{i18n('ai_helper_kb_search_btn')}</button>
          </form>
        </div>
        <div className="section__body no-padding">
          <table className="data-table">
            <thead>
              <tr>
                <th>{i18n('ai_helper_kb_col_title')}</th>
                <th>{i18n('ai_helper_kb_tags', '')}</th>
                <th>{i18n('ai_helper_kb_col_pid')}</th>
                <th>{i18n('ai_helper_kb_col_enabled')}</th>
                <th>{i18n('ai_helper_kb_col_actions')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td>{entry.title}<br /><span className="help-text">{entry.content.slice(0, 80)}</span></td>
                  <td>{(entry.tags || []).join(', ')}</td>
                  <td>{entry.problemPid || '-'}</td>
                  <td>
                    <label className="checkbox">
                      <input type="checkbox" checked={entry.enabled} onChange={() => toggleEntry(entry)} />
                    </label>
                  </td>
                  <td>
                    <button type="button" className="rounded button" onClick={() => editEntry(entry)}>{i18n('ai_helper_kb_edit')}</button>
                    <button type="button" className="rounded button warn" onClick={() => deleteEntry(entry.id)}>{i18n('ai_helper_kb_delete')}</button>
                  </td>
                </tr>
              ))}
              {!entries.length && (
                <tr><td colSpan={5} className="text-center">{i18n('ai_helper_kb_no_entries')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="section visible">
        <div className="section__header">
          <h1 className="section__title">{i18n('ai_helper_kb_test')}</h1>
          <div className="section__tools">
            <button type="button" className="rounded button" onClick={runTest}>{i18n('ai_helper_kb_run')}</button>
          </div>
        </div>
        <div className="section__body">
          <p className="help-text">{i18n('ai_helper_kb_test_placeholder')}</p>
        </div>
      </div>
    </div>
  );
}

export default KnowledgePanel;
