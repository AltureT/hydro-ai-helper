import { useReducer, useRef, useCallback, useEffect, useMemo } from 'react';
import { buildApiUrl } from '../../utils/domainUtils';
import {
  clearConversationId as clearStoredConversationId,
  loadConversationId,
  saveConversationId,
  shouldResetConversation,
} from '../../utils/conversationStorage';
import { consumeSSEStream, type SSEHandlers } from '../../utils/sseParser';
import {
  type ChatState,
  type ChatAction,
  chatReducer,
  initialChatState,
  type Message,
  BASE_QUESTION_TYPES,
  type ChatApiErrorPayload,
  type ProblemInfo,
} from '../types';

interface UseChatSessionOptions {
  problemId: string;
}

export function useChatSession({ problemId }: UseChatSessionOptions) {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const {
    questionType,
    userThinking,
    code,
    includeCode,
    conversationId,
    conversationHistory,
    isStreaming,
    isLoading,
    hasAccepted,
    acCode,
  } = state;

  const chatContainerRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const streamingContentRef = useRef<string>('');
  const rafRef = useRef<number | null>(null);

  const QUESTION_TYPES = useMemo(() => {
    const types = [...BASE_QUESTION_TYPES];
    if (hasAccepted) {
      types.push({ value: 'optimize', label: '代码优化 - 代码能运行,但想让它更高效' });
    }
    return types;
  }, [hasAccepted]);

  const scrollToBottom = () => {
    setTimeout(() => {
      if (chatContainerRef.current) {
        chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
      }
    }, 100);
  };

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

  const writeToScratchpad = (codeToWrite: string): boolean => {
    try {
      const editor = (window as any).editor;
      if (editor?.setValue) {
        editor.setValue(codeToWrite);
        return true;
      }

      const store = window.store;
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

  const refreshCodeFromScratchpad = () => {
    const scratchpadCode = readFromScratchpad();
    if (scratchpadCode !== null) {
      dispatch({ type: 'SET_CODE', payload: scratchpadCode });
      dispatch({ type: 'SET_INCLUDE_CODE', payload: true });
    }
  };

  const handleQuestionTypeChange = (newType: string) => {
    dispatch({ type: 'SET_QUESTION_TYPE', payload: newType });
    if (newType === 'optimize' && acCode) {
      dispatch({ type: 'SET_SHOW_LOAD_CODE_CONFIRM', payload: true });
    }
    if (newType === 'debug' && !includeCode) {
      dispatch({ type: 'SET_INCLUDE_CODE', payload: true });
      if (!code) {
        const scratchpadCode = readFromScratchpad();
        if (scratchpadCode) {
          dispatch({ type: 'SET_CODE', payload: scratchpadCode });
          dispatch({ type: 'SET_SCRATCHPAD_AVAILABLE', payload: true });
        }
      }
    }
  };

  const fetchSubmissionStatus = useCallback(async () => {
    if (!problemId) return;
    try {
      const response = await fetch(buildApiUrl(`/ai-helper/problem-status/${problemId}`), {
        credentials: 'include',
      });
      if (response.ok) {
        const data = await response.json();
        dispatch({ type: 'SET_HAS_ACCEPTED', payload: data.hasAccepted });
        if (data.acCode) {
          dispatch({ type: 'SET_AC_CODE', payload: data.acCode });
        }
      }
    } catch (error) {
      console.error('Failed to fetch submission status:', error);
    }
  }, [problemId]);

  const handleSubmit = async (clarifyContext?: { sourceAiMessageId: string; selectedText: string }) => {
    const effectiveQuestionType = questionType || (conversationHistory.length > 0 ? 'think' : '');
    if (!effectiveQuestionType) {
      dispatch({ type: 'SET_ERROR', payload: { error: '请选择问题类型' } });
      return;
    }

    if (conversationHistory.length > 0 && !userThinking.trim()) {
      dispatch({ type: 'SET_ERROR', payload: { error: '请输入追问内容' } });
      return;
    }

    if (includeCode && !code.trim()) {
      dispatch({ type: 'SET_ERROR', payload: { error: '请粘贴代码或关闭「附带代码」选项' } });
      return;
    }

    const getQuestionTypeLabel = (type: string) => {
      const found = QUESTION_TYPES.find(t => t.value === type);
      return found ? found.label.split(' - ')[0] : type;
    };
    const messageContent = userThinking.trim()
      ? userThinking
      : (conversationHistory.length === 0
        ? `【${getQuestionTypeLabel(effectiveQuestionType)}】请帮我分析这道题`
        : '（继续追问）');
    const studentMessage: Message = {
      role: 'student',
      content: messageContent,
      timestamp: new Date(),
      code: includeCode ? code : undefined,
    };
    dispatch({ type: 'ADD_MESSAGE', payload: studentMessage });
    scrollToBottom();

    dispatch({ type: 'CLEAR_ERROR' });

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      dispatch({ type: 'SET_ERROR', payload: { error: '网络已断开，请检查网络连接后重试', category: 'network', retryable: true } });
      return;
    }

    dispatch({ type: 'SET_IS_LOADING', payload: true });

    const savedUserThinking = userThinking;
    const savedCode = includeCode ? code : undefined;
    dispatch({ type: 'SET_USER_THINKING', payload: '' });

    const ac = new AbortController();
    abortControllerRef.current = ac;
    let clientTimedOut = false;
    // 前端超时作为最终兜底（10分钟），实际超时由后端控制
    const clientTimeout = setTimeout(() => { clientTimedOut = true; ac.abort(); }, 600_000);

    try {
      const finalProblemTitle = state.problemInfo?.title || state.manualTitle || undefined;
      const finalProblemContent = state.problemInfo?.content || undefined;

      const currentTid = new URLSearchParams(window.location.search).get('tid') || undefined;
      const supportsStream = typeof ReadableStream !== 'undefined';

      const sendChatRequest = (activeConversationId: string | null) =>
        fetch(buildApiUrl('/ai-helper/chat'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            ...(supportsStream ? { 'Accept': 'text/event-stream, application/json' } : {}),
          },
          credentials: 'include',
          signal: ac.signal,
          body: JSON.stringify({
            problemId,
            problemTitle: finalProblemTitle,
            problemContent: finalProblemContent,
            questionType: effectiveQuestionType,
            userThinking: savedUserThinking,
            includeCode,
            code: savedCode,
            conversationId: activeConversationId || undefined,
            contestId: currentTid,
            stream: supportsStream ? true : undefined,
            ...(effectiveQuestionType === 'clarify' && clarifyContext?.sourceAiMessageId ? { clarifyContext } : {}),
          }),
        });

      const parseErrorPayload = async (response: Response): Promise<ChatApiErrorPayload> => {
        try {
          return await response.json() as ChatApiErrorPayload;
        } catch {
          return {};
        }
      };

      const createCategorizedError = (msg: string, category?: string, retryable?: boolean): Error => {
        const e = new Error(msg) as Error & { _category?: string; _retryable?: boolean };
        if (category) e._category = category;
        if (retryable !== undefined) e._retryable = retryable;
        return e;
      };

      let response = await sendChatRequest(conversationId);
      if (!response.ok) {
        let errorData = await parseErrorPayload(response);

        if (response.status === 403 && errorData.code === 'CONTEST_MODE_RESTRICTED') {
          dispatch({ type: 'SET_CONTEST_RESTRICTED', payload: true });
          throw new Error(errorData.error || '比赛期间 AI 助手不可用，请独立完成作答');
        }

        if (conversationId && shouldResetConversation(response.status, errorData.error, errorData.code)) {
          clearStoredConversationId(problemId);
          dispatch({ type: 'SET_CONVERSATION_ID', payload: null });
          response = await sendChatRequest(null);
          if (!response.ok) {
            errorData = await parseErrorPayload(response);
            throw createCategorizedError(errorData.error || '请求失败', errorData.category, errorData.retryable);
          }
        } else {
          throw createCategorizedError(errorData.error || '请求失败', errorData.category, errorData.retryable);
        }
      }

      const contentType = response.headers.get('content-type') || '';
      const isSSE = contentType.includes('text/event-stream');

      if (isSSE && response.body) {
        dispatch({ type: 'SET_IS_STREAMING', payload: true });
        streamingContentRef.current = '';
        dispatch({ type: 'SET_STREAMING_CONTENT', payload: '' });

        const reader = response.body.getReader();
        const handlers: SSEHandlers = {
          onMeta: (data) => {
            if (data.conversationId) {
              dispatch({ type: 'SET_CONVERSATION_ID', payload: data.conversationId });
              saveConversationId(problemId, data.conversationId);
            }
          },
          onChunk: (data) => {
            streamingContentRef.current += data.content;
            if (rafRef.current === null) {
              rafRef.current = requestAnimationFrame(() => {
                dispatch({ type: 'SET_STREAMING_CONTENT', payload: streamingContentRef.current });
                scrollToBottom();
                rafRef.current = null;
              });
            }
          },
          onReplace: (data) => {
            streamingContentRef.current = data.content;
            dispatch({ type: 'SET_STREAMING_CONTENT', payload: data.content });
          },
          onDone: (data) => {
            const finalContent = streamingContentRef.current;
            const aiMessage: Message = {
              role: 'ai',
              content: finalContent,
              timestamp: new Date(),
              id: data.messageId,
            };
            dispatch({ type: 'ADD_MESSAGE', payload: aiMessage });
            dispatch({ type: 'SET_STREAMING_CONTENT', payload: '' });
            streamingContentRef.current = '';
            dispatch({ type: 'SET_IS_STREAMING', payload: false });
            scrollToBottom();
          },
          onError: (data) => {
            dispatch({ type: 'SET_IS_STREAMING', payload: false });
            dispatch({ type: 'SET_STREAMING_CONTENT', payload: '' });
            streamingContentRef.current = '';
            throw createCategorizedError(data.error || 'AI 服务异常', data.category, data.retryable);
          },
        };

        await consumeSSEStream(reader, handlers, ac.signal);

        if (streamingContentRef.current) {
          const finalContent = streamingContentRef.current;
          const aiMessage: Message = {
            role: 'ai',
            content: finalContent,
            timestamp: new Date(),
          };
          dispatch({ type: 'ADD_MESSAGE', payload: aiMessage });
          dispatch({ type: 'SET_STREAMING_CONTENT', payload: '' });
          streamingContentRef.current = '';
          dispatch({ type: 'SET_IS_STREAMING', payload: false });
        }
      } else {
        let data: any;
        try {
          data = await response.json();
        } catch {
          throw createCategorizedError('服务器返回格式异常，请稍后重试', 'server', true);
        }
        if (!data?.message?.content) {
          throw createCategorizedError('AI 返回内容为空，请重试', 'server', true);
        }

        const aiMessage: Message = {
          role: 'ai',
          content: data.message.content,
          timestamp: new Date(),
          id: data.message.id,
        };
        dispatch({ type: 'ADD_MESSAGE', payload: aiMessage });
        scrollToBottom();

        if (data.conversationId) {
          dispatch({ type: 'SET_CONVERSATION_ID', payload: data.conversationId });
          saveConversationId(problemId, data.conversationId);
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        if (clientTimedOut) {
          dispatch({ type: 'SET_ERROR', payload: { error: 'AI 服务响应超时，请稍后再试', category: 'timeout', retryable: true } });
        } else {
          dispatch({ type: 'SET_ERROR', payload: { error: '请求已取消', category: 'aborted', retryable: false } });
        }
      } else {
        const errObj = err as Error & { _category?: string; _retryable?: boolean };
        dispatch({ type: 'SET_ERROR', payload: { error: errObj.message || '未知错误', category: errObj._category, retryable: errObj._retryable } });
      }
      console.error('[AI Helper] 提交失败:', err);
      dispatch({ type: 'SET_USER_THINKING', payload: savedUserThinking });
      dispatch({ type: 'REMOVE_LAST_MESSAGE' });
    } finally {
      clearTimeout(clientTimeout);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      abortControllerRef.current = null;
      dispatch({ type: 'SET_IS_LOADING', payload: false });
      dispatch({ type: 'SET_IS_STREAMING', payload: false });
    }
  };

  const handleSubmitRef = useRef(handleSubmit);
  handleSubmitRef.current = handleSubmit;

  const startNewConversation = () => {
    abortControllerRef.current?.abort();
    dispatch({ type: 'START_NEW_CONVERSATION' });
    clearStoredConversationId(problemId);
  };

  // Restore conversationId from localStorage on problemId change, clear history
  useEffect(() => {
    if (problemId) {
      const savedId = loadConversationId(problemId);
      dispatch({ type: 'SET_CONVERSATION_ID', payload: savedId });
      dispatch({ type: 'SET_CONVERSATION_HISTORY', payload: [] });
    }
  }, [problemId]);

  // Fetch submission status on mount
  useEffect(() => {
    fetchSubmissionStatus();
  }, [fetchSubmissionStatus]);

  // Redux store subscribe: watch for AC status changes (STATUS_ACCEPTED=1)
  useEffect(() => {
    const STATUS_ACCEPTED = 1;
    const store = window.store;
    if (!store || hasAccepted) return;

    let lastRecordsRef: any = null;
    let lastCheckedRecordId = '';
    let lastCheckedStatus: number | undefined;

    const unsubscribe = store.subscribe(() => {
      const storeState = store.getState();
      const { rows = [], items = {} } = storeState?.records || {};

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
  }, [hasAccepted, fetchSubmissionStatus]);

  // Auto-read scratchpad when includeCode toggled on and no code
  useEffect(() => {
    if (includeCode && !code) {
      const scratchpadCode = readFromScratchpad();
      if (scratchpadCode !== null) {
        dispatch({ type: 'SET_CODE', payload: scratchpadCode });
        dispatch({ type: 'SET_SCRATCHPAD_AVAILABLE', payload: true });
      }
    }
  }, [includeCode]);

  // Read problem info from DOM
  useEffect(() => {
    try {
      const titleElement = document.querySelector('.section__title');
      const title = titleElement?.textContent?.trim() || '';

      const match = window.location.pathname.match(/\/p\/([A-Z0-9]+)/i);
      const problemIdFromUrl = match ? match[1] : problemId;

      const descElement = document.querySelector('.section__body.typo[data-fragment-id="problem-description"]');
      const fullText = descElement?.textContent?.trim() || '';
      const content = fullText.substring(0, 500) + (fullText.length > 500 ? '...' : '');

      if (title && content) {
        dispatch({
          type: 'SET_PROBLEM_INFO',
          payload: { title, problemId: problemIdFromUrl, content },
        });
      } else {
        dispatch({ type: 'SET_PROBLEM_INFO_ERROR', payload: '无法自动读取题目信息,请手动输入题目标题' });
      }
    } catch (err) {
      console.error('[AI Helper] 读取题目信息失败:', err);
      dispatch({ type: 'SET_PROBLEM_INFO_ERROR', payload: '读取题目信息失败,请手动输入' });
    }
  }, [problemId]);

  // Cleanup abort controller on unmount
  useEffect(() => () => { abortControllerRef.current?.abort(); }, []);

  const cancelRequest = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  return {
    state,
    dispatch,
    QUESTION_TYPES,
    chatContainerRef,
    handleSubmit,
    startNewConversation,
    handleQuestionTypeChange,
    readFromScratchpad,
    writeToScratchpad,
    refreshCodeFromScratchpad,
    scrollToBottom,
    handleSubmitRef,
    cancelRequest,
  };
}
