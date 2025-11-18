import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: parseInt(__ENV.VUS || '5', 10),
  duration: __ENV.DURATION || '30s',
  thresholds: {
    http_req_duration: ['p(95)<1000'],
    checks: ['rate>0.95']
  }
};

const BASE_URL = __ENV.HYDRO_BASE_URL || 'http://127.0.0.1';
const COOKIE = __ENV.HYDRO_TEACHER_COOKIE || __ENV.HYDRO_ADMIN_COOKIE || '';
const PAGE_LIMIT = parseInt(__ENV.PAGE_LIMIT || '50', 10);
const SLEEP_SECONDS = parseFloat(__ENV.SLEEP || '1');

export default function () {
  const res = http.get(`${BASE_URL}/ai-helper/conversations?limit=${PAGE_LIMIT}`, {
    headers: {
      Cookie: COOKIE
    }
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'response time < 1s': (r) => r.timings.duration < 1000
  });

  if (SLEEP_SECONDS > 0) {
    sleep(SLEEP_SECONDS);
  }
}
