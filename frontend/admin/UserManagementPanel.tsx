/**
 * “用户管理”标签：二级导航
 *
 * 分区顺序与设计稿一致：学生总览 / 小组 / 每日额度 / 操作审计。
 * 当前分区写入 URL 的 `section` 参数，刷新或分享链接时保持。
 */

import React, { useCallback, useEffect, useState } from 'react';
import { i18n } from '../utils/i18n';
import { getDomainFromUrl } from '../utils/domainUtils';
import { SPACING } from '../utils/styles';
import { Toast, useToast } from '../components/Toast';
import { GroupManagerPanel } from './GroupManagerPanel';
import { AuditPanel } from './AuditPanel';
import { QuotaPanel } from './QuotaPanel';
import { UserOverviewPanel } from './UserOverviewPanel';
import { SubNav } from './userManagementUi';

type UserSection = 'students' | 'groups' | 'quota' | 'audit';

const SECTIONS: UserSection[] = ['students', 'groups', 'quota', 'audit'];

function readSection(): UserSection {
  if (typeof window === 'undefined') return 'students';
  const value = new URLSearchParams(window.location.search).get('section');
  return SECTIONS.includes(value as UserSection) ? value as UserSection : 'students';
}

export const UserManagementPanel: React.FC = () => {
  const [section, setSection] = useState<UserSection>(readSection);
  const { toasts, showToast, dismissToast } = useToast(4000);
  const domainId = getDomainFromUrl() || 'system';

  useEffect(() => {
    const onPop = () => setSection(readSection());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const changeSection = useCallback((next: UserSection) => {
    setSection(next);
    const url = new URL(window.location.href);
    url.searchParams.set('section', next);
    window.history.pushState({}, '', url.toString());
  }, []);

  const labels: Record<UserSection, string> = {
    students: i18n('ai_helper_um_nav_students'),
    groups: i18n('ai_helper_um_nav_groups'),
    quota: i18n('ai_helper_um_nav_quota'),
    audit: i18n('ai_helper_um_nav_audit'),
  };

  return (
    <div className="ai-um-root" style={{ padding: SPACING.lg }}>
      <style>{`
        .ai-um-root input, .ai-um-root select, .ai-um-root textarea { box-sizing: border-box; }
        .ai-um-root button:disabled { opacity: 0.55; cursor: not-allowed; }
      `}</style>
      <Toast messages={toasts} onDismiss={dismissToast} />
      <SubNav
        ariaLabel={i18n('ai_helper_dashboard_tab_users')}
        items={SECTIONS.map((id) => ({ id, label: labels[id] }))}
        active={section}
        onChange={changeSection}
      />
      {section === 'students' && <UserOverviewPanel domainId={domainId} showToast={showToast} onOpenAudit={() => changeSection('audit')} />}
      {section === 'groups' && (
        <GroupManagerPanel initialDomainId={domainId} onOpenAudit={() => changeSection('audit')} showToast={showToast} />
      )}
      {section === 'quota' && <QuotaPanel domainId={domainId} showToast={showToast} />}
      {section === 'audit' && <AuditPanel currentDomainId={domainId} showToast={showToast} />}
    </div>
  );
};

export default UserManagementPanel;
