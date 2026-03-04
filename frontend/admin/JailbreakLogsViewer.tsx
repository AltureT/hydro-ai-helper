import React from 'react';
import type { JailbreakLogPagination } from './configTypes';

interface JailbreakLogsViewerProps {
  logPagination: JailbreakLogPagination;
  loading: boolean;
  onChangePage: (page: number) => void;
  onCopyToClipboard: (text: string) => void;
  onAppendPattern: (pattern: string) => void;
}

const actionBtnStyle: React.CSSProperties = {
  padding: '8px 12px', backgroundColor: '#e5e7eb',
  border: '1px solid #d1d5db', borderRadius: '6px',
  fontSize: '13px', cursor: 'pointer',
};

export const JailbreakLogsViewer: React.FC<JailbreakLogsViewerProps> = ({
  logPagination, loading, onChangePage, onCopyToClipboard, onAppendPattern,
}) => (
  <div style={{
    marginTop: '20px', padding: '20px', backgroundColor: '#f9fafb',
    borderRadius: '8px', border: '1px solid #e5e7eb',
  }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
      <h2 style={{ margin: 0, fontSize: '18px' }}>越狱尝试记录</h2>
      {logPagination.total > 0 && (
        <span style={{ fontSize: '13px', color: '#6b7280' }}>
          共 {logPagination.total} 条记录
        </span>
      )}
    </div>

    {logPagination.logs.length === 0 ? (
      <div style={{
        padding: '15px', backgroundColor: '#fff', borderRadius: '6px',
        border: '1px dashed #d1d5db', color: '#6b7280', fontSize: '14px',
      }}>
        暂无命中记录，说明最近没有学生尝试修改系统提示词。
      </div>
    ) : (
      <>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
          {logPagination.logs.map((log) => {
            const contextPieces: string[] = [];
            if (log.userId !== undefined) contextPieces.push(`用户 ID：${log.userId}`);
            if (log.problemId) contextPieces.push(`题目 ID：${log.problemId}`);
            if (log.conversationId) contextPieces.push(`会话 ID：${log.conversationId}`);
            if (log.questionType) contextPieces.push(`问题类型：${log.questionType}`);
            const contextText = contextPieces.join(' · ');

            return (
              <div key={log.id} style={{
                padding: '15px', backgroundColor: '#fff', borderRadius: '8px', border: '1px solid #e5e7eb',
              }}>
                <div style={{ fontSize: '14px', color: '#111827', fontWeight: 500 }}>
                  时间：{new Date(log.createdAt).toLocaleString()}
                </div>
                <div style={{ marginTop: '6px', fontSize: '13px', color: '#4b5563' }}>
                  命中规则：<code style={{ fontFamily: 'monospace' }}>{log.matchedPattern}</code>
                </div>
                <pre style={{
                  marginTop: '10px', padding: '12px', backgroundColor: '#1f2937', color: '#f9fafb',
                  borderRadius: '6px', fontSize: '13px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}>
                  {log.matchedText}
                </pre>
                {contextText && (
                  <div style={{ marginTop: '6px', fontSize: '12px', color: '#6b7280' }}>
                    {contextText}
                  </div>
                )}
                <div style={{ marginTop: '10px', display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
                  <button type="button" onClick={() => onCopyToClipboard(log.matchedText)} style={actionBtnStyle}>
                    复制命中文本
                  </button>
                  <button type="button" onClick={() => onCopyToClipboard(log.matchedPattern)} style={actionBtnStyle}>
                    复制命中正则
                  </button>
                  <button
                    type="button"
                    onClick={() => onAppendPattern(log.matchedPattern)}
                    style={{ ...actionBtnStyle, backgroundColor: '#eef2ff', borderColor: '#c7d2fe' }}
                  >
                    追加到自定义规则
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Pagination */}
        {logPagination.totalPages > 1 && (
          <div style={{
            marginTop: '20px', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '10px',
          }}>
            <button
              onClick={() => onChangePage(logPagination.page - 1)}
              disabled={logPagination.page <= 1 || loading}
              style={{
                padding: '8px 16px',
                backgroundColor: logPagination.page <= 1 ? '#f3f4f6' : '#e5e7eb',
                border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '14px',
                cursor: logPagination.page <= 1 ? 'not-allowed' : 'pointer',
              }}
            >
              上一页
            </button>
            <span style={{ fontSize: '14px', color: '#4b5563' }}>
              第 {logPagination.page} / {logPagination.totalPages} 页
            </span>
            <button
              onClick={() => onChangePage(logPagination.page + 1)}
              disabled={logPagination.page >= logPagination.totalPages || loading}
              style={{
                padding: '8px 16px',
                backgroundColor: logPagination.page >= logPagination.totalPages ? '#f3f4f6' : '#e5e7eb',
                border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '14px',
                cursor: logPagination.page >= logPagination.totalPages ? 'not-allowed' : 'pointer',
              }}
            >
              下一页
            </button>
          </div>
        )}
      </>
    )}
  </div>
);
