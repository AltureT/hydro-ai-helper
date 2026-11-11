import { DomainModel, UserModel } from 'hydrooj';
import { setHydroMode } from '../__mocks__/hydrooj';
import {
  allowedJoinRoles,
  clearDomainUserCache,
  defaultJoinRole,
  groupColl,
  hasSystemPriv,
  isJoinFlagMembership,
  joinDomain,
  leaveDomain,
  memberFilter,
  roleHasPerm,
} from '../../utils/hydroCompat';
import { installRealisticDomainModel } from '../helpers/fakeHydroDomain';

const PERM_EDIT_DOMAIN = 1n << 1n;

describe('hydroCompat (Hydro 4 shape)', () => {
  beforeEach(() => setHydroMode('v4'));

  it('detects role-based membership', () => {
    expect(isJoinFlagMembership()).toBe(false);
    expect(memberFilter()).toEqual({ role: { $nin: ['default', 'guest'], $ne: null } });
  });

  it('joins users one by one because the array form cannot upsert new rows', async () => {
    await joinDomain('oi2023', [1031, 1032, 1031], 'student');
    expect(DomainModel.setUserRole).toHaveBeenCalledTimes(2);
    expect(DomainModel.setUserRole).toHaveBeenNthCalledWith(1, 'oi2023', 1031, 'student');
    expect(DomainModel.setUserRole).toHaveBeenNthCalledWith(2, 'oi2023', 1032, 'student');
  });

  it('leaves the domain by resetting the role to default', async () => {
    await leaveDomain('oi2023', [1031]);
    expect(DomainModel.setUserRole).toHaveBeenCalledWith('oi2023', 1031, 'default');
  });

  it('excludes default, guest and root from join roles', () => {
    const roles = allowedJoinRoles({ roles: { student: '4', teacher: '6', default: '8' } });
    expect(roles).toEqual(['student', 'teacher']);
  });

  it('clears local cache keys for the domain and then broadcasts', () => {
    UserModel.cache.set('id/1031/oi2023', {});
    UserModel.cache.set('name/2301张三/oi2023', {});
    UserModel.cache.set('id/1031/oi2024', {});
    const order: string[] = [];
    const originalDelete = UserModel.cache.delete.bind(UserModel.cache);
    UserModel.cache.delete = (key: string) => { order.push(`delete:${key}`); return originalDelete(key); };
    const broadcast = jest.fn(() => { order.push('broadcast'); });

    clearDomainUserCache({ broadcast }, 'oi2023');

    expect([...UserModel.cache.keys()]).toEqual(['id/1031/oi2024']);
    expect(broadcast).toHaveBeenCalledWith('user/delcache', JSON.stringify('oi2023'));
    expect(order[order.length - 1]).toBe('broadcast');
  });

  it('tolerates a missing broadcast function', () => {
    expect(() => clearDomainUserCache({}, 'oi2023')).not.toThrow();
  });
});

describe('hydroCompat (Hydro 5 shape)', () => {
  beforeEach(() => setHydroMode('v5'));

  it('detects join-flag membership', () => {
    expect(isJoinFlagMembership()).toBe(true);
    expect(memberFilter()).toEqual({ join: true });
  });

  it('joins users one by one with autojoin, because the array form only updates existing rows', async () => {
    await joinDomain('oi2023', [1031, 1032, 1031], 'student');
    expect(DomainModel.setUserRole).toHaveBeenCalledTimes(2);
    expect(DomainModel.setUserRole).toHaveBeenNthCalledWith(1, 'oi2023', 1031, 'student', true);
    expect(DomainModel.setUserRole).toHaveBeenNthCalledWith(2, 'oi2023', 1032, 'student', true);
  });

  it('leaves the domain the same way as Hydro kick', async () => {
    await leaveDomain('oi2023', [1031, 1032]);
    expect(DomainModel.setJoin).toHaveBeenCalledWith('oi2023', [1031, 1032], false);
    expect(DomainModel.setUserRole).toHaveBeenCalledWith('oi2023', 1031, 'guest');
    expect(DomainModel.setUserRole).toHaveBeenCalledWith('oi2023', 1032, 'guest');
    expect(DomainModel.setUserRole).not.toHaveBeenCalledWith('oi2023', expect.any(Array), 'guest');
  });

  it('joins people with no domain.user record against Hydro\'s real array semantics', async () => {
    const domainUser = { docs: [{ domainId: 'oi2023', uid: 1031, role: 'student', join: true }] as any[] };
    installRealisticDomainModel(domainUser, { joinFlag: true });
    await joinDomain('oi2024', [1031, 1032], 'student');
    await joinDomain('oi2024', [1033, 1034], 'student');
    const rows = domainUser.docs.filter((row) => row.domainId === 'oi2024');
    expect(rows.map((row) => row.uid).sort()).toEqual([1031, 1032, 1033, 1034]);
    expect(rows.every((row) => row.join === true && row.role === 'student')).toBe(true);
  });

  it('allows default as a join role but still excludes guest and root', () => {
    expect(allowedJoinRoles({ roles: { student: '4' } })).toEqual(['student', 'default']);
  });

  it('delegates cache clearing to _deleteUserCache', () => {
    const broadcast = jest.fn();
    clearDomainUserCache({ broadcast }, 'oi2023');
    expect(UserModel._deleteUserCache).toHaveBeenCalledWith('oi2023');
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('does nothing for an empty uid list', async () => {
    await joinDomain('oi2023', [], 'student');
    await leaveDomain('oi2023', []);
    expect(DomainModel.setUserRole).not.toHaveBeenCalled();
    expect(DomainModel.setJoin).not.toHaveBeenCalled();
  });
});

describe('hydroCompat helpers', () => {
  beforeEach(() => setHydroMode('v4'));

  it('uses the join-settings role only when it is allowed', () => {
    expect(defaultJoinRole({ roles: { student: '4' }, _join: { role: 'student' } })).toBe('student');
    expect(defaultJoinRole({ roles: { student: '4' }, _join: { role: 'default' } })).toBeNull();
    expect(defaultJoinRole({ roles: { student: '4' }, _join: null })).toBeNull();
  });

  it('checks role permissions including root and built-in roles', () => {
    const ddoc = { roles: { teacher: String(PERM_EDIT_DOMAIN | 4n), student: '4' } };
    expect(roleHasPerm(ddoc, 'teacher', PERM_EDIT_DOMAIN)).toBe(true);
    expect(roleHasPerm(ddoc, 'student', PERM_EDIT_DOMAIN)).toBe(false);
    expect(roleHasPerm(ddoc, 'root', PERM_EDIT_DOMAIN)).toBe(true);
    expect(roleHasPerm(ddoc, 'missing', PERM_EDIT_DOMAIN)).toBe(false);
    expect(roleHasPerm(ddoc, undefined, PERM_EDIT_DOMAIN)).toBe(false);
  });

  it('detects system privilege bits', () => {
    expect(hasSystemPriv(2)).toBe(true);
    expect(hasSystemPriv(-1)).toBe(true);
    expect(hasSystemPriv(1)).toBe(false);
    expect(hasSystemPriv(undefined)).toBe(false);
  });

  it('returns the Hydro group collection', () => {
    const coll = {};
    const db = { collection: jest.fn(() => coll) } as any;
    expect(groupColl(db)).toBe(coll);
    expect(db.collection).toHaveBeenCalledWith('user.group');
  });
});
