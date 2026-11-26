import { ProblemModel, db } from 'hydrooj';

/**
 * 比赛进行中判定（禁用 AI 的唯一可信依据，不依赖客户端传来的 contestId/referer）。
 *
 * 判定逻辑：
 * 1. 反查题目是否被任何比赛文档引用（pids 兼容对象 {docId: score} 与
 *    数组 [docId, ...] 两种存储形态）；
 * 2. 命中比赛若 rule 非 homework 且处于 beginAt <= now < endAt 时间窗口，
 *    则判定为受限；
 * 3. 任何查询异常向上抛出，由调用方 fail-closed 处理。
 */
export async function isProblemInOngoingContest(
  domainId: string,
  problemId: string | number,
): Promise<boolean> {
  const pdoc = await ProblemModel.get(domainId, problemId, ['docId']);
  if (!pdoc) return false;
  // pids 在不同版本/导入路径下有两种存储形态：
  //   对象 { "<docId>": score }  或  数组 [docId, ...]
  // 两种都要命中，否则比赛禁用会静默失效。
  const refContests = await db.collection('document').find({
    domainId,
    docType: 30,
    $or: [
      { [`pids.${pdoc.docId}`]: { $exists: true } },
      { pids: { $elemMatch: { $eq: pdoc.docId } } },
    ],
  }).project({ rule: 1, beginAt: 1, endAt: 1 }).toArray();
  const now = new Date();
  return refContests.some((c: any) => c.rule !== 'homework'
    && c.beginAt <= now && now < c.endAt);
}
