declare global {
  interface Window {
    editor?: {
      getValue: (options?: { lineEnding?: string; preserveBOM?: boolean }) => string;
    };
    monaco?: unknown;
    store?: {
      subscribe: (listener: () => void) => () => void;
      getState: () => Record<string, any>;
      dispatch?: (action: { type: string; payload?: unknown }) => void;
    };
  }
}

export const BASE_QUESTION_TYPES = [
  { value: 'understand', label: 'ai_helper_student_qt_understand', description: 'ai_helper_student_qtd_understand' },
  { value: 'think', label: 'ai_helper_student_qt_think', description: 'ai_helper_student_qtd_think' },
  { value: 'debug', label: 'ai_helper_student_qt_debug', description: 'ai_helper_student_qtd_debug' },
];

export interface ProblemInfo {
  title: string;
  problemId: string;
  content: string;
}

export interface ChatApiErrorPayload {
  error?: string;
  code?: string;
  category?: string;
  retryable?: boolean;
}

export interface Message {
  role: 'student' | 'ai';
  content: string;
  timestamp: Date;
  code?: string;
  id?: string;
}

export interface ChatState {
  questionType: string;
  userThinking: string;
  code: string;
  includeCode: boolean;
  conversationId: string | null;
  conversationHistory: Message[];
  streamingContent: string;
  isStreaming: boolean;
  isLoading: boolean;
  error: string;
  errorCategory: string;
  errorRetryable: boolean;
  scratchpadAvailable: boolean;
  hasAccepted: boolean;
  acCode: string | null;
  showLoadCodeConfirm: boolean;
  problemInfo: ProblemInfo | null;
  problemInfoError: string;
  manualTitle: string;
  isContestRestricted: boolean;
}

export type ChatAction =
  | { type: 'SET_QUESTION_TYPE'; payload: string }
  | { type: 'SET_USER_THINKING'; payload: string }
  | { type: 'SET_CODE'; payload: string }
  | { type: 'SET_INCLUDE_CODE'; payload: boolean }
  | { type: 'SET_CONVERSATION_ID'; payload: string | null }
  | { type: 'ADD_MESSAGE'; payload: Message }
  | { type: 'REMOVE_LAST_MESSAGE' }
  | { type: 'SET_CONVERSATION_HISTORY'; payload: Message[] }
  | { type: 'SET_STREAMING_CONTENT'; payload: string }
  | { type: 'SET_IS_STREAMING'; payload: boolean }
  | { type: 'SET_IS_LOADING'; payload: boolean }
  | { type: 'SET_ERROR'; payload: { error: string; category?: string; retryable?: boolean } }
  | { type: 'CLEAR_ERROR' }
  | { type: 'SET_SCRATCHPAD_AVAILABLE'; payload: boolean }
  | { type: 'SET_HAS_ACCEPTED'; payload: boolean }
  | { type: 'SET_AC_CODE'; payload: string | null }
  | { type: 'SET_SHOW_LOAD_CODE_CONFIRM'; payload: boolean }
  | { type: 'SET_PROBLEM_INFO'; payload: ProblemInfo | null }
  | { type: 'SET_PROBLEM_INFO_ERROR'; payload: string }
  | { type: 'SET_MANUAL_TITLE'; payload: string }
  | { type: 'SET_CONTEST_RESTRICTED'; payload: boolean }
  | { type: 'START_NEW_CONVERSATION' }
  | { type: 'SUBMIT_START'; payload: { userThinking: string } }
  | { type: 'SUBMIT_FINISH_STREAM' };

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'SET_QUESTION_TYPE': return { ...state, questionType: action.payload };
    case 'SET_USER_THINKING': return { ...state, userThinking: action.payload };
    case 'SET_CODE': return { ...state, code: action.payload };
    case 'SET_INCLUDE_CODE': return { ...state, includeCode: action.payload };
    case 'SET_CONVERSATION_ID': return { ...state, conversationId: action.payload };
    case 'ADD_MESSAGE': return { ...state, conversationHistory: [...state.conversationHistory, action.payload] };
    case 'REMOVE_LAST_MESSAGE': return { ...state, conversationHistory: state.conversationHistory.slice(0, -1) };
    case 'SET_CONVERSATION_HISTORY': return { ...state, conversationHistory: action.payload };
    case 'SET_STREAMING_CONTENT': return { ...state, streamingContent: action.payload };
    case 'SET_IS_STREAMING': return { ...state, isStreaming: action.payload };
    case 'SET_IS_LOADING': return { ...state, isLoading: action.payload };
    case 'SET_ERROR': return { ...state, error: action.payload.error, errorCategory: action.payload.category || '', errorRetryable: action.payload.retryable ?? false };
    case 'CLEAR_ERROR': return { ...state, error: '', errorCategory: '', errorRetryable: false };
    case 'SET_SCRATCHPAD_AVAILABLE': return { ...state, scratchpadAvailable: action.payload };
    case 'SET_HAS_ACCEPTED': return { ...state, hasAccepted: action.payload };
    case 'SET_AC_CODE': return { ...state, acCode: action.payload };
    case 'SET_SHOW_LOAD_CODE_CONFIRM': return { ...state, showLoadCodeConfirm: action.payload };
    case 'SET_PROBLEM_INFO': return { ...state, problemInfo: action.payload, problemInfoError: '' };
    case 'SET_PROBLEM_INFO_ERROR': return { ...state, problemInfoError: action.payload };
    case 'SET_MANUAL_TITLE': return { ...state, manualTitle: action.payload };
    case 'SET_CONTEST_RESTRICTED': return { ...state, isContestRestricted: action.payload };
    case 'START_NEW_CONVERSATION':
      return {
        ...state,
        questionType: '', userThinking: '', code: '', includeCode: false,
        conversationId: null, conversationHistory: [],
        streamingContent: '', isStreaming: false, isLoading: false,
        error: '', errorCategory: '', errorRetryable: false,
      };
    case 'SUBMIT_START':
      return { ...state, userThinking: '', error: '', errorCategory: '', errorRetryable: false, isLoading: true };
    case 'SUBMIT_FINISH_STREAM':
      return { ...state, isLoading: false, isStreaming: false, streamingContent: '' };
    default: return state;
  }
}

export const initialChatState: ChatState = {
  questionType: '',
  userThinking: '',
  code: '',
  includeCode: false,
  conversationId: null,
  conversationHistory: [],
  streamingContent: '',
  isStreaming: false,
  isLoading: false,
  error: '',
  errorCategory: '',
  errorRetryable: false,
  scratchpadAvailable: false,
  hasAccepted: false,
  acCode: null,
  showLoadCodeConfirm: false,
  problemInfo: null,
  problemInfoError: '',
  manualTitle: '',
  isContestRestricted: false,
};
