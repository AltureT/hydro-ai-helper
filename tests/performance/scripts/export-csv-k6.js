import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: parseInt(__ENV.VUS || '2', 10),
  duration: __ENV.DURATION || '20s',
  thresholds: {
    http_req_duration: ['p(95)<3000'],
    checks: ['rate>0.95']
  }
};

const BASE_URL = __ENV.HYDRO_BASE_URL || 'http://127.0.0.1';
const COOKIE = __ENV.HYDRO_TEACHER_COOKIE || __ENV.HYDRO_ADMIN_COOKIE || '';
const DAYS = parseInt(__ENV.EXPORT_DAYS || '7', 10);
const SLEEP_SECONDS = parseFloat(__ENV.SLEEP || '1');

const endDate = new Date();
const startDate = new Date(endDate.getTime() - DAYS * 24 * 60 * 60 * 1000);

export default function () {
  const url = `${BASE_URL}/ai-helper/export?format=csv&startDate=${encodeURIComponent(
    startDate.toISOString()
  )}&endDate=${encodeURIComponent(endDate.toISOString())}`;

  const res = http.get(url, {
    headers: {
      Cookie: COOKIE
    }
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'response time < 3s': (r) => r.timings.duration < 3000,
    'has csv content': (r) => (r.headers['Content-Type'] || '').includes('csv')
  });

  if (SLEEP_SECONDS > 0) {
    sleep(SLEEP_SECONDS);
  }
}
