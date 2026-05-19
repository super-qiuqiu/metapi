import { and, eq, gte, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { getLocalRangeStartDayKey } from "./localTimeService.js";
import {
  readSnapshotCache,
  type SnapshotEnvelope,
} from "./snapshotCacheService.js";
import { createAdminSnapshotPersistence } from "./adminSnapshotStore.js";
import { runUsageAggregationProjectionPass } from "./usageAggregationService.js";

export type ModelBySiteSnapshotPayload = {
  models: Array<{
    model: string;
    calls: number;
    spend: number;
    tokens: number;
  }>;
};

const MODEL_BY_SITE_TTL_MS = 15_000;

function toRoundedMicroNumber(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

async function loadModelBySiteSnapshotPayload(input: {
  days: number;
  siteId?: number | null;
}): Promise<ModelBySiteSnapshotPayload> {
  await runUsageAggregationProjectionPass();

  const sinceDay = getLocalRangeStartDayKey(input.days);
  const rows = input.siteId != null
    ? await db
        .select({
          model: schema.modelDayUsage.model,
          calls: sql<number>`coalesce(sum(${schema.modelDayUsage.totalCalls}), 0)`,
          spend: sql<number>`coalesce(sum(${schema.modelDayUsage.totalSpend}), 0)`,
          tokens: sql<number>`coalesce(sum(${schema.modelDayUsage.totalTokens}), 0)`,
        })
        .from(schema.modelDayUsage)
        .where(
          and(
            gte(schema.modelDayUsage.localDay, sinceDay),
            eq(schema.modelDayUsage.siteId, input.siteId),
          ),
        )
        .groupBy(schema.modelDayUsage.model)
        .all()
    : await db
        .select({
          model: schema.modelDayUsage.model,
          calls: sql<number>`coalesce(sum(${schema.modelDayUsage.totalCalls}), 0)`,
          spend: sql<number>`coalesce(sum(${schema.modelDayUsage.totalSpend}), 0)`,
          tokens: sql<number>`coalesce(sum(${schema.modelDayUsage.totalTokens}), 0)`,
        })
        .from(schema.modelDayUsage)
        .where(gte(schema.modelDayUsage.localDay, sinceDay))
        .groupBy(schema.modelDayUsage.model)
        .all();

  const models = rows
    .map((row) => ({
      model: row.model || "unknown",
      calls: Number(row.calls || 0),
      spend: toRoundedMicroNumber(Number(row.spend || 0)),
      tokens: Number(row.tokens || 0),
    }))
    .sort((left, right) => right.calls - left.calls);

  return { models };
}

export async function getModelBySiteSnapshot(options?: {
  days?: number;
  siteId?: number | null;
  forceRefresh?: boolean;
}): Promise<SnapshotEnvelope<ModelBySiteSnapshotPayload>> {
  const days = Math.max(1, Math.trunc(options?.days || 7));
  const siteId =
    options?.siteId != null && Number.isFinite(options.siteId)
      ? Math.trunc(options.siteId)
      : null;
  const cacheKey = JSON.stringify({ days, siteId });

  return readSnapshotCache({
    namespace: "model-by-site",
    key: cacheKey,
    ttlMs: MODEL_BY_SITE_TTL_MS,
    forceRefresh: options?.forceRefresh,
    persistence: createAdminSnapshotPersistence<ModelBySiteSnapshotPayload>({
      namespace: "model-by-site",
      key: cacheKey,
    }),
    loader: () =>
      loadModelBySiteSnapshotPayload({
        days,
        siteId,
      }),
  });
}
