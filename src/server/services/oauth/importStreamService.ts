/**
 * importStreamService.ts — 三阶段流式导入核心逻辑
 *
 * Phase 0: 预缓存 ensureOauthSite（按 provider 去重，每种调用一次）
 * Phase 1: 串行 upsert（复用 normalize + fingerprint 去重，使用预缓存 site）
 * Phase 2: 按 (provider, projectId) 分组并发 refresh（discoverOauthModels + persistModelAvailabilityBatch）
 * Phase 2.5: 并发批量额度刷新（refreshOauthConnectionQuotaBatch）
 * Phase 3: rebuildTokenRoutesFromAvailability（只执行 1 次）
 */

import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import {
  normalizeImportedOauthJsonItems,
  resolveImportedNativeOauthIdentity,
  upsertOauthAccount,
  isRecord,
  asNonEmptyString,
  MAX_OAUTH_IMPORT_BATCH_SIZE,
  type ImportedNativeOauthJson,
  refreshOauthConnectionQuotaBatch,
} from './service.js';
import {
  discoverOauthModels,
  persistModelAvailabilityBatch,
  rebuildTokenRoutesFromAvailability,
  updateOauthModelDiscoveryState,
  type OauthDiscoveryResult,
  type ModelRefreshAccountNotFoundResult,
  type ModelRefreshSkippedResult,
} from '../modelService.js';
import { setAccountRuntimeHealth } from '../accountHealthService.js';
import { ensureOauthProviderSite } from './oauthSiteRegistry.js';
import {
  getOAuthProviderDefinition,
  type OAuthProviderDefinition,
} from './providers.js';
import { fingerprintKey, type OauthFingerprint } from './oauthIdentityResolver.js';

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export type OauthImportStreamItem = {
  index: number;
  name: string;
  status: 'imported' | 'updated' | 'skipped' | 'failed';
  provider?: string;
  accountId?: number;
  message?: string;
};

export type OauthImportStreamCallbacks = {
  onItem: (item: OauthImportStreamItem) => void;
  onCheckpoint: (data: { upsertedAccountIds: number[]; pendingRefreshIds: number[] }) => void;
  onRefreshed: (data: { index: number; accountId: number; modelCount: number; provider: string }) => void;
  onQuotaRefreshed: (data: { index: number; accountId: number; success: boolean; provider: string }) => void;
  onError: (data: { index: number; accountId?: number; provider?: string; message: string; phase: 'upsert' | 'refresh' }) => void;
  onDone: (data: {
    imported: number;
    updated: number;
    skipped: number;
    skippedDuplicateInBatch: number;
    skippedExpiredMissing: number;
    skippedExpiredNotNewer: number;
    parseFailed: number;
    refreshFailed: number;
    quotaRefreshFailed: number;
  }) => void;
  signal?: { aborted: boolean };
};

type UpsertedAccountInfo = {
  accountId: number;
  provider: string;
  projectId: string | null;
  status: string;
};

// ---------------------------------------------------------------------------
// 简易并发限制器（替代 pLimit）
// ---------------------------------------------------------------------------

function createConcurrencyLimiter(concurrency: number) {
  let activeCount = 0;
  const queue: Array<() => void> = [];

  function release() {
    activeCount--;
    if (queue.length > 0) {
      const next = queue.shift()!;
      next();
    }
  }

  async function limit<T>(fn: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      if (activeCount < concurrency) {
        activeCount++;
        resolve();
      } else {
        queue.push(() => {
          activeCount++;
          resolve();
        });
      }
    });
    try {
      return await fn();
    } finally {
      release();
    }
  }

  return { limit };
}

// ---------------------------------------------------------------------------
// Phase 0: 预缓存 ensureOauthSite
// ---------------------------------------------------------------------------

async function preCacheSites(
  definitions: Array<{ provider: string; definition: OAuthProviderDefinition }>,
): Promise<Map<string, any>> {
  const siteCache = new Map<string, any>();
  for (const { provider, definition } of definitions) {
    const site = await ensureOauthProviderSite(definition);
    siteCache.set(provider, site);
  }
  return siteCache;
}

// ---------------------------------------------------------------------------
// Phase 1: 串行 upsert
// ---------------------------------------------------------------------------

async function serialUpsert(input: {
  payloadItems: unknown[];
  proxyUrl?: string | null;
  useSystemProxy?: boolean;
  siteCache: Map<string, any>;
  callbacks: OauthImportStreamCallbacks;
}): Promise<{
  upsertedAccounts: UpsertedAccountInfo[];
  imported: number;
  updated: number;
  failed: number;
  skipped: number;
  skippedDuplicateInBatch: number;
  skippedExpiredMissing: number;
  skippedExpiredNotNewer: number;
}> {
  const { payloadItems, proxyUrl, useSystemProxy, siteCache, callbacks } = input;

  // 批内 fingerprint 去重
  const dedupedPayloads = new Map<string, ImportedNativeOauthJson>();
  const skippedInBatch: Array<{ name: string; provider?: string; reason: 'duplicate_in_batch' | 'incoming_expired_missing' | 'incoming_expired_not_newer' }> = [];
  const earlyFailItems: OauthImportStreamItem[] = [];

  for (const rawPayload of payloadItems) {
    if (!isRecord(rawPayload)) {
      throw new Error('data must be a native oauth json object');
    }
    const payload = rawPayload as ImportedNativeOauthJson;
    try {
      const resolvedIdentity = resolveImportedNativeOauthIdentity(payload);
      const fp: OauthFingerprint = {
        provider: resolvedIdentity.provider,
        accountKey: resolvedIdentity.exchange.accountKey ?? null,
        projectId: resolvedIdentity.exchange.projectId ?? null,
      };
      const key = fingerprintKey(fp);
      if (dedupedPayloads.has(key)) {
        skippedInBatch.push({ name: resolvedIdentity.name, provider: resolvedIdentity.provider, reason: 'duplicate_in_batch' });
      }
      dedupedPayloads.set(key, payload);
    } catch (error: any) {
      earlyFailItems.push({
        index: -1, // 会在后面赋值
        name: asNonEmptyString(payload.email)
          || asNonEmptyString(payload.account_key)
          || asNonEmptyString(payload.account_id)
          || asNonEmptyString(payload.type)
          || 'unknown',
        status: 'failed',
        provider: asNonEmptyString(payload.type) || undefined,
        message: error?.message || 'oauth import failed',
      });
    }
  }

  // 处理去重后的条目 — 串行 upsert
  let imported = 0;
  let updated = 0;
  let failed = 0;
  const upsertedAccounts: UpsertedAccountInfo[] = [];
  let itemIndex = 0;

  for (const payload of dedupedPayloads.values()) {
    if (callbacks.signal?.aborted) break;

    let resolvedIdentity: ReturnType<typeof resolveImportedNativeOauthIdentity> | null = null;
    try {
      resolvedIdentity = resolveImportedNativeOauthIdentity(payload);
      const definition = getOAuthProviderDefinition(resolvedIdentity.provider);
      if (!definition) {
        throw new Error(`unsupported oauth provider: ${resolvedIdentity.provider}`);
      }
      const preResolvedSite = siteCache.get(resolvedIdentity.provider);
      const persisted = await upsertOauthAccount({
        definition,
        exchange: resolvedIdentity.exchange,
        proxyUrl,
        useSystemProxy,
        persistedStatus: resolvedIdentity.disabled ? 'disabled' : 'active',
        preResolvedSite,
        importDecisionMode: 'expired_only',
      });

      if (persisted.created) {
        imported += 1;
      } else if (persisted.skipped) {
        skippedInBatch.push({
          name: resolvedIdentity.name,
          provider: resolvedIdentity.provider,
          reason: persisted.skipReason,
        });
      } else {
        updated += 1;
      }

      const accountId = persisted.account?.id;
      const provider = resolvedIdentity.provider;
      const projectId = resolvedIdentity.exchange.projectId ?? null;

      const reconcileMessage = persisted.importReconcileInfo && persisted.importReconcileInfo.disabledAccountIds.length > 0
        ? `已自动收敛同邮箱多身份（primary=${persisted.importReconcileInfo.primaryAccountId}，disabled=${persisted.importReconcileInfo.disabledAccountIds.join(',')}）`
        : undefined;
      const item: OauthImportStreamItem = {
        index: itemIndex,
        name: resolvedIdentity.name,
        status: persisted.skipped ? 'skipped' : (persisted.created ? 'imported' : 'updated'),
        provider,
        accountId,
        ...((persisted.skipped || reconcileMessage)
          ? {
              message: persisted.skipped
                ? (persisted.skipReason === 'incoming_expired_missing'
                  ? '跳过：导入项缺少有效 expired'
                  : `跳过：导入 expired 不晚于现有账号（incoming=${persisted.skipDecision?.incomingTokenExpiresAt ?? 'n/a'}，existing=${persisted.skipDecision?.existingTokenExpiresAt ?? 'n/a'}，matchedAccountId=${persisted.skipDecision?.matchedAccountId ?? 'n/a'}）`)
                : reconcileMessage
            }
          : {}),
      };
      callbacks.onItem(item);

      if (accountId && !persisted.skipped) {
        upsertedAccounts.push({
          accountId,
          provider,
          projectId,
          status: persisted.account?.status || 'active',
        });
      }

      itemIndex++;
    } catch (error: any) {
      failed += 1;
      const item: OauthImportStreamItem = {
        index: itemIndex,
        name: resolvedIdentity?.name
          || asNonEmptyString(payload.email)
          || asNonEmptyString(payload.account_key)
          || asNonEmptyString(payload.account_id)
          || asNonEmptyString(payload.type)
          || 'unknown',
        status: 'failed',
        provider: resolvedIdentity?.provider || asNonEmptyString(payload.type) || undefined,
        message: error?.message || 'oauth import failed',
      };
      callbacks.onItem(item);
      itemIndex++;
    }
  }

  // 早失败的条目也需要回调并赋 index
  for (const failItem of earlyFailItems) {
    failItem.index = itemIndex;
    callbacks.onItem(failItem);
    itemIndex++;
  }
  failed += earlyFailItems.length;

  // 批内跳过的条目
  const skipped = skippedInBatch.length;

  // checkpoint
  const upsertedAccountIds = upsertedAccounts.map((a) => a.accountId);
  // 只有 status=active 的才需要 refresh
  const pendingRefreshIds = upsertedAccounts
    .filter((a) => a.status === 'active')
    .map((a) => a.accountId);

  callbacks.onCheckpoint({ upsertedAccountIds, pendingRefreshIds });

  const skippedDuplicateInBatch = skippedInBatch.filter((item) => item.reason === 'duplicate_in_batch').length;
  const skippedExpiredMissing = skippedInBatch.filter((item) => item.reason === 'incoming_expired_missing').length;
  const skippedExpiredNotNewer = skippedInBatch.filter((item) => item.reason === 'incoming_expired_not_newer').length;

  return {
    upsertedAccounts,
    imported,
    updated,
    failed,
    skipped,
    skippedDuplicateInBatch,
    skippedExpiredMissing,
    skippedExpiredNotNewer,
  };
}

// ---------------------------------------------------------------------------
// Phase 2: 按 (provider, projectId) 分组并发 refresh
// ---------------------------------------------------------------------------

type RefreshGroup = {
  key: string;
  provider: string;
  projectId: string | null;
  accounts: UpsertedAccountInfo[];
};

function groupAccountsForRefresh(accounts: UpsertedAccountInfo[]): RefreshGroup[] {
  const groupMap = new Map<string, UpsertedAccountInfo[]>();

  for (const account of accounts) {
    if (account.status !== 'active') continue;
    const groupKey = `${account.provider}::${account.projectId ?? ''}`;
    const list = groupMap.get(groupKey) || [];
    list.push(account);
    groupMap.set(groupKey, list);
  }

  const groups: RefreshGroup[] = [];
  for (const [key, groupAccounts] of groupMap) {
    const [provider, ...projectIdParts] = key.split('::');
    const projectId = projectIdParts.join('::') || null;
    groups.push({
      key,
      provider,
      projectId,
      accounts: groupAccounts,
    });
  }

  return groups;
}

/** 标记模型探测失败：写入 lastModelSyncError + runtimeHealth unhealthy */
async function markModelDiscoveryFailed(accountId: number, errorMessage: string): Promise<void> {
  try {
    const account = await db.select().from(schema.accounts)
      .where(eq(schema.accounts.id, accountId))
      .get();
    if (!account) return;
    const checkedAt = new Date().toISOString();
    await updateOauthModelDiscoveryState({
      account,
      checkedAt,
      status: 'abnormal',
      lastModelSyncError: errorMessage,
      lastDiscoveredModels: [],
    });
    await setAccountRuntimeHealth(accountId, {
      state: 'unhealthy',
      reason: errorMessage,
      source: 'model-discovery',
      checkedAt,
    });
  } catch {
    // best effort — 不阻断导入主流程
  }
}

async function refreshGroup(input: {
  group: RefreshGroup;
  globalIndex: { value: number };
  callbacks: OauthImportStreamCallbacks;
  signal?: { aborted: boolean };
}): Promise<{ refreshedCount: number; failedCount: number }> {
  const { group, globalIndex, callbacks, signal } = input;
  let refreshedCount = 0;
  let failedCount = 0;

  if (signal?.aborted) return { refreshedCount, failedCount };

  // 每组选第一个 active 的 accountId 做一次 discoverOauthModels
  const discoveryAccountId = group.accounts[0]?.accountId;
  if (!discoveryAccountId) return { refreshedCount, failedCount };

  let discoveryResult: OauthDiscoveryResult | ModelRefreshAccountNotFoundResult | ModelRefreshSkippedResult;

  try {
    discoveryResult = await discoverOauthModels({ accountId: discoveryAccountId });
  } catch (error: any) {
    // 代表账户 discover 抛异常 → 回退到组内逐个独立探测
    for (const account of group.accounts) {
      if (signal?.aborted) break;
      try {
        const singleResult = await discoverOauthModels({ accountId: account.accountId });
        if ('models' in singleResult && singleResult.models !== null && singleResult.models !== undefined) {
          await persistModelAvailabilityBatch({
            items: [{
              accountId: account.accountId,
              models: singleResult.models,
              discoveryAccount: singleResult.discoveryAccount,
              checkedAt: singleResult.checkedAt,
              latencyMs: singleResult.latencyMs,
              provider: singleResult.provider,
              previousModelAvailability: singleResult.previousModelAvailability,
              previousAccountTokens: singleResult.previousAccountTokens,
              previousTokenModelAvailability: singleResult.previousTokenModelAvailability,
            }],
          });
          const idx = globalIndex.value++;
          refreshedCount++;
          callbacks.onRefreshed({
            index: idx,
            accountId: account.accountId,
            modelCount: singleResult.models.length,
            provider: account.provider,
          });
        } else {
          const idx = globalIndex.value++;
          failedCount++;
          const errorMessage = 'errorMessage' in singleResult
            ? (singleResult as any).errorMessage
            : 'model discovery returned no models';
          callbacks.onError({
            index: idx,
            accountId: account.accountId,
            provider: account.provider,
            message: errorMessage || 'model discovery returned no models',
            phase: 'refresh',
          });
          await markModelDiscoveryFailed(account.accountId, errorMessage);
        }
      } catch (innerError: any) {
        const idx = globalIndex.value++;
        failedCount++;
        const innerMsg = innerError?.message || 'model discovery failed';
        callbacks.onError({
          index: idx,
          accountId: account.accountId,
          provider: account.provider,
          message: innerMsg,
          phase: 'refresh',
        });
        await markModelDiscoveryFailed(account.accountId, innerMsg);
      }
    }
    return { refreshedCount, failedCount };
  }

  // 判断 discover 结果
  if (!('models' in discoveryResult) || discoveryResult.models === null || discoveryResult.models === undefined) {
    // 代表账户 discover 返回无模型 → 回退到组内逐个独立探测
    for (const account of group.accounts) {
      if (signal?.aborted) break;
      try {
        const singleResult = await discoverOauthModels({ accountId: account.accountId });
        if ('models' in singleResult && singleResult.models !== null && singleResult.models !== undefined) {
          await persistModelAvailabilityBatch({
            items: [{
              accountId: account.accountId,
              models: singleResult.models,
              discoveryAccount: singleResult.discoveryAccount,
              checkedAt: singleResult.checkedAt,
              latencyMs: singleResult.latencyMs,
              provider: singleResult.provider,
              previousModelAvailability: singleResult.previousModelAvailability,
              previousAccountTokens: singleResult.previousAccountTokens,
              previousTokenModelAvailability: singleResult.previousTokenModelAvailability,
            }],
          });
          const idx = globalIndex.value++;
          refreshedCount++;
          callbacks.onRefreshed({
            index: idx,
            accountId: account.accountId,
            modelCount: singleResult.models.length,
            provider: account.provider,
          });
        } else {
          const idx = globalIndex.value++;
          failedCount++;
          const singleErrorMessage = 'errorMessage' in singleResult
            ? (singleResult as any).errorMessage
            : 'model discovery returned no models';
          callbacks.onError({
            index: idx,
            accountId: account.accountId,
            provider: account.provider,
            message: singleErrorMessage || 'model discovery returned no models',
            phase: 'refresh',
          });
          await markModelDiscoveryFailed(account.accountId, singleErrorMessage);
        }
      } catch (innerError: any) {
        const idx = globalIndex.value++;
        failedCount++;
        const innerMsg = innerError?.message || 'model discovery failed';
        callbacks.onError({
          index: idx,
          accountId: account.accountId,
          provider: account.provider,
          message: innerMsg,
          phase: 'refresh',
        });
        await markModelDiscoveryFailed(account.accountId, innerMsg);
      }
    }
    return { refreshedCount, failedCount };
  }

  // discover 成功 — 组内所有账号批量 persistModelAvailability（共享同一份模型列表）
  const models = discoveryResult.models;

  // 批量写入 modelAvailability，替代逐条调用
  try {
    await persistModelAvailabilityBatch({
      items: group.accounts.map((account) => ({
        accountId: account.accountId,
        models,
        discoveryAccount: discoveryResult.discoveryAccount,
        checkedAt: discoveryResult.checkedAt,
        latencyMs: discoveryResult.latencyMs,
        provider: discoveryResult.provider,
        previousModelAvailability: discoveryResult.previousModelAvailability,
        previousAccountTokens: discoveryResult.previousAccountTokens,
        previousTokenModelAvailability: discoveryResult.previousTokenModelAvailability,
      })),
    });

    // 批量写入成功，逐条推送 onRefreshed 回调
    for (const account of group.accounts) {
      const idx = globalIndex.value++;
      refreshedCount++;
      callbacks.onRefreshed({
        index: idx,
        accountId: account.accountId,
        modelCount: models.length,
        provider: account.provider,
      });
    }
  } catch (error: any) {
    // 批量写入失败，所有账号标记失败
    const batchErrorMsg = error?.message || 'persist model availability batch failed';
    for (const account of group.accounts) {
      const idx = globalIndex.value++;
      failedCount++;
      callbacks.onError({
        index: idx,
        accountId: account.accountId,
        provider: account.provider,
        message: batchErrorMsg,
        phase: 'refresh',
      });
      await markModelDiscoveryFailed(account.accountId, batchErrorMsg);
    }
  }

  return { refreshedCount, failedCount };
}

async function concurrentRefresh(input: {
  upsertedAccounts: UpsertedAccountInfo[];
  callbacks: OauthImportStreamCallbacks;
  concurrency?: number;
}): Promise<{ refreshedCount: number; failedCount: number }> {
  const { upsertedAccounts, callbacks, concurrency = 4 } = input;

  const groups = groupAccountsForRefresh(upsertedAccounts);
  if (groups.length === 0) {
    return { refreshedCount: 0, failedCount: 0 };
  }

  const limiter = createConcurrencyLimiter(concurrency);
  const globalIndex = { value: 0 };

  const results = await Promise.all(
    groups.map((group) =>
      limiter.limit(() =>
        refreshGroup({
          group,
          globalIndex,
          callbacks,
          signal: callbacks.signal,
        }),
      ),
    ),
  );

  let refreshedCount = 0;
  let failedCount = 0;
  for (const r of results) {
    refreshedCount += r.refreshedCount;
    failedCount += r.failedCount;
  }

  return { refreshedCount, failedCount };
}

// ---------------------------------------------------------------------------
// Phase 3: rebuildRoutes
// ---------------------------------------------------------------------------

async function rebuildRoutes(): Promise<void> {
  await rebuildTokenRoutesFromAvailability();
}

// ---------------------------------------------------------------------------
// 主入口：importOauthConnectionsStream
// ---------------------------------------------------------------------------

export async function importOauthConnectionsStream(input: {
  data?: unknown;
  items?: unknown[];
  proxyUrl?: string | null;
  useSystemProxy?: boolean;
}, callbacks: OauthImportStreamCallbacks): Promise<void> {
  const { proxyUrl, useSystemProxy } = input;

  // --- 验证 & 标准化 ---
  const payloadItems = normalizeImportedOauthJsonItems(input);
  if (payloadItems.length <= 0) {
    throw new Error('data must be a native oauth json object');
  }
  if (payloadItems.length > MAX_OAUTH_IMPORT_BATCH_SIZE) {
    throw new Error(`oauth import supports at most ${MAX_OAUTH_IMPORT_BATCH_SIZE} items`);
  }

  // --- Phase 0: 预缓存 site ---
  const providerDefinitions: Array<{ provider: string; definition: OAuthProviderDefinition }> = [];
  const seenProviders = new Set<string>();

  for (const rawPayload of payloadItems) {
    if (!isRecord(rawPayload)) continue;
    const payload = rawPayload as ImportedNativeOauthJson;
    try {
      const resolvedIdentity = resolveImportedNativeOauthIdentity(payload);
      if (!seenProviders.has(resolvedIdentity.provider)) {
        seenProviders.add(resolvedIdentity.provider);
        const definition = getOAuthProviderDefinition(resolvedIdentity.provider);
        if (definition) {
          providerDefinitions.push({ provider: resolvedIdentity.provider, definition });
        }
      }
    } catch {
      // 解析失败的条目不影响 Phase 0
    }
  }

  const siteCache = await preCacheSites(providerDefinitions);

  // --- Phase 1: 串行 upsert ---
  const phase1Result = await serialUpsert({
    payloadItems,
    proxyUrl,
    useSystemProxy,
    siteCache,
    callbacks,
  });

  // --- Phase 2: 按 (provider, projectId) 分组并发 refresh ---
  let refreshFailed = 0;
  if (phase1Result.upsertedAccounts.length > 0 && !callbacks.signal?.aborted) {
    const refreshResult = await concurrentRefresh({
      upsertedAccounts: phase1Result.upsertedAccounts,
      callbacks,
      concurrency: 4,
    });
    refreshFailed = refreshResult.failedCount;
  }

  // --- Phase 2.5: 批量额度刷新 ---
  let quotaRefreshFailed = 0;
  if (phase1Result.upsertedAccounts.length > 0 && !callbacks.signal?.aborted) {
    // 只刷新 status=active 的账户
    const activeAccountIds = phase1Result.upsertedAccounts
      .filter(a => a.status === 'active')
      .map(a => a.accountId);

    if (activeAccountIds.length > 0) {
      try {
        const quotaResult = await refreshOauthConnectionQuotaBatch(activeAccountIds);
        let quotaIdx = 0;
        for (const item of quotaResult.items) {
          callbacks.onQuotaRefreshed({
            index: quotaIdx++,
            accountId: item.accountId,
            success: item.success,
            provider: phase1Result.upsertedAccounts.find(a => a.accountId === item.accountId)?.provider || 'unknown',
          });
          if (!item.success) {
            quotaRefreshFailed++;
          }
        }
      } catch {
        // 额度刷新整体失败不阻断主流程
        quotaRefreshFailed = activeAccountIds.length;
      }
    }
  }

  // --- Phase 3: rebuildRoutes ---
  if (!callbacks.signal?.aborted) {
    try {
      await rebuildRoutes();
    } catch {
      // rebuildRoutes 失败不阻断主流程，但影响路由
    }
  }

  // --- 完成 ---
  callbacks.onDone({
    imported: phase1Result.imported,
    updated: phase1Result.updated,
    skipped: phase1Result.skipped,
    skippedDuplicateInBatch: phase1Result.skippedDuplicateInBatch,
    skippedExpiredMissing: phase1Result.skippedExpiredMissing,
    skippedExpiredNotNewer: phase1Result.skippedExpiredNotNewer,
    parseFailed: phase1Result.failed,
    refreshFailed: refreshFailed,
    quotaRefreshFailed,
  });
}
