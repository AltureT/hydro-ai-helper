import { DomainModel, PRIV } from 'hydrooj';
import { setHydroMode } from '../__mocks__/hydrooj';
import { createFakeCollection, createFakeDb } from '../helpers/fakeMongo';
import { AuditLogModel } from '../../models/auditLog';
import { GroupMetaModel } from '../../models/groupMeta';
import { QuotaGroupModel } from '../../models/quotaGroup';
import { TransferJobModel } from '../../models/transferJob';
import { AuditService } from '../../services/auditService';
import { TransferService } from '../../services/transferService';
import {
  TransferExecuteHandler,
  TransferHandlerPriv,
  TransferPreviewHandler,
  TransferResumeHandler,
  TransferUndoHandler,
} from '../../handlers/transferHandler';

function setup() {
  setHydroMode('v5');
  const db = createFakeDb({
    user: createFakeCollection([{ _id: 2031, uname: '2301张三', priv: 1 }]),
    domain: createFakeCollection([{ _id: 'oi2023', name: '信息学 2023' }, { _id: 'oi2024', name: '信息学 2024' }]),
    'domain.user': createFakeCollection([{ domainId: 'oi2023', uid: 2031, role: 'student', join: true }]),
    'user.group': createFakeCollection([{ domainId: 'oi2023', name: '2023级1班', uids: [2031] }]),
  });
  DomainModel.get.mockImplementation(async (id: string) => ({ _id: id, owner: 1, roles: { student: '4' }, _join: { role: 'student' } }));
  let now = new Date('2026-11-10T08:00:00Z');
  const service = new TransferService(
    db as any,
    new GroupMetaModel(db as any),
    new QuotaGroupModel(db as any),
    new TransferJobModel(db as any),
    new AuditService(new AuditLogModel(db as any)),
    { invalidate: jest.fn() },
    { broadcast: jest.fn() },
    () => now,
  );
  return { db, service, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

function makeHandler<T extends { request: any; response: any; ctx: any; user?: any }>(
  HandlerClass: new () => T,
  env: ReturnType<typeof setup>,
  options: { body?: any; csrf?: boolean; admin?: boolean } = {},
): T {
  const handler = new HandlerClass();
  handler.request = { headers: options.csrf === false ? {} : { 'x-requested-with': 'XMLHttpRequest' }, body: options.body || {}, query: {} };
  handler.response = {};
  handler.user = { _id: 2, hasPriv: (priv: number) => (options.admin === false ? false : priv === PRIV.PRIV_EDIT_SYSTEM) };
  (handler as any).translate = (key: string) => key;
  handler.ctx = { get: (name: string) => (name === 'transferService' ? env.service : undefined) };
  return handler;
}

const request = { kind: 'groups', mode: 'copy', sourceDomainId: 'oi2023', targetDomainId: 'oi2024', groupNames: ['2023级1班'] };
const handlers = [TransferPreviewHandler, TransferExecuteHandler, TransferResumeHandler, TransferUndoHandler];

describe('transfer handlers', () => {
  it('are system-admin only, at the route and inside the handler', async () => {
    expect(TransferHandlerPriv).toBe(PRIV.PRIV_EDIT_SYSTEM);
    const env = setup();
    for (const HandlerClass of handlers) {
      const handler = makeHandler(HandlerClass as any, env, { admin: false, body: request }) as any;
      await handler.post();
      expect(handler.response.status).toBe(403);
      expect(handler.response.body.code).toBe('SYSTEM_ADMIN_REQUIRED');
    }
  });

  it('reject requests without the CSRF header', async () => {
    const env = setup();
    for (const HandlerClass of handlers) {
      const handler = makeHandler(HandlerClass as any, env, { csrf: false, body: request }) as any;
      await handler.post();
      expect(handler.response.status).toBe(403);
    }
    expect(env.db.store.ai_transfer_jobs?.docs || []).toHaveLength(0);
  });

  it('previews, rejects an expired token with 409, then executes and undoes', async () => {
    const env = setup();
    const preview = makeHandler(TransferPreviewHandler, env, { body: request });
    await preview.post();
    const token = preview.response.body.previewToken;
    expect(preview.response.body.joinUids).toEqual([2031]);

    env.advance(11 * 60 * 1000);
    const expired = makeHandler(TransferExecuteHandler, env, { body: { ...request, previewToken: token } });
    await expired.post();
    expect(expired.response.status).toBe(409);
    expect(expired.response.body).toEqual({ error: 'ai_helper_transfer_preview_expired', code: 'PREVIEW_EXPIRED' });

    const again = makeHandler(TransferPreviewHandler, env, { body: request });
    await again.post();
    const execute = makeHandler(TransferExecuteHandler, env, { body: { ...request, previewToken: again.response.body.previewToken } });
    await execute.post();
    expect(execute.response.body).toEqual(expect.objectContaining({ status: 'done' }));

    const resume = makeHandler(TransferResumeHandler, env, { body: { auditId: execute.response.body.auditId } });
    await resume.post();
    expect(resume.response.status).toBe(409);
    expect(resume.response.body.code).toBe('TRANSFER_NOT_RESUMABLE');

    const undo = makeHandler(TransferUndoHandler, env, { body: { auditId: execute.response.body.auditId } });
    await undo.post();
    expect(undo.response.body).toEqual({ success: true, undone: 2, status: 'undone' });
  });

  it('maps validation errors to 400', async () => {
    const env = setup();
    const handler = makeHandler(TransferPreviewHandler, env, { body: { ...request, targetDomainId: 'oi2023' } });
    await handler.post();
    expect(handler.response.status).toBe(400);
    expect(handler.response.body.code).toBe('SAME_DOMAIN');
    const missing = makeHandler(TransferPreviewHandler, env, { body: { ...request, targetDomainId: 'nowhere' } });
    await missing.post();
    expect(missing.response.status).toBe(404);
  });
});
