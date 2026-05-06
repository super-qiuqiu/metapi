import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getInsertedRowId } from '../db/insertHelpers.js';
import { getAdapter } from './platforms/index.js';
import {
  ACCOUNT_TOKEN_VALUE_STATUS_READY,
  ensureDefaultTokenForAccount,
  getPreferredAccountToken,
  isMaskedTokenValue,
  isUsableAccountToken,
} from './accountTokenService.js';
import {
  getCredentialModeFromExtraConfig,
  mergeAccountExtraConfig,
  resolveProxyUrlFromExtraConfig,
  requiresManagedAccountTokens,
  resolvePlatformUserId,
  supportsDirectAccountRoutingConnection,
} from './accountExtraConfig.js';
import { invalidateTokenRouterCache } from './tokenRouter.js';
import { getBlockedBrandRules, isModelBlockedByBrand } from './brandMatcher.js';
import { config } from '../config.js';
import { setAccountRuntimeHealth } from './accountHealthService.js';
import { clearAllRouteDecisionSnapshots } from './routeDecisionSnapshotStore.js';
import { withAccountProxyOverride } from './siteProxy.js';
import { isCodexPlatform } from './oauth/codexAccount.js';
import { buildStoredOauthStateFromAccount, getOauthInfoFromAccount } from './oauth/oauthAccount.js';
import { refreshOauthAccessTokenSingleflight } from './oauth/refreshSingleflight.js';
import { listEnabledOauthRouteUnitsWithMembers } from './oauth/routeUnitService.js';
import { requireSiteApiBaseUrl } from './siteApiEndpointService.js';
import {
  discoverAntigravityModelsFromCloud,
  discoverClaudeModelsFromCloud,
  discoverCodexModelsFromCloud,
  validateGeminiCliOauthConnection,
} from './platformDiscoveryRegistry.js';

const API_TOKEN_DISCOVERY_TIMEOUT_MS = 8_000;
const MODEL_DISCOVERY_TIMEOUT_MS = 12_000;
const MODEL_REFRESH_BATCH_SIZE = 3;
const GEMINI_CLI_STATIC_MODELS = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-3-pro-preview',
  'gemini-3.1-pro-preview',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite-preview',
];
let inFlightRefreshModelsAndRebuildRoutes: Promise<{
  refresh: ModelRefreshResult[];
  rebuild: Awaited<ReturnType<typeof rebuildTokenRoutesFromAvailability>>;
}> | null = null;

type ModelRefreshErrorCode = 'timeout' | 'unauthorized' | 'empty_models' | 'unknown';
type ModelRefreshSkipCode = 'site_disabled' | 'adapter_or_status';

export type ModelRefreshAccountNotFoundResult = {
  accountId: number;
  refreshed: false;
  status: 'failed';
  errorCode: 'account_not_found';
  errorMessage: '账号不存在';
  modelCount: 0;
  modelsPreview: string[];
  reason: 'account_not_found';
};

export type ModelRefreshSkippedResult = {
  accountId: number;
  refreshed: false;
  status: 'skipped';
  errorCode: ModelRefreshSkipCode;
  errorMessage: string;
  modelCount: 0;
  modelsPreview: string[];
  reason: ModelRefreshSkipCode;
};

export type ModelRefreshFailureResult = {
  accountId: number;
  refreshed: true;
  status: 'failed';
  errorCode: ModelRefreshErrorCode;
  errorMessage: string;
  modelCount: 0;
  modelsPreview: string[];
  tokenScanned: number;
  discoveredByCredential: boolean;
  discoveredApiToken: boolean;
};

export type ModelRefreshSuccessResult = {
  accountId: number;
  refreshed: true;
  status: 'success';
  errorCode: null;
  errorMessage: '';
  modelCount: number;
  modelsPreview: string[];
  tokenScanned: number;
  discoveredByCredential: boolean;
  discoveredApiToken: boolean;
};

export type ModelRefreshResult =
  | ModelRefreshAccountNotFoundResult
  | ModelRefreshSkippedResult
  | ModelRefreshFailureResult
  | ModelRefreshSuccessResult;

type ModelDiscoveryAccountRow = typeof schema.accounts.$inferSelect;
const REFRESHED_OAUTH_ACCOUNT = Symbol('refreshedOauthAccount');

function throwWithRefreshedOauthAccount(error: unknown, account: ModelDiscoveryAccountRow): never {
  if (error && typeof error === 'object') {
    Object.defineProperty(error, REFRESHED_OAUTH_ACCOUNT, {
      value: account,
      configurable: true,
    });
    throw error;
  }

  const wrapped = new Error(String(error || 'oauth model discovery failed'));
  Object.defineProperty(wrapped, REFRESHED_OAUTH_ACCOUNT, {
    value: account,
    configurable: true,
  });
  throw wrapped;
}

function getRefreshedOauthAccountFromError(error: unknown): ModelDiscoveryAccountRow | null {
  if (!error || typeof error !== 'object') return null;
  return (
    (error as Record<symbol, ModelDiscoveryAccountRow | undefined>)[REFRESHED_OAUTH_ACCOUNT]
    || null
  );
}

function looksLikeHtmlJsonParseError(message: string): boolean {
  const lowered = String(message || '').trim().toLowerCase();
  return (
    lowered.includes('unexpected token')
    && lowered.includes('not valid json')
    && (lowered.includes('<html') || lowered.includes('<script'))
  );
}

function looksLikeShieldChallenge(message: string): boolean {
  const lowered = String(message || '').trim().toLowerCase();
  return (
    lowered.includes('acw_sc__v2')
    || lowered.includes('var arg1')
    || lowered.includes('captcha')
    || lowered.includes('challenge')
    || lowered.includes('cloudflare tunnel error')
  );
}

function classifyModelDiscoveryError(message: string): ModelRefreshErrorCode {
  const lowered = message.toLowerCase();
  if (lowered.includes('timeout') || lowered.includes('timed out') || lowered.includes('请求超时')) return 'timeout';
  if (lowered.includes('http 401') || lowered.includes('http 403')
    || lowered.includes('unauthorized') || lowered.includes('invalid')
    || lowered.includes('无权') || lowered.includes('未提供令牌')) return 'unauthorized';
  return 'unknown';
}

function buildModelFailureMessage(code: ModelRefreshErrorCode, fallback?: string, platform?: string | null) {
  const raw = String(fallback || '').trim();
  if (looksLikeHtmlJsonParseError(raw) || looksLikeShieldChallenge(raw)) {
    const normalizedPlatform = String(platform || '').trim().toLowerCase();
    if (normalizedPlatform === 'new-api' || normalizedPlatform === 'anyrouter') {
      return '模型获取失败：站点返回了防护页面，请在目标站点创建 API Key 后再同步模型';
    }
    return '模型获取失败：站点返回了网页而不是 JSON 响应';
  }
  if (code === 'timeout') return '模型获取失败（请求超时）';
  if (code === 'unauthorized') return '模型获取失败，API Key 已无效';
  if (code === 'empty_models') return '模型获取失败：未获取到可用模型';
  return fallback || '模型获取失败';
}

function isSiteDisabled(status?: string | null): boolean {
  return (status || 'active') === 'disabled';
}

function normalizeModels(models: string[]): string[] {
  const normalizedModels: string[] = [];
  const seen = new Set<string>();

  for (const rawModel of models) {
    if (typeof rawModel !== 'string') continue;
    const modelName = rawModel.trim();
    if (!modelName) continue;

    // Keep app/database behavior stable across SQLite/MySQL by deduping with a
    // case-insensitive key after trimming whitespace.
    const dedupeKey = modelName.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    normalizedModels.push(modelName);
  }

  return normalizedModels;
}

export async function updateOauthModelDiscoveryState(input: {
  account: typeof schema.accounts.$inferSelect;
  checkedAt: string;
  status: 'healthy' | 'abnormal';
  lastModelSyncError?: string;
  lastDiscoveredModels?: string[];
}) {
  const oauth = getOauthInfoFromAccount(input.account);
  if (!oauth) return input.account.extraConfig || null;
  const extraConfig = mergeAccountExtraConfig(input.account.extraConfig, {
    oauth: buildStoredOauthStateFromAccount(input.account, {
      provider: oauth.provider,
      modelDiscoveryStatus: input.status,
      lastModelSyncAt: input.checkedAt,
      lastModelSyncError: input.lastModelSyncError,
      lastDiscoveredModels: input.lastDiscoveredModels ?? [],
    }),
  });
  await db.update(schema.accounts).set({
    extraConfig,
    updatedAt: input.checkedAt,
  }).where(eq(schema.accounts.id, input.account.id)).run();
  return extraConfig;
}

function isExactModelPattern(modelPattern: string): boolean {
  const normalized = modelPattern.trim();
  if (!normalized) return false;
  if (normalized.toLowerCase().startsWith('re:')) return false;
  return !/[\*\?]/.test(normalized);
}

async function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function buildAccountNotFoundRefreshResult(accountId: number): ModelRefreshAccountNotFoundResult {
  return {
    accountId,
    refreshed: false,
    status: 'failed',
    errorCode: 'account_not_found',
    errorMessage: '账号不存在',
    modelCount: 0,
    modelsPreview: [],
    reason: 'account_not_found',
  };
}

function buildSkippedRefreshResult(
  accountId: number,
  code: ModelRefreshSkipCode,
  errorMessage: string,
): ModelRefreshSkippedResult {
  return {
    accountId,
    refreshed: false,
    status: 'skipped',
    errorCode: code,
    errorMessage,
    modelCount: 0,
    modelsPreview: [],
    reason: code,
  };
}

function buildFailedRefreshResult(input: {
  accountId: number;
  errorCode: ModelRefreshErrorCode;
  errorMessage: string;
  tokenScanned: number;
  discoveredByCredential: boolean;
  discoveredApiToken: boolean;
}): ModelRefreshFailureResult {
  return {
    accountId: input.accountId,
    refreshed: true,
    status: 'failed',
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
    modelCount: 0,
    modelsPreview: [],
    tokenScanned: input.tokenScanned,
    discoveredByCredential: input.discoveredByCredential,
    discoveredApiToken: input.discoveredApiToken,
  };
}

function buildSuccessfulRefreshResult(input: {
  accountId: number;
  modelCount: number;
  modelsPreview: string[];
  tokenScanned: number;
  discoveredByCredential: boolean;
  discoveredApiToken: boolean;
}): ModelRefreshSuccessResult {
  return {
    accountId: input.accountId,
    refreshed: true,
    status: 'success',
    errorCode: null,
    errorMessage: '',
    modelCount: input.modelCount,
    modelsPreview: input.modelsPreview,
    tokenScanned: input.tokenScanned,
    discoveredByCredential: input.discoveredByCredential,
    discoveredApiToken: input.discoveredApiToken,
  };
}

function shouldRetryModelDiscoveryWithOauthRefresh(error: unknown): boolean {
  const message = ((error as { message?: string })?.message || '').toLowerCase();
  return message.includes('http 401')
    || message.includes('unauthorized')
    || message.includes('unauthenticated');
}

async function retryOauthModelDiscoveryWithRefresh<T>(input: {
  account: ModelDiscoveryAccountRow;
  attempt: (account: ModelDiscoveryAccountRow) => Promise<T>;
}): Promise<{ result: T; account: ModelDiscoveryAccountRow }> {
  let discoveryAccount = input.account;

  try {
    return {
      result: await input.attempt(discoveryAccount),
      account: discoveryAccount,
    };
  } catch (error) {
    if (!shouldRetryModelDiscoveryWithOauthRefresh(error)) {
      throw error;
    }

    await refreshOauthAccessTokenSingleflight(discoveryAccount.id);
    const refreshedAccount = await db.select().from(schema.accounts)
      .where(eq(schema.accounts.id, discoveryAccount.id))
      .get();
    if (!refreshedAccount) {
      throw error;
    }

    discoveryAccount = refreshedAccount;
    try {
      return {
        result: await input.attempt(discoveryAccount),
        account: discoveryAccount,
      };
    } catch (retryError) {
      throwWithRefreshedOauthAccount(retryError, discoveryAccount);
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 1: discoverOauthModels — network-only, no DB writes
// ---------------------------------------------------------------------------
export type OauthDiscoveryResult = {
  models: string[] | null;
  discoveryAccount: ModelDiscoveryAccountRow;
  checkedAt: string;
  latencyMs: number;
  errorCode?: ModelRefreshErrorCode;
  errorMessage?: string;
  provider: string;
  // snapshot for rollback (collected in discover, used by persist)
  previousModelAvailability: any[];
  previousAccountTokens: any[];
  previousTokenModelAvailability: any[];
};

export async function discoverOauthModels(input: {
  accountId: number;
  allowInactive?: boolean;
}): Promise<OauthDiscoveryResult | ModelRefreshAccountNotFoundResult | ModelRefreshSkippedResult> {
  const row = await db.select().from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(eq(schema.accounts.id, input.accountId))
    .get();

  if (!row) {
    return buildAccountNotFoundRefreshResult(input.accountId);
  }

  const account = row.accounts;
  const site = row.sites;
  const oauth = getOauthInfoFromAccount(account);
  const accountProxyUrl = resolveProxyUrlFromExtraConfig(account.extraConfig);

  if (isSiteDisabled(site.status)) {
    return buildSkippedRefreshResult(input.accountId, 'site_disabled', '站点已禁用');
  }

  if (account.status !== 'active' && !input.allowInactive) {
    return buildSkippedRefreshResult(input.accountId, 'adapter_or_status', '平台不可用或账号未激活');
  }

  // Only OAuth providers are handled here
  if (!oauth || !['codex', 'claude', 'gemini-cli', 'antigravity'].includes(oauth.provider)) {
    return buildSkippedRefreshResult(input.accountId, 'adapter_or_status', '非 OAuth 提供商，不走 discover 阶段');
  }

  // Snapshot previous availability for rollback
  const restoreAvailabilityOnFailure = input.allowInactive === true;
  const previousAccountTokens = restoreAvailabilityOnFailure
    ? await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, input.accountId))
      .all()
    : [];
  const previousModelAvailability = restoreAvailabilityOnFailure
    ? await db.select()
      .from(schema.modelAvailability)
      .where(and(
        eq(schema.modelAvailability.accountId, input.accountId),
        eq(schema.modelAvailability.isManual, false),
      ))
      .all()
    : [];
  const previousTokenModelAvailability = restoreAvailabilityOnFailure
    ? (await Promise.all(previousAccountTokens.map(async (token) => db.select()
      .from(schema.tokenModelAvailability)
      .where(eq(schema.tokenModelAvailability.tokenId, token.id))
      .all()))).flat()
    : [];

  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  let discoveryAccount = account;

  // --- codex ---
  if (oauth.provider === 'codex') {
    try {
      const { result: codexModels, account: refreshedAccount } = await retryOauthModelDiscoveryWithRefresh({
        account,
        attempt: async (candidateAccount) => withTimeout(
          () => withAccountProxyOverride(accountProxyUrl,
            () => discoverCodexModelsFromCloud({ site, account: candidateAccount })),
          MODEL_DISCOVERY_TIMEOUT_MS,
          `codex model discovery timeout (${Math.round(MODEL_DISCOVERY_TIMEOUT_MS / 1000)}s)`,
        ),
      });
      discoveryAccount = refreshedAccount;
      if (codexModels.length === 0) {
        throw new Error('未获取到可用模型');
      }
      return {
        models: codexModels,
        discoveryAccount,
        checkedAt,
        latencyMs: Date.now() - startedAt,
        provider: 'codex',
        previousModelAvailability,
        previousAccountTokens,
        previousTokenModelAvailability,
      };
    } catch (err) {
      discoveryAccount = getRefreshedOauthAccountFromError(err) || discoveryAccount;
      const rawMessage = (err as { message?: string })?.message || 'codex model discovery failed';
      const errorCode = classifyModelDiscoveryError(rawMessage);
      const errorMessage = `Codex 模型获取失败（${rawMessage}）`;
      return {
        models: null,
        discoveryAccount,
        checkedAt,
        latencyMs: Date.now() - startedAt,
        errorCode,
        errorMessage,
        provider: 'codex',
        previousModelAvailability,
        previousAccountTokens,
        previousTokenModelAvailability,
      };
    }
  }

  // --- claude ---
  if (oauth.provider === 'claude') {
    try {
      const { result: claudeModels, account: refreshedAccount } = await retryOauthModelDiscoveryWithRefresh({
        account,
        attempt: async (candidateAccount) => withTimeout(
          () => withAccountProxyOverride(accountProxyUrl,
            () => discoverClaudeModelsFromCloud({ site, account: candidateAccount })),
          MODEL_DISCOVERY_TIMEOUT_MS,
          `claude oauth model discovery timeout (${Math.round(MODEL_DISCOVERY_TIMEOUT_MS / 1000)}s)`,
        ),
      });
      discoveryAccount = refreshedAccount;
      if (claudeModels.length === 0) {
        throw new Error('未获取到可用模型');
      }
      return {
        models: claudeModels,
        discoveryAccount,
        checkedAt,
        latencyMs: Date.now() - startedAt,
        provider: 'claude',
        previousModelAvailability,
        previousAccountTokens,
        previousTokenModelAvailability,
      };
    } catch (err) {
      discoveryAccount = getRefreshedOauthAccountFromError(err) || discoveryAccount;
      const rawMessage = (err as { message?: string })?.message || 'claude oauth model discovery failed';
      const errorCode = classifyModelDiscoveryError(rawMessage);
      const errorMessage = `Claude OAuth 模型获取失败（${rawMessage}）`;
      return {
        models: null,
        discoveryAccount,
        checkedAt,
        latencyMs: Date.now() - startedAt,
        errorCode,
        errorMessage,
        provider: 'claude',
        previousModelAvailability,
        previousAccountTokens,
        previousTokenModelAvailability,
      };
    }
  }

  // --- gemini-cli ---
  if (oauth.provider === 'gemini-cli') {
    try {
      try {
        await withTimeout(
          () => withAccountProxyOverride(accountProxyUrl,
            () => validateGeminiCliOauthConnection({ site, account: discoveryAccount })),
          MODEL_DISCOVERY_TIMEOUT_MS,
          `gemini cli oauth validation timeout (${Math.round(MODEL_DISCOVERY_TIMEOUT_MS / 1000)}s)`,
        );
      } catch (error) {
        if (!shouldRetryModelDiscoveryWithOauthRefresh(error)) {
          throw error;
        }
        const refreshed = await refreshOauthAccessTokenSingleflight(discoveryAccount.id);
        if (!refreshed?.extraConfig) {
          throw error;
        }
        discoveryAccount = {
          ...discoveryAccount,
          accessToken: refreshed.accessToken,
          extraConfig: refreshed.extraConfig,
        };
        await withTimeout(
          () => withAccountProxyOverride(accountProxyUrl,
            () => validateGeminiCliOauthConnection({ site, account: discoveryAccount })),
          MODEL_DISCOVERY_TIMEOUT_MS,
          `gemini cli oauth validation timeout (${Math.round(MODEL_DISCOVERY_TIMEOUT_MS / 1000)}s)`,
        );
      }
      return {
        models: [...GEMINI_CLI_STATIC_MODELS],
        discoveryAccount,
        checkedAt,
        latencyMs: Date.now() - startedAt,
        provider: 'gemini-cli',
        previousModelAvailability,
        previousAccountTokens,
        previousTokenModelAvailability,
      };
    } catch (err) {
      const rawMessage = (err as { message?: string })?.message || 'gemini cli oauth validation failed';
      const errorCode = classifyModelDiscoveryError(rawMessage);
      const errorMessage = `Gemini CLI 模型获取失败（${rawMessage}）`;
      return {
        models: null,
        discoveryAccount,
        checkedAt,
        latencyMs: Date.now() - startedAt,
        errorCode,
        errorMessage,
        provider: 'gemini-cli',
        previousModelAvailability,
        previousAccountTokens,
        previousTokenModelAvailability,
      };
    }
  }

  // --- antigravity ---
  if (oauth.provider === 'antigravity') {
    try {
      const { result: antigravityModels, account: refreshedAccount } = await retryOauthModelDiscoveryWithRefresh({
        account,
        attempt: async (candidateAccount) => withTimeout(
          () => withAccountProxyOverride(accountProxyUrl,
            () => discoverAntigravityModelsFromCloud({ site, account: candidateAccount })),
          MODEL_DISCOVERY_TIMEOUT_MS,
          `antigravity model discovery timeout (${Math.round(MODEL_DISCOVERY_TIMEOUT_MS / 1000)}s)`,
        ),
      });
      discoveryAccount = refreshedAccount;
      if (antigravityModels.length === 0) {
        throw new Error('未获取到可用模型');
      }
      return {
        models: antigravityModels,
        discoveryAccount,
        checkedAt,
        latencyMs: Date.now() - startedAt,
        provider: 'antigravity',
        previousModelAvailability,
        previousAccountTokens,
        previousTokenModelAvailability,
      };
    } catch (err) {
      discoveryAccount = getRefreshedOauthAccountFromError(err) || discoveryAccount;
      const rawMessage = (err as { message?: string })?.message || 'antigravity model discovery failed';
      const errorCode = classifyModelDiscoveryError(rawMessage);
      const errorMessage = `Antigravity 模型获取失败（${rawMessage}）`;
      return {
        models: null,
        discoveryAccount,
        checkedAt,
        latencyMs: Date.now() - startedAt,
        errorCode,
        errorMessage,
        provider: 'antigravity',
        previousModelAvailability,
        previousAccountTokens,
        previousTokenModelAvailability,
      };
    }
  }

  // Unreachable, but satisfy TS
  return buildSkippedRefreshResult(input.accountId, 'adapter_or_status', '非 OAuth 提供商');
}

// ---------------------------------------------------------------------------
// Phase 2: persistModelAvailability — DB writes only
// ---------------------------------------------------------------------------
async function clearExistingAvailabilityForAccount(accountId: number) {
  await db.delete(schema.modelAvailability)
    .where(and(
      eq(schema.modelAvailability.accountId, accountId),
      eq(schema.modelAvailability.isManual, false),
    ))
    .run();

  const currentAccountTokens = await db.select({ id: schema.accountTokens.id })
    .from(schema.accountTokens)
    .where(eq(schema.accountTokens.accountId, accountId))
    .all();

  for (const token of currentAccountTokens) {
    await db.delete(schema.tokenModelAvailability)
      .where(eq(schema.tokenModelAvailability.tokenId, token.id))
      .run();
  }
}

async function restorePreviousAvailabilityForAccount(input: {
  accountId: number;
  previousModelAvailability: any[];
  previousAccountTokens: any[];
  previousTokenModelAvailability: any[];
}) {
  await clearExistingAvailabilityForAccount(input.accountId);
  if (input.previousModelAvailability.length > 0) {
    await db.insert(schema.modelAvailability).values(
      input.previousModelAvailability.map(({ id: _id, ...row }: any) => row),
    ).run();
  }
  if (input.previousTokenModelAvailability.length > 0) {
    await db.insert(schema.tokenModelAvailability).values(
      input.previousTokenModelAvailability.map(({ id: _id, ...row }: any) => row),
    ).run();
  }
}

export async function persistModelAvailability(input: {
  accountId: number;
  models: string[];
  discoveryAccount: ModelDiscoveryAccountRow;
  checkedAt: string;
  latencyMs: number;
  provider: string;
  previousModelAvailability: any[];
  previousAccountTokens: any[];
  previousTokenModelAvailability: any[];
  allowInactive?: boolean;
}): Promise<ModelRefreshResult> {
  const { accountId, models, discoveryAccount, checkedAt, latencyMs, provider } = input;

  // Clear existing availability (non-manual)
  await clearExistingAvailabilityForAccount(accountId);

  // Collect manual model names for dedup
  const manualModelNames = new Set(
    (await db.select({ modelName: schema.modelAvailability.modelName })
      .from(schema.modelAvailability)
      .where(and(
        eq(schema.modelAvailability.accountId, accountId),
        eq(schema.modelAvailability.isManual, true),
      ))
      .all()
    ).map((r) => r.modelName.toLowerCase()),
  );

  const newModels = models.filter((m) => !manualModelNames.has(m.toLowerCase()));
  if (newModels.length > 0) {
    await db.insert(schema.modelAvailability).values(
      newModels.map((modelName) => ({
        accountId,
        modelName,
        available: true,
        latencyMs,
        checkedAt,
      })),
    ).run();
  }

  // Provider-specific health labels
  const healthReasonMap: Record<string, string> = {
    codex: 'Codex 云端模型探测成功',
    claude: 'Claude OAuth 模型探测成功',
    'gemini-cli': 'Gemini CLI OAuth 健康探测成功',
    antigravity: 'Antigravity OAuth 健康探测成功',
  };

  await updateOauthModelDiscoveryState({
    account: discoveryAccount,
    checkedAt,
    status: 'healthy',
    lastDiscoveredModels: models,
  });
  await setAccountRuntimeHealth(accountId, {
    state: 'healthy',
    reason: healthReasonMap[provider] || 'OAuth 模型探测成功',
    source: 'model-discovery',
    checkedAt,
  });

  return buildSuccessfulRefreshResult({
    accountId,
    modelCount: models.length,
    modelsPreview: models.slice(0, 10),
    tokenScanned: 0,
    discoveredByCredential: true,
    discoveredApiToken: false,
  });
}

// ---------------------------------------------------------------------------
// persistModelAvailabilityBatch — batch version for import stream Phase 2
// Replaces multiple sequential persistModelAvailability calls within a group
// sharing the same discovery result.
// ---------------------------------------------------------------------------

export async function persistModelAvailabilityBatch(input: {
  items: Array<{
    accountId: number;
    models: string[];
    discoveryAccount: ModelDiscoveryAccountRow;
    checkedAt: string;
    latencyMs: number;
    provider: string;
    previousModelAvailability: any[];
    previousAccountTokens: any[];
    previousTokenModelAvailability: any[];
    allowInactive?: boolean;
  }>;
}): Promise<void> {
  const { items } = input;
  if (items.length === 0) return;

  const accountIds = items.map((item) => item.accountId);

  // 1. Batch delete non-manual modelAvailability rows for all accounts
  await db.delete(schema.modelAvailability)
    .where(and(
      inArray(schema.modelAvailability.accountId, accountIds),
      eq(schema.modelAvailability.isManual, false),
    ))
    .run();

  // 2. Batch delete tokenModelAvailability for all accounts' tokens
  const accountTokenRows = await db.select({ id: schema.accountTokens.id, accountId: schema.accountTokens.accountId })
    .from(schema.accountTokens)
    .where(inArray(schema.accountTokens.accountId, accountIds))
    .all();

  const tokenIdsByAccount = new Map<number, number[]>();
  for (const row of accountTokenRows) {
    if (!tokenIdsByAccount.has(row.accountId)) tokenIdsByAccount.set(row.accountId, []);
    tokenIdsByAccount.get(row.accountId)!.push(row.id);
  }

  if (accountTokenRows.length > 0) {
    const allTokenIds = accountTokenRows.map((r) => r.id);
    await db.delete(schema.tokenModelAvailability)
      .where(inArray(schema.tokenModelAvailability.tokenId, allTokenIds))
      .run();
  }

  // 3. Batch query manual model names for all accounts
  const manualRows = await db.select({ accountId: schema.modelAvailability.accountId, modelName: schema.modelAvailability.modelName })
    .from(schema.modelAvailability)
    .where(and(
      inArray(schema.modelAvailability.accountId, accountIds),
      eq(schema.modelAvailability.isManual, true),
    ))
    .all();

  const manualByAccount = new Map<number, Set<string>>();
  for (const row of manualRows) {
    if (!manualByAccount.has(row.accountId)) manualByAccount.set(row.accountId, new Set());
    manualByAccount.get(row.accountId)!.add(row.modelName.toLowerCase());
  }

  // 4. Collect all new model rows across all items, batch insert
  const allValues = items.flatMap((item) => {
    const manualNames = manualByAccount.get(item.accountId) || new Set<string>();
    const newModels = item.models.filter((m) => !manualNames.has(m.toLowerCase()));
    return newModels.map((modelName) => ({
      accountId: item.accountId,
      modelName,
      available: true as boolean,
      latencyMs: item.latencyMs,
      checkedAt: item.checkedAt,
    }));
  });

  if (allValues.length > 0) {
    await db.insert(schema.modelAvailability).values(allValues).run();
  }

  // 5. Per-account: updateOauthModelDiscoveryState + setAccountRuntimeHealth
  //    (these involve extraConfig JSON operations, must be per-account)
  const healthReasonMap: Record<string, string> = {
    codex: 'Codex 云端模型探测成功',
    claude: 'Claude OAuth 模型探测成功',
    'gemini-cli': 'Gemini CLI OAuth 健康探测成功',
    antigravity: 'Antigravity OAuth 健康探测成功',
  };

  // Batch-fetch account rows for all items so we can update each account's
  // own extraConfig (not just the discovery representative's).
  const uniqueAccountIds = [...new Set(items.map((item) => item.accountId))];
  const accountRows = await db.select().from(schema.accounts)
    .where(inArray(schema.accounts.id, uniqueAccountIds))
    .all();
  const accountById = new Map<number, ModelDiscoveryAccountRow>(
    accountRows.map((a) => [a.id, a] as const),
  );

  for (const item of items) {
    const ownAccount: ModelDiscoveryAccountRow =
      accountById.get(item.accountId) ?? item.discoveryAccount;
    await updateOauthModelDiscoveryState({
      account: ownAccount,
      checkedAt: item.checkedAt,
      status: 'healthy',
      lastDiscoveredModels: item.models,
    });
    await setAccountRuntimeHealth(item.accountId, {
      state: 'healthy',
      reason: healthReasonMap[item.provider] || 'OAuth 模型探测成功',
      source: 'model-discovery',
      checkedAt: item.checkedAt,
    });
  }
}

async function persistModelAvailabilityFailure(input: {
  accountId: number;
  discoveryAccount: ModelDiscoveryAccountRow;
  checkedAt: string;
  errorCode: ModelRefreshErrorCode;
  errorMessage: string;
  provider: string;
  previousModelAvailability: any[];
  previousAccountTokens: any[];
  previousTokenModelAvailability: any[];
  allowInactive?: boolean;
}): Promise<ModelRefreshFailureResult> {
  const { accountId, discoveryAccount, checkedAt, errorCode, errorMessage } = input;

  await updateOauthModelDiscoveryState({
    account: discoveryAccount,
    checkedAt,
    status: 'abnormal',
    lastModelSyncError: errorMessage,
    lastDiscoveredModels: [],
  });
  await setAccountRuntimeHealth(input.discoveryAccount.id, {
    state: 'unhealthy',
    reason: errorMessage,
    source: 'model-discovery',
    checkedAt,
  });

  // Restore previous availability on failure
  if (input.allowInactive === true) {
    await restorePreviousAvailabilityForAccount({
      accountId,
      previousModelAvailability: input.previousModelAvailability,
      previousAccountTokens: input.previousAccountTokens,
      previousTokenModelAvailability: input.previousTokenModelAvailability,
    });
  }

  return buildFailedRefreshResult({
    accountId,
    errorCode,
    errorMessage,
    tokenScanned: 0,
    discoveredByCredential: false,
    discoveredApiToken: false,
  });
}

// ---------------------------------------------------------------------------
// refreshModelsForAccount — composed from discover + persist (OAuth) or
// original adapter logic (non-OAuth)
// ---------------------------------------------------------------------------
export async function refreshModelsForAccount(
  accountId: number,
  options?: { allowInactive?: boolean },
): Promise<ModelRefreshResult> {
  // --- OAuth path: discover + persist ---
  const discovery = await discoverOauthModels({ accountId, allowInactive: options?.allowInactive });

  // If discovery returned a not-found or skipped result, pass through
  if ('status' in discovery && (discovery.status === 'failed' && 'reason' in discovery && discovery.reason === 'account_not_found')) {
    return discovery as ModelRefreshAccountNotFoundResult;
  }
  if ('status' in discovery && discovery.status === 'skipped') {
    // Check if it's a real skip (site_disabled / adapter_or_status for non-OAuth)
    const skipped = discovery as ModelRefreshSkippedResult;
    if (skipped.errorCode === 'site_disabled' || (skipped.errorCode === 'adapter_or_status' && skipped.errorMessage !== '非 OAuth 提供商，不走 discover 阶段')) {
      return skipped;
    }
    // "非 OAuth 提供商" falls through to adapter logic below
  }

  // OAuth discovery succeeded or failed with models info
  if ('models' in discovery) {
    const oauthResult = discovery as OauthDiscoveryResult;

    if (oauthResult.models !== null) {
      return persistModelAvailability({
        accountId,
        models: oauthResult.models,
        discoveryAccount: oauthResult.discoveryAccount,
        checkedAt: oauthResult.checkedAt,
        latencyMs: oauthResult.latencyMs,
        provider: oauthResult.provider,
        previousModelAvailability: oauthResult.previousModelAvailability,
        previousAccountTokens: oauthResult.previousAccountTokens,
        previousTokenModelAvailability: oauthResult.previousTokenModelAvailability,
        allowInactive: options?.allowInactive,
      });
    } else {
      return persistModelAvailabilityFailure({
        accountId,
        discoveryAccount: oauthResult.discoveryAccount,
        checkedAt: oauthResult.checkedAt,
        errorCode: oauthResult.errorCode!,
        errorMessage: oauthResult.errorMessage!,
        provider: oauthResult.provider,
        previousModelAvailability: oauthResult.previousModelAvailability,
        previousAccountTokens: oauthResult.previousAccountTokens,
        previousTokenModelAvailability: oauthResult.previousTokenModelAvailability,
        allowInactive: options?.allowInactive,
      });
    }
  }

  // --- Adapter (non-OAuth) path: original logic ---
  const row = await db.select().from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(eq(schema.accounts.id, accountId))
    .get();

  if (!row) {
    return buildAccountNotFoundRefreshResult(accountId);
  }

  const account = row.accounts;
  const site = row.sites;
  const adapter = getAdapter(site.platform);
  const accountProxyUrl = resolveProxyUrlFromExtraConfig(account.extraConfig);

  const restoreAvailabilityOnFailure = options?.allowInactive === true;
  const previousAccountTokens = restoreAvailabilityOnFailure
    ? await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, accountId))
      .all()
    : [];
  const previousModelAvailability = restoreAvailabilityOnFailure
    ? await db.select()
      .from(schema.modelAvailability)
      .where(and(
        eq(schema.modelAvailability.accountId, accountId),
        eq(schema.modelAvailability.isManual, false),
      ))
      .all()
    : [];
  const previousTokenModelAvailability = restoreAvailabilityOnFailure
    ? (await Promise.all(previousAccountTokens.map(async (token) => db.select()
      .from(schema.tokenModelAvailability)
      .where(eq(schema.tokenModelAvailability.tokenId, token.id))
      .all()))).flat()
    : [];

  const restorePreviousAvailability = async () => {
    if (!restoreAvailabilityOnFailure) return;
    await clearExistingAvailabilityForAccount(accountId);
    if (previousModelAvailability.length > 0) {
      await db.insert(schema.modelAvailability).values(
        previousModelAvailability.map(({ id: _id, ...row }) => row),
      ).run();
    }
    if (previousTokenModelAvailability.length > 0) {
      await db.insert(schema.tokenModelAvailability).values(
        previousTokenModelAvailability.map(({ id: _id, ...row }) => row),
      ).run();
    }
  };

  await clearExistingAvailabilityForAccount(accountId);

  // Collect manual model names so discovered models that collide are skipped (unique index).
  const manualModelNames = new Set(
    (await db.select({ modelName: schema.modelAvailability.modelName })
      .from(schema.modelAvailability)
      .where(and(
        eq(schema.modelAvailability.accountId, accountId),
        eq(schema.modelAvailability.isManual, true),
      ))
      .all()
    ).map((r) => r.modelName.toLowerCase()),
  );

  if (isSiteDisabled(site.status)) {
    return buildSkippedRefreshResult(accountId, 'site_disabled', '站点已禁用');
  }

  if (account.status !== 'active' && !options?.allowInactive) {
    return buildSkippedRefreshResult(accountId, 'adapter_or_status', '平台不可用或账号未激活');
  }

  if (!adapter) {
    return buildSkippedRefreshResult(accountId, 'adapter_or_status', '平台不可用或账号未激活');
  }

  const platformUserId = resolvePlatformUserId(account.extraConfig, account.username);
  let discoveredApiToken: string | null = null;

  if (!account.apiToken && account.accessToken) {
    try {
      discoveredApiToken = await withTimeout(
        () => withAccountProxyOverride(accountProxyUrl,
          () => adapter.getApiToken(site.url, account.accessToken, platformUserId)),
        API_TOKEN_DISCOVERY_TIMEOUT_MS,
        `api token discovery timeout (${Math.round(API_TOKEN_DISCOVERY_TIMEOUT_MS / 1000)}s)`,
      );
      if (discoveredApiToken && !isMaskedTokenValue(discoveredApiToken)) {
        await ensureDefaultTokenForAccount(account.id, discoveredApiToken, { name: 'default', source: 'sync' });
        await db.update(schema.accounts).set({
          apiToken: discoveredApiToken,
          updatedAt: new Date().toISOString(),
        }).where(eq(schema.accounts.id, account.id)).run();
      } else {
        discoveredApiToken = null;
      }
    } catch { }
  }

  const usesManagedTokens = requiresManagedAccountTokens(account);
  let enabledTokens = usesManagedTokens
    ? await db.select()
      .from(schema.accountTokens)
      .where(and(
        eq(schema.accountTokens.accountId, account.id),
        eq(schema.accountTokens.enabled, true),
        eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
      ))
      .all()
    : [];
  enabledTokens = enabledTokens.filter(isUsableAccountToken);

  // Last fallback: if still no managed token but account has a legacy apiToken, mirror it into token table.
  if (usesManagedTokens && enabledTokens.length === 0) {
    const fallback = discoveredApiToken || account.apiToken || null;
    if (fallback) {
      await ensureDefaultTokenForAccount(account.id, fallback, { name: 'default', source: 'legacy' });
      enabledTokens = await db.select()
        .from(schema.accountTokens)
        .where(and(
          eq(schema.accountTokens.accountId, account.id),
          eq(schema.accountTokens.enabled, true),
          eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
        ))
        .all();
      enabledTokens = enabledTokens.filter(isUsableAccountToken);
    }
  }

  let aiBaseUrl: string;
  try {
    aiBaseUrl = await requireSiteApiBaseUrl(site);
  } catch (err) {
    const rawMessage = (err as { message?: string })?.message || '模型获取失败';
    const errorCode = classifyModelDiscoveryError(rawMessage);
    const errorMessage = rawMessage;
    await setAccountRuntimeHealth(account.id, {
      state: 'unhealthy',
      reason: errorMessage,
      source: 'model-discovery',
      checkedAt: new Date().toISOString(),
    });
    await restorePreviousAvailability();
    return buildFailedRefreshResult({
      accountId,
      errorCode,
      errorMessage,
      tokenScanned: 0,
      discoveredByCredential: false,
      discoveredApiToken: !!discoveredApiToken,
    });
  }

  const accountModels = new Map<string, string>();   // lowercase key → original name (first-wins)
  const modelLatency = new Map<string, number | null>();
  let scannedTokenCount = 0;
  let discoveredByCredential = false;
  const attemptedCredentials = new Set<string>();
  const failureMessages: string[] = [];
  const recordFailure = (err: unknown) => {
    const message = (err as { message?: string })?.message || String(err || '');
    if (message) failureMessages.push(message);
  };

  const mergeDiscoveredModels = (models: string[], latencyMs: number | null) => {
    for (const modelName of models) {
      const key = modelName.toLowerCase();
      if (!accountModels.has(key)) accountModels.set(key, modelName);
      const prev = modelLatency.get(key);
      if (prev === undefined || prev === null) {
        modelLatency.set(key, latencyMs);
        continue;
      }
      if (latencyMs === null) continue;
      if (latencyMs < prev) modelLatency.set(key, latencyMs);
    }
  };

  const discoverModelsWithCredential = async (credentialRaw: string | null | undefined) => {
    const credential = (credentialRaw || '').trim();
    if (!credential) return;
    if (isMaskedTokenValue(credential)) return;
    if (attemptedCredentials.has(credential)) return;
    attemptedCredentials.add(credential);

    const startedAt = Date.now();
    let models: string[] = [];
    try {
      models = normalizeModels(
        await withTimeout(
          () => withAccountProxyOverride(accountProxyUrl,
            () => adapter.getModels(aiBaseUrl, credential, platformUserId)),
          MODEL_DISCOVERY_TIMEOUT_MS,
          `model discovery timeout (${Math.round(MODEL_DISCOVERY_TIMEOUT_MS / 1000)}s)`,
        ),
      );
    } catch (err) {
      recordFailure(err);
      models = [];
    }
    if (models.length === 0) return;
    discoveredByCredential = true;
    const latencyMs = Date.now() - startedAt;
    mergeDiscoveredModels(models, latencyMs);
  };

  // Prefer account-level credential discovery so model availability does not rely on managed tokens.
  await discoverModelsWithCredential(account.apiToken);
  await discoverModelsWithCredential(discoveredApiToken);
  await discoverModelsWithCredential(account.accessToken);

  for (const token of enabledTokens) {
    const startedAt = Date.now();
    let models: string[] = [];

    try {
      models = normalizeModels(
        await withTimeout(
          () => withAccountProxyOverride(accountProxyUrl,
            () => adapter.getModels(aiBaseUrl, token.token, platformUserId)),
          MODEL_DISCOVERY_TIMEOUT_MS,
          `model discovery timeout (${Math.round(MODEL_DISCOVERY_TIMEOUT_MS / 1000)}s)`,
        ),
      );
    } catch (err) {
      recordFailure(err);
      models = [];
    }

    if (models.length === 0) continue;

    const latencyMs = Date.now() - startedAt;
    const checkedAt = new Date().toISOString();

    await db.insert(schema.tokenModelAvailability).values(
      models.map((modelName) => ({
        tokenId: token.id,
        modelName,
        available: true,
        latencyMs,
        checkedAt,
      })),
    ).run();

    scannedTokenCount++;
    mergeDiscoveredModels(models, latencyMs);
  }

  if (accountModels.size === 0) {
    const firstMessage = failureMessages[0] || '';
    const errorCode = firstMessage ? classifyModelDiscoveryError(firstMessage) : 'empty_models';
    const errorMessage = buildModelFailureMessage(errorCode, firstMessage, site.platform);
    await setAccountRuntimeHealth(account.id, {
      state: 'unhealthy',
      reason: errorMessage,
      source: 'model-discovery',
      checkedAt: new Date().toISOString(),
    });
    await restorePreviousAvailability();
    return buildFailedRefreshResult({
      accountId,
      errorCode,
      errorMessage,
      tokenScanned: scannedTokenCount,
      discoveredByCredential,
      discoveredApiToken: !!discoveredApiToken,
    });
  }

  const checkedAt = new Date().toISOString();
  const newAccountModels = Array.from(accountModels.values()).filter((m) => !manualModelNames.has(m.toLowerCase()));
  if (newAccountModels.length > 0) {
    await db.insert(schema.modelAvailability).values(
      newAccountModels.map((modelName) => ({
        accountId: account.id,
        modelName,
        available: true,
        latencyMs: modelLatency.get(modelName.toLowerCase()) ?? null,
        checkedAt,
      })),
    ).run();
  }

  await setAccountRuntimeHealth(account.id, {
    state: 'healthy',
    reason: '模型探测成功',
    source: 'model-discovery',
    checkedAt,
  });

  const modelsPreview = Array.from(accountModels.values()).slice(0, 10);
  return buildSuccessfulRefreshResult({
    accountId,
    modelCount: accountModels.size,
    modelsPreview,
    tokenScanned: scannedTokenCount,
    discoveredByCredential,
    discoveredApiToken: !!discoveredApiToken,
  });
}

async function refreshModelsForAllActiveAccounts(): Promise<ModelRefreshResult[]> {
  const accounts = await db.select({ id: schema.accounts.id }).from(schema.accounts)
    .where(eq(schema.accounts.status, 'active'))
    .all();

  const results: ModelRefreshResult[] = [];
  for (let offset = 0; offset < accounts.length; offset += MODEL_REFRESH_BATCH_SIZE) {
    const batch = accounts.slice(offset, offset + MODEL_REFRESH_BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(async (account) => refreshModelsForAccount(account.id)));
    results.push(...batchResults);
  }
  return results;
}

export async function rebuildTokenRoutesFromAvailability() {
  const tokenRows = await db.select().from(schema.tokenModelAvailability)
    .innerJoin(schema.accountTokens, eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id))
    .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(
      and(
        eq(schema.tokenModelAvailability.available, true),
        eq(schema.accountTokens.enabled, true),
        eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
        eq(schema.accounts.status, 'active'),
        eq(schema.sites.status, 'active'),
      ),
    )
    .all();
  const usableTokenRows = tokenRows.filter((row) => (
    isUsableAccountToken(row.account_tokens)
    && requiresManagedAccountTokens(row.accounts)
  ));

  const accountRows = await db.select().from(schema.modelAvailability)
    .innerJoin(schema.accounts, eq(schema.modelAvailability.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(
      and(
        eq(schema.modelAvailability.available, true),
        eq(schema.accounts.status, 'active'),
        eq(schema.sites.status, 'active'),
      ),
    )
    .all();

  // Load site-level disabled models
  const disabledModelRows = await db.select().from(schema.siteDisabledModels).all();
  const disabledModelsBySite = new Map<number, Set<string>>();
  for (const row of disabledModelRows) {
    if (!disabledModelsBySite.has(row.siteId)) disabledModelsBySite.set(row.siteId, new Set());
    disabledModelsBySite.get(row.siteId)!.add(row.modelName.toLowerCase());
  }

  function isModelDisabledForSite(siteId: number, modelName: string): boolean {
    const disabled = disabledModelsBySite.get(siteId);
    return !!disabled && disabled.has(modelName.toLowerCase());
  }

  // Load global brand filter
  const blockedBrandRules = getBlockedBrandRules(config.globalBlockedBrands);

  // Load global allowed models whitelist
  const globalAllowedModels = new Set(
    config.globalAllowedModels.map((m) => m.toLowerCase().trim()).filter(Boolean),
  );

  function isModelAllowedByWhitelist(modelName: string): boolean {
    // If whitelist is empty, allow all models (backward compatible)
    if (globalAllowedModels.size === 0) return true;
    // Check if model is in whitelist (case-insensitive)
    return globalAllowedModels.has(modelName.toLowerCase().trim());
  }

  const enabledOauthRouteUnits = await listEnabledOauthRouteUnitsWithMembers();
  const routeUnitByAccountId = new Map<number, {
    routeUnitId: number;
    representativeAccountId: number;
  }>();
  for (const routeUnit of enabledOauthRouteUnits) {
    const representativeAccountId = routeUnit.members[0]?.account.id;
    if (!representativeAccountId) continue;
    for (const member of routeUnit.members) {
      routeUnitByAccountId.set(member.account.id, {
        routeUnitId: routeUnit.unit.id,
        representativeAccountId,
      });
    }
  }

  const modelCandidates = new Map<string, Map<string, {
    accountId: number;
    tokenId: number | null;
    oauthRouteUnitId: number | null;
  }>>();
  const buildCandidateKey = (input: {
    accountId: number;
    tokenId: number | null;
    oauthRouteUnitId: number | null;
  }) => (
    input.oauthRouteUnitId
      ? `route-unit:${input.oauthRouteUnitId}`
      : `${input.accountId}:${input.tokenId ?? 'account'}`
  );
  const buildChannelKey = (channel: typeof schema.routeChannels.$inferSelect) => (
    channel.oauthRouteUnitId
      ? `route-unit:${channel.oauthRouteUnitId}`
      : `${channel.accountId}:${channel.tokenId ?? 'account'}`
  );
  const addModelCandidate = (
    modelNameRaw: string | null | undefined,
    accountId: number,
    tokenId: number | null,
    siteId: number,
    oauthRouteUnitId: number | null = null,
  ) => {
    const modelName = (modelNameRaw || '').trim();
    if (!modelName) return;
    if (!isModelAllowedByWhitelist(modelName)) return;
    if (isModelDisabledForSite(siteId, modelName)) return;
    if (blockedBrandRules.length > 0 && isModelBlockedByBrand(modelName, blockedBrandRules)) return;
    if (!modelCandidates.has(modelName)) modelCandidates.set(modelName, new Map());
    const candidate = { accountId, tokenId, oauthRouteUnitId };
    modelCandidates.get(modelName)!.set(buildCandidateKey(candidate), candidate);
  };

  for (const row of usableTokenRows) {
    addModelCandidate(row.token_model_availability.modelName, row.accounts.id, row.account_tokens.id, row.accounts.siteId);
  }

  for (const row of accountRows) {
    if (!supportsDirectAccountRoutingConnection(row.accounts)) continue;
    const routeUnit = routeUnitByAccountId.get(row.accounts.id);
    if (routeUnit) {
      addModelCandidate(
        row.model_availability.modelName,
        routeUnit.representativeAccountId,
        null,
        row.accounts.siteId,
        routeUnit.routeUnitId,
      );
      continue;
    }
    addModelCandidate(row.model_availability.modelName, row.accounts.id, null, row.accounts.siteId);
  }

  const routes = await db.select().from(schema.tokenRoutes).all();
  const channels = await db.select().from(schema.routeChannels).all();

  let createdRoutes = 0;
  let createdChannels = 0;
  let removedChannels = 0;
  let removedRoutes = 0;

  for (const [modelName, candidateMap] of modelCandidates.entries()) {
    let route = routes.find((r) => (r.routeMode || 'pattern') !== 'explicit_group' && r.modelPattern === modelName);
    if (!route) {
      const inserted = await db.insert(schema.tokenRoutes).values({
        modelPattern: modelName,
        enabled: true,
      }).run();
      const insertedId = getInsertedRowId(inserted);
      route = insertedId != null
        ? await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, insertedId)).get()
        : undefined;
      if (!route) continue;
      routes.push(route);
      createdRoutes++;
    }

    const routeChannels = channels.filter((channel) => channel.routeId === route.id);
    const desiredKeys = new Set(Array.from(candidateMap.keys()));

    for (const [candidateKey, candidate] of candidateMap.entries()) {
      const exists = routeChannels.some((channel) => buildChannelKey(channel) === candidateKey);
      if (exists) continue;

      const inserted = await db.insert(schema.routeChannels).values({
        routeId: route.id,
        accountId: candidate.accountId,
        tokenId: candidate.tokenId,
        oauthRouteUnitId: candidate.oauthRouteUnitId,
        priority: 0,
        weight: 10,
        enabled: true,
        manualOverride: false,
      }).run();
      const insertedId = getInsertedRowId(inserted);
      if (insertedId == null) continue;
      const created = await db.select().from(schema.routeChannels).where(eq(schema.routeChannels.id, insertedId)).get();
      if (!created) continue;
      channels.push(created);
      createdChannels++;
      desiredKeys.add(candidateKey);
    }

    for (const channel of routeChannels) {
      const channelKey = buildChannelKey(channel);
      if (desiredKeys.has(channelKey)) {
        continue;
      }

      if (!channel.tokenId) {
        const preferred = await getPreferredAccountToken(channel.accountId);
        if (preferred && desiredKeys.has(`${channel.accountId}:${preferred.id}`)) {
          await db.update(schema.routeChannels)
            .set({ tokenId: preferred.id })
            .where(eq(schema.routeChannels.id, channel.id))
            .run();
          continue;
        }
      }

      if (!channel.manualOverride) {
        await db.delete(schema.routeChannels).where(eq(schema.routeChannels.id, channel.id)).run();
        removedChannels++;
      }
    }
  }

  const latestModelNames = new Set<string>(Array.from(modelCandidates.keys()));
  for (const route of routes) {
    if ((route.routeMode || 'pattern') === 'explicit_group') {
      continue;
    }
    const modelPattern = (route.modelPattern || '').trim();
    if (!modelPattern || !isExactModelPattern(modelPattern) || latestModelNames.has(modelPattern)) {
      continue;
    }

    const routeChannelCount = channels.filter((channel) => channel.routeId === route.id).length;
    if (routeChannelCount > 0) {
      removedChannels += routeChannelCount;
    }

    const deleted = (await db.delete(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, route.id)).run()).changes;
    if (deleted > 0) {
      removedRoutes += deleted;
    }
  }

  if (createdRoutes > 0 || createdChannels > 0 || removedChannels > 0 || removedRoutes > 0) {
    await clearAllRouteDecisionSnapshots();
  }

  invalidateTokenRouterCache();

  return {
    models: modelCandidates.size,
    createdRoutes,
    createdChannels,
    removedChannels,
    removedRoutes,
  };
}

async function runRefreshModelsAndRebuildRoutes() {
  const refresh = await refreshModelsForAllActiveAccounts();
  const rebuild = await rebuildTokenRoutesFromAvailability();
  return { refresh, rebuild };
}

export async function refreshModelsAndRebuildRoutes() {
  if (inFlightRefreshModelsAndRebuildRoutes) {
    return inFlightRefreshModelsAndRebuildRoutes;
  }

  inFlightRefreshModelsAndRebuildRoutes = (async () => {
    try {
      return await runRefreshModelsAndRebuildRoutes();
    } finally {
      inFlightRefreshModelsAndRebuildRoutes = null;
    }
  })();

  return inFlightRefreshModelsAndRebuildRoutes;
}
