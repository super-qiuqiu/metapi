import { and, eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { config } from '../../config.js';
import { fetchModelPricingCatalog } from '../modelPricingService.js';
import { channelBanditStore } from './channelBanditStore.js';
import { isExactTokenRouteModelPattern } from '../../../shared/tokenRoutePatterns.js';

type ChannelPricingRow = {
  channelId: number;
  sourceModel: string | null;
  routeModelPattern: string;
  siteId: number;
  siteUrl: string;
  sitePlatform: string;
  siteApiKey: string | null;
  accountId: number;
  accountAccessToken: string;
  accountApiToken: string | null;
  accountUnitCost: number | null;
};

let syncTimer: ReturnType<typeof setInterval> | null = null;
let syncInFlight: Promise<void> | null = null;

function pickModelNameForChannel(row: ChannelPricingRow): string | null {
  const sourceModel = (row.sourceModel || '').trim();
  if (sourceModel) return sourceModel;
  const pattern = (row.routeModelPattern || '').trim();
  if (!pattern) return null;
  if (!isExactTokenRouteModelPattern(pattern)) return null;
  return pattern;
}

function normalizeModelName(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function resolveGroupPricing(entry: any): any {
  const groupPricing = entry?.groupPricing;
  if (!groupPricing || typeof groupPricing !== 'object') return null;
  if (groupPricing.default) return groupPricing.default;
  const first = Object.values(groupPricing).find((item) => item && typeof item === 'object');
  return first || null;
}

async function loadEnabledChannelPricingRows(): Promise<ChannelPricingRow[]> {
  return await db.select({
    channelId: schema.routeChannels.id,
    sourceModel: schema.routeChannels.sourceModel,
    routeModelPattern: schema.tokenRoutes.modelPattern,
    siteId: schema.sites.id,
    siteUrl: schema.sites.url,
    sitePlatform: schema.sites.platform,
    siteApiKey: schema.sites.apiKey,
    accountId: schema.accounts.id,
    accountAccessToken: schema.accounts.accessToken,
    accountApiToken: schema.accounts.apiToken,
    accountUnitCost: schema.accounts.unitCost,
  })
    .from(schema.routeChannels)
    .innerJoin(schema.tokenRoutes, eq(schema.routeChannels.routeId, schema.tokenRoutes.id))
    .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(and(
      eq(schema.routeChannels.enabled, true),
      eq(schema.tokenRoutes.enabled, true),
      eq(schema.sites.status, 'active'),
    ))
    .all();
}

export async function runChannelBanditPricingSync(): Promise<void> {
  const rows = await loadEnabledChannelPricingRows();
  if (rows.length <= 0) return;

  const modelBySiteAccount = new Map<string, string>();
  for (const row of rows) {
    const modelName = pickModelNameForChannel(row);
    if (!modelName) continue;
    const key = `${row.siteId}:${row.accountId}`;
    if (!modelBySiteAccount.has(key)) {
      modelBySiteAccount.set(key, modelName);
    }
  }

  const catalogBySiteAccount = new Map<string, any>();
  for (const [siteAccountKey, modelName] of modelBySiteAccount.entries()) {
    const [siteIdRaw, accountIdRaw] = siteAccountKey.split(':');
    const siteId = Number(siteIdRaw);
    const accountId = Number(accountIdRaw);
    const row = rows.find((item) => item.siteId === siteId && item.accountId === accountId);
    if (!row) continue;
    try {
      const catalog = await fetchModelPricingCatalog({
        site: {
          id: row.siteId,
          url: row.siteUrl,
          platform: row.sitePlatform,
          apiKey: row.siteApiKey,
        },
        account: {
          id: row.accountId,
          accessToken: row.accountAccessToken,
          apiToken: row.accountApiToken,
        },
        modelName,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      });
      if (catalog) {
        catalogBySiteAccount.set(siteAccountKey, catalog);
      }
    } catch {
      // Best effort sync: keep stale snapshot on fetch failures.
    }
  }

  for (const row of rows) {
    const fallbackUnitCost = Math.max(config.routingFallbackUnitCost || 1, 1e-6);
    const modelName = pickModelNameForChannel(row);
    if (!modelName) {
      const perCall = Number.isFinite(row.accountUnitCost as number) && (row.accountUnitCost as number) > 0
        ? (row.accountUnitCost as number)
        : fallbackUnitCost;
      await channelBanditStore.upsertPricingSnapshot(row.channelId, {
        quotaType: 1,
        referenceUnitCost: perCall,
        groupMultiplier: 1,
      });
      continue;
    }

    const siteAccountKey = `${row.siteId}:${row.accountId}`;
    const catalog = catalogBySiteAccount.get(siteAccountKey);
    const entries = Array.isArray(catalog?.models) ? catalog.models : [];
    const entry = entries.find((candidate: any) => normalizeModelName(candidate?.modelName) === normalizeModelName(modelName));
    const groupPricing = resolveGroupPricing(entry);

    if (!groupPricing) {
      const perCall = Number.isFinite(row.accountUnitCost as number) && (row.accountUnitCost as number) > 0
        ? (row.accountUnitCost as number)
        : fallbackUnitCost;
      await channelBanditStore.upsertPricingSnapshot(row.channelId, {
        quotaType: 1,
        referenceUnitCost: perCall,
        groupMultiplier: 1,
      });
      continue;
    }

    const quotaType = Number(groupPricing.quotaType) === 1 ? 1 : 0;
    if (quotaType === 1) {
      const perCallTotal = Number(groupPricing.perCallTotal) || fallbackUnitCost;
      await channelBanditStore.upsertPricingSnapshot(row.channelId, {
        quotaType: 1,
        referenceUnitCost: Math.max(perCallTotal, 1e-6),
        groupMultiplier: 1,
      });
      continue;
    }

    const inputRate = Math.max(0, Number(groupPricing.inputPerMillion) || 0);
    const outputRate = Math.max(0, Number(groupPricing.outputPerMillion) || 0);
    const cacheReadRate = Math.max(0, Number(groupPricing.cacheReadPerMillion) || 0);
    const cacheCreationRate = Math.max(0, Number(groupPricing.cacheCreationPerMillion) || 0);
    const referenceUnitCost = Math.max(fallbackUnitCost, inputRate / 1_000_000);

    await channelBanditStore.upsertPricingSnapshot(row.channelId, {
      quotaType: 0,
      referenceUnitCost,
      groupMultiplier: 1,
      inputRate,
      outputRate,
      cacheReadRate,
      cacheCreationRate,
    });
  }

  await channelBanditStore.flushDirty();
}

export function startChannelBanditPricingSyncScheduler(): void {
  if (syncTimer || process.env.NODE_ENV === 'test') return;

  const run = async () => {
    if (syncInFlight) return await syncInFlight;
    syncInFlight = runChannelBanditPricingSync().finally(() => {
      syncInFlight = null;
    });
    await syncInFlight;
  };

  void run();
  syncTimer = setInterval(() => {
    void run().catch((error) => {
      console.warn('[routing-bandit] pricing sync failed', error);
    });
  }, 10 * 60 * 1000);
  syncTimer.unref?.();
}

export async function stopChannelBanditPricingSyncScheduler(): Promise<void> {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  if (syncInFlight) {
    await syncInFlight;
  }
}
