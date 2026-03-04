import { setJsonResponse, setErrorResponse, setTemplateResponse, expectsJson } from '../../lib/httpHelpers';

function createMockHandler(acceptHeader?: string) {
  return {
    response: {
      status: 200,
      body: null as any,
      type: '' as string,
      template: '' as string,
    },
    request: {
      headers: {
        accept: acceptHeader || '',
      },
    },
  } as any;
}

describe('setJsonResponse', () => {
  it('should set response body and type', () => {
    const handler = createMockHandler();
    setJsonResponse(handler, { success: true });

    expect(handler.response.body).toEqual({ success: true });
    expect(handler.response.type).toBe('application/json');
    expect(handler.response.status).toBe(200);
  });

  it('should set custom status code', () => {
    const handler = createMockHandler();
    setJsonResponse(handler, { created: true }, 201);

    expect(handler.response.status).toBe(201);
  });
});

describe('setErrorResponse', () => {
  it('should set structured error response', () => {
    const handler = createMockHandler();
    setErrorResponse(handler, 'INVALID_INPUT', '输入无效');

    expect(handler.response.status).toBe(400);
    expect(handler.response.body).toEqual({
      error: { code: 'INVALID_INPUT', message: '输入无效' },
    });
    expect(handler.response.type).toBe('application/json');
  });

  it('should use custom status code', () => {
    const handler = createMockHandler();
    setErrorResponse(handler, 'NOT_FOUND', '未找到', 404);

    expect(handler.response.status).toBe(404);
  });
});

describe('setTemplateResponse', () => {
  it('should set template and body', () => {
    const handler = createMockHandler();
    setTemplateResponse(handler, 'ai_dashboard.html', { title: 'Dashboard' });

    expect(handler.response.template).toBe('ai_dashboard.html');
    expect(handler.response.body).toEqual({ title: 'Dashboard' });
  });

  it('should default data to empty object', () => {
    const handler = createMockHandler();
    setTemplateResponse(handler, 'ai_chat.html');

    expect(handler.response.body).toEqual({});
  });
});

describe('expectsJson', () => {
  it('should return true for application/json accept header', () => {
    const handler = createMockHandler('application/json');
    expect(expectsJson(handler)).toBe(true);
  });

  it('should return true for mixed accept header containing json', () => {
    const handler = createMockHandler('text/html, application/json');
    expect(expectsJson(handler)).toBe(true);
  });

  it('should return false for html accept header', () => {
    const handler = createMockHandler('text/html');
    expect(expectsJson(handler)).toBe(false);
  });

  it('should return false for empty accept header', () => {
    const handler = createMockHandler('');
    expect(expectsJson(handler)).toBe(false);
  });
});
