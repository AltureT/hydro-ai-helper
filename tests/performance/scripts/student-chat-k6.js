import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: parseInt(__ENV.VUS || '10', 10),
  duration: __ENV.DURATION || '30s',
  thresholds: {
    http_req_duration: ['p(95)<2000'],
    checks: ['rate>0.95']
  }
};

const BASE_URL = __ENV.HYDRO_BASE_URL || 'http://127.0.0.1';
const COOKIE = __ENV.HYDRO_STUDENT_COOKIE || '';
const SLEEP_SECONDS = parseFloat(__ENV.SLEEP || '1');

const payload = JSON.stringify({
  problemId: __ENV.PROBLEM_ID || 'demo',
  problemTitle: __ENV.PROBLEM_TITLE || 'Sample Problem',
  problemContent: __ENV.PROBLEM_CONTENT || '给定两个整数 A 和 B，输出它们的和。',
  questionType: 'understand',
  userThinking: __ENV.USER_THINKING || '请帮我理解这道题的双指针/枚举思路。',
  includeCode: false
});

const params = {
  headers: {
    'Content-Type': 'application/json',
    Cookie: COOKIE
  }
};

export default function () {
  const res = http.post(`${BASE_URL}/ai-helper/chat`, payload, params);

  check(res, {
    'status is 200': (r) => r.status === 200,
    'response time < 2s': (r) => r.timings.duration < 2000
  });

  if (SLEEP_SECONDS > 0) {
    sleep(SLEEP_SECONDS);
  }
}
