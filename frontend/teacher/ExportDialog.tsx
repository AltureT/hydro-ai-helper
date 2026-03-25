/**
 * 教师端导出对话框组件
 * 允许教师导出对话数据为 CSV 格式
 */

import React, { useState } from 'react';
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
      const start = filters.startDate || '不限';
      const end = filters.endDate || '不限';
      items.push(`时间范围：${start} ~ ${end}`);
    }

    if (filters.classId) {
      items.push(`班级：${filters.classId}`);
    }

    if (filters.problemId) {
      items.push(`题目：${filters.problemId}`);
    }

    if (filters.userId) {
      items.push(`学生 ID：${filters.userId}`);
    }

    if (items.length === 0) {
      items.push('导出全部对话记录');
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
          导出对话数据
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
            导出格式
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: SPACING.sm }}>
            <input type="radio" name="format" value="csv" checked readOnly />
            <span style={{ ...TYPOGRAPHY.sm, color: COLORS.textMuted }}>CSV（兼容 Excel）</span>
          </div>
          <p
            style={{
              margin: `${SPACING.sm} 0 0 0`,
              fontSize: '13px',
              color: COLORS.textMuted,
              lineHeight: '1.4',
            }}
          >
            暂时仅支持 CSV 格式，后续可扩展为 Excel。
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
            包含真实学生 ID（敏感数据）
          </label>
          <p
            style={{
              margin: `${SPACING.sm} 0 0 0`,
              fontSize: '13px',
              color: COLORS.textMuted,
              lineHeight: '1.4',
            }}
          >
            建议在对外分享时关闭此选项；关闭时会使用匿名 ID 替代真实学生账号。
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
            导出范围预览
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
            取消
          </button>
          <button
            type="button"
            onClick={handleExport}
            style={getButtonStyle('primary')}
          >
            导出
          </button>
        </div>
      </div>
    </div>
  );
};

export default ExportDialog;
