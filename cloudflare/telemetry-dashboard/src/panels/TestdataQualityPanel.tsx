import { useEffect, useState } from 'react';
import { getTestdataQuality } from '../api';
import type {
  TestdataQualityDistributionItem,
  TestdataQualityResponse,
} from '../types';
import {
  buildTestdataModelRoleRows,
  buildTestdataQualityCards,
  buildTestdataStageLatencyRows,
  formatTestdataQualityRate,
} from '../testdataQualityView';

const EMPTY_ITEMS: TestdataQualityDistributionItem[] = [];

function Distribution({ title, items }: {
  title: string;
  items?: TestdataQualityDistributionItem[];
}) {
  const rows = items ?? EMPTY_ITEMS;
  return (
    <section style={sectionStyle}>
      <h3 style={headingStyle}>{title}</h3>
      {rows.length === 0 ? <p style={emptyStyle}>暂无数据</p> : rows.map(item => (
        <div key={item.key} style={rowStyle}>
          <code>{item.key}</code><strong>{item.count}</strong>
        </div>
      ))}
    </section>
  );
}

export function TestdataQualityPanel() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<TestdataQualityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    getTestdataQuality(days)
      .then(value => { if (active) setData(value); })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [days]);

  return (
    <div>
      <div style={toolbarStyle}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20 }}>测试数据质量</h2>
          <p style={{ ...emptyStyle, margin: '4px 0 0' }}>仅展示 Worker 返回的匿名聚合结果；每个比率均显示分子和分母。</p>
        </div>
        <label style={{ fontSize: 14 }}>
          统计窗口{' '}
          <select value={days} onChange={event => setDays(Number(event.target.value))} style={selectStyle}>
            <option value={7}>7 天</option>
            <option value={30}>30 天</option>
            <option value={90}>90 天</option>
            <option value={400}>400 天</option>
          </select>
        </label>
      </div>

      {loading && <p style={emptyStyle}>加载中...</p>}
      {error && <p style={{ color: '#ef4444' }}>加载失败: {error}</p>}
      {!loading && !error && data && (
        <>
          <div style={cardGridStyle}>
            {buildTestdataQualityCards(data).map(card => (
              <div key={card.key} style={cardStyle}>
                <div style={labelStyle}>{card.label}</div>
                <div style={valueStyle}>{card.value}</div>
              </div>
            ))}
          </div>

          <div style={threeColumnStyle}>
            <Distribution title="FailureCode 分布" items={data.failure_codes} />
            <Distribution title="失败 Stage 分布" items={data.failure_stages} />
            <Distribution title="失败 Artifact 分布" items={data.failure_artifacts} />
            <Distribution title="Risk tier 分布" items={data.risk_tiers} />
          </div>

          <section style={sectionStyle}>
            <h3 style={headingStyle}>阶段耗时</h3>
            {(data.stage_latency?.length ?? 0) === 0 ? <p style={emptyStyle}>暂无数据</p> : (
              <div style={tableWrapStyle}>
                <table style={tableStyle}>
                  <thead><tr><th>Stage</th><th>样本数</th><th>P50</th><th>P95</th></tr></thead>
                  <tbody>{buildTestdataStageLatencyRows(data).map(item => <tr key={item.stage}>
                    <td><code>{item.stage}</code></td><td>{item.runs}</td>
                    <td>{item.p50}</td><td>{item.p95}</td>
                  </tr>)}</tbody>
                </table>
              </div>
            )}
          </section>

          <section style={sectionStyle}>
            <h3 style={headingStyle}>模型角色成功率</h3>
            <div style={tableWrapStyle}>
              <table style={tableStyle}>
                <thead><tr><th>角色</th><th>运行数</th><th>Pipeline 完成</th><th>机器验证</th><th>Pipeline 失败</th></tr></thead>
                <tbody>{buildTestdataModelRoleRows(data).map(item => <tr key={item.role}>
                  <td>{item.label}</td><td>{item.runs}</td><td>{item.completed}</td>
                  <td>{item.verified}</td><td>{item.failed}</td>
                </tr>)}</tbody>
              </table>
            </div>
          </section>

          <section style={sectionStyle}>
            <h3 style={headingStyle}>模板语言验证</h3>
            <div style={tableWrapStyle}>
              <table style={tableStyle}>
                <thead><tr><th>语言</th><th>请求数</th><th>验证数</th><th>完成率</th></tr></thead>
                <tbody>{(['py', 'java', 'cc'] as const).map(language => {
                  const item = data.templates?.[language];
                  return <tr key={language}>
                    <td>{language === 'py' ? 'Python' : language === 'cc' ? 'C++' : 'Java'}</td>
                    <td>{item?.requested ?? 0}</td><td>{item?.verified ?? 0}</td>
                    <td>{formatTestdataQualityRate(item ? {
                      count: item.verified, total: item.requested, rate: item.rate,
                    } : undefined)}</td>
                  </tr>;
                })}</tbody>
              </table>
            </div>
          </section>

          <div style={threeColumnStyle}>
            <section style={sectionStyle}>
              <h3 style={headingStyle}>Checker</h3>
              {(['configured', 'read', 'compiled', 'executed'] as const).map(key => (
                <div key={key} style={rowStyle}>
                  <span>{key}</span><strong>{formatTestdataQualityRate(data.checker?.[key])}</strong>
                </div>
              ))}
              <div style={rowStyle}>
                <span>infra failure rate</span>
                <strong>{formatTestdataQualityRate(data.checker?.infra_failure)}</strong>
              </div>
              <div style={rowStyle}><span>infra failures</span><strong>{data.checker?.infra_failures ?? 0}</strong></div>
            </section>
            <section style={sectionStyle}>
              <h3 style={headingStyle}>Stress 计数</h3>
              {(['generated', 'valid', 'dropped_invalid', 'unique', 'compared', 'agreed'] as const).map(key => (
                <div key={key} style={rowStyle}><span>{key}</span><strong>{data.stress?.[key] ?? 0}</strong></div>
              ))}
            </section>
            <section style={sectionStyle}>
              <h3 style={headingStyle}>说明</h3>
              <p style={emptyStyle}>Pipeline 完成不等于 verified；verified 与 wouldBlock 均直接采用生成端的权威结果。</p>
              <p style={emptyStyle}>0 次样本显示“暂无数据”，不会把 0/0 渲染为 100%。</p>
            </section>
          </div>

          <section style={sectionStyle}>
            <h3 style={headingStyle}>插件版本趋势</h3>
            {(data.version_trend?.length ?? 0) === 0 ? <p style={emptyStyle}>暂无数据</p> : (
              <div style={tableWrapStyle}><table style={tableStyle}>
                <thead><tr><th>版本</th><th>运行</th><th>Pipeline 完成</th><th>Verified</th><th>WouldBlock</th></tr></thead>
                <tbody>{data.version_trend?.map(item => <tr key={item.plugin_version}>
                  <td>{item.plugin_version}</td><td>{item.runs}</td><td>{item.pipeline_completed}</td>
                  <td>{item.verified}</td><td>{item.would_block}</td>
                </tr>)}</tbody>
              </table></div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

const toolbarStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'end', gap: 16, marginBottom: 16 };
const selectStyle: React.CSSProperties = { padding: '6px 8px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff' };
const cardGridStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12, marginBottom: 16 };
const threeColumnStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16, marginBottom: 16 };
const cardStyle: React.CSSProperties = { padding: 18, background: '#fff', borderRadius: 10, boxShadow: '0 1px 3px rgba(0,0,0,0.1)' };
const labelStyle: React.CSSProperties = { color: '#6b7280', fontSize: 13, marginBottom: 8 };
const valueStyle: React.CSSProperties = { color: '#1d4ed8', fontWeight: 700, fontSize: 22 };
const sectionStyle: React.CSSProperties = { padding: 18, background: '#fff', borderRadius: 10, boxShadow: '0 1px 3px rgba(0,0,0,0.1)', marginBottom: 16 };
const headingStyle: React.CSSProperties = { margin: '0 0 12px', fontSize: 16 };
const emptyStyle: React.CSSProperties = { color: '#6b7280', fontSize: 13 };
const rowStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '6px 0', borderBottom: '1px solid #f3f4f6', fontSize: 13 };
const tableWrapStyle: React.CSSProperties = { overflowX: 'auto' };
const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: 13 };
