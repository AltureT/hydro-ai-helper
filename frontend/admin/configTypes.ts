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

export type AIScenarioKey = 'studentChat' | 'learningSummary' | 'teachingAnalysis' | 'testdataGeneration';

export const AI_SCENARIO_KEYS: readonly AIScenarioKey[] = ['studentChat', 'learningSummary', 'teachingAnalysis', 'testdataGeneration'] as const;

/** 每个场景的专属模型链；空数组 = 跟随全局 selectedModels */
export type ScenarioModelsState = Record<AIScenarioKey, SelectedModel[]>;

export interface BudgetConfigState {
  dailyTokenLimitPerUser: number | '';
  dailyTokenLimitPerDomain: number | '';
  monthlyTokenLimitPerDomain: number | '';
  softLimitPercent: number | '';
}

export interface ConfigState {
  endpoints: Endpoint[];
  selectedModels: SelectedModel[];
  scenarioModels: ScenarioModelsState;
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
  domainId?: string;
  userId?: number;
  problemId?: string;
  conversationId?: string;
  questionType?: string;
  matchedPattern: string;
  matchedText: string;
  category?: 'answer_seeking' | 'prompt_injection' | 'prompt_exfiltration' | 'obfuscated_injection';
  confidence?: 'medium' | 'high';
  riskScore?: number;
  detectionSource?: 'plain' | 'compacted' | 'base64' | 'hex' | 'custom';
  actionTaken?: 'blocked' | 'cooldown_60s' | 'cooldown_5m';
  blockedUntil?: string;
  reviewStatus?: 'pending' | 'confirmed' | 'false_positive';
  reviewedAt?: string;
  reviewedBy?: number;
  createdAt: string;
}

export interface JailbreakLogPagination {
  logs: JailbreakLogEntry[];
  total: number;
  page: number;
  totalPages: number;
}

export interface TelemetryStatus {
  enabled: boolean;
  instanceId: string;
  lastReportAt?: string;
  version: string;
}

export interface FeedbackPayload {
  type: 'bug' | 'feature' | 'other';
  subject: string;
  body: string;
  contactEmail?: string;
}

export interface APIConfigResponse {
  config: {
    endpoints?: Array<Omit<Endpoint, 'newApiKey' | 'isNew'> & { apiKeyMasked?: string; hasApiKey?: boolean }>;
    selectedModels?: SelectedModel[];
    scenarioModels?: Partial<Record<AIScenarioKey, SelectedModel[]>>;
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
  telemetry?: TelemetryStatus | null;
  builtinJailbreakPatterns?: string[];
  jailbreakLogs?: JailbreakLogPagination;
  recentJailbreakLogs?: JailbreakLogEntry[];
}
