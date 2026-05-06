import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { fetch } from 'undici';
import { db, schema } from '../../db/index.js';
import { mergeAccountExtraConfig } from '../accountExtraConfig.js';
import { runWithSiteApiEndpointPool } from '../siteApiEndpointService.js';
import { withExplicitProxyRequestInit } from '../siteProxy.js';
import {
  buildStoredOauthStateFromAccount,
  getOauthInfoFromAccount,
  type OauthInfo,
} from './oauthAccount.js';
import { resolveOauthAccountProxyUrl } from './requestProxy.js';
import { setAccountRuntimeHealth } from '../accountHealthService.js';
import { updateOauthModelDiscoveryState } from '../modelService.js';
import type { OauthQuotaSnapshot, OauthQuotaWindowSnapshot, AntigravityQuotaGroupSnapshot } from './quotaTypes.js';
import {
  ANTIGRAVITY_UPSTREAM_BASE_URL,
  ANTIGRAVITY_DAILY_UPSTREAM_BASE_URL,
  ANTIGRAVITY_SANDBOX_DAILY_UPSTREAM_BASE_URL,
  ANTIGRAVITY_INTERNAL_API_VERSION,
  ANTIGRAVITY_MODELS_USER_AGENT,
} from './antigravityProvider.js';

type CodexJwtClaims = {
  'https://api.openai.com/auth'?: {
    chatgpt_plan_type?: unknown;
    chatgpt_subscription_active_start?: unknown;
    chatgpt_subscription_active_until?: unknown;
  };
};

type HeaderSource = {
  get(name: string): string | null;
} | Record<string, unknown>;

type CodexQuotaHeaderSnapshot = {
  primaryUsedPercent?: number;
  primaryResetAfterSeconds?: number;
  primaryWindowMinutes?: number;
  secondaryUsedPercent?: number;
  secondaryResetAfterSeconds?: number;
  secondaryWindowMinutes?: number;
  capturedAt: string;
};

type NormalizedCodexQuotaHeaders = {
  fiveHour?: {
    usedPercent?: number;
    resetAfterSeconds?: number;
    windowMinutes?: number;
  };
  sevenDay?: {
    usedPercent?: number;
    resetAfterSeconds?: number;
    windowMinutes?: number;
  };
};

const CODEX_WHAM_USAGE_URL_PATH = '/backend-api/wham/usage';

// The wham/usage API lives on chatgpt.com, not under the codex sub-path.
// Site baseUrl is typically "https://chatgpt.com/backend-api/codex";
// we need to extract the origin to build the correct wham URL.
function buildCodexWhamUsageUrl(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl.replace(/\/+$/, ''));
    return `${parsed.origin}${CODEX_WHAM_USAGE_URL_PATH}`;
  } catch {
    return `${baseUrl.replace(/\/+$/, '')}${CODEX_WHAM_USAGE_URL_PATH}`;
  }
}

const CODEX_WHAM_USAGE_REQUEST_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'User-Agent': 'codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal',
};

function buildCodexWhamUsageHeaders(input: {
  accessToken: string;
  accountId?: string;
}): Record<string, string> {
  return {
    Authorization: `Bearer ${input.accessToken.trim()}`,
    ...CODEX_WHAM_USAGE_REQUEST_HEADERS,
    ...(input.accountId ? { 'Chatgpt-Account-Id': input.accountId } : {}),
  };
}

type CodexWhamUsageWindow = {
  used_percent?: unknown;
  usedPercent?: unknown;
  limit_window_seconds?: unknown;
  limitWindowSeconds?: unknown;
  reset_after_seconds?: unknown;
  resetAfterSeconds?: unknown;
  reset_at?: unknown;
  resetAt?: unknown;
};

type CodexWhamRateLimitInfo = {
  allowed?: unknown;
  limit_reached?: unknown;
  limitReached?: unknown;
  primary_window?: CodexWhamUsageWindow | null;
  primaryWindow?: CodexWhamUsageWindow | null;
  secondary_window?: CodexWhamUsageWindow | null;
  secondaryWindow?: CodexWhamUsageWindow | null;
};

type CodexWhamUsagePayload = {
  plan_type?: unknown;
  planType?: unknown;
  rate_limit?: CodexWhamRateLimitInfo | null;
  rateLimit?: CodexWhamRateLimitInfo | null;
};

const FIVE_HOUR_SECONDS = 18000;
const WEEK_SECONDS = 604800;

function classifyWhamWindows(
  limitInfo?: CodexWhamRateLimitInfo | null,
): { fiveHourWindow: CodexWhamUsageWindow | null; sevenDayWindow: CodexWhamUsageWindow | null } {
  const primary = limitInfo?.primary_window ?? limitInfo?.primaryWindow ?? null;
  const secondary = limitInfo?.secondary_window ?? limitInfo?.secondaryWindow ?? null;

  let fiveHourWindow: CodexWhamUsageWindow | null = null;
  let sevenDayWindow: CodexWhamUsageWindow | null = null;

  for (const window of [primary, secondary]) {
    if (!window) continue;
    const seconds = asFiniteInteger(window.limit_window_seconds ?? window.limitWindowSeconds);
    if (seconds === FIVE_HOUR_SECONDS && !fiveHourWindow) {
      fiveHourWindow = window;
    } else if (seconds === WEEK_SECONDS && !sevenDayWindow) {
      sevenDayWindow = window;
    }
  }

  // Fallback: without window duration, primary → 5h, secondary → 7d
  if (!fiveHourWindow) {
    fiveHourWindow = primary && primary !== sevenDayWindow ? primary : null;
  }
  if (!sevenDayWindow) {
    sevenDayWindow = secondary && secondary !== fiveHourWindow ? secondary : null;
  }

  return { fiveHourWindow, sevenDayWindow };
}

function buildWindowFromWham(
  rawWindow: CodexWhamUsageWindow | null,
  syncedAt: string,
  limitReached?: boolean,
  allowed?: boolean,
): OauthQuotaWindowSnapshot | null {
  if (!rawWindow) return null;

  const rawUsedPercent = asFiniteNumber(rawWindow.used_percent ?? rawWindow.usedPercent);
  const isLimitReached = Boolean(limitReached) || allowed === false;
  const resetAfterSeconds = asFiniteInteger(rawWindow.reset_after_seconds ?? rawWindow.resetAfterSeconds);
  const resetAtEpoch = asFiniteNumber(rawWindow.reset_at ?? rawWindow.resetAt);
  const resetAt = resetAtEpoch && resetAtEpoch > 0
    ? new Date(resetAtEpoch * 1000).toISOString()
    : addSecondsToIso(syncedAt, resetAfterSeconds);

  const usedPercent = rawUsedPercent ?? (isLimitReached && resetAt ? 100 : undefined);
  if (usedPercent === undefined && !resetAt) return null;

  const windowMinutes = asFiniteInteger(rawWindow.limit_window_seconds ?? rawWindow.limitWindowSeconds);
  const windowMinutesDisplay = windowMinutes ? Math.round(windowMinutes / 60) : null;

  return {
    supported: true,
    ...(usedPercent !== undefined
      ? {
        used: roundPercent(usedPercent),
        limit: 100,
        remaining: roundPercent(Math.max(0, 100 - usedPercent)),
      }
      : {}),
    ...(resetAt ? { resetAt } : {}),
    message: windowMinutesDisplay
      ? `codex ${windowMinutesDisplay}m window from official wham/usage API`
      : 'codex window from official wham/usage API',
  };
}

function buildCodexSnapshotFromWhamUsage(input: {
  oauth: Pick<OauthInfo, 'provider' | 'planType' | 'idToken' | 'quota'>;
  payload: CodexWhamUsagePayload;
  syncedAt: string;
}): OauthQuotaSnapshot | null {
  const rateLimit = input.payload.rate_limit ?? input.payload.rateLimit ?? null;
  if (!rateLimit) return null;

  const { fiveHourWindow, sevenDayWindow } = classifyWhamWindows(rateLimit);
  const limitReached = rateLimit.limit_reached ?? rateLimit.limitReached;
  const allowed = rateLimit.allowed;

  const baseSnapshot = buildQuotaSnapshotFromOauthInfo(input.oauth);
  const isFreeTier = isCodexFreeTierPlanType(baseSnapshot.subscription?.planType || input.oauth.planType);

  const fiveHour = isFreeTier
    ? null
    : buildWindowFromWham(fiveHourWindow, input.syncedAt, limitReached as boolean | undefined, allowed as boolean | undefined);
  const sevenDay = buildWindowFromWham(sevenDayWindow, input.syncedAt, limitReached as boolean | undefined, allowed as boolean | undefined);

  if (!fiveHour && !sevenDay) return null;

  const planTypeFromUsage = asTrimmedString(input.payload.plan_type ?? input.payload.planType);
  if (planTypeFromUsage && baseSnapshot.subscription) {
    baseSnapshot.subscription.planType = planTypeFromUsage;
  }

  const lastLimitResetAt = sevenDay?.resetAt || fiveHour?.resetAt || baseSnapshot.lastLimitResetAt;

  return {
    ...baseSnapshot,
    status: 'supported',
    source: 'official',
    lastSyncAt: input.syncedAt,
    lastError: undefined,
    providerMessage: 'codex usage windows from official wham/usage API',
    windows: {
      fiveHour: isFreeTier ? buildCodexFreeTierFiveHourUnsupportedWindow() : (fiveHour || baseSnapshot.windows.fiveHour),
      sevenDay: sevenDay || baseSnapshot.windows.sevenDay,
    },
    ...(lastLimitResetAt ? { lastLimitResetAt } : {}),
  };
}

async function fetchCodexWhamUsage(input: {
  account: typeof schema.accounts.$inferSelect;
  oauth: OauthInfo;
  syncedAt: string;
}): Promise<OauthQuotaSnapshot | null> {
  const site = await db.select().from(schema.sites).where(eq(schema.sites.id, input.account.siteId)).get();
  if (!site) {
    throw new Error('oauth site not found');
  }
  const accessToken = (input.account.accessToken || '').trim();
  if (!accessToken) {
    throw new Error('codex oauth access token missing');
  }
  const proxyUrl = await resolveOauthAccountProxyUrl({
    siteId: input.account.siteId,
    extraConfig: input.account.extraConfig,
  });
  const headers = buildCodexWhamUsageHeaders({
    accessToken,
    accountId: input.oauth.accountId || input.oauth.accountKey,
  });

  return runWithSiteApiEndpointPool(site, async (target) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CODEX_QUOTA_PROBE_TIMEOUT_MS);
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetch(
        buildCodexWhamUsageUrl(target.baseUrl),
        withExplicitProxyRequestInit(proxyUrl, {
          method: 'GET',
          headers,
          signal: controller.signal,
        }),
      );
    } catch (error) {
      if (controller.signal.aborted) {
        return null;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      return null;
    }

    const body = await response.text().catch(() => '');
    if (!body) return null;

    let payload: CodexWhamUsagePayload;
    try {
      payload = JSON.parse(body) as CodexWhamUsagePayload;
    } catch {
      return null;
    }

    return buildCodexSnapshotFromWhamUsage({
      oauth: input.oauth,
      payload,
      syncedAt: input.syncedAt,
    });
  });
}

const CODEX_QUOTA_PROBE_MODELS = ['gpt-5.1-codex', 'gpt-5.3-codex'] as const;
const CODEX_UNSUPPORTED_MODEL_PATTERN = /is not supported when using Codex/i;
const CODEX_QUOTA_PROBE_VERSION = '0.101.0';
const CODEX_QUOTA_PROBE_USER_AGENT = 'codex_cli_rs/0.101.0 (Mac OS 26.0.1; arm64) Apple_Terminal/464';
const CODEX_QUOTA_PROBE_BETA = 'responses-2025-03-11';
const CODEX_QUOTA_PROBE_INSTRUCTIONS = 'You are a helpful assistant.';
const CODEX_QUOTA_PROBE_TIMEOUT_MS = 10_000;
const QUOTA_HEADER_SNAPSHOT_DEDUPE_WINDOW_MS = 30_000;
const recentQuotaHeaderSnapshotByAccount = new Map<number, {
  fingerprint: string;
  recordedAtMs: number;
}>();
const pendingQuotaHeaderSnapshotKeys = new Set<string>();

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function getHeaderValue(headers: HeaderSource, key: string): string | undefined {
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const value = (headers as { get(name: string): string | null }).get(key);
    return asTrimmedString(value);
  }

  for (const [candidateKey, candidateValue] of Object.entries(headers)) {
    if (candidateKey.toLowerCase() !== key.toLowerCase()) continue;
    if (typeof candidateValue === 'string') return asTrimmedString(candidateValue);
    if (Array.isArray(candidateValue)) {
      for (const item of candidateValue) {
        const normalized = asTrimmedString(item);
        if (normalized) return normalized;
      }
    }
  }

  return undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Number.parseFloat(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asFiniteInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value !== 'string') return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asIsoDateTime(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

function parseCodexJwtClaims(idToken?: string): CodexJwtClaims | null {
  if (!idToken) return null;
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1] || '', 'base64url').toString('utf8')) as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    return payload as CodexJwtClaims;
  } catch {
    return null;
  }
}

function buildUnsupportedWindow(message: string): OauthQuotaWindowSnapshot {
  return { supported: false, message };
}

const CODEX_FREE_TIER_PLAN_TYPES = new Set(['free']);

function isCodexFreeTierPlanType(planType?: string | null): boolean {
  if (!planType) return false;
  return CODEX_FREE_TIER_PLAN_TYPES.has(planType.toLowerCase());
}

const CODEX_FREE_TIER_FIVE_HOUR_UNSUPPORTED_MESSAGE = '5h quota window does not apply to codex free tier';

function buildCodexFreeTierFiveHourUnsupportedWindow(): OauthQuotaWindowSnapshot {
  return buildUnsupportedWindow(CODEX_FREE_TIER_FIVE_HOUR_UNSUPPORTED_MESSAGE);
}

function buildCodexUnsupportedWindows(): OauthQuotaSnapshot['windows'] {
  return {
    fiveHour: buildUnsupportedWindow('official 5h quota window is not exposed by current codex oauth artifacts'),
    sevenDay: buildUnsupportedWindow('official 7d quota window is not exposed by current codex oauth artifacts'),
  };
}

function buildProviderUnsupportedSnapshot(provider: string): OauthQuotaSnapshot {
  return {
    status: 'unsupported',
    source: 'official',
    providerMessage: `official quota windows are not exposed for ${provider} oauth`,
    windows: {
      fiveHour: buildUnsupportedWindow('official 5h quota window is unavailable for this provider'),
      sevenDay: buildUnsupportedWindow('official 7d quota window is unavailable for this provider'),
    },
  };
}

// ---------------------------------------------------------------------------
// Antigravity quota via fetchAvailableModels
// ---------------------------------------------------------------------------

type AntigravityModelQuotaInfo = {
  remainingFraction?: unknown;
  remaining_fraction?: unknown;
  remaining?: unknown;
  resetTime?: unknown;
  reset_time?: unknown;
};

type AntigravityModelEntry = {
  displayName?: unknown;
  quotaInfo?: unknown;
  quota_info?: unknown;
};

type AntigravityFetchModelsPayload = {
  models?: Record<string, AntigravityModelEntry>;
};

type AntigravityGroupDefinition = {
  id: string;
  label: string;
  identifiers: string[];
  labelFromModel?: boolean;
};

const ANTIGRAVITY_QUOTA_GROUP_DEFINITIONS: AntigravityGroupDefinition[] = [
  {
    id: 'claude-gpt',
    label: 'Claude/GPT',
    identifiers: ['claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium'],
  },
  {
    id: 'gemini-3-pro',
    label: 'Gemini 3 Pro',
    identifiers: ['gemini-3-pro-high', 'gemini-3-pro-low'],
  },
  {
    id: 'gemini-3-1-pro-series',
    label: 'Gemini 3.1 Pro Series',
    identifiers: ['gemini-3.1-pro-high', 'gemini-3.1-pro-low'],
  },
  {
    id: 'gemini-2-5-flash',
    label: 'Gemini 2.5 Flash',
    identifiers: ['gemini-2.5-flash', 'gemini-2.5-flash-thinking'],
  },
  {
    id: 'gemini-2-5-flash-lite',
    label: 'Gemini 2.5 Flash Lite',
    identifiers: ['gemini-2.5-flash-lite'],
  },
  {
    id: 'gemini-2-5-cu',
    label: 'Gemini 2.5 CU',
    identifiers: ['rev19-uic3-1p'],
  },
  {
    id: 'gemini-3-flash',
    label: 'Gemini 3 Flash',
    identifiers: ['gemini-3-flash'],
  },
  {
    id: 'gemini-image',
    label: 'Gemini 3.1 Flash Image',
    identifiers: ['gemini-3.1-flash-image'],
    labelFromModel: true,
  },
];

const ANTIGRAVITY_FETCH_MODELS_URLS = [
  `${ANTIGRAVITY_DAILY_UPSTREAM_BASE_URL}/${ANTIGRAVITY_INTERNAL_API_VERSION}:fetchAvailableModels`,
  `${ANTIGRAVITY_SANDBOX_DAILY_UPSTREAM_BASE_URL}/${ANTIGRAVITY_INTERNAL_API_VERSION}:fetchAvailableModels`,
  `${ANTIGRAVITY_UPSTREAM_BASE_URL}/${ANTIGRAVITY_INTERNAL_API_VERSION}:fetchAvailableModels`,
];

const ANTIGRAVITY_QUOTA_TIMEOUT_MS = 10_000;

function extractAntigravityQuotaInfo(entry: AntigravityModelEntry): AntigravityModelQuotaInfo {
  const info = entry.quotaInfo ?? entry.quota_info;
  if (!info || typeof info !== 'object' || Array.isArray(info)) {
    return {};
  }
  return info as AntigravityModelQuotaInfo;
}

function normalizeQuotaFraction(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value.trim());
    return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : null;
  }
  return null;
}

function buildAntigravityGroups(
  models: Record<string, AntigravityModelEntry>,
): AntigravityQuotaGroupSnapshot[] {
  const groups: AntigravityQuotaGroupSnapshot[] = [];

  for (const definition of ANTIGRAVITY_QUOTA_GROUP_DEFINITIONS) {
    const matches = definition.identifiers
      .map((identifier) => {
        const entry = models[identifier];
        if (!entry) return null;
        const quota = extractAntigravityQuotaInfo(entry);
        const fraction = normalizeQuotaFraction(
          quota.remainingFraction ?? quota.remaining_fraction ?? quota.remaining,
        );
        const resetTime = asIsoDateTime(quota.resetTime ?? quota.reset_time);
        let resolvedFraction: number;
        if (fraction !== null) {
          resolvedFraction = fraction;
        } else if (resetTime) {
          resolvedFraction = 0;
        } else {
          return null;
        }
        const displayName = typeof entry.displayName === 'string' ? entry.displayName.trim() : undefined;
        return { id: identifier, remainingFraction: resolvedFraction, resetTime: resetTime ?? undefined, displayName };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    if (matches.length === 0) continue;

    const remainingFraction = Math.min(...matches.map((m) => m.remainingFraction));
    const resetTime = matches.map((m) => m.resetTime).find(Boolean) ?? null;
    const displayName = matches.map((m) => m.displayName).find(Boolean);
    const label = definition.labelFromModel && displayName ? displayName : definition.label;

    groups.push({
      id: definition.id,
      label,
      models: matches.map((m) => m.id),
      remainingFraction,
      resetTime,
    });
  }

  return groups;
}

function buildAntigravityQuotaSnapshot(groups: AntigravityQuotaGroupSnapshot[], syncedAt: string): OauthQuotaSnapshot {
  return {
    status: 'supported',
    source: 'official',
    lastSyncAt: syncedAt,
    providerMessage: 'antigravity quota via fetchAvailableModels API',
    windows: {
      fiveHour: buildUnsupportedWindow('antigravity uses model-group remainingFraction, not 5h window'),
      sevenDay: buildUnsupportedWindow('antigravity uses model-group remainingFraction, not 7d window'),
    },
    antigravityGroups: groups,
  };
}

async function fetchAntigravityQuotaSnapshot(input: {
  account: typeof schema.accounts.$inferSelect;
  oauth: OauthInfo;
  syncedAt: string;
}): Promise<OauthQuotaSnapshot> {
  const accessToken = (input.account.accessToken || '').trim();
  if (!accessToken) {
    throw new Error('antigravity oauth access token missing');
  }
  const projectId = input.oauth.projectId;
  if (!projectId) {
    throw new Error('antigravity project id missing, cannot fetch quota');
  }
  const proxyUrl = await resolveOauthAccountProxyUrl({
    siteId: input.account.siteId,
    extraConfig: input.account.extraConfig,
  });

  const requestHeaders: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': ANTIGRAVITY_MODELS_USER_AGENT,
  };

  const requestBody = JSON.stringify({ project: projectId });
  let lastError = '';

  for (const url of ANTIGRAVITY_FETCH_MODELS_URLS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ANTIGRAVITY_QUOTA_TIMEOUT_MS);
    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetch(
        url,
        withExplicitProxyRequestInit(proxyUrl, {
          method: 'POST',
          headers: requestHeaders,
          body: requestBody,
          signal: controller.signal,
        }),
      );
    } catch (error) {
      if (controller.signal.aborted) {
        lastError = `antigravity quota fetch timeout (${Math.round(ANTIGRAVITY_QUOTA_TIMEOUT_MS / 1000)}s)`;
        continue;
      }
      lastError = error instanceof Error ? error.message : String(error);
      continue;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      lastError = errorText || `antigravity quota fetch failed with status ${response.status}`;
      if (response.status === 403 || response.status === 404) continue;
      // Non-retryable error, return error snapshot immediately
      return {
        status: 'error',
        source: 'official',
        lastSyncAt: input.syncedAt,
        lastError,
        providerMessage: lastError,
        windows: {
          fiveHour: buildUnsupportedWindow('antigravity uses model-group remainingFraction, not 5h window'),
          sevenDay: buildUnsupportedWindow('antigravity uses model-group remainingFraction, not 7d window'),
        },
      };
    }

    const body = await response.text().catch(() => '');
    if (!body) {
      lastError = 'antigravity quota response body is empty';
      continue;
    }

    let payload: AntigravityFetchModelsPayload;
    try {
      payload = JSON.parse(body) as AntigravityFetchModelsPayload;
    } catch {
      lastError = 'antigravity quota response is not valid JSON';
      continue;
    }

    const models = payload.models;
    if (!models || typeof models !== 'object' || Array.isArray(models)) {
      lastError = 'antigravity quota response has no models field';
      continue;
    }

    const groups = buildAntigravityGroups(models);
    return buildAntigravityQuotaSnapshot(groups, input.syncedAt);
  }

  // All URLs exhausted
  return {
    status: 'error',
    source: 'official',
    lastSyncAt: input.syncedAt,
    lastError: lastError || 'antigravity quota fetch failed: all endpoints exhausted',
    providerMessage: lastError || 'antigravity quota fetch failed: all endpoints exhausted',
    windows: {
      fiveHour: buildUnsupportedWindow('antigravity uses model-group remainingFraction, not 5h window'),
      sevenDay: buildUnsupportedWindow('antigravity uses model-group remainingFraction, not 7d window'),
    },
  };
}

function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}

function addSecondsToIso(baseIso: string, seconds?: number): string | undefined {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return undefined;
  const parsed = Date.parse(baseIso);
  if (Number.isNaN(parsed)) return undefined;
  const clampedSeconds = Math.max(0, Math.trunc(seconds));
  return new Date(parsed + clampedSeconds * 1000).toISOString();
}

function parseCodexQuotaHeaders(
  headers: HeaderSource,
  capturedAt = new Date().toISOString(),
): CodexQuotaHeaderSnapshot | null {
  const snapshot: CodexQuotaHeaderSnapshot = { capturedAt };
  let hasAnyValue = false;

  const assignField = (
    field: keyof Omit<CodexQuotaHeaderSnapshot, 'capturedAt'>,
    value: number | undefined,
  ) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    snapshot[field] = value as CodexQuotaHeaderSnapshot[keyof Omit<CodexQuotaHeaderSnapshot, 'capturedAt'>];
    hasAnyValue = true;
  };

  assignField('primaryUsedPercent', asFiniteNumber(getHeaderValue(headers, 'x-codex-primary-used-percent')));
  assignField('primaryResetAfterSeconds', asFiniteInteger(getHeaderValue(headers, 'x-codex-primary-reset-after-seconds')));
  assignField('primaryWindowMinutes', asFiniteInteger(getHeaderValue(headers, 'x-codex-primary-window-minutes')));
  assignField('secondaryUsedPercent', asFiniteNumber(getHeaderValue(headers, 'x-codex-secondary-used-percent')));
  assignField('secondaryResetAfterSeconds', asFiniteInteger(getHeaderValue(headers, 'x-codex-secondary-reset-after-seconds')));
  assignField('secondaryWindowMinutes', asFiniteInteger(getHeaderValue(headers, 'x-codex-secondary-window-minutes')));

  return hasAnyValue ? snapshot : null;
}

function normalizeCodexQuotaHeaders(snapshot: CodexQuotaHeaderSnapshot): NormalizedCodexQuotaHeaders | null {
  const primaryWindow = snapshot.primaryWindowMinutes;
  const secondaryWindow = snapshot.secondaryWindowMinutes;
  const hasPrimaryWindow = typeof primaryWindow === 'number' && Number.isFinite(primaryWindow);
  const hasSecondaryWindow = typeof secondaryWindow === 'number' && Number.isFinite(secondaryWindow);

  let fiveHourSource: 'primary' | 'secondary' | null = null;
  let sevenDaySource: 'primary' | 'secondary' | null = null;

  if (hasPrimaryWindow && hasSecondaryWindow) {
    if ((primaryWindow || 0) < (secondaryWindow || 0)) {
      fiveHourSource = 'primary';
      sevenDaySource = 'secondary';
    } else {
      fiveHourSource = 'secondary';
      sevenDaySource = 'primary';
    }
  } else if (hasPrimaryWindow) {
    if ((primaryWindow || 0) <= 360) {
      fiveHourSource = 'primary';
    } else {
      sevenDaySource = 'primary';
    }
  } else if (hasSecondaryWindow) {
    if ((secondaryWindow || 0) <= 360) {
      fiveHourSource = 'secondary';
    } else {
      sevenDaySource = 'secondary';
    }
  } else {
    sevenDaySource = 'primary';
    fiveHourSource = 'secondary';
  }

  const pickSource = (source: 'primary' | 'secondary' | null) => {
    if (!source) return undefined;
    if (source === 'primary') {
      return {
        usedPercent: snapshot.primaryUsedPercent,
        resetAfterSeconds: snapshot.primaryResetAfterSeconds,
        windowMinutes: snapshot.primaryWindowMinutes,
      };
    }
    return {
      usedPercent: snapshot.secondaryUsedPercent,
      resetAfterSeconds: snapshot.secondaryResetAfterSeconds,
      windowMinutes: snapshot.secondaryWindowMinutes,
    };
  };

  const normalized: NormalizedCodexQuotaHeaders = {
    fiveHour: pickSource(fiveHourSource),
    sevenDay: pickSource(sevenDaySource),
  };

  const hasData = !!(
    normalized.fiveHour?.usedPercent !== undefined
    || normalized.fiveHour?.resetAfterSeconds !== undefined
    || normalized.sevenDay?.usedPercent !== undefined
    || normalized.sevenDay?.resetAfterSeconds !== undefined
  );
  return hasData ? normalized : null;
}

function buildCodexQuotaHeadersFingerprint(headers: HeaderSource): string | null {
  const parsed = parseCodexQuotaHeaders(headers, 'fingerprint');
  if (!parsed) return null;
  const { capturedAt: _capturedAt, ...stableFields } = parsed;
  return JSON.stringify(stableFields);
}

function buildCodexWindowFromNormalized(input: {
  usedPercent?: number;
  resetAfterSeconds?: number;
  windowMinutes?: number;
  capturedAt: string;
}): OauthQuotaWindowSnapshot | null {
  const usedPercent = typeof input.usedPercent === 'number' && Number.isFinite(input.usedPercent)
    ? roundPercent(input.usedPercent)
    : undefined;
  const resetAt = addSecondsToIso(input.capturedAt, input.resetAfterSeconds);
  if (usedPercent === undefined && !resetAt) {
    return null;
  }

  return {
    supported: true,
    ...(usedPercent !== undefined
      ? {
        used: usedPercent,
        limit: 100,
        remaining: roundPercent(Math.max(0, 100 - usedPercent)),
      }
      : {}),
    ...(resetAt ? { resetAt } : {}),
    message: typeof input.windowMinutes === 'number' && Number.isFinite(input.windowMinutes)
      ? `codex ${Math.max(0, Math.trunc(input.windowMinutes))}m window inferred from rate limit headers`
      : 'codex window inferred from rate limit headers',
  };
}

function normalizeStoredWindow(value: unknown): OauthQuotaWindowSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const supported = typeof raw.supported === 'boolean' ? raw.supported : undefined;
  if (supported === undefined) return undefined;
  const pickNumber = (field: string) => {
    const item = raw[field];
    return typeof item === 'number' && Number.isFinite(item) ? item : undefined;
  };
  const normalized: OauthQuotaWindowSnapshot = {
    supported,
  };
  const limit = pickNumber('limit');
  const used = pickNumber('used');
  const remaining = pickNumber('remaining');
  const resetAt = asIsoDateTime(raw.resetAt);
  const message = asTrimmedString(raw.message);
  if (limit !== undefined) normalized.limit = limit;
  if (used !== undefined) normalized.used = used;
  if (remaining !== undefined) normalized.remaining = remaining;
  if (resetAt) normalized.resetAt = resetAt;
  if (message) normalized.message = message;
  return normalized;
}

function normalizeStoredQuotaSnapshot(value: unknown): OauthQuotaSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const status = raw.status === 'supported' || raw.status === 'unsupported' || raw.status === 'error'
    ? raw.status
    : undefined;
  const source = raw.source === 'official' || raw.source === 'reverse_engineered'
    ? raw.source
    : undefined;
  const windowsRaw = raw.windows;
  if (!status || !source || !windowsRaw || typeof windowsRaw !== 'object' || Array.isArray(windowsRaw)) {
    return undefined;
  }
  const windowsObject = windowsRaw as Record<string, unknown>;
  const fiveHour = normalizeStoredWindow(windowsObject.fiveHour);
  const sevenDay = normalizeStoredWindow(windowsObject.sevenDay);
  if (!fiveHour || !sevenDay) return undefined;

  const subscriptionRaw = raw.subscription;
  const subscription = subscriptionRaw && typeof subscriptionRaw === 'object' && !Array.isArray(subscriptionRaw)
    ? {
      planType: asTrimmedString((subscriptionRaw as Record<string, unknown>).planType),
      activeStart: asIsoDateTime((subscriptionRaw as Record<string, unknown>).activeStart),
      activeUntil: asIsoDateTime((subscriptionRaw as Record<string, unknown>).activeUntil),
    }
    : undefined;

  return {
    status,
    source,
    ...(asIsoDateTime(raw.lastSyncAt) ? { lastSyncAt: asIsoDateTime(raw.lastSyncAt)! } : {}),
    ...(asTrimmedString(raw.lastError) ? { lastError: asTrimmedString(raw.lastError)! } : {}),
    ...(asTrimmedString(raw.providerMessage) ? { providerMessage: asTrimmedString(raw.providerMessage)! } : {}),
    ...(subscription && (subscription.planType || subscription.activeStart || subscription.activeUntil)
      ? { subscription }
      : {}),
    windows: { fiveHour, sevenDay },
    ...(Array.isArray(raw.antigravityGroups) && raw.antigravityGroups.length > 0
      ? { antigravityGroups: raw.antigravityGroups as AntigravityQuotaGroupSnapshot[] }
      : {}),
    ...(asIsoDateTime(raw.lastLimitResetAt) ? { lastLimitResetAt: asIsoDateTime(raw.lastLimitResetAt)! } : {}),
  };
}

function buildQuotaErrorSnapshot(input: {
  oauth: Pick<OauthInfo, 'provider' | 'planType' | 'idToken' | 'quota'>;
  message: string;
  syncedAt: string;
  lastLimitResetAt?: string;
}): OauthQuotaSnapshot {
  const baseSnapshot = buildQuotaSnapshotFromOauthInfo(input.oauth);
  return {
    ...baseSnapshot,
    status: 'error',
    lastSyncAt: input.syncedAt,
    lastError: input.message,
    providerMessage: input.message,
    ...(input.lastLimitResetAt
      ? { lastLimitResetAt: input.lastLimitResetAt }
      : (baseSnapshot.lastLimitResetAt ? { lastLimitResetAt: baseSnapshot.lastLimitResetAt } : {})),
  };
}

export function buildCodexQuotaSnapshotFromHeaders(
  oauth: Pick<OauthInfo, 'provider' | 'planType' | 'idToken' | 'quota'>,
  headers: HeaderSource,
  capturedAt = new Date().toISOString(),
): OauthQuotaSnapshot | null {
  if (oauth.provider !== 'codex') return null;
  const parsedHeaders = parseCodexQuotaHeaders(headers, capturedAt);
  if (!parsedHeaders) return null;
  const normalizedHeaders = normalizeCodexQuotaHeaders(parsedHeaders);
  if (!normalizedHeaders) return null;

  const baseSnapshot = buildQuotaSnapshotFromOauthInfo(oauth);
  const isFreeTier = isCodexFreeTierPlanType(baseSnapshot.subscription?.planType || oauth.planType);
  const fiveHour = normalizedHeaders.fiveHour && !isFreeTier
    ? buildCodexWindowFromNormalized({
      ...normalizedHeaders.fiveHour,
      capturedAt: parsedHeaders.capturedAt,
    })
    : null;
  const sevenDay = normalizedHeaders.sevenDay
    ? buildCodexWindowFromNormalized({
      ...normalizedHeaders.sevenDay,
      capturedAt: parsedHeaders.capturedAt,
    })
    : null;
  if (!fiveHour && !sevenDay) return null;

  const lastLimitResetAt = sevenDay?.resetAt || baseSnapshot.lastLimitResetAt;

  return {
    ...baseSnapshot,
    status: 'supported',
    source: 'reverse_engineered',
    lastSyncAt: parsedHeaders.capturedAt,
    lastError: undefined,
    providerMessage: 'codex usage windows inferred from rate limit response headers',
    windows: {
      fiveHour: isFreeTier ? buildCodexFreeTierFiveHourUnsupportedWindow() : (fiveHour || baseSnapshot.windows.fiveHour),
      sevenDay: sevenDay || baseSnapshot.windows.sevenDay,
    },
    ...(lastLimitResetAt ? { lastLimitResetAt } : {}),
  };
}

function buildStoredCodexSnapshot(oauth: Pick<OauthInfo, 'planType' | 'idToken' | 'quota'>): OauthQuotaSnapshot {
  const claims = parseCodexJwtClaims(oauth.idToken);
  const authClaims = claims?.['https://api.openai.com/auth'];
  const storedQuota = normalizeStoredQuotaSnapshot(oauth.quota);
  const subscription = {
    planType: asTrimmedString(authClaims?.chatgpt_plan_type) || oauth.planType,
    activeStart: asIsoDateTime(authClaims?.chatgpt_subscription_active_start),
    activeUntil: asIsoDateTime(authClaims?.chatgpt_subscription_active_until),
  };
  const isFreeTier = isCodexFreeTierPlanType(subscription.planType);
  const baseWindows = storedQuota?.windows || buildCodexUnsupportedWindows();
  const windows = isFreeTier
    ? { fiveHour: buildCodexFreeTierFiveHourUnsupportedWindow(), sevenDay: baseWindows.sevenDay }
    : baseWindows;

  return {
    status: storedQuota?.status || 'supported',
    source: storedQuota?.source || 'reverse_engineered',
    ...(storedQuota?.lastSyncAt ? { lastSyncAt: storedQuota.lastSyncAt } : {}),
    ...(storedQuota?.lastError ? { lastError: storedQuota.lastError } : {}),
    providerMessage: storedQuota?.providerMessage || 'current codex oauth signals do not expose stable 5h/7d remaining values',
    ...((subscription.planType || subscription.activeStart || subscription.activeUntil) ? { subscription } : {}),
    windows,
    ...(storedQuota?.lastLimitResetAt ? { lastLimitResetAt: storedQuota.lastLimitResetAt } : {}),
  };
}

function buildStoredAntigravitySnapshot(oauth: Pick<OauthInfo, 'quota'>): OauthQuotaSnapshot {
  const storedQuota = normalizeStoredQuotaSnapshot(oauth.quota);
  if (storedQuota) {
    // Preserve antigravityGroups from stored data if present
    const storedGroups = oauth.quota && typeof oauth.quota === 'object' && !Array.isArray(oauth.quota)
      ? (oauth.quota as Record<string, unknown>).antigravityGroups
      : undefined;
    const parsedGroups = Array.isArray(storedGroups) ? storedGroups as AntigravityQuotaGroupSnapshot[] : undefined;
    return {
      ...storedQuota,
      ...(parsedGroups && parsedGroups.length > 0 ? { antigravityGroups: parsedGroups } : {}),
    };
  }
  return {
    status: 'unsupported',
    source: 'official',
    providerMessage: 'antigravity quota has not been synced yet',
    windows: {
      fiveHour: buildUnsupportedWindow('antigravity uses model-group remainingFraction, not 5h window'),
      sevenDay: buildUnsupportedWindow('antigravity uses model-group remainingFraction, not 7d window'),
    },
  };
}

export function buildQuotaSnapshotFromOauthInfo(oauth: Pick<OauthInfo, 'provider' | 'planType' | 'idToken' | 'quota'>): OauthQuotaSnapshot {
  if (oauth.provider === 'codex') {
    return buildStoredCodexSnapshot(oauth);
  }
  if (oauth.provider === 'antigravity') {
    return buildStoredAntigravitySnapshot(oauth);
  }
  return buildProviderUnsupportedSnapshot(oauth.provider);
}

export function parseCodexQuotaResetHint(
  statusCode: number,
  errorBody: string | null | undefined,
  nowMs = Date.now(),
): { resetAt: string; message: string } | null {
  if (statusCode !== 429 || !errorBody) return null;
  try {
    const parsed = JSON.parse(errorBody) as Record<string, any>;
    const error = parsed?.error;
    if (!error || typeof error !== 'object' || error.type !== 'usage_limit_reached') {
      return null;
    }
    if (typeof error.resets_at === 'number' && Number.isFinite(error.resets_at) && error.resets_at > 0) {
      return {
        resetAt: new Date(error.resets_at * 1000).toISOString(),
        message: 'codex usage_limit_reached reset hint observed from upstream',
      };
    }
    if (typeof error.resets_in_seconds === 'number' && Number.isFinite(error.resets_in_seconds) && error.resets_in_seconds > 0) {
      return {
        resetAt: new Date(nowMs + error.resets_in_seconds * 1000).toISOString(),
        message: 'codex usage_limit_reached reset hint observed from upstream',
      };
    }
  } catch {
    return null;
  }
  return null;
}

async function persistQuotaSnapshot(accountId: number, snapshot: OauthQuotaSnapshot) {
  const account = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId)).get();
  if (!account) {
    throw new Error('oauth account not found');
  }
  const oauth = getOauthInfoFromAccount(account);
  if (!oauth) {
    throw new Error('account is not managed by oauth');
  }
  const nextExtraConfig = mergeAccountExtraConfig(account.extraConfig, {
    oauth: buildStoredOauthStateFromAccount(account, {
      quota: snapshot,
    }),
  });
  await db.update(schema.accounts).set({
    extraConfig: nextExtraConfig,
    updatedAt: new Date().toISOString(),
  }).where(eq(schema.accounts.id, accountId)).run();
  return snapshot;
}

export async function recordOauthQuotaHeadersSnapshot(input: {
  accountId: number;
  headers: HeaderSource;
}): Promise<OauthQuotaSnapshot | null> {
  const account = await db.select().from(schema.accounts).where(eq(schema.accounts.id, input.accountId)).get();
  if (!account) return null;
  const oauth = getOauthInfoFromAccount(account);
  if (!oauth || oauth.provider !== 'codex') return null;

  const fingerprint = buildCodexQuotaHeadersFingerprint(input.headers);
  if (!fingerprint) return null;
  const nowMs = Date.now();
  const lastRecorded = recentQuotaHeaderSnapshotByAccount.get(input.accountId);
  if (
    lastRecorded
    && lastRecorded.fingerprint === fingerprint
    && nowMs - lastRecorded.recordedAtMs < QUOTA_HEADER_SNAPSHOT_DEDUPE_WINDOW_MS
  ) {
    return buildQuotaSnapshotFromOauthInfo(oauth);
  }
  const pendingKey = `${input.accountId}:${fingerprint}`;
  if (pendingQuotaHeaderSnapshotKeys.has(pendingKey)) {
    return buildQuotaSnapshotFromOauthInfo(oauth);
  }

  const snapshot = buildCodexQuotaSnapshotFromHeaders(oauth, input.headers);
  if (!snapshot) return null;
  pendingQuotaHeaderSnapshotKeys.add(pendingKey);
  try {
    const persisted = await persistQuotaSnapshot(input.accountId, snapshot);
    recentQuotaHeaderSnapshotByAccount.set(input.accountId, {
      fingerprint,
      recordedAtMs: nowMs,
    });
    return persisted;
  } finally {
    pendingQuotaHeaderSnapshotKeys.delete(pendingKey);
  }
}

function buildCodexQuotaProbePayload(model: string): Record<string, unknown> {
  return {
    model,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'hi',
          },
        ],
      },
    ],
    stream: true,
    store: false,
    instructions: CODEX_QUOTA_PROBE_INSTRUCTIONS,
  };
}

function buildCodexQuotaProbeUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/responses`;
}

function buildCodexQuotaProbeHeaders(input: {
  accessToken: string;
  accountId?: string;
}): Record<string, string> {
  return {
    Authorization: `Bearer ${input.accessToken.trim()}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    Connection: 'Keep-Alive',
    Originator: 'codex_cli_rs',
    Version: CODEX_QUOTA_PROBE_VERSION,
    'User-Agent': CODEX_QUOTA_PROBE_USER_AGENT,
    'OpenAI-Beta': CODEX_QUOTA_PROBE_BETA,
    Session_id: randomUUID(),
    ...(input.accountId ? { 'Chatgpt-Account-Id': input.accountId } : {}),
  };
}

async function probeCodexQuotaSnapshot(input: {
  account: typeof schema.accounts.$inferSelect;
  oauth: OauthInfo;
  syncedAt: string;
}): Promise<OauthQuotaSnapshot> {
  const site = await db.select().from(schema.sites).where(eq(schema.sites.id, input.account.siteId)).get();
  if (!site) {
    throw new Error('oauth site not found');
  }
  const accessToken = (input.account.accessToken || '').trim();
  if (!accessToken) {
    throw new Error('codex oauth access token missing');
  }
  const proxyUrl = await resolveOauthAccountProxyUrl({
    siteId: input.account.siteId,
    extraConfig: input.account.extraConfig,
  });
  const probeHeaders = buildCodexQuotaProbeHeaders({
    accessToken,
    accountId: input.oauth.accountId || input.oauth.accountKey,
  });

  return runWithSiteApiEndpointPool(site, async (target) => {
    let lastErrorText = '';

    for (const model of CODEX_QUOTA_PROBE_MODELS) {
      const requestBody = JSON.stringify(buildCodexQuotaProbePayload(model));
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), CODEX_QUOTA_PROBE_TIMEOUT_MS);
      let response: Awaited<ReturnType<typeof fetch>>;
      try {
        response = await fetch(
          buildCodexQuotaProbeUrl(target.baseUrl),
          withExplicitProxyRequestInit(proxyUrl, {
            method: 'POST',
            headers: probeHeaders,
            body: requestBody,
            signal: controller.signal,
          }),
        );
      } catch (error) {
        if (controller.signal.aborted) {
          throw new Error(`codex quota probe timeout (${Math.round(CODEX_QUOTA_PROBE_TIMEOUT_MS / 1000)}s)`);
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }

      const snapshot = buildCodexQuotaSnapshotFromHeaders(input.oauth, response.headers, input.syncedAt);
      if (snapshot) {
        const responseBody = response as { body?: { cancel?: () => Promise<void> | void } };
        void Promise.resolve(responseBody.body?.cancel?.()).catch(() => {});
        return snapshot;
      }

      const errorText = await response.text().catch(() => '');
      if (!response.ok) {
        lastErrorText = errorText;
        if (CODEX_UNSUPPORTED_MODEL_PATTERN.test(errorText)) {
          continue;
        }
        const resetHint = parseCodexQuotaResetHint(response.status, errorText, Date.now());
        return buildQuotaErrorSnapshot({
          oauth: input.oauth,
          message: errorText || `codex quota probe failed with status ${response.status}`,
          syncedAt: input.syncedAt,
          ...(resetHint ? { lastLimitResetAt: resetHint.resetAt } : {}),
        });
      }

      return buildQuotaErrorSnapshot({
        oauth: input.oauth,
        message: 'codex quota probe response did not expose x-codex rate limit headers',
        syncedAt: input.syncedAt,
      });
    }

    const resetHint = parseCodexQuotaResetHint(400, lastErrorText, Date.now());
    return buildQuotaErrorSnapshot({
      oauth: input.oauth,
      message: lastErrorText || 'codex quota probe failed: no supported model found for this account',
      syncedAt: input.syncedAt,
      ...(resetHint ? { lastLimitResetAt: resetHint.resetAt } : {}),
    });
  });
}

export async function refreshOauthQuotaSnapshot(accountId: number): Promise<OauthQuotaSnapshot> {
  const account = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId)).get();
  if (!account) {
    throw new Error('oauth account not found');
  }
  const oauth = getOauthInfoFromAccount(account);
  if (!oauth) {
    throw new Error('account is not managed by oauth');
  }

  let snapshot: OauthQuotaSnapshot;

  if (oauth.provider === 'codex') {
    const syncedAt = new Date().toISOString();
    try {
      // Prefer official wham/usage API for accurate quota data
      const whamSnapshot = await fetchCodexWhamUsage({ account, oauth, syncedAt });
      if (whamSnapshot) {
        snapshot = await persistQuotaSnapshot(accountId, whamSnapshot);
      } else {
        // Fallback to header-inferred probe if wham/usage is unavailable
        snapshot = await persistQuotaSnapshot(accountId, await probeCodexQuotaSnapshot({
          account,
          oauth,
          syncedAt,
        }));
      }
    } catch (error) {
      const message = error instanceof Error
        ? (error.message || error.name)
        : String(error || 'codex quota probe failed');
      snapshot = await persistQuotaSnapshot(accountId, buildQuotaErrorSnapshot({
        oauth,
        message,
        syncedAt,
      }));
    }
  } else if (oauth.provider === 'antigravity') {
    const syncedAt = new Date().toISOString();
    try {
      snapshot = await persistQuotaSnapshot(accountId, await fetchAntigravityQuotaSnapshot({
        account,
        oauth,
        syncedAt,
      }));
    } catch (error) {
      const message = error instanceof Error
        ? (error.message || error.name)
        : String(error || 'antigravity quota fetch failed');
      snapshot = await persistQuotaSnapshot(accountId, buildQuotaErrorSnapshot({
        oauth,
        message,
        syncedAt,
      }));
    }
  } else {
    const baseSnapshot = buildQuotaSnapshotFromOauthInfo(oauth);
    snapshot = await persistQuotaSnapshot(accountId, {
      ...baseSnapshot,
      lastSyncAt: new Date().toISOString(),
      ...(baseSnapshot.status === 'error' ? {} : { lastError: undefined }),
    });
  }

  // Post-check: if snapshot indicates token failure, mark account unhealthy
  // AND mark model discovery as abnormal (token dead = models cannot be fetched).
  // This catches both thrown-exception paths (catch blocks above) AND
  // non-throwing paths (e.g. probeCodexQuotaSnapshot returns buildQuotaErrorSnapshot
  // on 401 without throwing, so the catch block is never reached).
  if (snapshot.status === 'error') {
    const errorText = snapshot.lastError || snapshot.providerMessage || '';
    if (/token_invalidated|refresh_token_reused|http\s*401|status.*401/i.test(errorText)) {
      await setAccountRuntimeHealth(accountId, {
        state: 'unhealthy',
        reason: errorText,
        source: 'quota-refresh',
        checkedAt: snapshot.lastSyncAt || new Date().toISOString(),
      }).catch(() => {});
      // Token is irrecoverably dead — models cannot be fetched either.
      // Update modelDiscoveryStatus so the frontend shows "获取失败"
      // instead of stale "同步正常".
      // Re-read account from DB so updateOauthModelDiscoveryState sees
      // the latest extraConfig (which now includes the quota we just persisted).
      const checkedAt = snapshot.lastSyncAt || new Date().toISOString();
      const refreshedAccount = await db.select().from(schema.accounts)
        .where(eq(schema.accounts.id, accountId)).get();
      if (refreshedAccount) {
        await updateOauthModelDiscoveryState({
          account: refreshedAccount,
          checkedAt,
          status: 'abnormal',
          lastModelSyncError: errorText,
        }).catch(() => {});
      }
    }
  }

  return snapshot;
}

export async function recordOauthQuotaResetHint(input: {
  accountId: number;
  statusCode: number;
  errorText?: string | null;
}): Promise<OauthQuotaSnapshot | null> {
  const resetHint = parseCodexQuotaResetHint(input.statusCode, input.errorText);
  if (!resetHint) return null;

  const account = await db.select().from(schema.accounts).where(eq(schema.accounts.id, input.accountId)).get();
  if (!account) return null;
  const oauth = getOauthInfoFromAccount(account);
  if (!oauth || oauth.provider !== 'codex') return null;

  const baseSnapshot = buildQuotaSnapshotFromOauthInfo({
    ...oauth,
    quota: {
      ...normalizeStoredQuotaSnapshot(oauth.quota),
      status: 'supported',
      source: 'reverse_engineered',
      lastLimitResetAt: resetHint.resetAt,
      providerMessage: 'current codex oauth signals do not expose stable 5h/7d remaining values',
      windows: normalizeStoredQuotaSnapshot(oauth.quota)?.windows || buildCodexUnsupportedWindows(),
    },
  });

  return persistQuotaSnapshot(input.accountId, {
    ...baseSnapshot,
    lastSyncAt: new Date().toISOString(),
    lastLimitResetAt: resetHint.resetAt,
  });
}
