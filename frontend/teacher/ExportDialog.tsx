/**
 * 教师端导出对话框组件
 * 允许教师导出对话数据为 CSV 格式
 */

import React, { useState } from 'react';
import { i18n } from '@hydrooj/ui-default';
import { buildApiUrl } from '../utils/domainUtils';
import {
  COLORS, SPACING, RADIUS, TYPOGRAPHY,
  modalOverlayStyle, modalContentStyle, getButtonStyle,
} from '../utils/styles';

/**
 * 导出对话框 Props 接口
 */
export interface ExportDialogProps {
  /** 是否打开弹窗 */
  isOpen: boolean;
  /** 关闭弹窗回调 */
  onClose: () => void;
  /** 从列表页继承的筛选条件 */
  filters: {
    startDate?: string;
    endDate?: string;
    classId?: string;
    problemId?: string;
    userId?: string;
  };
}

/**
 * ExportDialog 组件 - 数据导出对话框
 */
export const ExportDialog: React.FC<ExportDialogProps> = ({ isOpen, onClose, filters }) => {
  // 是否包含敏感信息（默认不包含）
  const [includeSensitive, setIncludeSensitive] = useState(false);
  const [includeMetrics, setIncludeMetrics] = useState(false);

  // 如果弹窗关闭，不渲染
  if (!isOpen) return null;

  /**
   * 处理导出操作
   */
  const handleExport = () => {
    // 1. 组装查询参数
    const params: Record<string, string> = {
      format: 'csv',
    };

    // 2. 添加筛选条件（如果存在）
    if (filters.startDate) params.startDate = filters.startDate;
    if (filters.endDate) params.endDate = filters.endDate;
    if (filters.classId) params.classId = filters.classId;
    if (filters.problemId) params.problemId = filters.problemId;
    if (filters.userId) params.userId = filters.userId;

    // 3. 添加敏感信息选项
    params.includeSensitive = includeSensitive ? 'true' : 'false';
    if (includeMetrics) params.includeMetrics = 'true';

    // 4. 构造导出 URL（使用域前缀）
    const query = new URLSearchParams(params).toString();
    const url = buildApiUrl(`/ai-helper/export?${query}`);

    console.log('[ExportDialog] Exporting with URL:', url);

    // 5. 触发下载（使用 window.open）
    window.open(url, '_blank');

    // 6. 关闭弹窗
    onClose();
  };

  /**
   * 渲染筛选条件预览
   */
  const renderFiltersPreview = () => {
    const items: string[] = [];

    if (filters.startDate || filters.endDate) {
      const start = filters.startDate || i18n('ai_helper_teacher_export_unlimited');
      const end = filters.endDate || i18n('ai_helper_teacher_export_unlimited');
      items.push(`${i18n('ai_helper_teacher_export_time_range')}${start} ~ ${end}`);
    }

    if (filters.classId) {
      items.push(`${i18n('ai_helper_teacher_conv_col_class')}${filters.classId}`);
    }

    if (filters.problemId) {
      items.push(`${i18n('ai_helper_teacher_conv_col_problem')}${filters.problemId}`);
    }

    if (filters.userId) {
      items.push(`${i18n('ai_helper_teacher_filter_student_id')}${filters.userId}`);
    }

    if (items.length === 0) {
      items.push(i18n('ai_helper_teacher_export_all'));
    }

    return items;
  };

  return (
    <div
      style={modalOverlayStyle}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        style={modalContentStyle}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题 */}
        <h2
          style={{
            margin: `0 0 ${SPACING.lg} 0`,
            ...TYPOGRAPHY.lg,
            color: COLORS.textPrimary,
          }}
        >
          {i18n('ai_helper_teacher_export_title')}
        </h2>

        {/* 导出格式选择 */}
        <div style={{ marginBottom: SPACING.lg }}>
          <label
            style={{
              display: 'block',
              marginBottom: SPACING.sm,
              ...TYPOGRAPHY.sm,
              fontWeight: 500,
              color: COLORS.textSecondary,
            }}
          >
            {i18n('ai_helper_teacher_export_format')}
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: SPACING.sm }}>
            <input type="radio" name="format" value="csv" checked readOnly />
            <span style={{ ...TYPOGRAPHY.sm, color: COLORS.textMuted }}>{i18n('ai_helper_teacher_export_csv_label')}</span>
          </div>
          <p
            style={{
              margin: `${SPACING.sm} 0 0 0`,
              fontSize: '13px',
              color: COLORS.textMuted,
              lineHeight: '1.4',
            }}
          >
            {i18n('ai_helper_teacher_export_csv_note')}
          </p>
        </div>

        {/* 敏感信息选项 */}
        <div style={{ marginBottom: SPACING.lg }}>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: SPACING.sm,
              ...TYPOGRAPHY.sm,
              fontWeight: 500,
              color: COLORS.textSecondary,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={includeSensitive}
              onChange={(e) => setIncludeSensitive(e.target.checked)}
              style={{ cursor: 'pointer' }}
            />
            {i18n('ai_helper_teacher_export_include_sensitive')}
          </label>
          <p
            style={{
              margin: `${SPACING.sm} 0 0 0`,
              fontSize: '13px',
              color: COLORS.textMuted,
              lineHeight: '1.4',
            }}
          >
            {i18n('ai_helper_teacher_export_sensitive_note')}
          </p>
        </div>

        {/* 对话信号数据选项 */}
        <div style={{ marginBottom: SPACING.lg }}>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: SPACING.sm,
              fontWeight: 500,
              color: COLORS.textSecondary,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={includeMetrics}
              onChange={(e) => setIncludeMetrics(e.target.checked)}
              style={{ cursor: 'pointer' }}
            />
            {i18n('ai_helper_teacher_export_include_metrics')}
          </label>
          <p
            style={{
              margin: `${SPACING.sm} 0 0 0`,
              fontSize: '13px',
              color: COLORS.textMuted,
              lineHeight: '1.4',
            }}
          >
            {i18n('ai_helper_teacher_export_metrics_note')}
          </p>
        </div>

        {/* 导出范围预览 */}
        <div style={{ marginBottom: SPACING.lg }}>
          <label
            style={{
              display: 'block',
              marginBottom: SPACING.sm,
              ...TYPOGRAPHY.sm,
              fontWeight: 500,
              color: COLORS.textSecondary,
            }}
          >
            {i18n('ai_helper_teacher_export_preview')}
          </label>
          <ul
            style={{
              margin: 0,
              padding: `${SPACING.md} ${SPACING.base}`,
              backgroundColor: COLORS.bgPage,
              borderRadius: RADIUS.md,
              border: `1px solid ${COLORS.border}`,
              listStyleType: 'none',
            }}
          >
            {renderFiltersPreview().map((item, index) => (
              <li
                key={index}
                style={{
                  fontSize: '13px',
                  color: COLORS.textMuted,
                  lineHeight: '1.6',
                  marginBottom: index < renderFiltersPreview().length - 1 ? SPACING.xs : '0',
                }}
              >
                • {item}
              </li>
            ))}
          </ul>
        </div>

        {/* 底部按钮 */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: SPACING.md,
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={getButtonStyle('secondary')}
          >
            {i18n('ai_helper_teacher_cancel')}
          </button>
          <button
            type="button"
            onClick={handleExport}
            style={getButtonStyle('primary')}
          >
            {i18n('ai_helper_teacher_export_btn')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ExportDialog;
