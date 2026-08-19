export interface Overview {
  instances: number;
  reporting_instances?: number;
  active_users_7d: number;
  active_users_30d?: number;
  active_users_90d?: number;
  total_conversations: number;
  error_rate_percent: number;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
  latency_p99_ms: number | null;
  api_metric_window_hours?: number;
  health_freshness_hours?: number;
}

export interface Instance {
  instance_id: string;
  version: string;
  active_users_7d: number;
  active_users_30d?: number;
  active_users_90d?: number;
  total_conversations: number;
  error_count_24h: number;
  api_failure_count_24h: number;
  last_report_at: string;
  installed_at?: string | null;
  node_version: string | null;
  os_platform: string | null;
  geo_country?: string | null;
  geo_region?: string | null;
  degraded_features?: number;
}

export interface VersionDistribution {
  version: string;
  count: number;
}

export interface InstancesResponse {
  instances: Instance[];
  total: number;
  limit: number;
  offset: number;
  version_distribution: VersionDistribution[];
}

export interface ErrorGroup {
  stack_fingerprint: string;
  error_type: string;
  category: string;
  message: string;
  affected_instances: number;
  total_count: number;
  last_seen: string;
  metadata?: string;
  versions?: string;
}

export interface ErrorsResponse {
  errors: ErrorGroup[];
  total: number;
  limit: number;
  offset: number;
}

export interface RelatedError {
  stack_fingerprint: string;
  error_type: string;
  category: string;
  message: string | null;
  count: number;
  last_seen: string;
}

export interface FeedbackItem {
  id: number;
  instance_id: string;
  version: string;
  type: string;
  subject: string;
  body: string | null;
  contact_email: string | null;
  received_at: string;
  related_errors?: RelatedError[];
}

export interface FeatureHealth {
  feature: string;
  attempts: number;
  successes: number;
  broken_instances: number;
  reporting_instances: number;
  last_success_at: string | null;
}

/** 按日累计的功能用量汇总（plugin_feature_daily） */
export interface FeatureUsage {
  feature: string;
  total_attempts: number;
  total_successes: number;
  instances: number;
  since: string | null;
  until: string | null;
}

/** 按场景、模型累计的完整请求结果（成功与失败都有分母）。 */
export interface ModelUsage {
  scenario: string;
  model_name: string;
  total_attempts: number;
  total_successes: number;
  instances: number;
  since: string | null;
  until: string | null;
}

export interface FeatureHealthResponse {
  features: FeatureHealth[];
  usage?: FeatureUsage[];
  model_usage?: ModelUsage[];
  usage_window_days?: number;
  snapshot_max_age_hours?: number;
}

export interface TestdataQualityRate {
  count: number;
  total: number;
  rate: number | null;
}

export interface TestdataQualityDistributionItem {
  key: string;
  count: number;
}

export interface TestdataQualityResponse {
  window_days: number;
  total_runs: number;
  metrics?: Partial<Record<
    | 'pipeline_completion'
    | 'verified'
    | 'would_block'
    | 'accepted_unchanged'
    | 'accepted_edited'
    | 'discarded'
    | 'regenerated'
    | 'model_escalation_rescue'
    | 'verified_but_teacher_changed',
    TestdataQualityRate
  >>;
  failure_codes?: TestdataQualityDistributionItem[];
  failure_stages?: TestdataQualityDistributionItem[];
  failure_artifacts?: TestdataQualityDistributionItem[];
  risk_tiers?: TestdataQualityDistributionItem[];
  templates?: Partial<Record<'py' | 'java' | 'cc', {
    requested: number;
    verified: number;
    rate: number | null;
  }>>;
  checker?: {
    configured?: TestdataQualityRate;
    read?: TestdataQualityRate;
    compiled?: TestdataQualityRate;
    executed?: TestdataQualityRate;
    infra_failure?: TestdataQualityRate;
    infra_failures?: number;
  };
  stress?: Partial<Record<
    'generated' | 'valid' | 'dropped_invalid' | 'unique' | 'compared' | 'agreed',
    number
  >>;
  version_trend?: Array<{
    plugin_version: string;
    runs: number;
    pipeline_completed: number;
    verified: number;
    would_block: number;
  }>;
}

export interface Alert {
  id: number;
  alert_key: string;
  severity: string;
  title: string;
  detail: string | null;
  created_at: string;
}

export interface TelegramConfig {
  enabled: boolean;
  configured: boolean;
  decryptable: boolean;
  bot_id: string | null;
  chat_id: string | null;
}

export interface TelegramConfigInput {
  enabled: boolean;
  chat_id: string;
  token?: string; // omitted ⇒ keep existing token
}

export type Tab = 'overview' | 'instances' | 'errors' | 'feature-health' | 'testdata-quality' | 'alerts' | 'feedback';
