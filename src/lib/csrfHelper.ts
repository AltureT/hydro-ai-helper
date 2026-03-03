import type { Handler } from 'hydrooj';

export function rejectIfCsrfInvalid(handler: Handler): boolean {
  const xrw = handler.request.headers['x-requested-with'];
  if (xrw !== 'XMLHttpRequest') {
    handler.response.status = 403;
    handler.response.body = { error: 'CSRF validation failed', code: 'CSRF_REJECTED' };
    handler.response.type = 'application/json';
    return true;
  }
  return false;
}
