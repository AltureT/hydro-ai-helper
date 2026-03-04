export interface Endpoint {
  id?: string;
  name: string;
  apiBaseUrl: string;
  apiKeyMasked?: string;
  hasApiKey?: boolean;
  newApiKey?: string;
  models: string[];
  modelsLastFetched?: string;
  enabled: boolean;
  isNew?: boolean;
}

export interface SelectedModel {
  endpointId: string;
  modelName: string;
}

export interface BudgetConfigState {
  dailyTokenLimitPerUser: number | '';
  dailyTokenLimitPerDomain: number | '';
  monthlyTokenLimitPerDomain: number | '';
  softLimitPercent: number | '';
}

export interface ConfigState {
  endpoints: Endpoint[];
  selectedModels: SelectedModel[];
  apiBaseUrl: string;
  modelName: string;
  rateLimitPerMinute: number | '';
  timeoutSeconds: number | '';
  systemPromptTemplate: string;
  extraJailbreakPatternsText: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
  budgetConfig: BudgetConfigState;
}

export interface JailbreakLogEntry {
  id: string;
  userId?: number;
  problemId?: string;
  conversationId?: string;
  questionType?: string;
  matchedPattern: string;
  matchedText: string;
  createdAt: string;
}

export interface JailbreakLogPagination {
  logs: JailbreakLogEntry[];
  total: number;
  page: number;
  totalPages: number;
}

export interface APIConfigResponse {
  config: {
    endpoints?: Array<Omit<Endpoint, 'newApiKey' | 'isNew'> & { apiKeyMasked?: string; hasApiKey?: boolean }>;
    selectedModels?: SelectedModel[];
    apiBaseUrl?: string;
    modelName?: string;
    rateLimitPerMinute?: number;
    timeoutSeconds?: number;
    systemPromptTemplate?: string;
    extraJailbreakPatternsText?: string;
    budgetConfig?: {
      dailyTokenLimitPerUser?: number;
      dailyTokenLimitPerDomain?: number;
      monthlyTokenLimitPerDomain?: number;
      softLimitPercent?: number;
    };
    apiKeyMasked?: string;
    hasApiKey?: boolean;
  } | null;
  builtinJailbreakPatterns?: string[];
  jailbreakLogs?: JailbreakLogPagination;
  recentJailbreakLogs?: JailbreakLogEntry[];
}
