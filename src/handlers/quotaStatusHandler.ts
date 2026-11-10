/**
 * 学生端次数状态（FR-019，plan R18）
 * GET /ai-helper/quota-status
 *
 * 返回当前用户今日的上限、已用、剩余、重置时间，以及是否被管理员关闭。次数按用户跨域合计。
 * credit：信誉系数是否降低、预计恢复时间、近期扣分的违规类别和时间及申诉入口（FR-034，不含规则细节）。
 */

import { Handler, PRIV } from 'hydrooj';
import type { QuotaService } from '../services/quotaService';
import type { CreditService } from '../services/creditService';

export class QuotaStatusHandler extends Handler {
  async get() {
    try {
      const quotaService = this.ctx.get('quotaService') as QuotaService;
      const uid = Number(this.user._id);
      const creditService = this.ctx.get('creditService') as CreditService | undefined;
      const [status, credit] = await Promise.all([
        quotaService.status(uid),
        creditService ? creditService.studentStatus(uid).catch((err) => {
          console.warn('[AI Helper] 读取信誉状态失败:', err instanceof Error ? err.message : 'unknown');
          return null;
        }) : Promise.resolve(null),
      ]);
      this.response.body = { ...status, credit };
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
