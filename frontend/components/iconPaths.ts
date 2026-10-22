/** Shared 24 px outline geometry for controls and rendered report content. */
export const iconPaths = {
  message: 'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8l-5 3V6a2 2 0 0 1 2-2Z M7 9h10 M7 13h6',
  document: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z M14 3v6h6 M8 13h8 M8 17h5',
  chart: 'M4 3v17h17 M9 16v-5 M14 16V6 M19 16v-8',
  flask: 'M9 3h6 M10 3v6L4.5 18a2 2 0 0 0 1.7 3h11.6a2 2 0 0 0 1.7-3L14 9V3 M7 14h10',
  check: 'M5 12l4 4L19 6',
  checkCircle: 'M21 12a9 9 0 1 1-3-6.7 M8 11l4 4 9-10',
  close: 'M6 6l12 12 M18 6 6 18',
  circle: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  warning: 'm10.3 4-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0Z M12 9v4 M12 17h.01',
  info: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z M12 11v6 M12 7h.01',
  clock: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z M12 7v5l3 2',
  refresh: 'M20 7a9 9 0 1 0 1 9 M20 3v5h-5',
  arrowUp: 'M12 20V4 M5 11l7-7 7 7',
  arrowDown: 'M12 4v16 M5 13l7 7 7-7',
  arrowLeft: 'M20 12H4 M11 5l-7 7 7 7',
  arrowRight: 'M4 12h16 M13 5l7 7-7 7',
  chevronDown: 'm6 9 6 6 6-6',
  chevronUp: 'm6 15 6-6 6 6',
  chevronRight: 'm9 6 6 6-6 6',
  chevronLeft: 'm15 6-6 6 6 6',
  download: 'M12 3v12 M7 10l5 5 5-5 M4 16v4h16v-4',
  upload: 'M12 16V4 M7 9l5-5 5 5 M4 16v4h16v-4',
  edit: 'm15 5 4 4 M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15Z',
  copy: 'M9 9h12v12H9Z M15 9V3H3v12h6',
  lock: 'M6 10h12a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z M8 10V7a4 4 0 0 1 8 0v3 M12 14v3',
  help: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z M9.5 9a2.5 2.5 0 0 1 5 .5c0 2-2.5 2-2.5 4 M12 17h.01',
  lightbulb: 'M9 18h6 M10 21h4 M8 14a6 6 0 1 1 8 0l-1 2H9Z',
  code: 'm8 6-6 6 6 6 M16 6l6 6-6 6 M14 4l-4 16',
  gauge: 'M4 19a9 9 0 1 1 16 0Z M12 15l4-6 M7 10h.01 M12 6h.01',
  attachment: 'm8 12 7-7a4.2 4.2 0 0 1 6 6L11 21a6 6 0 0 1-8.5-8.5L13 2 M6 15l9-9a1.5 1.5 0 0 1 2 2l-9 9',
  send: 'm3 3 18 9-18 9 4-9Z M7 12h14',
  pause: 'M8 5v14 M16 5v14',
  play: 'm7 4 14 8-14 8Z',
  users: 'M15 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z M5 21v-3a7 7 0 0 1 14 0v3 M18 4a3 3 0 0 1 0 6 M21 14a5 5 0 0 1 2 4v2',
  search: 'M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z m-2 5 6 6',
  shield: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z M9 12l2 2 4-4',
  settings: 'M4 7h16 M4 17h16 M8 4v6 M16 14v6',
  wallet: 'M20 7H5a2 2 0 0 1 0-4h13v4 M3 5v14a2 2 0 0 0 2 2h15V7 M20 11h-5v6h5 M17 14h.01',
} as const;

export type IconName = keyof typeof iconPaths;

/** Only fixed, local paths enter report HTML; content never becomes SVG markup. */
export function iconMarkup(name: IconName): string {
  return `<svg class="ai-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true" focusable="false"><path d="${iconPaths[name]}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
