export interface Overview {
  instances: number;
  active_users_7d: number;
  total_conversations: number;
  error_rate_percent: number;
}

export interface Instance {
  instance_id: string;
  version: string;
  active_users_7d: number;
  total_conversations: number;
  error_count_24h: number;
  api_failure_count_24h: number;
  last_report_at: string;
  node_version: string | null;
  os_platform: string | null;
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

export interface FeedbackItem {
  id: number;
  instance_id: string;
  version: string;
  type: string;
  subject: string;
  body: string | null;
  contact_email: string | null;
  received_at: string;
}

export type Tab = 'overview' | 'instances' | 'errors' | 'feedback';
