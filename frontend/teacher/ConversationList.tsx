/**
 * 教师端对话列表组件
 * 显示所有学生的对话记录,支持筛选和分页
 * 现代简约风格设计
 */

import React, { useState, useEffect } from 'react';
import { ExportDialog } from './ExportDialog';
import { buildApiUrl, buildPageUrl } from '../utils/domainUtils';

/**
 * 对话摘要接口
 */
interface ConversationSummary {
  _id: string;
  userId: number;
  userName?: string;
  classId?: string;
  problemId: string;
  problemUrl?: string;
  startTime: string;
  endTime: string;
  messageCount: number;
  isEffective: boolean;
  tags: string[];
  teacherNote?: string;
  metadata?: {
    problemTitle?: string;
    problemContent?: string;
  };
  firstMessageSummary?: string;
}

/**
 * 对话列表响应接口
 */
interface ConversationListResponse {
  conversations: ConversationSummary[];
  total: number;
  page: number;
  limit: number;
}

/**
 * 从 URL query 中解析初始筛选条件
 */
function getInitialFiltersFromUrl(): { userId: string; classId: string; problemId: string } {
  if (typeof window === 'undefined') {
    return { userId: '', classId: '', problemId: '' };
  }
  const params = new URLSearchParams(window.location.search);
  return {
    userId: params.get('userId') || '',
    classId: params.get('classId') || '',
    problemId: params.get('problemId') || '',
  };
}

/**
 * ConversationList 组件 Props
 */
interface ConversationListProps {
  embedded?: boolean;
}

/**
 * ConversationList 组件
 */
export const ConversationList: React.FC<ConversationListProps> = ({ embedded = false }) => {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const initialFilters = getInitialFiltersFromUrl();
  const [filters, setFilters] = useState({
    startDate: '',
    endDate: '',
    problemId: initialFilters.problemId,
    classId: initialFilters.classId,
    userId: initialFilters.userId
  });

  const [exportDialogOpen, setExportDialogOpen] = useState(false);

  const loadConversations = async () => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        page: page.toString(),
        limit: limit.toString()
      });

      if (filters.startDate) params.append('startDate', filters.startDate);
      if (filters.endDate) params.append('endDate', filters.endDate);
      if (filters.problemId) params.append('problemId', filters.problemId);
      if (filters.classId) params.append('classId', filters.classId);
      if (filters.userId) params.append('userId', filters.userId);

      const response = await fetch(buildApiUrl(`/ai-helper/conversations?${params.toString()}`), {
        headers: {
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        const text = await response.text();
        console.error('[AI Helper] failed to load conversations', response.status, text);
        setConversations([]);
        setTotal(0);
        setError(`加载失败：${response.status}`);
        return;
      }

      const data: ConversationListResponse = await response.json();

      console.debug('[AI Helper] conversations loaded', data);
      setConversations(data.conversations || []);
      setTotal(data.total ?? 0);
    } catch (err) {
      console.error('[AI Helper] error while loading conversations', err);
      setConversations([]);
      setTotal(0);
      setError('加载失败：网络错误');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadConversations();
  }, [page]);

  const handleFilterSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    loadConversations();
  };

  const handleFilterChange = (field: string, value: string) => {
    setFilters(prev => ({ ...prev, [field]: value }));
  };

  const formatDateTime = (isoString: string): string => {
    const date = new Date(isoString);
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '10px 12px',
    borderRadius: '8px',
    border: '1px solid #e5e7eb',
    fontSize: '14px',
    backgroundColor: '#f9fafb',
    color: '#1f2937'
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    marginBottom: '8px',
    fontWeight: 500,
    fontSize: '14px',
    color: '#374151'
  };

  return (
    <div style={{
      padding: embedded ? '24px' : '32px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      backgroundColor: embedded ? 'transparent' : '#f8fafc',
      minHeight: embedded ? 'auto' : '100vh'
    }}>
      {/* 页面标题 - 仅在非嵌入模式显示 */}
      {!embedded && (
      <div style={{
        marginBottom: '32px',
        padding: '24px 32px',
        background: '#ffffff',
        borderRadius: '12px',
        border: '1px solid #e5e7eb',
        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.1)'
      }}>
        <h1 style={{ margin: 0, fontSize: '24px', fontWeight: 700, color: '#1f2937' }}>对话记录</h1>
        <p style={{ margin: '8px 0 0', color: '#6b7280', fontSize: '14px' }}>查看和管理学生与 AI 助手的对话记录</p>
      </div>
      )}

      {/* 筛选表单 */}
      <form onSubmit={handleFilterSubmit} style={{
        marginBottom: '24px',
        padding: '24px',
        backgroundColor: '#ffffff',
        borderRadius: '12px',
        boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
        border: '1px solid #e5e7eb'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600, color: '#1f2937' }}>筛选条件</h3>
          <div style={{ display: 'flex', gap: '12px' }}>
            <button
              type="button"
              onClick={() => setExportDialogOpen(true)}
              style={{
                padding: '10px 20px',
                fontSize: '14px',
                fontWeight: 600,
                color: '#ffffff',
                background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                boxShadow: '0 2px 8px rgba(16, 185, 129, 0.3)'
              }}
            >
              📥 导出数据
            </button>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px' }}>
          <div>
            <label style={labelStyle}>开始日期</label>
            <input
              type="date"
              value={filters.startDate}
              onChange={(e) => handleFilterChange('startDate', e.target.value)}
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>结束日期</label>
            <input
              type="date"
              value={filters.endDate}
              onChange={(e) => handleFilterChange('endDate', e.target.value)}
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>题目 ID</label>
            <input
              type="text"
              value={filters.problemId}
              onChange={(e) => handleFilterChange('problemId', e.target.value)}
              placeholder="如: P1000"
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>班级 ID</label>
            <input
              type="text"
              value={filters.classId}
              onChange={(e) => handleFilterChange('classId', e.target.value)}
              placeholder="班级 ID"
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>学生 ID</label>
            <input
              type="text"
              value={filters.userId}
              onChange={(e) => handleFilterChange('userId', e.target.value)}
              placeholder="学生用户 ID"
              style={inputStyle}
            />
          </div>
        </div>
        <button
          type="submit"
          style={{
            marginTop: '20px',
            padding: '12px 28px',
            background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            color: 'white',
            border: 'none',
            borderRadius: '8px',
            fontSize: '15px',
            fontWeight: 600,
            cursor: 'pointer',
            boxShadow: '0 2px 8px rgba(102, 126, 234, 0.3)'
          }}
        >
          搜索
        </button>
      </form>

      {/* 加载状态 */}
      {loading && (
        <div style={{
          padding: '40px',
          textAlign: 'center',
          color: '#6b7280',
          backgroundColor: '#ffffff',
          borderRadius: '12px',
          border: '1px solid #e5e7eb'
        }}>
          <div style={{ fontSize: '24px', marginBottom: '12px' }}>⏳</div>
          正在加载对话列表...
        </div>
      )}

      {/* 错误提示 */}
      {error && (
        <div style={{
          padding: '16px 20px',
          backgroundColor: '#fef2f2',
          border: '1px solid #fecaca',
          borderRadius: '12px',
          color: '#991b1b',
          marginBottom: '24px'
        }}>
          ⚠️ {error}
        </div>
      )}

      {/* 对话列表表格 */}
      {!loading && !error && (
        <>
          {conversations.length === 0 ? (
            <div style={{
              padding: '60px 20px',
              textAlign: 'center',
              color: '#9ca3af',
              backgroundColor: '#f9fafb',
              borderRadius: '12px',
              border: '1px dashed #e5e7eb'
            }}>
              <div style={{ fontSize: '48px', marginBottom: '16px' }}>💬</div>
              <div style={{ fontSize: '15px' }}>暂无对话记录</div>
            </div>
          ) : (
            <>
              <div style={{
                marginBottom: '16px',
                padding: '12px 16px',
                backgroundColor: '#ffffff',
                borderRadius: '8px',
                border: '1px solid #e5e7eb',
                fontSize: '14px',
                color: '#4b5563'
              }}>
                共 <strong style={{ color: '#1f2937' }}>{total}</strong> 条记录，当前第 <strong style={{ color: '#1f2937' }}>{page}</strong> 页
              </div>
              <div style={{
                backgroundColor: '#ffffff',
                borderRadius: '12px',
                boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
                border: '1px solid #e5e7eb',
                overflow: 'hidden'
              }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ backgroundColor: '#f9fafb' }}>
                      <th style={{ padding: '14px 16px', textAlign: 'left', fontWeight: 600, fontSize: '13px', color: '#6b7280', borderBottom: '2px solid #e5e7eb' }}>学生</th>
                      <th style={{ padding: '14px 16px', textAlign: 'left', fontWeight: 600, fontSize: '13px', color: '#6b7280', borderBottom: '2px solid #e5e7eb' }}>班级</th>
                      <th style={{ padding: '14px 16px', textAlign: 'left', fontWeight: 600, fontSize: '13px', color: '#6b7280', borderBottom: '2px solid #e5e7eb' }}>题目</th>
                      <th style={{ padding: '14px 16px', textAlign: 'left', fontWeight: 600, fontSize: '13px', color: '#6b7280', borderBottom: '2px solid #e5e7eb', minWidth: '200px' }}>问题摘要</th>
                      <th style={{ padding: '14px 16px', textAlign: 'left', fontWeight: 600, fontSize: '13px', color: '#6b7280', borderBottom: '2px solid #e5e7eb' }}>开始时间</th>
                      <th style={{ padding: '14px 16px', textAlign: 'center', fontWeight: 600, fontSize: '13px', color: '#6b7280', borderBottom: '2px solid #e5e7eb' }}>消息数</th>
                      <th style={{ padding: '14px 16px', textAlign: 'center', fontWeight: 600, fontSize: '13px', color: '#6b7280', borderBottom: '2px solid #e5e7eb' }}>有效</th>
                      <th style={{ padding: '14px 16px', textAlign: 'center', fontWeight: 600, fontSize: '13px', color: '#6b7280', borderBottom: '2px solid #e5e7eb' }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {conversations.map((conv, idx) => (
                      <tr key={conv._id} style={{ backgroundColor: idx % 2 === 0 ? '#ffffff' : '#fafafa' }}>
                        <td style={{ padding: '14px 16px', borderBottom: '1px solid #f3f4f6', fontSize: '14px', fontWeight: 500, color: '#1f2937' }}>
                          {conv.userName ? `${conv.userName}` : `#${conv.userId}`}
                          {conv.userName && <span style={{ color: '#9ca3af', fontSize: '12px', marginLeft: '4px' }}>({conv.userId})</span>}
                        </td>
                        <td style={{ padding: '14px 16px', borderBottom: '1px solid #f3f4f6', fontSize: '14px', color: '#4b5563' }}>
                          {conv.classId || <span style={{ color: '#9ca3af' }}>-</span>}
                        </td>
                        <td style={{ padding: '14px 16px', borderBottom: '1px solid #f3f4f6', fontSize: '14px' }}>
                          {conv.problemUrl ? (
                            <a
                              href={conv.problemUrl}
                              style={{ color: '#6366f1', textDecoration: 'none', fontWeight: 500 }}
                              title={`查看题目 ${conv.problemId}`}
                            >
                              {conv.metadata?.problemTitle || conv.problemId}
                            </a>
                          ) : (
                            <span style={{ color: '#9ca3af' }}>
                              {conv.metadata?.problemTitle || conv.problemId || '-'}
                            </span>
                          )}
                        </td>
                        <td style={{
                          padding: '14px 16px',
                          borderBottom: '1px solid #f3f4f6',
                          fontSize: '13px',
                          color: '#6b7280',
                          maxWidth: '300px',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap'
                        }}
                          title={conv.firstMessageSummary || ''}
                        >
                          {conv.firstMessageSummary || <span style={{ color: '#d1d5db' }}>-</span>}
                        </td>
                        <td style={{ padding: '14px 16px', borderBottom: '1px solid #f3f4f6', fontSize: '13px', color: '#6b7280' }}>
                          {formatDateTime(conv.startTime)}
                        </td>
                        <td style={{ padding: '14px 16px', borderBottom: '1px solid #f3f4f6', fontSize: '14px', color: '#4b5563', textAlign: 'center' }}>
                          <span style={{
                            display: 'inline-block',
                            minWidth: '28px',
                            padding: '4px 8px',
                            backgroundColor: '#f3f4f6',
                            borderRadius: '6px',
                            fontWeight: 500
                          }}>
                            {conv.messageCount}
                          </span>
                        </td>
                        <td style={{ padding: '14px 16px', borderBottom: '1px solid #f3f4f6', textAlign: 'center' }}>
                          <span style={{
                            display: 'inline-block',
                            padding: '4px 10px',
                            borderRadius: '20px',
                            fontSize: '12px',
                            fontWeight: 600,
                            backgroundColor: conv.isEffective ? '#dcfce7' : '#fee2e2',
                            color: conv.isEffective ? '#166534' : '#991b1b'
                          }}>
                            {conv.isEffective ? '有效' : '无效'}
                          </span>
                        </td>
                        <td style={{ padding: '14px 16px', borderBottom: '1px solid #f3f4f6', textAlign: 'center' }}>
                          <a
                            href={buildPageUrl(`/ai-helper/conversations/${conv._id}`)}
                            style={{
                              color: '#6366f1',
                              textDecoration: 'none',
                              fontWeight: 500,
                              padding: '6px 12px',
                              borderRadius: '6px',
                              backgroundColor: '#eef2ff',
                              display: 'inline-block'
                            }}
                          >
                            查看详情
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* 分页控件 */}
          {conversations.length > 0 && (
            <div style={{
              display: 'flex',
              gap: '12px',
              alignItems: 'center',
              justifyContent: 'center',
              marginTop: '24px'
            }}>
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                style={{
                  padding: '10px 20px',
                  background: page === 1 ? '#e5e7eb' : 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                  color: page === 1 ? '#9ca3af' : 'white',
                  border: 'none',
                  borderRadius: '8px',
                  fontSize: '14px',
                  fontWeight: 600,
                  cursor: page === 1 ? 'not-allowed' : 'pointer',
                  boxShadow: page === 1 ? 'none' : '0 2px 8px rgba(102, 126, 234, 0.3)'
                }}
              >
                ← 上一页
              </button>
              <span style={{
                padding: '10px 20px',
                backgroundColor: '#ffffff',
                borderRadius: '8px',
                border: '1px solid #e5e7eb',
                fontSize: '14px',
                fontWeight: 500,
                color: '#4b5563'
              }}>
                第 {page} 页
              </span>
              <button
                onClick={() => setPage(p => p + 1)}
                disabled={page * limit >= total}
                style={{
                  padding: '10px 20px',
                  background: page * limit >= total ? '#e5e7eb' : 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                  color: page * limit >= total ? '#9ca3af' : 'white',
                  border: 'none',
                  borderRadius: '8px',
                  fontSize: '14px',
                  fontWeight: 600,
                  cursor: page * limit >= total ? 'not-allowed' : 'pointer',
                  boxShadow: page * limit >= total ? 'none' : '0 2px 8px rgba(102, 126, 234, 0.3)'
                }}
              >
                下一页 →
              </button>
            </div>
          )}
        </>
      )}

      {/* 导出对话框 */}
      <ExportDialog
        isOpen={exportDialogOpen}
        onClose={() => setExportDialogOpen(false)}
        filters={{
          startDate: filters.startDate || undefined,
          endDate: filters.endDate || undefined,
          classId: filters.classId || undefined,
          problemId: filters.problemId || undefined,
          userId: filters.userId || undefined,
        }}
      />
    </div>
  );
};

export default ConversationList;
