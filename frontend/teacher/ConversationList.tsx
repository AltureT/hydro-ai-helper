/**
 * 教师端对话列表组件
 * 显示所有学生的对话记录,支持筛选和分页
 */

import React, { useState, useEffect } from 'react';

/**
 * 对话摘要接口
 */
interface ConversationSummary {
  _id: string;
  userId: number;
  classId?: string;
  problemId: string;
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
 * ConversationList 组件
 */
export const ConversationList: React.FC = () => {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 筛选条件
  const [filters, setFilters] = useState({
    startDate: '',
    endDate: '',
    problemId: '',
    classId: '',
    userId: ''
  });

  /**
   * 加载对话列表
   */
  const loadConversations = async () => {
    setLoading(true);
    setError(null);

    try {
      // 构造查询参数
      const params = new URLSearchParams({
        page: page.toString(),
        limit: limit.toString()
      });

      if (filters.startDate) params.append('startDate', filters.startDate);
      if (filters.endDate) params.append('endDate', filters.endDate);
      if (filters.problemId) params.append('problemId', filters.problemId);
      if (filters.classId) params.append('classId', filters.classId);
      if (filters.userId) params.append('userId', filters.userId);

      // 调用 API (显式设置 Accept 头以获取 JSON 数据)
      const response = await fetch(`/ai-helper/conversations?${params.toString()}`, {
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

  /**
   * 组件加载时获取数据
   */
  useEffect(() => {
    loadConversations();
  }, [page]); // 页码变化时重新加载

  /**
   * 处理筛选表单提交
   */
  const handleFilterSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1); // 重置到第一页
    loadConversations();
  };

  /**
   * 处理筛选条件变化
   */
  const handleFilterChange = (field: string, value: string) => {
    setFilters(prev => ({ ...prev, [field]: value }));
  };

  /**
   * 格式化日期时间
   */
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

  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif' }}>
      <h1>AI 学习助手 - 对话记录</h1>

      {/* 筛选表单 */}
      <form onSubmit={handleFilterSubmit} style={{ marginBottom: '20px', padding: '15px', backgroundColor: '#f5f5f5', borderRadius: '8px' }}>
        <h3>筛选条件</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' }}>
          <div>
            <label>开始日期:</label>
            <input
              type="date"
              value={filters.startDate}
              onChange={(e) => handleFilterChange('startDate', e.target.value)}
              style={{ width: '100%', padding: '5px', borderRadius: '4px', border: '1px solid #ccc' }}
            />
          </div>
          <div>
            <label>结束日期:</label>
            <input
              type="date"
              value={filters.endDate}
              onChange={(e) => handleFilterChange('endDate', e.target.value)}
              style={{ width: '100%', padding: '5px', borderRadius: '4px', border: '1px solid #ccc' }}
            />
          </div>
          <div>
            <label>题目 ID:</label>
            <input
              type="text"
              value={filters.problemId}
              onChange={(e) => handleFilterChange('problemId', e.target.value)}
              placeholder="如: P1000"
              style={{ width: '100%', padding: '5px', borderRadius: '4px', border: '1px solid #ccc' }}
            />
          </div>
          <div>
            <label>班级 ID:</label>
            <input
              type="text"
              value={filters.classId}
              onChange={(e) => handleFilterChange('classId', e.target.value)}
              placeholder="班级 ID"
              style={{ width: '100%', padding: '5px', borderRadius: '4px', border: '1px solid #ccc' }}
            />
          </div>
          <div>
            <label>学生 ID:</label>
            <input
              type="text"
              value={filters.userId}
              onChange={(e) => handleFilterChange('userId', e.target.value)}
              placeholder="学生用户 ID"
              style={{ width: '100%', padding: '5px', borderRadius: '4px', border: '1px solid #ccc' }}
            />
          </div>
        </div>
        <button type="submit" style={{ marginTop: '10px', padding: '8px 16px', backgroundColor: '#6366f1', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
          搜索
        </button>
      </form>

      {/* 加载状态 */}
      {loading && <p>正在加载对话列表...</p>}

      {/* 错误提示 */}
      {error && <p style={{ color: 'red' }}>{error}</p>}

      {/* 对话列表表格 */}
      {!loading && !error && (
        <>
          {conversations.length === 0 ? (
            <p>暂无对话记录。</p>
          ) : (
            <>
              <p>共 {total} 条记录,当前第 {page} 页</p>
              <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '20px' }}>
                <thead>
                  <tr style={{ backgroundColor: '#e5e7eb', textAlign: 'left' }}>
                    <th style={{ padding: '10px', border: '1px solid #ccc' }}>学生 ID</th>
                    <th style={{ padding: '10px', border: '1px solid #ccc' }}>班级</th>
                    <th style={{ padding: '10px', border: '1px solid #ccc' }}>题目</th>
                    <th style={{ padding: '10px', border: '1px solid #ccc' }}>开始时间</th>
                    <th style={{ padding: '10px', border: '1px solid #ccc' }}>消息数</th>
                    <th style={{ padding: '10px', border: '1px solid #ccc' }}>有效对话</th>
                    <th style={{ padding: '10px', border: '1px solid #ccc' }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {conversations.map(conv => (
                    <tr key={conv._id} style={{ borderBottom: '1px solid #ccc' }}>
                      <td style={{ padding: '10px', border: '1px solid #ccc' }}>{conv.userId}</td>
                      <td style={{ padding: '10px', border: '1px solid #ccc' }}>{conv.classId || '-'}</td>
                      <td style={{ padding: '10px', border: '1px solid #ccc' }}>
                        {conv.metadata?.problemTitle || conv.problemId}
                      </td>
                      <td style={{ padding: '10px', border: '1px solid #ccc' }}>{formatDateTime(conv.startTime)}</td>
                      <td style={{ padding: '10px', border: '1px solid #ccc' }}>{conv.messageCount}</td>
                      <td style={{ padding: '10px', border: '1px solid #ccc' }}>
                       {conv.isEffective ? '✓' : '✗'}
                      </td>
                      <td style={{ padding: '10px', border: '1px solid #ccc' }}>
                        <a
                          href={`/ai-helper/conversations/${conv._id}`}
                          style={{ color: '#6366f1', textDecoration: 'none' }}
                        >
                          查看详情
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {/* 分页控件 */}
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              style={{
                padding: '8px 16px',
                backgroundColor: page === 1 ? '#ccc' : '#6366f1',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: page === 1 ? 'not-allowed' : 'pointer'
              }}
            >
              上一页
            </button>
            <span>第 {page} 页</span>
            <button
              onClick={() => setPage(p => p + 1)}
              disabled={page * limit >= total}
              style={{
                padding: '8px 16px',
                backgroundColor: page * limit >= total ? '#ccc' : '#6366f1',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: page * limit >= total ? 'not-allowed' : 'pointer'
              }}
            >
              下一页
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default ConversationList;
