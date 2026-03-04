import React, { useState, useEffect } from 'react';
import { buildApiUrl } from '../utils/domainUtils';
import { AnalyticsItem, Dimension, ProblemColumnKey, PROBLEM_COLUMNS } from './analyticsTypes';
import { ClassAnalyticsTable } from './ClassAnalyticsTable';
import { ProblemAnalyticsTable } from './ProblemAnalyticsTable';
import { StudentAnalyticsTable } from './StudentAnalyticsTable';

interface AnalyticsResponse {
  dimension: Dimension;
  items: AnalyticsItem[];
}

function getInitialFiltersFromUrl() {
  if (typeof window === 'undefined') {
    return { startDate: '', endDate: '', classId: '', problemId: '', userId: '' };
  }
  const params = new URLSearchParams(window.location.search);
  return {
    startDate: params.get('startDate') || '',
    endDate: params.get('endDate') || '',
    classId: params.get('classId') || '',
    problemId: params.get('problemId') || '',
    userId: params.get('userId') || '',
  };
}

interface AnalyticsPageProps {
  embedded?: boolean;
}

export const AnalyticsPage: React.FC<AnalyticsPageProps> = ({ embedded = false }) => {
  const initialFilters = getInitialFiltersFromUrl();

  const [dimension, setDimension] = useState<Dimension>('problem');
  const [startDate, setStartDate] = useState<string>(initialFilters.startDate);
  const [endDate, setEndDate] = useState<string>(initialFilters.endDate);
  const [classId, setClassId] = useState<string>(initialFilters.classId);
  const [problemId, setProblemId] = useState<string>(initialFilters.problemId);

  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<AnalyticsResponse | null>(null);

  type SortField = keyof AnalyticsItem;
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  const [visibleColumns, setVisibleColumns] = useState<Set<ProblemColumnKey>>(() => {
    try {
      const saved = localStorage.getItem('ai_analytics_visible_columns');
      if (saved) {
        const parsed = JSON.parse(saved) as ProblemColumnKey[];
        if (Array.isArray(parsed) && parsed.length > 0) return new Set(parsed);
      }
    } catch {}
    return new Set(PROBLEM_COLUMNS.filter(c => c.defaultVisible).map(c => c.key));
  });

  useEffect(() => {
    try {
      localStorage.setItem('ai_analytics_visible_columns', JSON.stringify([...visibleColumns]));
    } catch {}
  }, [visibleColumns]);

  const hasInitialFilters = initialFilters.startDate || initialFilters.endDate ||
                           initialFilters.classId || initialFilters.problemId;

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set('dimension', dimension);
      if (startDate) params.set('startDate', startDate);
      if (endDate) params.set('endDate', endDate);
      if (classId) params.set('classId', classId);
      if (problemId) params.set('problemId', problemId);

      const res = await fetch(buildApiUrl(`/ai-helper/analytics?${params.toString()}`), {
        method: 'GET',
        credentials: 'include',
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `请求失败: ${res.status}`);
      }
      const json: AnalyticsResponse = await res.json();
      setData(json);
    } catch (err: any) {
      console.error('Fetch analytics error', err);
      setError(err.message || '加载统计数据失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (hasInitialFilters) fetchData();
  }, []);

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field as SortField);
      setSortOrder('desc');
    }
  };

  const getSortedItems = (items: AnalyticsItem[]): AnalyticsItem[] => {
    if (!sortField) return items;
    return [...items].sort((a, b) => {
      const aVal = a[sortField];
      const bVal = b[sortField];
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return sortOrder === 'asc' ? -1 : 1;
      if (bVal == null) return sortOrder === 'asc' ? 1 : -1;
      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortOrder === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }
      return sortOrder === 'asc' ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
    });
  };

  const renderTable = () => {
    if (!data || data.items.length === 0) {
      return (
        <div style={{
          padding: '60px 20px', textAlign: 'center', color: '#9ca3af',
          backgroundColor: '#f9fafb', borderRadius: '12px', border: '1px dashed #e5e7eb'
        }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>&#x1F4CA;</div>
          <div style={{ fontSize: '15px' }}>暂无数据，请调整筛选条件后重新查询</div>
        </div>
      );
    }

    const sortedItems = getSortedItems(data.items);

    if (data.dimension === 'class') {
      return <ClassAnalyticsTable items={sortedItems} sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />;
    }
    if (data.dimension === 'problem') {
      return (
        <ProblemAnalyticsTable
          items={sortedItems}
          sortField={sortField}
          sortOrder={sortOrder}
          onSort={handleSort}
          visibleColumns={visibleColumns}
          onVisibleColumnsChange={setVisibleColumns}
        />
      );
    }
    if (data.dimension === 'student') {
      return <StudentAnalyticsTable items={sortedItems} sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />;
    }
    return null;
  };

  return (
    <div style={{
      padding: embedded ? '24px' : '32px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      backgroundColor: embedded ? 'transparent' : '#f8fafc',
      minHeight: embedded ? 'auto' : '100vh'
    }}>
      {!embedded && (
        <div style={{
          marginBottom: '32px', padding: '24px 32px', background: '#ffffff',
          borderRadius: '12px', border: '1px solid #e5e7eb', boxShadow: '0 1px 3px rgba(0, 0, 0, 0.1)'
        }}>
          <h1 style={{ margin: 0, fontSize: '24px', fontWeight: 700, color: '#1f2937' }}>AI 使用统计</h1>
          <p style={{ margin: '8px 0 0', color: '#6b7280', fontSize: '14px' }}>查看学生使用 AI 学习助手的详细统计数据</p>
        </div>
      )}

      {/* Filter form */}
      <div style={{
        marginBottom: '24px', padding: '24px', backgroundColor: '#ffffff',
        borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', border: '1px solid #e5e7eb'
      }}>
        <h3 style={{ margin: '0 0 20px', fontSize: '16px', fontWeight: 600, color: '#1f2937' }}>筛选条件</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px' }}>
          <div>
            <label style={{ display: 'block', marginBottom: '8px', fontWeight: 500, fontSize: '14px', color: '#374151' }}>统计维度</label>
            <select
              value={dimension}
              onChange={(e) => { setDimension(e.target.value as Dimension); setData(null); setSortField(null); setSortOrder('desc'); }}
              style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid #e5e7eb', fontSize: '14px', backgroundColor: '#f9fafb', color: '#1f2937', cursor: 'pointer' }}
            >
              <option value="class">按班级</option>
              <option value="problem">按题目</option>
              <option value="student">按学生</option>
            </select>
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '8px', fontWeight: 500, fontSize: '14px', color: '#374151' }}>开始日期</label>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
              style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid #e5e7eb', fontSize: '14px', backgroundColor: '#f9fafb', color: '#1f2937' }} />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '8px', fontWeight: 500, fontSize: '14px', color: '#374151' }}>结束日期</label>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
              style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid #e5e7eb', fontSize: '14px', backgroundColor: '#f9fafb', color: '#1f2937' }} />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '8px', fontWeight: 500, fontSize: '14px', color: '#374151' }}>班级</label>
            <input type="text" value={classId} onChange={(e) => setClassId(e.target.value)} placeholder="班级 ID（可选）"
              style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid #e5e7eb', fontSize: '14px', backgroundColor: '#f9fafb', color: '#1f2937' }} />
          </div>
          <div>
            <label style={{ display: 'block', marginBottom: '8px', fontWeight: 500, fontSize: '14px', color: '#374151' }}>题目 ID</label>
            <input type="text" value={problemId} onChange={(e) => setProblemId(e.target.value)} placeholder="题目 ID（可选）"
              style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid #e5e7eb', fontSize: '14px', backgroundColor: '#f9fafb', color: '#1f2937' }} />
          </div>
        </div>
        <button onClick={fetchData} disabled={loading}
          style={{
            marginTop: '20px', padding: '12px 28px',
            background: loading ? '#9ca3af' : 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            color: 'white', border: 'none', borderRadius: '8px', fontSize: '15px', fontWeight: 600,
            cursor: loading ? 'not-allowed' : 'pointer',
            boxShadow: loading ? 'none' : '0 2px 8px rgba(102, 126, 234, 0.3)', transition: 'all 0.2s'
          }}
        >
          {loading ? '查询中...' : '查询'}
        </button>
      </div>

      {loading && (
        <div style={{ padding: '40px', textAlign: 'center', color: '#6b7280', backgroundColor: '#ffffff', borderRadius: '12px', border: '1px solid #e5e7eb' }}>
          <div style={{ fontSize: '24px', marginBottom: '12px' }}>&#x23F3;</div>
          正在加载统计数据...
        </div>
      )}

      {error && (
        <div style={{ padding: '16px 20px', backgroundColor: '#fef2f2', border: '1px solid #fecaca', borderRadius: '12px', color: '#991b1b', marginBottom: '24px' }}>
          &#x26A0;&#xFE0F; <strong>加载失败：</strong> {error}
        </div>
      )}

      {!loading && !error && renderTable()}
    </div>
  );
};

export default AnalyticsPage;
