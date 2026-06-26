/**
 * Update Channel - 更新通道配置
 *
 * 通过环境变量 AI_HELPER_UPDATE_CHANNEL 控制本实例的更新来源：
 *
 *   - stable（默认）：只更新到正式发布的版本标签（git tag `vX.Y.Z`）。
 *                     普通用户（学生/老师的生产实例）应使用此通道，
 *                     即使误点"覆盖更新"也只会拿到已发布、已测试的版本。
 *
 *   - edge：跟踪 main 分支最新代码（即旧版行为）。
 *           仅建议开发者在自己的测试服务器上设置，
 *           方便推送后一键拉取 main 进行测试。
 *
 * 设置方式（仅在需要 edge 的测试服务器上）：
 *   export AI_HELPER_UPDATE_CHANNEL=edge
 *
 * 未设置或取值非法时一律回退到 stable（最安全的默认值）。
 */

export type UpdateChannel = 'stable' | 'edge';

export const DEFAULT_UPDATE_CHANNEL: UpdateChannel = 'stable';

/**
 * 读取当前实例的更新通道
 * - 接受别名：edge/dev/main → edge；stable/release/prod/空 → stable
 * - 其它任何值出于安全考虑回退到 stable
 */
export function getUpdateChannel(): UpdateChannel {
  const raw = (process.env.AI_HELPER_UPDATE_CHANNEL || '').trim().toLowerCase();

  if (raw === 'edge' || raw === 'dev' || raw === 'main') {
    return 'edge';
  }

  // stable / release / prod / 空字符串 / 未知值 → 默认 stable
  return DEFAULT_UPDATE_CHANNEL;
}

/**
 * 是否为开发(edge)通道
 */
export function isEdgeChannel(): boolean {
  return getUpdateChannel() === 'edge';
}
