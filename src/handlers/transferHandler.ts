/**
 * 跨域转移接口（US9）
 *
 * 全部仅限系统管理员（PRIV_EDIT_SYSTEM）：路由层校验之外，处理器内再校验一次。
 * POST /ai-helper/admin/transfer/preview   预览（只读），返回 previewToken（10 分钟有效）
 * POST /ai-helper/admin/transfer/execute   预览请求体 + previewToken + joinRole + removeMembersFromSource? + selectedUids?
 * POST /ai-helper/admin/transfer/resume    { auditId } 继续完成剩余部分
 * POST /ai-helper/admin/transfer/undo      { auditId } 撤销已完成部分
 */

import { Handler, PRIV } from 'hydrooj';
import { rejectIfCsrfInvalid } from '../lib/csrfHelper';
import type { TransferService } from '../services/transferService';
import { rejectIfNotSystemAdmin, respondGroupError } from './groupAdminHandler';

function json(handler: Handler, status: number, body: Record<string, unknown>): void {
  if (status !== 200) handler.response.status = status;
  handler.response.body = body;
  handler.response.type = 'application/json';
}

function service(handler: Handler): TransferService {
  return handler.ctx.get('transferService') as TransferService;
}

function body(handler: Handler): Record<string, unknown> {
  const raw = handler.request.body;
  return raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
}

function actor(handler: Handler): number {
  return Number(handler.user?._id);
}

function guard(handler: Handler): boolean {
  return rejectIfCsrfInvalid(handler) || rejectIfNotSystemAdmin(handler);
}

export class TransferPreviewHandler extends Handler {
  async post() {
    if (guard(this)) return;
    try {
      json(this, 200, await service(this).preview(body(this)) as unknown as Record<string, unknown>);
    } catch (err) {
      respondGroupError(this, err, 'ai_helper_transfer_preview_failed', 'TRANSFER_PREVIEW_FAILED');
    }
  }
}

export class TransferExecuteHandler extends Handler {
  async post() {
    if (guard(this)) return;
    try {
      json(this, 200, await service(this).execute(body(this), actor(this)) as unknown as Record<string, unknown>);
    } catch (err) {
      respondGroupError(this, err, 'ai_helper_transfer_execute_failed', 'TRANSFER_EXECUTE_FAILED');
    }
  }
}

export class TransferResumeHandler extends Handler {
  async post() {
    if (guard(this)) return;
    try {
      json(this, 200, await service(this).resume(body(this).auditId, actor(this)) as unknown as Record<string, unknown>);
    } catch (err) {
      respondGroupError(this, err, 'ai_helper_transfer_execute_failed', 'TRANSFER_EXECUTE_FAILED');
    }
  }
}

export class TransferUndoHandler extends Handler {
  async post() {
    if (guard(this)) return;
    try {
      json(this, 200, { success: true, ...await service(this).undo(body(this).auditId, actor(this)) });
    } catch (err) {
      respondGroupError(this, err, 'ai_helper_transfer_undo_failed', 'TRANSFER_UNDO_FAILED');
    }
  }
}

export const TransferHandlerPriv = PRIV.PRIV_EDIT_SYSTEM;
