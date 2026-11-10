/**
 * 学生端次数状态（FR-019，plan R18）
 * GET /ai-helper/quota-status
 *
 * 返回当前用户今日的上限、已用、剩余、重置时间，以及是否被管理员关闭。次数按用户跨域合计。
 */

import { Handler, PRIV } from 'hydrooj';
import type { QuotaService } from '../services/quotaService';

export class QuotaStatusHandler extends Handler {
  async get() {
    try {
      const quotaService = this.ctx.get('quotaService') as QuotaService;
      const status = await quotaService.status(Number(this.user._id));
      this.response.body = status;
      this.response.type = 'application/json';
    } catch (err) {
      console.error('[AI Helper] QuotaStatusHandler error:', err instanceof Error ? err.message : 'unknown');
      this.response.status = 500;
      this.response.body = { error: this.translate('ai_helper_quota_status_failed'), code: 'QUOTA_STATUS_FAILED' };
      this.response.type = 'application/json';
    }
  }
}

export const QuotaStatusHandlerPriv = PRIV.PRIV_USER_PROFILE;
