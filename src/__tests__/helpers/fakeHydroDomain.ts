/**
 * 按 Hydro 的真实行为模拟 DomainModel.setUserRole / setJoin（Hydro 4.19 与 5.0 相同）：
 * - 单个 uid：findOneAndUpdate({ domainId, uid }, …, { upsert: true })，没有记录时正确插入。
 * - uid 数组：updateMany({ domainId, uid: { $in } }, …, { upsert: true })。只更新已有记录的人；
 *   一个都没命中时 MongoDB 插入一条不带 uid 的记录，同一域第二次这样插入违反 {domainId, uid} 唯一索引。
 * 早先的测试把数组形式模拟成“逐个 upsert”，掩盖了线上“加入域”失败的问题。
 */

import { ObjectId } from 'mongodb';
import { DomainModel } from 'hydrooj';

type Row = { _id?: unknown; domainId?: string; uid?: number; role?: string; join?: boolean };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FakeColl = { docs: any[] };

function duplicateKey(domainId: string): Error {
  return Object.assign(new Error(`E11000 duplicate key error collection: domain.user index: uid dup key: { domainId: "${domainId}", uid: null }`), { code: 11000 });
}

export function installRealisticDomainModel(domainUser: FakeColl, options: { joinFlag: boolean }): void {
  DomainModel.setUserRole.mockImplementation(async (domainId: string, uid: number | number[], role: string, autojoin = false) => {
    const $set: Partial<Row> = { role, ...(autojoin ? { join: true } : {}) };
    if (!Array.isArray(uid)) {
      const row = (domainUser.docs as Row[]).find((doc) => doc.domainId === domainId && doc.uid === uid);
      if (row) Object.assign(row, $set);
      else domainUser.docs.push({ _id: new ObjectId(), domainId, uid, ...$set });
      return;
    }
    const matched = (domainUser.docs as Row[]).filter((doc) => doc.domainId === domainId && doc.uid !== undefined && uid.includes(doc.uid));
    if (matched.length) {
      for (const row of matched) Object.assign(row, $set);
      return;
    }
    // $in 含多个值时不是等值条件，upsert 出的记录没有 uid
    if ((domainUser.docs as Row[]).some((doc) => doc.domainId === domainId && doc.uid === undefined)) throw duplicateKey(domainId);
    domainUser.docs.push({ _id: new ObjectId(), domainId, ...$set });
  });
  if (options.joinFlag) {
    DomainModel.setJoin.mockImplementation(async (domainId: string, uid: number | number[], join: boolean) => {
      const list = Array.isArray(uid) ? uid : [uid];
      for (const row of domainUser.docs as Row[]) {
        if (row.domainId === domainId && row.uid !== undefined && list.includes(row.uid)) row.join = join;
      }
    });
  }
}
