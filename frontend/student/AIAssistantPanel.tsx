/**
 * AI 学习助手面板 - 学生端
 * 在题目详情页显示的对话界面
 * T007A: 可折叠/可拖拽/可调尺寸的浮动卡片
 */

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import 'highlight.js/styles/github.css';
import { buildApiUrl } from '../utils/domainUtils';

/**
 * 基础问题类型选项
 */
const BASE_QUESTION_TYPES = [
  { value: 'understand', label: '理解题意 - 我对题目要求不太清楚' },
  { value: 'think', label: '理清思路 - 我需要帮助梳理解题思路' },
  { value: 'debug', label: '分析错误 - 我的代码有问题,需要找出原因' }
];

/**
 * 题目信息接口
 */
interface ProblemInfo {
  title: string;
  problemId: string;
  content: string;
}

/**
 * AI 助手面板组件
 */
/**
 * T039: 声明 Monaco Editor 全局类型
 * HydroOJ Scratchpad 使用 Monaco Editor
 */
declare global {
  interface Window {
    editor?: {
      getValue: (options?: { lineEnding?: string; preserveBOM?: boolean }) => string;
    };
    monaco?: unknown;
  }
}

interface AIAssistantPanelProps {
  problemId: string;
  defaultExpanded?: boolean;  // 默认是否展开
  onCollapse?: () => void;    // 折叠时的回调
  embedded?: boolean;         // 嵌入模式：不显示浮动外壳
}

export const AIAssistantPanel: React.FC<AIAssistantPanelProps> = ({
  problemId,
  defaultExpanded,
  onCollapse,
  embedded = false
}) => {
  // 原有业务状态
  const [questionType, setQuestionType] = useState<string>('');
  const [userThinking, setUserThinking] = useState<string>('');
  const [code, setCode] = useState<string>('');
  const [includeCode, setIncludeCode] = useState<boolean>(false);
  const [aiResponse, setAiResponse] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');

  // 多轮对话状态
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversationHistory, setConversationHistory] = useState<Array<{
    role: 'student' | 'ai';
    content: string;
    timestamp: Date;
    code?: string;  // 学生消息可能附带代码
  }>>([]);
  const chatContainerRef = useRef<HTMLDivElement>(null);

  // 选中答疑状态
  const [selectedText, setSelectedText] = useState<string>('');
  const [popupPosition, setPopupPosition] = useState<{x: number; y: number} | null>(null);
  const savedRangeRef = useRef<Range | null>(null);

  // 自动提交标记（用于"我不理解"功能）
  const [pendingAutoSubmit, setPendingAutoSubmit] = useState<boolean>(false);

  // 题目信息自动读取相关状态
  const [problemInfo, setProblemInfo] = useState<ProblemInfo | null>(null);
  const [problemInfoError, setProblemInfoError] = useState<string>('');
  const [manualTitle, setManualTitle] = useState<string>('');

  // T039: Scratchpad 代码自动读取相关状态
  const [scratchpadAvailable, setScratchpadAvailable] = useState<boolean>(false);

  // 用户是否已 AC 该题（用于显示"代码优化"选项）
  const [hasAccepted, setHasAccepted] = useState<boolean>(false);
  // 用户最近一次 AC 的代码（用于"代码优化"时自动加载）
  const [acCode, setAcCode] = useState<string | null>(null);
  // 确认框：是否显示加载AC代码确认框
  const [showLoadCodeConfirm, setShowLoadCodeConfirm] = useState<boolean>(false);

  // 动态生成问题类型列表（已 AC 时显示"代码优化"选项）
  const QUESTION_TYPES = useMemo(() => {
    const types = [...BASE_QUESTION_TYPES];
    if (hasAccepted) {
      types.push({ value: 'optimize', label: '代码优化 - 代码能运行,但想让它更高效' });
    }
    return types;
  }, [hasAccepted]);

  // T007A: 浮动面板 UI 状态
  const [isCollapsed, setIsCollapsed] = useState<boolean>(() => {
    // 如果指定了 defaultExpanded，优先使用
    if (defaultExpanded !== undefined) {
      return !defaultExpanded;
    }
    if (typeof window === 'undefined') return true; // SSR/构建安全
    const saved = window.localStorage.getItem('ai_assistant_collapsed');
    if (saved === 'true') return true;
    if (saved === 'false') return false;
    return true; // 默认折叠
  }); // 折叠状态
  const [position, setPosition] = useState({ bottom: 20, right: 20 }); // 面板位置
  const [size, setSize] = useState({ width: 400, height: 500 }); // 面板尺寸
  const [isDragging, setIsDragging] = useState<boolean>(false); // 拖拽状态
  const [isResizing, setIsResizing] = useState<boolean>(false); // 缩放状态
  const [resizeDirection, setResizeDirection] = useState<'width' | 'height' | null>(null); // 拖拽方向
  const [isMobile, setIsMobile] = useState<boolean>(false); // 移动端检测

  // DOM 引用
  const panelRef = useRef<HTMLDivElement>(null);
  const dragStartPos = useRef({ x: 0, y: 0 });
  const resizeStartSize = useRef({ width: 0, height: 0 });
  const resizeStartMouse = useRef({ x: 0, y: 0 });

  const toggleCollapse = () => {
    setIsCollapsed((prev) => {
      const next = !prev;
      try {
        // 如果有 onCollapse 回调，不保存到 localStorage（由父组件控制）
        if (!onCollapse) {
          window.localStorage.setItem('ai_assistant_collapsed', next ? 'true' : 'false');
        }
      } catch (e) {
        // 忽略本地存储错误
      }
      // 折叠时调用回调
      if (next && onCollapse) {
        onCollapse();
      }
      return next;
    });
  };

  /**
   * 初始化 Markdown 渲染器
   */
  const md = useMemo(() => {
    return new MarkdownIt({
      html: false, // 禁用 HTML 标签(安全考虑)
      linkify: true, // 自动将 URL 转为链接
      typographer: true, // 启用排版优化
      highlight: (str, lang) => {
        if (lang && hljs.getLanguage(lang)) {
          try {
            return hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
          } catch (err) {
            console.error('Highlight.js error:', err);
          }
        }
        return ''; // 使用默认转义
      }
    });
  }, []);

  /**
   * T007A: 移动端检测
   */
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768);
    };

    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  /**
   * 多轮对话：从 localStorage 恢复 conversationId
   */
  useEffect(() => {
    if (problemId) {
      try {
        const savedId = window.localStorage.getItem(`ai_conversation_${problemId}`);
        if (savedId) setConversationId(savedId);
      } catch (e) {
        // ignore localStorage error
      }
    }
  }, [problemId]);

  /**
   * 获取用户在该题的提交状态（是否已 AC）
   * 用于决定是否显示"代码优化"选项，并预加载 AC 代码
   */
  const fetchSubmissionStatus = useCallback(async () => {
    if (!problemId) return;
    try {
      const response = await fetch(buildApiUrl(`/ai-helper/problem-status/${problemId}`), {
        credentials: 'include'
      });
      if (response.ok) {
        const data = await response.json();
        setHasAccepted(data.hasAccepted);
        if (data.acCode) {
          setAcCode(data.acCode);
        }
      }
    } catch (error) {
      console.error('Failed to fetch submission status:', error);
    }
  }, [problemId]);

  useEffect(() => {
    fetchSubmissionStatus();
  }, [fetchSubmissionStatus]);

  /**
   * 监听 Redux Store 检测 AC 状态变化
   * 当用户在 Scratchpad 提交代码并 AC 时，自动刷新状态
   */
  useEffect(() => {
    const STATUS_ACCEPTED = 1;
    const store = (window as any).store;
    if (!store || isCollapsed || hasAccepted) return;

    let lastRecordsRef: any = null;
    let lastCheckedRecordId = '';
    let lastCheckedStatus: number | undefined;

    const unsubscribe = store.subscribe(() => {
      const state = store.getState();
      const { rows = [], items = {} } = state?.records || {};

      if (items === lastRecordsRef) return;
      lastRecordsRef = items;

      const latestRecordId = rows[0];
      const latestRecord = latestRecordId ? items[latestRecordId] : null;
      if (!latestRecord) return;

      if (latestRecordId === lastCheckedRecordId && latestRecord.status === lastCheckedStatus) return;
      lastCheckedRecordId = latestRecordId;
      lastCheckedStatus = latestRecord.status;

      if (latestRecord.status === STATUS_ACCEPTED) {
        fetchSubmissionStatus();
      }
    });

    return () => unsubscribe();
  }, [isCollapsed, hasAccepted, fetchSubmissionStatus]);

  /**
   * T040: 从 Scratchpad 读取代码
   * 使用 monaco.editor.getModels()[0].getValue() 获取当前编辑器内容
   */
  const readFromScratchpad = (): string | null => {
    try {
      const monaco = (window as any).monaco;
      if (monaco?.editor?.getModels) {
        const models = monaco.editor.getModels();
        if (models && models.length > 0) {
          return models[0].getValue();
        }
      }
      return null;
    } catch (err) {
      console.error('[AI Helper] Failed to read from Scratchpad:', err);
      return null;
    }
  };

  /**
   * 将代码写入 Scratchpad 编辑器
   * 优先使用 window.editor，其次尝试 Redux dispatch，最后降级到 getEditors()
   */
  const writeToScratchpad = (codeToWrite: string): boolean => {
    try {
      const editor = (window as any).editor;
      if (editor?.setValue) {
        editor.setValue(codeToWrite);
        return true;
      }

      const store = (window as any).store;
      if (store?.dispatch) {
        store.dispatch({ type: 'SCRATCHPAD_EDITOR_UPDATE_CODE', payload: codeToWrite });
        return true;
      }

      const monaco = (window as any).monaco;
      if (monaco?.editor?.getEditors) {
        const editors = monaco.editor.getEditors();
        if (editors && editors.length > 0) {
          const model = editors[0].getModel();
          if (model) {
            model.setValue(codeToWrite);
            return true;
          }
        }
      }

      return false;
    } catch (err) {
      console.error('[AI Helper] Failed to write to Scratchpad:', err);
      return false;
    }
  };

  /**
   * T046: 当用户勾选"附带当前代码"时，自动读取 Scratchpad 代码
   * 这样确保读取的是用户当前编辑的最新代码
   */
  useEffect(() => {
    if (includeCode && !code) {
      // 用户刚勾选，尝试自动读取代码
      const scratchpadCode = readFromScratchpad();
      if (scratchpadCode !== null) {
        setCode(scratchpadCode);
        setScratchpadAvailable(true);
      }
    }
  }, [includeCode]);

  /**
   * 处理问题类型变更
   * 当选择"代码优化"时，显示确认框询问是否加载AC代码
   */
  const handleQuestionTypeChange = (newType: string) => {
    setQuestionType(newType);
    if (newType === 'optimize' && acCode) {
      setShowLoadCodeConfirm(true);
    }
  };

  /**
   * T041: 处理"从 Scratchpad 读取代码"按钮点击
   * 用于手动刷新代码（当用户修改了 Scratchpad 中的代码后）
   */
  const handleReadFromScratchpad = () => {
    const scratchpadCode = readFromScratchpad();
    if (scratchpadCode !== null) {
      setCode(scratchpadCode);
      setScratchpadAvailable(true);
      setError(null);
    } else {
      setError('无法读取 Scratchpad 代码，请确保 Scratchpad 编辑器已加载');
    }
  };

  /**
   * T007A: 拖拽功能 - 标题栏拖拽
   */
  const handleDragStart = (e: React.MouseEvent) => {
    if (isMobile) return; // 移动端禁用拖拽
    setIsDragging(true);
    dragStartPos.current = {
      x: e.clientX - (window.innerWidth - position.right - size.width),
      y: e.clientY - (window.innerHeight - position.bottom - size.height)
    };
  };

  useEffect(() => {
    if (!isDragging) return;

    const handleDragMove = (e: MouseEvent) => {
      const newX = e.clientX - dragStartPos.current.x;
      const newY = e.clientY - dragStartPos.current.y;

      // 计算 bottom 和 right 位置
      const newBottom = window.innerHeight - newY - size.height;
      const newRight = window.innerWidth - newX - size.width;

      // 边界限制
      const clampedBottom = Math.max(0, Math.min(window.innerHeight - 100, newBottom));
      const clampedRight = Math.max(0, Math.min(window.innerWidth - 100, newRight));

      setPosition({ bottom: clampedBottom, right: clampedRight });
    };

    const handleDragEnd = () => {
      setIsDragging(false);
    };

    document.addEventListener('mousemove', handleDragMove);
    document.addEventListener('mouseup', handleDragEnd);

    return () => {
      document.removeEventListener('mousemove', handleDragMove);
      document.removeEventListener('mouseup', handleDragEnd);
    };
  }, [isDragging, position, size]);

  /**
   * T007A: 缩放功能 - 底部高度/左侧宽度手柄
   */
  const handleResizeStart = (e: React.MouseEvent, direction: 'width' | 'height') => {
    if (isMobile) return; // 移动端禁用缩放
    e.stopPropagation();
    setIsResizing(true);
    setResizeDirection(direction);
    resizeStartSize.current = { width: size.width, height: size.height };
    resizeStartMouse.current = { x: e.clientX, y: e.clientY };
  };

  useEffect(() => {
    if (!isResizing) return;

    const handleResizeMove = (e: MouseEvent) => {
      const deltaX = e.clientX - resizeStartMouse.current.x;
      const deltaY = e.clientY - resizeStartMouse.current.y;

      // 根据拖拽方向调整尺寸
      const maxHeight = Math.min(800, window.innerHeight * 0.8);
      const maxWidth = Math.min(900, window.innerWidth * 0.8);

      if (resizeDirection === 'width') {
        // 左侧拖拽: 向左拖动(deltaX为负)应增加宽度
        const newWidth = resizeStartSize.current.width - deltaX;
        const clampedWidth = Math.max(300, Math.min(maxWidth, newWidth));
        setSize(prev => ({ ...prev, width: clampedWidth }));
      } else if (resizeDirection === 'height') {
        // 底部拖拽: 向下拖动增加高度
        const newHeight = resizeStartSize.current.height + deltaY;
        const clampedHeight = Math.max(360, Math.min(maxHeight, newHeight));
        setSize(prev => ({ ...prev, height: clampedHeight }));
      }
    };

    const handleResizeEnd = () => {
      setIsResizing(false);
      setResizeDirection(null);
      document.body.style.userSelect = ''; // 恢复文本选择
    };

    // 禁用文本选择
    document.body.style.userSelect = 'none';

    document.addEventListener('mousemove', handleResizeMove);
    document.addEventListener('mouseup', handleResizeEnd);

    return () => {
      document.removeEventListener('mousemove', handleResizeMove);
      document.removeEventListener('mouseup', handleResizeEnd);
      document.body.style.userSelect = '';
    };
  }, [isResizing]);

  /**
   * 自动读取题目信息
   */
  useEffect(() => {
    try {
      // 读取题目标题
      const titleElement = document.querySelector('.section__title');
      const title = titleElement?.textContent?.trim() || '';

      // 从 URL 提取题目编号
      const match = window.location.pathname.match(/\/p\/([A-Z0-9]+)/i);
      const problemIdFromUrl = match ? match[1] : problemId;

      // 读取题目描述摘要
      const descElement = document.querySelector('.section__body.typo[data-fragment-id="problem-description"]');
      const fullText = descElement?.textContent?.trim() || '';
      const content = fullText.substring(0, 500) + (fullText.length > 500 ? '...' : '');

      // 检查是否成功读取
      if (title && content) {
        setProblemInfo({
          title,
          problemId: problemIdFromUrl,
          content
        });
        setProblemInfoError('');
      } else {
        setProblemInfoError('无法自动读取题目信息,请手动输入题目标题');
      }
    } catch (err) {
      console.error('[AI Helper] 读取题目信息失败:', err);
      setProblemInfoError('读取题目信息失败,请手动输入');
    }
  }, [problemId]);

  /**
   * 滚动聊天容器到底部
   */
  const scrollToBottom = () => {
    setTimeout(() => {
      if (chatContainerRef.current) {
        chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
      }
    }, 100);
  };

  /**
   * 提交问题到后端
   */
  const handleSubmit = async () => {
    // 首次提问必须选择问题类型，追问时可以复用之前的类型
    const effectiveQuestionType = questionType || (conversationHistory.length > 0 ? 'think' : '');
    if (!effectiveQuestionType) {
      setError('请选择问题类型');
      return;
    }

    // 追问时至少要有内容
    if (conversationHistory.length > 0 && !userThinking.trim()) {
      setError('请输入追问内容');
      return;
    }

    // 验证代码附带逻辑
    if (includeCode && !code.trim()) {
      setError('⚠️ 请粘贴代码或关闭「附带代码」选项');
      return;
    }

    // 添加学生消息到历史
    // 首次提问时如果没有输入内容，显示问题类型描述
    const getQuestionTypeLabel = (type: string) => {
      const found = QUESTION_TYPES.find(t => t.value === type);
      return found ? found.label.split(' - ')[0] : type;
    };
    const messageContent = userThinking.trim()
      ? userThinking
      : (conversationHistory.length === 0
        ? `【${getQuestionTypeLabel(effectiveQuestionType)}】请帮我分析这道题`
        : '（继续追问）');
    const studentMessage = {
      role: 'student' as const,
      content: messageContent,
      timestamp: new Date(),
      code: includeCode ? code : undefined
    };
    setConversationHistory(prev => [...prev, studentMessage]);
    scrollToBottom();

    setError('');
    setIsLoading(true);

    // 清空输入框
    const savedUserThinking = userThinking;
    const savedCode = includeCode ? code : undefined;
    setUserThinking('');

    try {
      // 准备题目信息
      const finalProblemTitle = problemInfo?.title || manualTitle || undefined;
      const finalProblemContent = problemInfo?.content || undefined;

      // T022: 调用后端 API（使用域前缀 URL）
      const response = await fetch(buildApiUrl('/ai-helper/chat'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          problemId,
          problemTitle: finalProblemTitle,
          problemContent: finalProblemContent,
          questionType: effectiveQuestionType,
          userThinking: savedUserThinking,
          includeCode,
          code: savedCode,
          conversationId // 多轮对话：携带已有会话 ID
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || '请求失败');
      }

      const data = await response.json();

      // 添加 AI 消息到历史
      const aiMessage = {
        role: 'ai' as const,
        content: data.message.content,
        timestamp: new Date()
      };
      setConversationHistory(prev => [...prev, aiMessage]);
      setAiResponse(data.message.content);
      scrollToBottom();

      // 多轮对话：保存 conversationId
      if (data.conversationId) {
        setConversationId(data.conversationId);
        try {
          window.localStorage.setItem(`ai_conversation_${problemId}`, data.conversationId);
        } catch (e) {
          // ignore localStorage error
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '未知错误');
      console.error('[AI Helper] 提交失败:', err);
      // 恢复输入内容
      setUserThinking(savedUserThinking);
      // 移除刚添加的学生消息
      setConversationHistory(prev => prev.slice(0, -1));
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * 开始新对话（完全重置，清除 localStorage）
   */
  const startNewConversation = () => {
    setQuestionType('');
    setUserThinking('');
    setCode('');
    setIncludeCode(false);
    setAiResponse('');
    setError('');
    setConversationId(null);
    setConversationHistory([]);
    try {
      window.localStorage.removeItem(`ai_conversation_${problemId}`);
    } catch (e) {
      // ignore
    }
  };

  /**
   * 重新获取 Scratchpad 代码（用于追问时更新代码）
   */
  const refreshCodeFromScratchpad = () => {
    const scratchpadCode = readFromScratchpad();
    if (scratchpadCode !== null) {
      setCode(scratchpadCode);
      setIncludeCode(true);
    } else {
      setError('无法读取 Scratchpad 代码');
    }
  };

  /**
   * 处理 AI 回复中的文本选择
   * 使用 DOM 检测方式，判断选中文本是否在任意 AI 消息容器内
   */
  const handleTextSelection = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      setPopupPosition(null);
      savedRangeRef.current = null;
      return;
    }
    const text = selection.toString().trim();
    if (!text) {
      setPopupPosition(null);
      savedRangeRef.current = null;
      return;
    }
    // 检查选中内容是否在 AI 消息容器内（使用 data-ai-message 属性标记）
    let node = selection.anchorNode;
    let isInAiMessage = false;
    while (node) {
      if (node instanceof HTMLElement && node.dataset.aiMessage === 'true') {
        isInAiMessage = true;
        break;
      }
      node = node.parentNode;
    }
    if (isInAiMessage) {
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      // 保存 Range 对象用于恢复选中状态
      savedRangeRef.current = range.cloneRange();
      setSelectedText(text);
      setPopupPosition({ x: rect.left + rect.width / 2, y: rect.top - 40 });
    } else {
      setPopupPosition(null);
      savedRangeRef.current = null;
    }
  };

  /**
   * 处理"我不理解"按钮点击
   */
  const handleDontUnderstand = () => {
    const truncated = selectedText.length > 100 ? selectedText.substring(0, 100) + '...' : selectedText;
    setQuestionType('clarify');
    setUserThinking(`我不太理解这部分："${truncated}"，能再解释一下吗？`);
    setAiResponse('');
    setPopupPosition(null);
    savedRangeRef.current = null;
    setPendingAutoSubmit(true); // 标记需要自动提交
    // conversationId 保持不变，实现追问
  };

  /**
   * 自动提交监听（用于"我不理解"功能）
   */
  useEffect(() => {
    if (pendingAutoSubmit && questionType && userThinking.trim()) {
      setPendingAutoSubmit(false);
      handleSubmit();
    }
  }, [pendingAutoSubmit, questionType, userThinking]);

  /**
   * 恢复选中状态（React 渲染后）
   */
  useEffect(() => {
    if (popupPosition && savedRangeRef.current) {
      const selection = window.getSelection();
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(savedRangeRef.current);
      }
    }
  }, [popupPosition]);

  /**
   * 渲染 Markdown 内容
   * 使用 markdown-it + highlight.js
   */
  const renderMarkdown = (text: string) => {
    const html = md.render(text);
    return (
      <div
        className="markdown-body"
        dangerouslySetInnerHTML={{ __html: html }}
        style={{
          fontSize: '13px',
          lineHeight: '1.6'
        }}
      />
    );
  };

  /**
   * 渲染加载AC代码确认框
   */
  const renderLoadCodeConfirmModal = () => {
    if (!showLoadCodeConfirm) return null;

    return (
      <div style={{
        position: 'fixed',
        top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 10001
      }}>
        <div style={{
          background: 'white',
          borderRadius: '12px',
          padding: '24px',
          maxWidth: '420px',
          width: '90%',
          boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1)'
        }}>
          <h3 style={{
            margin: '0 0 16px 0',
            fontSize: '16px',
            fontWeight: '600',
            color: '#374151'
          }}>
            加载AC代码
          </h3>

          <p style={{
            margin: '0 0 20px 0',
            fontSize: '14px',
            color: '#6b7280',
            lineHeight: '1.5'
          }}>
            是否将最近一次AC的代码加载到当前编辑器？
            <br />
            <span style={{ color: '#dc2626', fontSize: '13px' }}>
              注意：这将覆盖编辑器中的当前代码
            </span>
          </p>

          <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
            <button
              onClick={() => {
                setShowLoadCodeConfirm(false);
                const scratchpadCode = readFromScratchpad();
                if (scratchpadCode) {
                  setCode(scratchpadCode);
                }
                setIncludeCode(true);
              }}
              style={{
                padding: '10px 20px',
                border: '1px solid #d1d5db',
                borderRadius: '6px',
                background: 'white',
                color: '#374151',
                cursor: 'pointer',
                fontSize: '14px'
              }}
            >
              使用当前代码
            </button>
            <button
              onClick={() => {
                setShowLoadCodeConfirm(false);
                if (acCode) {
                  setCode(acCode);
                  setIncludeCode(true);
                  writeToScratchpad(acCode);
                }
              }}
              style={{
                padding: '10px 20px',
                border: 'none',
                borderRadius: '6px',
                background: '#6366f1',
                color: 'white',
                cursor: 'pointer',
                fontSize: '14px',
                fontWeight: '500'
              }}
            >
              加载AC代码
            </button>
          </div>
        </div>
      </div>
    );
  };

  // 计算面板样式(移动端 vs 桌面端)
  const panelStyle: React.CSSProperties = isMobile ? {
    // 移动端:全屏模式
    position: 'fixed',
    top: 0,
    left: 0,
    width: '100vw',
    height: isCollapsed ? '56px' : '100vh',
    background: '#f9fafb',
    zIndex: 1000,
    display: 'flex',
    flexDirection: 'column',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    transition: 'height 0.3s ease'
  } : {
    // 桌面端:浮动按钮/卡片
    position: 'fixed',
    bottom: `${position.bottom}px`,
    right: `${position.right}px`,
    width: isCollapsed ? '64px' : `${size.width}px`,
    height: isCollapsed ? '64px' : `${size.height}px`,
    background: isCollapsed ? '#6366f1' : '#f9fafb',
    borderRadius: isCollapsed ? '50%' : '12px',
    boxShadow: isCollapsed
      ? '0 8px 16px rgba(99, 102, 241, 0.4), 0 2px 8px rgba(99, 102, 241, 0.3)'
      : '0 10px 25px rgba(0, 0, 0, 0.15), 0 4px 10px rgba(0, 0, 0, 0.1)',
    zIndex: 1000,
    display: 'flex',
    flexDirection: 'column',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    overflow: 'hidden',
    transition: 'all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)',
    cursor: isCollapsed ? 'pointer' : 'default'
  };

  // Markdown 样式（共用）
  const markdownStyles = `
    .markdown-body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .markdown-body h1, .markdown-body h2, .markdown-body h3,
    .markdown-body h4, .markdown-body h5, .markdown-body h6 {
      font-weight: bold;
      margin-top: 16px;
      margin-bottom: 8px;
    }
    .markdown-body h1 { font-size: 18px; }
    .markdown-body h2 { font-size: 16px; }
    .markdown-body h3 { font-size: 15px; }
    .markdown-body ul, .markdown-body ol {
      padding-left: 20px;
      margin: 8px 0;
    }
    .markdown-body li {
      margin: 4px 0;
    }
    .markdown-body blockquote {
      padding: 0 1em;
      color: #6a737d;
      border-left: 4px solid #dfe2e5;
      margin: 8px 0;
    }
    .markdown-body a {
      color: #6366f1;
      text-decoration: underline;
    }
    .markdown-body pre {
      background: #f6f8fa;
      border: 1px solid #e1e4e8;
      border-radius: 6px;
      padding: 16px;
      overflow-x: auto;
      margin: 8px 0;
    }
    .markdown-body pre code {
      font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
      font-size: 13px;
      line-height: 1.6;
      background: transparent;
      border: none;
      padding: 0;
    }
    .markdown-body code {
      background: #f0f0f0;
      border: 1px solid #e0e0e0;
      border-radius: 3px;
      padding: 2px 6px;
      font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
      font-size: 13px;
    }
    .markdown-body p {
      margin: 8px 0;
    }
  `;

  // 嵌入模式：直接渲染内容，不显示浮动外壳
  if (embedded) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#ffffff' }}>
        <style>{markdownStyles}</style>

        {/* 选中文本弹出框 - "我不理解"按钮 */}
        {popupPosition && (
          <div
            style={{
              position: 'fixed',
              left: popupPosition.x,
              top: popupPosition.y,
              transform: 'translateX(-50%)',
              zIndex: 10000,
              background: '#1f2937',
              color: 'white',
              padding: '6px 12px',
              borderRadius: '6px',
              fontSize: '12px',
              cursor: 'pointer',
              boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
              whiteSpace: 'nowrap'
            }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleDontUnderstand}
          >
            ❓ 我不理解
          </div>
        )}

        {/* 聊天消息区域 */}
        <div
          ref={chatContainerRef}
          onMouseUp={handleTextSelection}
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px'
          }}
        >
          {/* 题目信息卡片 + 新对话按钮 */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
            {problemInfo ? (
              <div style={{
                flex: 1,
                background: '#f5f3ff',
                border: '1px solid #e0ddff',
                padding: '10px 12px',
                borderRadius: '8px'
              }}>
                <div style={{ fontSize: '12px', color: '#9333ea', marginBottom: '4px', fontWeight: '500' }}>
                  题目 {problemInfo.problemId}
                </div>
                <div style={{
                  fontWeight: '600', fontSize: '14px', color: '#5b21b6', lineHeight: '1.4',
                  overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box',
                  WebkitLineClamp: 2, WebkitBoxOrient: 'vertical'
                }}>
                  {problemInfo.title}
                </div>
              </div>
            ) : problemInfoError ? (
              <div style={{ flex: 1, background: '#fef3c7', border: '1px solid #fbbf24', padding: '12px', borderRadius: '8px' }}>
                <div style={{ fontSize: '13px', color: '#92400e', marginBottom: '8px' }}>
                  ⚠️ 无法自动获取题目信息
                </div>
                <input
                  type="text"
                  placeholder="请手动输入题目标题"
                  value={manualTitle}
                  onChange={(e) => setManualTitle(e.target.value)}
                  style={{
                    width: '100%', padding: '8px', border: '1px solid #fbbf24',
                    borderRadius: '4px', fontSize: '13px', boxSizing: 'border-box'
                  }}
                />
              </div>
            ) : <div style={{ flex: 1 }} />}

            {/* 新对话按钮 */}
            {conversationHistory.length > 0 && (
              <button
                onClick={startNewConversation}
                style={{
                  padding: '8px 12px',
                  background: '#f3f4f6',
                  border: '1px solid #e5e7eb',
                  borderRadius: '6px',
                  fontSize: '12px',
                  color: '#4b5563',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  whiteSpace: 'nowrap',
                  flexShrink: 0
                }}
                title="开始新对话"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" fill="#4b5563"/>
                </svg>
                新对话
              </button>
            )}
          </div>

          {/* 历史消息 */}
          {conversationHistory.map((msg, idx) => (
            <div
              key={idx}
              style={{
                display: 'flex',
                flexDirection: msg.role === 'student' ? 'row-reverse' : 'row',
                gap: '8px'
              }}
            >
              <div
                data-ai-message={msg.role === 'ai' ? 'true' : undefined}
                style={{
                  maxWidth: '85%',
                  padding: '10px 14px',
                  borderRadius: msg.role === 'student' ? '12px 12px 0 12px' : '12px 12px 12px 0',
                  background: msg.role === 'student' ? '#6366f1' : '#f3f4f6',
                  color: msg.role === 'student' ? 'white' : '#1f2937',
                  fontSize: '13px',
                  lineHeight: '1.6'
                }}
              >
                {msg.role === 'ai' ? (
                  <div
                    className="markdown-body"
                    style={{ fontSize: '13px' }}
                    dangerouslySetInnerHTML={{ __html: md.render(msg.content) }}
                  />
                ) : (
                  <div style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>
                )}
              </div>
            </div>
          ))}

          {/* 加载指示器 */}
          {isLoading && (
            <div style={{ display: 'flex', gap: '8px' }}>
              <div style={{
                padding: '10px 14px', borderRadius: '12px 12px 12px 0',
                background: '#f3f4f6', color: '#6b7280', fontSize: '13px'
              }}>
                <span style={{ animation: 'pulse 1.5s ease-in-out infinite' }}>正在思考中...</span>
              </div>
            </div>
          )}

          {/* 错误提示 */}
          {error && (
            <div style={{
              background: '#fef2f2', border: '1px solid #fecaca',
              padding: '12px', borderRadius: '8px', color: '#991b1b', fontSize: '13px'
            }}>
              ⚠️ {error}
            </div>
          )}

          {/* 首次对话：问题类型选择 */}
          {conversationHistory.length === 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ fontSize: '13px', color: '#6b7280', marginBottom: '4px' }}>选择问题类型：</div>
              {QUESTION_TYPES.map((type) => (
                <label
                  key={type.value}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px',
                    background: questionType === type.value ? '#eef2ff' : '#f9fafb',
                    border: questionType === type.value ? '2px solid #6366f1' : '1px solid #e5e7eb',
                    borderRadius: '8px', cursor: 'pointer', fontSize: '13px',
                    transition: 'all 0.2s'
                  }}
                >
                  <input
                    type="radio"
                    name="questionType"
                    value={type.value}
                    checked={questionType === type.value}
                    onChange={(e) => handleQuestionTypeChange(e.target.value)}
                    style={{ accentColor: '#6366f1' }}
                  />
                  {type.label}
                </label>
              ))}
            </div>
          )}
        </div>

        {/* 输入区域 */}
        <div style={{
          borderTop: '1px solid #e5e7eb', padding: '12px 16px',
          background: '#fafafa', flexShrink: 0
        }}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
            <textarea
              value={userThinking}
              onChange={(e) => setUserThinking(e.target.value)}
              placeholder={conversationHistory.length === 0 ? "描述你的问题或疑惑..." : "继续追问..."}
              style={{
                flex: 1, minHeight: conversationHistory.length === 0 ? '60px' : '40px',
                maxHeight: '100px', padding: '10px 12px', border: '1px solid #d4d4d8',
                borderRadius: '8px', fontSize: '13px', lineHeight: '1.5', resize: 'none',
                boxSizing: 'border-box', outline: 'none',
                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
              }}
              onFocus={(e) => { e.target.style.borderColor = '#6366f1'; }}
              onBlur={(e) => { e.target.style.borderColor = '#d4d4d8'; }}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
            />
            {conversationHistory.length === 0 && (
              <label style={{
                display: 'flex', alignItems: 'center',
                cursor: questionType === 'optimize' ? 'not-allowed' : 'pointer',
                fontSize: '12px',
                color: questionType === 'optimize' ? '#9ca3af' : '#6b7280',
                whiteSpace: 'nowrap', alignSelf: 'center'
              }}
              title={questionType === 'optimize' ? '代码优化必须附带代码' : undefined}
              >
                <input
                  type="checkbox"
                  checked={includeCode}
                  disabled={questionType === 'optimize'}
                  onChange={(e) => {
                    setIncludeCode(e.target.checked);
                    if (e.target.checked && !code) {
                      const scratchpadCode = readFromScratchpad();
                      if (scratchpadCode) setCode(scratchpadCode);
                    }
                  }}
                  style={{ marginRight: '6px', accentColor: '#7c3aed' }}
                />
                📎 附带代码
                {questionType === 'optimize' && (
                  <span style={{ marginLeft: '4px', color: '#f59e0b', fontSize: '11px' }}>(必需)</span>
                )}
                {includeCode && code && questionType !== 'optimize' && (
                  <span style={{ marginLeft: '4px', color: '#10b981', fontSize: '11px' }}>✓</span>
                )}
              </label>
            )}
            <button
              onClick={handleSubmit}
              disabled={isLoading || (conversationHistory.length === 0 && !questionType) || (conversationHistory.length > 0 && !userThinking.trim())}
              style={{
                padding: '10px 16px',
                background: (isLoading || (conversationHistory.length === 0 && !questionType) || (conversationHistory.length > 0 && !userThinking.trim()))
                  ? '#d1d5db' : 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
                color: 'white', border: 'none', borderRadius: '8px',
                fontSize: '14px', fontWeight: '600',
                cursor: (isLoading || (conversationHistory.length === 0 && !questionType) || (conversationHistory.length > 0 && !userThinking.trim()))
                  ? 'not-allowed' : 'pointer',
                whiteSpace: 'nowrap'
              }}
            >
              {isLoading ? '⏳' : '发送'}
            </button>
          </div>
        </div>

        {/* 加载AC代码确认框 */}
        {renderLoadCodeConfirmModal()}
      </div>
    );
  }

  return (
    <>
      {/* Markdown 样式 */}
      <style>{markdownStyles}</style>

      <div
        ref={panelRef}
        style={panelStyle}
        onClick={isCollapsed && !isMobile ? toggleCollapse : undefined}
      >
      {/* 标题栏 - 可拖拽 */}
      {isMobile || !isCollapsed ? (
        <div
          onMouseDown={handleDragStart}
          style={{
            padding: '12px 16px',
            borderBottom: isCollapsed ? 'none' : '1px solid #e5e7eb',
            background: '#6366f1',
            color: 'white',
            borderRadius: isMobile ? '0' : '12px 12px 0 0',
            fontWeight: '600',
            fontSize: '15px',
            cursor: isMobile ? 'default' : (isDragging ? 'grabbing' : 'grab'),
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            userSelect: 'none',
            height: isMobile ? '56px' : '48px',
            boxSizing: 'border-box'
          }}
        >
          <span>✨ AI 学习助手</span>
          <button
            onClick={toggleCollapse}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'white',
              fontSize: '18px',
              cursor: 'pointer',
              padding: '4px 8px',
              lineHeight: '1'
            }}
            title={isCollapsed ? '展开面板' : '折叠面板'}
          >
            {isCollapsed ? '▲' : '▼'}
          </button>
        </div>
      ) : (
        /* 桌面端折叠时显示圆形按钮 */
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '28px',
            userSelect: 'none',
            transition: 'transform 0.2s ease'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = 'scale(1.1)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'scale(1)';
          }}
          title="展开 AI 学习助手"
        >
          ✨
        </div>
      )}

      {/* 内容区 - 折叠时隐藏 */}
      {!isCollapsed && (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        background: '#ffffff',
        borderRadius: isMobile ? '0' : '0 0 12px 12px',
        overflow: 'hidden'
      }}>
        {/* 聊天消息区域 - 可滚动 */}
        <div
          ref={chatContainerRef}
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px'
          }}
        >
          {/* 题目信息卡片 - 始终显示在顶部 */}
          {problemInfo ? (
            <div style={{
              background: '#f5f3ff',
              border: '1px solid #e0ddff',
              padding: '10px 12px',
              borderRadius: '8px'
            }}>
              <div style={{
                fontSize: '12px',
                color: '#9333ea',
                marginBottom: '4px',
                fontWeight: '500'
              }}>
                题目 {problemInfo.problemId}
              </div>
              <div style={{
                fontWeight: '600',
                fontSize: '14px',
                color: '#5b21b6',
                lineHeight: '1.4',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical'
              }}>
                {problemInfo.title}
              </div>
            </div>
          ) : (
            <div style={{
              background: '#fef3c7',
              border: '1px solid #fbbf24',
              padding: '12px',
              borderRadius: '8px'
            }}>
              <div style={{ fontSize: '13px', color: '#92400e', marginBottom: '8px' }}>
                ⚠️ {problemInfoError}
              </div>
              <input
                type="text"
                value={manualTitle}
                onChange={(e) => setManualTitle(e.target.value)}
                placeholder="请输入题目标题(如: A+B Problem)"
                style={{
                  width: '100%',
                  padding: '8px',
                  border: '1px solid #fbbf24',
                  borderRadius: '6px',
                  fontSize: '13px',
                  boxSizing: 'border-box'
                }}
              />
            </div>
          )}

          {/* 对话历史消息 */}
          {conversationHistory.map((msg, idx) => (
            <div
              key={idx}
              data-ai-message={msg.role === 'ai' ? 'true' : undefined}
              onMouseUp={msg.role === 'ai' ? handleTextSelection : undefined}
              style={{
                background: msg.role === 'student' ? '#dbeafe' : '#f0fdf4',
                border: `1px solid ${msg.role === 'student' ? '#93c5fd' : '#86efac'}`,
                padding: '12px',
                borderRadius: '10px',
                position: 'relative'
              }}
            >
              <div style={{
                fontWeight: '600',
                fontSize: '13px',
                marginBottom: '6px',
                color: msg.role === 'student' ? '#1e40af' : '#15803d'
              }}>
                {msg.role === 'student' ? '💬 我' : '🤖 AI 导师'}
              </div>
              <div style={{
                fontSize: '13px',
                color: msg.role === 'student' ? '#1e3a8a' : '#166534'
              }}>
                {msg.role === 'ai' ? renderMarkdown(msg.content) : (
                  <div style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>
                )}
              </div>
              {msg.code && (
                <pre style={{
                  background: '#f1f5f9',
                  border: '1px solid #cbd5e1',
                  padding: '8px',
                  borderRadius: '6px',
                  marginTop: '8px',
                  fontSize: '11px',
                  overflow: 'auto',
                  maxHeight: '100px',
                  fontFamily: 'Consolas, Monaco, "Courier New", monospace'
                }}>
                  <code>{msg.code.length > 300 ? msg.code.substring(0, 300) + '...' : msg.code}</code>
                </pre>
              )}
            </div>
          ))}

          {/* 加载中提示 */}
          {isLoading && (
            <div style={{
              background: '#f0fdf4',
              border: '1px solid #86efac',
              padding: '12px',
              borderRadius: '10px',
              color: '#15803d',
              fontSize: '13px'
            }}>
              🤖 AI 导师正在思考...
            </div>
          )}

          {/* 选中文本弹窗 */}
          {popupPosition && (
            <div style={{
              position: 'fixed',
              top: popupPosition.y,
              left: popupPosition.x,
              transform: 'translateX(-50%)',
              zIndex: 2000
            }}>
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.stopPropagation();
                  handleDontUnderstand();
                }}
                style={{
                  background: '#dc2626',
                  color: 'white',
                  border: 'none',
                  borderRadius: '6px',
                  padding: '8px 14px',
                  fontSize: '13px',
                  fontWeight: '500',
                  cursor: 'pointer',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
                  whiteSpace: 'nowrap'
                }}
              >
                ❓ 我不理解
              </button>
            </div>
          )}
        </div>

        {/* 输入区域 - 固定在底部 */}
        <div style={{
          borderTop: '1px solid #e5e7eb',
          padding: '12px 16px 40px 16px',  // 底部留出空间避免被 resize 把手覆盖
          background: '#fafafa'
        }}>
          {/* 错误提示 */}
          {error && (
            <div style={{
              padding: '8px 12px',
              background: '#fee2e2',
              color: '#dc2626',
              borderRadius: '6px',
              marginBottom: '10px',
              fontSize: '12px',
              border: '1px solid #fecaca'
            }}>
              ⚠️ {error}
            </div>
          )}

          {/* 首次提问：显示问题类型选择 */}
          {conversationHistory.length === 0 && (
            <div style={{ marginBottom: '10px' }}>
              <div style={{
                fontSize: '12px',
                color: '#6b7280',
                marginBottom: '6px'
              }}>
                选择问题类型：
              </div>
              <div style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '6px'
              }}>
                {QUESTION_TYPES.map(type => {
                  const isSelected = questionType === type.value;
                  return (
                    <label
                      key={type.value}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        padding: '6px 10px',
                        borderRadius: '999px',
                        border: `1.5px solid ${isSelected ? '#7c3aed' : '#d1d5db'}`,
                        background: isSelected ? '#ede9fe' : '#ffffff',
                        color: isSelected ? '#5b21b6' : '#4b5563',
                        fontSize: '12px',
                        fontWeight: isSelected ? '600' : '500',
                        cursor: 'pointer',
                        transition: 'all 0.2s ease',
                        userSelect: 'none'
                      }}
                    >
                      <input
                        type="radio"
                        name="questionType"
                        value={type.value}
                        checked={isSelected}
                        onChange={(e) => handleQuestionTypeChange(e.target.value)}
                        style={{ display: 'none' }}
                      />
                      {type.label.split(' - ')[0]}
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {/* 追问时：显示刷新代码按钮 */}
          {conversationHistory.length > 0 && (
            <div style={{
              display: 'flex',
              gap: '8px',
              marginBottom: '10px'
            }}>
              <button
                type="button"
                onClick={refreshCodeFromScratchpad}
                style={{
                  padding: '6px 12px',
                  background: '#f3f4f6',
                  color: '#374151',
                  border: '1px solid #d1d5db',
                  borderRadius: '6px',
                  fontSize: '12px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px'
                }}
              >
                📎 {includeCode ? '已附带代码' : '附带代码'}
              </button>
              <button
                type="button"
                onClick={startNewConversation}
                style={{
                  padding: '6px 12px',
                  background: '#f3f4f6',
                  color: '#6b7280',
                  border: '1px solid #d1d5db',
                  borderRadius: '6px',
                  fontSize: '12px',
                  cursor: 'pointer'
                }}
              >
                🔄 新对话
              </button>
            </div>
          )}

          {/* 代码预览（追问时附带代码） */}
          {conversationHistory.length > 0 && includeCode && code && (
            <div style={{
              background: '#f9fafb',
              border: '1px solid #e5e7eb',
              borderRadius: '6px',
              padding: '8px',
              marginBottom: '10px',
              fontSize: '11px'
            }}>
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '4px'
              }}>
                <span style={{ color: '#6b7280' }}>📝 已附带代码 ({code.length} 字符)</span>
                <button
                  type="button"
                  onClick={() => { setCode(''); setIncludeCode(false); }}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#ef4444',
                    cursor: 'pointer',
                    fontSize: '11px',
                    padding: '2px 4px'
                  }}
                >
                  ✕ 移除
                </button>
              </div>
              <pre style={{
                margin: 0,
                fontFamily: 'Consolas, Monaco, "Courier New", monospace',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                color: '#374151',
                maxHeight: '60px',
                overflow: 'auto'
              }}>
                {code.length > 200 ? code.substring(0, 200) + '...' : code}
              </pre>
            </div>
          )}

          {/* 输入框和发送按钮 */}
          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
            <textarea
              value={userThinking}
              onChange={(e) => setUserThinking(e.target.value)}
              placeholder={conversationHistory.length === 0
                ? "描述你的问题或疑惑..."
                : "继续追问..."}
              style={{
                flex: 1,
                minHeight: conversationHistory.length === 0 ? '80px' : '40px',
                maxHeight: '120px',
                padding: '10px 12px',
                border: '1px solid #d4d4d8',
                borderRadius: '8px',
                fontSize: '13px',
                lineHeight: '1.5',
                resize: 'none',
                boxSizing: 'border-box',
                fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                outline: 'none'
              }}
              onFocus={(e) => {
                e.target.style.borderColor = '#6366f1';
              }}
              onBlur={(e) => {
                e.target.style.borderColor = '#d4d4d8';
              }}
              onKeyDown={(e) => {
                // Ctrl+Enter 或 Cmd+Enter 发送
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
            />
            {/* 首次提问：附带代码选项 - 与输入框同行 */}
            {conversationHistory.length === 0 && (
              <label style={{
                display: 'flex',
                alignItems: 'center',
                cursor: questionType === 'optimize' ? 'not-allowed' : 'pointer',
                fontSize: '12px',
                color: questionType === 'optimize' ? '#9ca3af' : '#6b7280',
                whiteSpace: 'nowrap',
                alignSelf: 'center'
              }}
              title={questionType === 'optimize' ? '代码优化必须附带代码' : undefined}
              >
                <input
                  type="checkbox"
                  checked={includeCode}
                  disabled={questionType === 'optimize'}
                  onChange={(e) => {
                    setIncludeCode(e.target.checked);
                    if (e.target.checked && !code) {
                      const scratchpadCode = readFromScratchpad();
                      if (scratchpadCode) setCode(scratchpadCode);
                    }
                  }}
                  style={{
                    marginRight: '6px',
                    accentColor: '#7c3aed'
                  }}
                />
                📎 附带当前代码
                {questionType === 'optimize' && (
                  <span style={{ marginLeft: '4px', color: '#f59e0b', fontSize: '11px' }}>
                    (必需)
                  </span>
                )}
                {includeCode && code && questionType !== 'optimize' && (
                  <span style={{ marginLeft: '4px', color: '#10b981', fontSize: '11px' }}>
                    ✓
                  </span>
                )}
              </label>
            )}
            <button
              onClick={handleSubmit}
              disabled={
                isLoading ||
                (conversationHistory.length === 0 && !questionType) ||
                (conversationHistory.length > 0 && !userThinking.trim())
              }
              style={{
                padding: '10px 16px',
                background: (
                  isLoading ||
                  (conversationHistory.length === 0 && !questionType) ||
                  (conversationHistory.length > 0 && !userThinking.trim())
                ) ? '#d1d5db' : 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                fontSize: '14px',
                fontWeight: '600',
                cursor: (
                  isLoading ||
                  (conversationHistory.length === 0 && !questionType) ||
                  (conversationHistory.length > 0 && !userThinking.trim())
                ) ? 'not-allowed' : 'pointer',
                whiteSpace: 'nowrap'
              }}
            >
              {isLoading ? '⏳' : '发送'}
            </button>
          </div>
        </div>
      </div>
      )}

      {/* 拖拽宽度调整把手 - 左侧边缘 */}
      {!isMobile && !isCollapsed && (
        <div
          onMouseDown={(e) => handleResizeStart(e, 'width')}
          style={{
            position: 'absolute',
            top: '48px',
            left: '0',
            bottom: '32px',
            width: '8px',
            cursor: 'ew-resize',
            background: 'transparent',
            transition: 'background 0.2s ease',
            borderRadius: '12px 0 0 0'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(99, 102, 241, 0.1)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
          }}
          title="拖拽调整面板宽度"
        >
          {/* 竖线作为拖拽图标 */}
          <div style={{
            position: 'absolute',
            top: '50%',
            left: '2px',
            transform: 'translateY(-50%)',
            width: '3px',
            height: '40px',
            borderRadius: '2px',
            background: '#d1d5db',
            pointerEvents: 'none'
          }} />
        </div>
      )}

      {/* 拖拽高度调整把手 - 仅桌面端且未折叠时显示 */}
      {!isMobile && !isCollapsed && (
        <div
          onMouseDown={(e) => handleResizeStart(e, 'height')}
          style={{
            position: 'absolute',
            bottom: '0',
            left: '0',
            right: '0',
            height: '32px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'ns-resize',
            background: 'transparent',
            transition: 'background 0.2s ease',
            borderRadius: '0 0 12px 12px'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(99, 102, 241, 0.05)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
          }}
          title="拖拽调整面板高度"
        >
          {/* 三条横线作为拖拽图标 */}
          <div style={{
            width: '40px',
            height: '4px',
            borderRadius: '2px',
            background: '#d1d5db',
            position: 'relative',
            pointerEvents: 'none'
          }}>
            <div style={{
              position: 'absolute',
              top: '-6px',
              left: '0',
              right: '0',
              height: '3px',
              borderRadius: '2px',
              background: '#d1d5db'
            }} />
            <div style={{
              position: 'absolute',
              top: '6px',
              left: '0',
              right: '0',
              height: '3px',
              borderRadius: '2px',
              background: '#d1d5db'
            }} />
          </div>
        </div>
      )}

      {/* 加载AC代码确认框 */}
      {renderLoadCodeConfirmModal()}
    </div>
    </>
  );
};
