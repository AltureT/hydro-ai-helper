import React, { useState, useEffect } from 'react';
import { i18n } from 'vj/utils';
import { buildApiUrl } from '../utils/domainUtils';
import {
  COLORS, FONT_FAMILY, SPACING, RADIUS, SHADOWS, TRANSITIONS,
  cardStyle, emptyStateStyle, getInputStyle, getPillStyle, getButtonStyle, getAlertStyle,
} from '../utils/styles';
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

const DIMENSION_OPTIONS: { value: Dimension; labelKey: string }[] = [
  { value: 'problem', labelKey: 'ai_helper_teacher_analytics_by_problem' },
  { value: 'student', labelKey: 'ai_helper_teacher_analytics_by_student' },
  { value: 'class', labelKey: 'ai_helper_teacher_analytics_by_class' },
];

const labelStyle: React.CSSProperties = {
  display: 'block',
  marginBottom: SPACING.sm,
  fontWeight: 500,
  fontSize: '14px',
  color: COLORS.textSecondary,
};

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
        throw new Error(text || `${i18n('ai_helper_teacher_request_failed')}: ${res.status}`);
      }
      const json: AnalyticsResponse = await res.json();
      setData(json);
    } catch (err: any) {
      console.error('Fetch analytics error', err);
      setError(err.message || i18n('ai_helper_teacher_analytics_load_failed'));
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
        <div style={emptyStateStyle}>
          <div style={{ fontSize: '48px', marginBottom: SPACING.base }}>&#x1F4CA;</div>
          <div style={{ fontSize: '15px' }}>{i18n('ai_helper_teacher_analytics_no_data')}</div>
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

  const buttonBaseStyle = getButtonStyle('primary');
  const queryButtonStyle: React.CSSProperties = {
    ...buttonBaseStyle,
    marginTop: SPACING.lg,
    padding: `${SPACING.md} 28px`,
    fontSize: '15px',
    fontWeight: 600,
    ...(loading ? {
      backgroundColor: COLORS.textDisabled,
      cursor: 'not-allowed',
      boxShadow: 'none',
    } : {}),
  };

  return (
    <div style={{
      padding: embedded ? SPACING.lg : SPACING.xl,
      fontFamily: FONT_FAMILY,
      backgroundColor: embedded ? 'transparent' : COLORS.bgPage,
      minHeight: embedded ? 'auto' : '100vh',
    }}>
      {!embedded && (
        <div style={{
          ...cardStyle,
          marginBottom: SPACING.xl,
          padding: `${SPACING.lg} ${SPACING.xl}`,
        }}>
          <h1 style={{ margin: 0, fontSize: '24px', fontWeight: 700, color: COLORS.textPrimary }}>{i18n('ai_helper_teacher_analytics_title')}</h1>
          <p style={{ margin: `${SPACING.sm} 0 0`, color: COLORS.textSecondary, fontSize: '14px' }}>{i18n('ai_helper_teacher_analytics_subtitle')}</p>
        </div>
      )}

      {/* Filter form */}
      <div style={{ ...cardStyle, marginBottom: SPACING.lg }}>
        <h3 style={{ margin: `0 0 ${SPACING.lg}`, fontSize: '16px', fontWeight: 600, color: COLORS.textPrimary }}>{i18n('ai_helper_teacher_filter_title')}</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: SPACING.lg }}>
          <div>
            <label style={labelStyle}>{i18n('ai_helper_teacher_analytics_dimension')}</label>
            <div style={{ display: 'flex', gap: SPACING.sm, flexWrap: 'wrap' }}>
              {DIMENSION_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => { setDimension(opt.value); setData(null); setSortField(null); setSortOrder('desc'); }}
                  style={getPillStyle(dimension === opt.value)}
                >
                  {i18n(opt.labelKey)}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label style={labelStyle}>{i18n('ai_helper_teacher_filter_start_date')}</label>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
              style={getInputStyle()} />
          </div>
          <div>
            <label style={labelStyle}>{i18n('ai_helper_teacher_filter_end_date')}</label>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
              style={getInputStyle()} />
          </div>
          <div>
            <label style={labelStyle}>{i18n('ai_helper_teacher_conv_col_class')}</label>
            <input type="text" value={classId} onChange={(e) => setClassId(e.target.value)} placeholder={i18n('ai_helper_teacher_filter_class_id_optional')}
              style={getInputStyle()} />
          </div>
          <div>
            <label style={labelStyle}>{i18n('ai_helper_teacher_filter_problem_id')}</label>
            <input type="text" value={problemId} onChange={(e) => setProblemId(e.target.value)} placeholder={i18n('ai_helper_teacher_filter_problem_id_optional')}
              style={getInputStyle()} />
          </div>
        </div>
        <button onClick={fetchData} disabled={loading} style={queryButtonStyle}>
          {loading ? i18n('ai_helper_teacher_querying') : i18n('ai_helper_teacher_query')}
        </button>
      </div>

      {loading && (
        <div style={{
          padding: SPACING.xxl,
          textAlign: 'center',
          color: COLORS.textSecondary,
          backgroundColor: COLORS.bgCard,
          borderRadius: RADIUS.lg,
          border: `1px solid ${COLORS.border}`,
        }}>
          <div style={{ fontSize: '24px', marginBottom: SPACING.md }}>&#x23F3;</div>
          {i18n('ai_helper_teacher_analytics_loading')}
        </div>
      )}

      {error && (
        <div style={{ ...getAlertStyle('error'), marginBottom: SPACING.lg }}>
          <strong>{i18n('ai_helper_teacher_load_failed')}</strong> {error}
        </div>
      )}

      {!loading && !error && renderTable()}
    </div>
  );
};

export default AnalyticsPage;
