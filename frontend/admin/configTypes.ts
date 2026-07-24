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
  apiKeyMasked: string;
  hasApiKey: boolean;
  budgetConfig: BudgetConfigState;
}

export type JailbreakCategory =
  | 'answer_seeking'
  | 'prompt_injection'
  | 'prompt_exfiltration'
  | 'obfuscated_injection';

export type JailbreakReviewStatus = 'pending' | 'confirmed' | 'false_positive';

export interface JailbreakLogFilters {
  reviewStatus?: JailbreakReviewStatus;
  category?: JailbreakCategory;
  appealedOnly?: boolean;
  userId?: string;
  problemId?: string;
  actionTaken?: 'blocked' | 'cooldown_60s' | 'cooldown_5m';
  detectionSource?: 'plain' | 'compacted' | 'base64' | 'hex' | 'conversation' | 'custom';
  dateFrom?: string;
  dateTo?: string;
}

export interface JailbreakReviewSummary {
  total: number;
  pending: number;
  confirmed: number;
  falsePositive: number;
  reviewed: number;
  falsePositiveRate: number;
  appealedPending: number;
}

export interface JailbreakRuleMetric {
  matchedPattern: string;
  category?: JailbreakCategory;
  total: number;
  pending: number;
  confirmed: number;
  falsePositive: number;
  reviewed: number;
  falsePositiveRate: number;
}

export interface JailbreakOperationalMetrics {
  windowDays: number;
  total: number;
  cooldown: number;
  appealed: number;
  pendingAppeals: number;
  reviewed: number;
  averageReviewMinutes: number | null;
  averageAppealReviewMinutes: number | null;
  dailyTrend: Array<{
    date: string;
    total: number;
    cooldown: number;
    appealed: number;
    falsePositive: number;
  }>;
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
  category?: JailbreakCategory;
  confidence?: 'medium' | 'high';
  riskScore?: number;
  detectionSource?: 'plain' | 'compacted' | 'base64' | 'hex' | 'conversation' | 'custom';
  actionTaken?: 'blocked' | 'cooldown_60s' | 'cooldown_5m';
  blockedUntil?: string;
  reviewStatus?: JailbreakReviewStatus;
  reviewedAt?: string;
  reviewedBy?: number;
  studentAppealedAt?: string;
  studentAppealReason?: string;
  expiresAt?: string;
  createdAt: string;
}

export interface JailbreakLogPagination {
  logs: JailbreakLogEntry[];
  total: number;
  page: number;
  totalPages: number;
  summary: JailbreakReviewSummary;
  ruleMetrics: JailbreakRuleMetric[];
  operationalMetrics?: JailbreakOperationalMetrics;
  filters?: JailbreakLogFilters;
}

export interface JailbreakLogFilterOption {
  value: string;
  label: string;
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
}
