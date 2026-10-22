import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

jest.mock('../../../frontend/utils/i18n', () => ({ i18n: (key: string) => key }));
const { EndpointManager } = require('../../../frontend/admin/EndpointManager');

function createProps() {
  return {
    endpoints: [{ id: 'temp-1', name: 'Synthetic endpoint', apiBaseUrl: '', models: [], enabled: true, isNew: true }],
    selectedModels: [], onUpdateEndpoint: jest.fn(), onRemoveEndpoint: jest.fn(), onAddEndpoint: jest.fn(),
    onFetchModels: jest.fn(), fetchingModels: null, onAddSelectedModel: jest.fn(),
    onRemoveSelectedModel: jest.fn(), onMoveSelectedModel: jest.fn(), disabled: false,
    legacy: { apiBaseUrl: '', hasApiKey: false },
  } as any;
}

function elements(node: React.ReactNode): React.ReactElement[] {
  if (!React.isValidElement(node)) return [];
  return [node, ...React.Children.toArray(node.props.children).flatMap(elements)];
}

describe('EndpointManager model discovery', () => {
  afterEach(() => jest.restoreAllMocks());

  it('shows capability hints without hiding or disabling unknown model IDs', () => {
    const props = createProps();
    props.endpoints[0].models = ['arbitrary-model', 'confirmed-model', 'speech-model'];
    props.endpoints[0].modelChatSupport = { 'confirmed-model': true, 'speech-model': false };
    const html = renderToStaticMarkup(React.createElement(EndpointManager, props));
    for (const text of ['arbitrary-model', 'confirmed-model', 'speech-model',
      'ai_helper_admin_endpoint_chat_unknown', 'ai_helper_admin_endpoint_chat_supported',
      'ai_helper_admin_endpoint_chat_unsupported', 'ai_helper_admin_endpoint_manual_model']) {
      expect(html).toContain(text);
    }
  });

  it('adds a trimmed manual ID without listing credentials and permits selecting it before first save', () => {
    const props = createProps();
    const slots: any[] = [];
    let cursor = 0;
    jest.spyOn(React, 'useState').mockImplementation(((initial: any) => {
      const slot = cursor++;
      if (!(slot in slots)) slots[slot] = initial;
      return [slots[slot], (value: any) => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value; }];
    }) as any);
    const render = () => { cursor = 0; return elements(EndpointManager(props)); };
    render().find(el => el.props['aria-label'] === 'ai_helper_admin_endpoint_manual_model')!
      .props.onChange({ target: { value: '  Provider/Custom-V3  ' } });
    const add = () => render().find(el => el.type === 'button' && el.props.children === 'ai_helper_admin_endpoint_manual_add')!;
    expect(add().props.disabled).toBe(false);
    add().props.onClick();
    expect(props.onUpdateEndpoint).toHaveBeenLastCalledWith(0, { models: ['Provider/Custom-V3'] });
    expect(add().props.disabled).toBe(true);

    props.endpoints[0].models = ['Provider/Custom-V3'];
    const modelButton = render().find(el => el.type === 'button'
      && React.Children.toArray(el.props.children).includes('Provider/Custom-V3'))!;
    expect(modelButton.props.disabled).toBe(false);
    modelButton.props.onClick();
    expect(props.onAddSelectedModel).toHaveBeenCalledWith('temp-1', 'Provider/Custom-V3');

    render().find(el => el.props['aria-label'] === 'ai_helper_admin_endpoint_manual_model')!
      .props.onChange({ target: { value: 'Provider/Custom-V3' } });
    add().props.onClick();
    expect(props.onUpdateEndpoint).toHaveBeenLastCalledWith(0, { models: ['Provider/Custom-V3'] });

    props.disabled = true;
    expect(add().props.disabled).toBe(true);
  });
});
