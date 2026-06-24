import type { Overview, Instance, ErrorGroup, FeedbackItem, FeatureHealth, Alert, TelegramConfig, TelegramConfigInput } from './types';

let apiBase = '';
let token = '';

export function configure(base: string, dashboardToken: string) {
  apiBase = base.replace(/\/+$/, '');
  token = dashboardToken;
}

async function fetchApi<T>(path: string): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
  return res.json();
}

async function postApi<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // 4xx carry a JSON {error}; surface it rather than the bare status.
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !('ok' in (data as object))) {
    throw new Error((data as { error?: string }).error || `API ${res.status}`);
  }
  return data as T;
}

export const getOverview = () => fetchApi<Overview>('/api/dashboard/overview');

export const getInstances = (limit = 50, offset = 0) =>
  fetchApi<{ instances: Instance[] }>(`/api/dashboard/instances?limit=${limit}&offset=${offset}`);

export const getErrors = (limit = 50, offset = 0) =>
  fetchApi<{ errors: ErrorGroup[] }>(`/api/dashboard/errors?limit=${limit}&offset=${offset}`);

export const getFeedback = (limit = 50, offset = 0) =>
  fetchApi<{ feedback: FeedbackItem[] }>(`/api/dashboard/feedback?limit=${limit}&offset=${offset}`);

export const getFeatureHealth = () =>
  fetchApi<{ features: FeatureHealth[] }>('/api/dashboard/feature-health');

export const getAlerts = (limit = 50) =>
  fetchApi<{ alerts: Alert[] }>(`/api/dashboard/alerts?limit=${limit}`);

export const getAlertConfig = () =>
  fetchApi<{ telegram: TelegramConfig }>('/api/dashboard/alert-config');

export const saveAlertConfig = (telegram: TelegramConfigInput) =>
  postApi<{ success: boolean; error?: string }>('/api/dashboard/alert-config', { telegram });

export const removeAlertConfig = () =>
  postApi<{ success: boolean }>('/api/dashboard/alert-config/remove');

export const testAlertConfig = () =>
  postApi<{ ok: boolean; error?: string }>('/api/dashboard/alert-config/test');
