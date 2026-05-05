export type AntigravityQuotaGroupSnapshot = {
  id: string;
  label: string;
  models: string[];
  remainingFraction: number;
  resetTime?: string | null;
};

export type OauthQuotaWindowSnapshot = {
  supported: boolean;
  limit?: number | null;
  used?: number | null;
  remaining?: number | null;
  resetAt?: string | null;
  message?: string;
};

export type OauthQuotaSnapshot = {
  status: 'supported' | 'unsupported' | 'error';
  source: 'official' | 'reverse_engineered';
  lastSyncAt?: string;
  lastError?: string;
  providerMessage?: string;
  subscription?: {
    planType?: string;
    activeStart?: string;
    activeUntil?: string;
  };
  windows: {
    fiveHour: OauthQuotaWindowSnapshot;
    sevenDay: OauthQuotaWindowSnapshot;
  };
  antigravityGroups?: AntigravityQuotaGroupSnapshot[];
  lastLimitResetAt?: string;
};
