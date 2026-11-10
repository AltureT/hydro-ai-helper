/**
 * 跨域选人：按用户名开头搜索或粘贴名单（复用小组搜索接口，范围固定为全部域）
 * 用于额度组加成员、设置个人额度。
 */

import React, { useState } from 'react';
import { i18n } from '../utils/i18n';
import { COLORS, RADIUS, SPACING, getButtonStyle, getInputStyle } from '../utils/styles';
import { postJson, errorMessage } from './userManagementApi';
import { domainApiUrl, type SearchResponse, type SearchUser } from './userManagementLogic';
import { PillGroup, linkButtonStyle, mutedTextStyle } from './userManagementUi';

export interface PickedUser {
  uid: number;
  uname: string;
}

type PickMode = 'prefix' | 'list';

export const UserPicker: React.FC<{
  domainId: string;
  selected: PickedUser[];
  onChange: (users: PickedUser[]) => void;
  max?: number;
  /** 已在目标中的用户：结果里标出且不可再选 */
  existing?: Set<number>;
}> = ({ domainId, selected, onChange, max = 500, existing }) => {
  const [mode, setMode] = useState<PickMode>('prefix');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchUser[] | null>(null);
  const [unmatched, setUnmatched] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedIds = new Set(selected.map((user) => user.uid));

  const search = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setError(null);
    try {
      const res = await postJson<SearchResponse>(
        domainApiUrl(domainId, '/ai-helper/groups/search'),
        { mode, query, scope: 'all' },
        i18n('ai_helper_group_search_failed'),
      );
      if (res.overflow) {
        setResults([]);
        setError(i18n('ai_helper_um_picker_overflow', 500));
        return;
      }
      setResults(res.users);
      setUnmatched(res.unmatched || []);
      // 粘贴名单是明确点名：直接全部加入
      if (mode === 'list') add(res.users);
    } catch (err) {
      setError(errorMessage(err, i18n('ai_helper_group_search_failed')));
    } finally {
      setSearching(false);
    }
  };

  const add = (users: PickedUser[]) => {
    const next = [...selected];
    for (const user of users) {
      if (next.length >= max) break;
      if (existing?.has(user.uid)) continue;
      if (!next.some((item) => item.uid === user.uid)) next.push({ uid: user.uid, uname: user.uname });
    }
    onChange(next);
  };

  const toggle = (user: SearchUser) => {
    if (selectedIds.has(user.uid)) onChange(selected.filter((item) => item.uid !== user.uid));
    else add([user]);
  };

  return (
    <div style={{ display: 'grid', gap: SPACING.sm }}>
      <div style={{ display: 'flex', gap: SPACING.sm, alignItems: 'center', flexWrap: 'wrap' }}>
        <PillGroup<PickMode>
          ariaLabel={i18n('ai_helper_um_picker_mode')}
          value={mode}
          onChange={(next) => { setMode(next); setResults(null); setUnmatched([]); }}
          options={[
            { id: 'prefix', label: i18n('ai_helper_um_picker_prefix') },
            { id: 'list', label: i18n('ai_helper_um_picker_list') },
          ]}
        />
      </div>
      <div style={{ display: 'flex', gap: SPACING.sm, alignItems: 'flex-start' }}>
        {mode === 'prefix' ? (
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); search(); } }}
            placeholder={i18n('ai_helper_um_picker_prefix_placeholder')}
            aria-label={i18n('ai_helper_um_picker_prefix')}
            style={{ ...getInputStyle(), flex: 1, minWidth: 0 }}
          />
        ) : (
          <textarea
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            rows={3}
            placeholder={i18n('ai_helper_um_picker_list_placeholder')}
            aria-label={i18n('ai_helper_um_picker_list')}
            style={{ ...getInputStyle(), flex: 1, minWidth: 0, resize: 'vertical', fontFamily: 'inherit' }}
          />
        )}
        <button type="button" onClick={search} disabled={searching || !query.trim()} style={getButtonStyle('secondary')}>
          {searching ? i18n('ai_helper_um_searching') : i18n('ai_helper_um_search')}
        </button>
      </div>
      {error && <div style={{ ...mutedTextStyle, color: COLORS.errorText }}>{error}</div>}
      {unmatched.length > 0 && (
        <div style={{ ...mutedTextStyle, color: COLORS.warningText }}>
          {i18n('ai_helper_um_picker_unmatched', unmatched.length, unmatched.slice(0, 5).join('、'))}
        </div>
      )}
      {results && mode === 'prefix' && (
        <div style={{ border: `1px solid ${COLORS.border}`, borderRadius: RADIUS.md, maxHeight: '180px', overflowY: 'auto' }}>
          {results.length === 0 && <div style={{ ...mutedTextStyle, padding: SPACING.sm }}>{i18n('ai_helper_um_picker_none')}</div>}
          {results.length > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: `4px ${SPACING.sm}`, borderBottom: `1px solid ${COLORS.border}` }}>
              <span style={mutedTextStyle}>{i18n('ai_helper_um_picker_found', results.length)}</span>
              <button type="button" style={linkButtonStyle} onClick={() => add(results)}>{i18n('ai_helper_um_picker_add_all')}</button>
            </div>
          )}
          {results.map((user) => (
            <label
              key={user.uid}
              style={{
                display: 'flex', gap: SPACING.sm, alignItems: 'center', padding: `6px ${SPACING.sm}`, fontSize: '14px',
                cursor: existing?.has(user.uid) ? 'default' : 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={selectedIds.has(user.uid) || !!existing?.has(user.uid)}
                disabled={!!existing?.has(user.uid)}
                onChange={() => toggle(user)}
              />
              <span style={{ fontWeight: 600, color: COLORS.textPrimary }}>{user.uname}</span>
              <span style={mutedTextStyle}>uid {user.uid}</span>
              {existing?.has(user.uid) && <span style={{ ...mutedTextStyle, fontSize: '12px' }}>{i18n('ai_helper_um_picker_existing')}</span>}
              {user.domains && user.domains.length > 0 && (
                <span style={{ ...mutedTextStyle, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {user.domains.map((domain) => domain.name).join('、')}
                </span>
              )}
            </label>
          ))}
        </div>
      )}
      {selected.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }} aria-label={i18n('ai_helper_um_picker_selected', selected.length)}>
          <span style={mutedTextStyle}>{i18n('ai_helper_um_picker_selected', selected.length)}</span>
          {selected.slice(0, 30).map((user) => (
            <span
              key={user.uid}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '2px 4px 2px 10px',
                borderRadius: RADIUS.full, background: COLORS.primaryLight, color: COLORS.primary, fontSize: '13px',
              }}
            >
              {user.uname}
              <button
                type="button"
                aria-label={i18n('ai_helper_um_picker_remove', user.uname)}
                onClick={() => onChange(selected.filter((item) => item.uid !== user.uid))}
                style={{ border: 'none', background: 'transparent', color: COLORS.primary, cursor: 'pointer', padding: '0 4px', fontSize: '14px' }}
              >
                ×
              </button>
            </span>
          ))}
          {selected.length > 30 && <span style={mutedTextStyle}>{i18n('ai_helper_um_and_more', selected.length - 30)}</span>}
          <button type="button" style={linkButtonStyle} onClick={() => onChange([])}>{i18n('ai_helper_um_picker_clear')}</button>
        </div>
      )}
    </div>
  );
};
