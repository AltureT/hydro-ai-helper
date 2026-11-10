import React from 'react';
import { i18n } from '../utils/i18n';
import { getInputStyle } from '../utils/styles';
import { groupChoices, type GroupFilterOptions } from './groupFilterLogic';

interface GroupSelectProps {
  value: string;
  options: GroupFilterOptions;
  onChange: (value: string) => void;
  id?: string;
  style?: React.CSSProperties;
}

/** 小组下拉框：全部小组 / 各小组 / 未分组 */
export const GroupSelect: React.FC<GroupSelectProps> = ({ value, options, onChange, id, style }) => (
  <select id={id} value={value} onChange={(event) => onChange(event.target.value)} style={{ ...getInputStyle(), ...style }}>
    <option value="">{i18n('ai_helper_group_filter_all')}</option>
    {groupChoices(options, value).map((choice) => (
      <option key={choice.value} value={choice.value}>
        {choice.ungrouped ? i18n('ai_helper_group_ungrouped') : choice.value}
      </option>
    ))}
  </select>
);
