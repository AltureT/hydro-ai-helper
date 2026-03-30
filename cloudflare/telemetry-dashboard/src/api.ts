import type { Overview, Instance, ErrorGroup, FeedbackItem } from './types';

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

export const getOverview = () => fetchApi<Overview>('/api/dashboard/overview');

export const getInstances = (limit = 50, offset = 0) =>
  fetchApi<{ instances: Instance[] }>(`/api/dashboard/instances?limit=${limit}&offset=${offset}`);

export const getErrors = (limit = 50, offset = 0) =>
  fetchApi<{ errors: ErrorGroup[] }>(`/api/dashboard/errors?limit=${limit}&offset=${offset}`);

export const getFeedback = (limit = 50, offset = 0) =>
  fetchApi<{ feedback: FeedbackItem[] }>(`/api/dashboard/feedback?limit=${limit}&offset=${offset}`);
