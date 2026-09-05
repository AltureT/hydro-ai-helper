/** Exact GeneratorPlan v1 shapes; examples describe syntax, never task constraints. */
export const GENERATOR_PLAN_CONTRACT = `GeneratorPlan v1 完整 JSON 结构：
{"version":1,"seed":17,"cases":[{"label":"实际覆盖","fields":{"字段id":{"kind":"integer","value":1}}}]}
seed 为 0..4294967295 整数；cases 为要求的数量（1..30）；每个 case 只允许 label、fields 和可选 subtaskId。fields 必须恰好包含 frozen Spec 的全部字段 id；不要在 plan 中添加 encoding、约束、源码或 coverage 字段。
每种字段仅允许以下完整形式（数值只是语法示例，必须按 Spec、覆盖与字节预算选择）：
- integer: {"kind":"integer","value":1} 或 {"kind":"integer","min":0,"max":10}。有对应集合生成器的计数字段使用 {"kind":"integer","value":"derived"}；其他字段不得使用 derived。超出安全整数范围的固定值用十进制字符串，仅支持有符号 64 位；min/max 必须是安全整数。
- string: {"kind":"string","length":10,"alphabet":"01","pattern":"random"}；pattern 仅 random/same/alternating；alphabet 不含空白且字符不重复。
- array: {"kind":"array","length":10,"min":0,"max":10,"pattern":"random"}；pattern 仅 random/sorted/reversed/all-equal/alternating。
- matrix: {"kind":"matrix","rows":2,"columns":3,"min":0,"max":10,"pattern":"random"}；pattern 与 array 相同。
- permutation: {"kind":"permutation","size":10,"pattern":"identity"}；pattern 仅 identity/reversed/random。
- tree: {"kind":"tree","size":10,"shape":"chain"}；shape 仅 chain/star/balanced/broom/random。
- graph: {"kind":"graph","size":10,"shape":"sparse"}；shape 仅 sparse/near-tree/dense/bridge/cycle；size 是顶点数，边数由 shape 派生，不能自定义 edges 或 weights。最少 3 个顶点，near-tree 至少 4，bridge 至少 6，dense 至多 500。
- operations 字段: {"kind":"operation-sequence","length":10,"pattern":"add-delete-repeat","minKey":1,"maxKey":10}；pattern 仅 add-delete-repeat/nested-lifetime/query-between-updates；前两种长度至少 4，后一种至少 3 且必须声明 query。仅支持单整数键的集合增删查；参数字段用 integer 的 min/max，必须与 minKey/maxKey 一致；nested-lifetime 至少有两个不同键。
所有长度/size 是 1..100000 整数；matrix 每维至多 10000、总元素至多 100000；所有 CASE 的生成工作量合计至多 1000000（图计入边数）。这是生成能力与资源上限，不是题面上限；不得用它改写 Spec 或声称缺失的最大规模已覆盖。编码计数与实际长度必须相等；多个集合共享计数字段时长度必须一致。`;
