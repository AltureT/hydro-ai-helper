import React from 'react';
import type { TeachingFinding } from './useTeachingSummary';

const STATUS: Record<number, string> = { 1: 'AC', 2: 'WA', 3: 'TLE', 4: 'MLE', 5: 'OLE', 6: 'RE', 7: 'CE' };

export const FindingCodeSample: React.FC<{ finding: TeachingFinding; domainId: string }> = ({ finding, domainId }) => {
  const code = finding.evidence.samples?.code?.[0];
  if (!code) return null;
  const source = finding.evidence.samples?.codeSources?.[0];
  const verifiedError = source && source.status >= 2 && source.status <= 7;
  const recordUrl = source?.recordId && /^[a-f\d]{24}$/i.test(source.recordId)
    ? `/d/${encodeURIComponent(domainId)}/record/${source.recordId}` : undefined;
  return <div style={{ marginTop: 12 }}>
    <div style={{ fontSize: 12, marginBottom: 8 }}>
      <strong>{verifiedError ? '历史失败提交示例（仅代表该提交）' : '旧报告样本来源未校验，请重新生成'}</strong>
      {source && <div>
        {STATUS[source.status] || '判题状态未知'} · {source.resolved ? '该生本题已有通过记录' : '该生本题尚无通过记录'}
        {source.submittedAt && ` · 提交于 ${new Date(source.submittedAt).toLocaleString()}`}
        {source.lang && ` · ${source.lang}`}
        {source.truncated && ' · 代码已截断，不能据此判断完整逻辑'}
        {recordUrl && <> · <a href={recordUrl} target="_blank" rel="noopener noreferrer">查看原提交</a></>}
      </div>}
    </div>
    <pre style={{ margin: 0, fontSize: 13, overflowX: 'auto', backgroundColor: '#1e293b', borderRadius: 8,
      padding: 16, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: '#e2e8f0', lineHeight: 1.6 }}>
      {code}
    </pre>
  </div>;
};
