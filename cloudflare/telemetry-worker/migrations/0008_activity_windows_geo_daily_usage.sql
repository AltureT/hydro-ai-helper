-- Migration 0008: Longer activity windows, coarse geo, per-day feature usage
--
-- 1) active_users_30d / active_users_90d: 学生寒暑假后返校仍会继续使用，
--    仅 7 天窗口会在假期把活跃统计清零；新增 30/90 天窗口列。
-- 2) geo_country / geo_region: 上报请求的粗粒度来源（Cloudflare 从请求 IP
--    推断的国家与省/州名，不存储 IP 本身），实例级粒度，用于教研统计。
-- 3) plugin_feature_daily: 按 (instance, feature, date) 累计的功能用量。
--    旧表 plugin_feature_stats 只保留最新 24h 快照（健康监控用），无法回答
--    "测试数据生成/对话/教学分析/学生报告 共发生了多少次"；本表按日累积，
--    upsert 时对同日计数取最大值（计数在一天内单调递增，取最大即最全快照）。
-- Apply with: wrangler d1 migrations apply <db-name>

ALTER TABLE plugin_stats ADD COLUMN active_users_30d INTEGER DEFAULT 0;
ALTER TABLE plugin_stats ADD COLUMN active_users_90d INTEGER DEFAULT 0;
ALTER TABLE plugin_stats ADD COLUMN geo_country TEXT;
ALTER TABLE plugin_stats ADD COLUMN geo_region TEXT;

CREATE TABLE IF NOT EXISTS plugin_feature_daily (
  instance_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  date TEXT NOT NULL,
  attempts INTEGER DEFAULT 0,
  successes INTEGER DEFAULT 0,
  version TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (instance_id, feature, date)
);

CREATE INDEX IF NOT EXISTS idx_feature_daily_feature_date ON plugin_feature_daily(feature, date);
CREATE INDEX IF NOT EXISTS idx_feature_daily_date ON plugin_feature_daily(date);
