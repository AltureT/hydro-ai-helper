import * as React from 'react';
import * as ReactDOM from 'react-dom';

export function renderComponent(node: React.ReactNode, container: Element | null) {
  if (!container) return;
  const rd = ReactDOM as unknown as {
    createRoot?: (el: Element) => { render: (n: React.ReactNode) => void };
    render?: (n: React.ReactNode, el: Element) => void;
  };
  if (typeof rd.createRoot === 'function') {
    rd.createRoot(container).render(node);
  } else if (typeof rd.render === 'function') {
    rd.render(node, container);
  }
}
