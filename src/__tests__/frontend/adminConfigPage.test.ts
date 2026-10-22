jest.mock('../../../frontend/utils/i18n', () => ({ i18n: (key: string) => key }));
jest.mock('../../../frontend/utils/renderHelper', () => ({ renderComponent: jest.fn() }));

import { renderComponent } from '../../../frontend/utils/renderHelper';

describe('Hydro admin config page entry', () => {
  it('mounts ConfigPanel into the template root after DOMContentLoaded', () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const root = {};
    const addEventListener = jest.fn();
    const getElementById = jest.fn().mockReturnValue(root);
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { pathname: '/ai-helper/admin/config' } } });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { readyState: 'loading', addEventListener, getElementById } });
    try {
      require('../../../frontend/ai_helper_admin_config.page');
      expect(addEventListener).toHaveBeenCalledWith('DOMContentLoaded', expect.any(Function), { once: true });
      addEventListener.mock.calls[0][1]();
      expect(getElementById).toHaveBeenCalledWith('ai-helper-admin-config-root');
      const [tree, container] = (renderComponent as jest.Mock).mock.calls[0];
      expect(container).toBe(root);
      expect(tree.props.children.type.name).toBe('ConfigPanel');
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
      else delete (globalThis as any).window;
      if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
      else delete (globalThis as any).document;
    }
  });
});
