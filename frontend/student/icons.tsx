import React from 'react';
import { Icon, IconName } from '../components/Icon';

type IconProps = { size?: number };
const typeIcons: Record<string, IconName> = { understand: 'help', think: 'lightbulb', debug: 'code', optimize: 'gauge' };
export const TypeIcon: React.FC<IconProps & { type: string }> = ({ type, size = 14 }) => (
  typeIcons[type] ? <Icon name={typeIcons[type]} size={size} /> : null
);
export const SendIcon: React.FC<IconProps> = ({ size = 15 }) => <Icon name="send" size={size} />;
export const AttachIcon: React.FC<IconProps> = ({ size = 15 }) => <Icon name="attachment" size={size} />;
export const RefreshIcon: React.FC<IconProps> = ({ size = 15 }) => <Icon name="refresh" size={size} />;
export const RemoveIcon: React.FC<IconProps> = ({ size = 15 }) => <Icon name="close" size={size} />;

/** 字母标识：替换原机器人 emoji 头像 */
export const AIMark: React.FC<{ size?: number; radius?: number; fontSize?: number }> = ({
  size = 28, radius = 8, fontSize = 11,
}) => (
  <div style={{
    width: size, height: size, borderRadius: radius,
    background: '#2563eb',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: "'JetBrains Mono', ui-monospace, 'SFMono-Regular', monospace",
    fontSize, fontWeight: 700, color: '#ffffff', letterSpacing: '-0.5px',
    flexShrink: 0,
  }}>AI</div>
);
