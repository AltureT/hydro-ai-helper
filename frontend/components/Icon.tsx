import React from 'react';
import { iconPaths, IconName } from './iconPaths';

export type { IconName } from './iconPaths';

interface IconProps {
  name: IconName;
  size?: number;
  style?: React.CSSProperties;
}

/** Decorative icon. The containing control supplies its visible or accessible label. */
export const Icon: React.FC<IconProps> = ({ name, size = 16, style }) => (
  <svg
    className="ai-icon" width={size} height={size} viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth={1.8}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"
    style={{ verticalAlign: '-0.15em', flexShrink: 0, ...style }}
  ><path d={iconPaths[name]} /></svg>
);
