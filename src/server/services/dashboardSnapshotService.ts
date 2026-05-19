import { and, eq, gt, gte, lt, lte, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import {
  buildModelAnalysis,
  buildModelAnalysisFromDailyUsage,
  type ModelAnalysisDailyUsageRow,
} from "./modelAnalysisService.js";
import { parseCheckinRewardAmount } from "./checkinRewardParser.js";
import {
  formatUtcSqlDateTime,
  getLocalDayRangeUtc,
  getLocalHourAnchor,
  getLocalHourRangeStartUtc,
  getLocalRangeStartDayKey,
  toLocalDayKeyFromStoredUtc,
} from "./localTimeService.js";
import {
  readSnapshotCache,
  type SnapshotEnvelope,
} from "./snapshotCacheService.js";
import {
  buildSiteAvailabilitySummariesFromHourlyAggregates,
  proxyCostSqlExpression,
  type SiteAvailabilitySiteRow,
  toRoundedMicroNumber,
} from "./statsShared.js";
import { estimateRewardWithTodayIncomeFallback } from "./todayIncomeRewardService.js";
import { createAdminSnapshotPersistence } from "./adminSnapshotStore.js";
import { runUsageAggregationProjectionPass } from "./usageAggregationService.js";

export type DashboardSummaryPayload = {
  totalBalance: number;
  totalUsed: number;
  todaySpend: number;
  todayReward: number;
  activeAccounts: number;
  totalAccounts: number;
  todayCheckin: { success: number; failed: number; total: number };
  proxy24h: {
    success: number;
    failed: number;
    total: number;
    totalTokens: number;
  };
  performance: {
    windowSeconds: number;
    requestsPerMinute: number;
    tokensPerMinute: number;
  };
};

export type DashboardInsightsPayload = {
  siteAvailability: ReturnType<
    typeof buildSiteAvailabilitySummariesFromHourlyAggregates
  >;
  modelAnalysis: ReturnType<typeof buildModelAnalysis>;
};

const DASHBOARD_SUMMARY_TTL_MS = 12_000;
const DASHBOARD_INSIGHTS_TTL_MS = 20_000;
const SITE_AVAILABILITY_BUCKET_COUNT = 24;
const USAGE_AGGREGATES_PROJECTOR_KEY = "usage-aggregates-v1";
const dashboardSummaryPersistence =
  createAdminSnapshotPersistence<DashboardSummaryPayload>({
    namespace: "dashboard-summary",
    key: "default",
  });
function createDashboardInsightsPersistence(cacheKey: string) {
  return createAdminSnapshotPersistence<DashboardInsightsPayload>({
    namespace: "dashboard-insights",
    key: cacheKey,
  });
}

function mergeDailyUsageRows(
  baseRows: ModelAnalysisDailyUsageRow[],
  tailRows: ModelAnalysisDailyUsageRow[],
): ModelAnalysisDailyUsageRow[] {
  const merged = new Map<string, ModelAnalysisDailyUsageRow>();
  const append = (row: ModelAnalysisDailyUsageRow) => {
    const day = String(row.localDay || "").trim();
    const model = String(row.model || "").trim() || "unknown";
    if (!day) return;
    const key = `${day}::${model}`;
    const current = merged.get(key) || {
      localDay: day,
      model,
      totalCalls: 0,
      successCalls: 0,
      totalTokens: 0,
      totalSpend: 0,
      totalLatencyMs: 0,
    };
    current.totalCalls += Number(row.totalCalls || 0);
    current.successCalls += Number(row.successCalls || 0);
    current.totalTokens += Number(row.totalTokens || 0);
    current.totalSpend += Number(row.totalSpend || 0);
    current.totalLatencyMs += Number(row.totalLatencyMs || 0);
    merged.set(key, current);
  };

  for (const row of baseRows) append(row);
  for (const row of tailRows) append(row);
  return Array.from(merged.values());
}

async function loadDashboardSummaryPayload(): Promise<DashboardSummaryPayload> {
  await runUsageAggregationProjectionPass();

  const accounts = await db
    .select({
      id: schema.accounts.id,
      balance: schema.accounts.balance,
      status: schema.accounts.status,
      extraConfig: schema.accounts.extraConfig,
    })
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(eq(schema.sites.status, "active"))
    .all();
  const totalBalance = accounts.reduce(
    (sum, account) => sum + (account.balance || 0),
    0,
  );
  const activeCount = accounts.filter(
    (account) => account.status === "active",
  ).length;

  const {
    localDay: today,
    startUtc: todayStartUtc,
    endUtc: todayEndUtc,
  } = getLocalDayRangeUtc();
  const nowTs = Date.now();
  const last24hDate = formatUtcSqlDateTime(new Date(nowTs - 86_400_000));
  const lastMinuteDate = formatUtcSqlDateTime(new Date(nowTs - 60_000));

  const [
    todayCheckinRows,
    totalUsedRow,
    proxy24hRow,
    proxyPerformanceRow,
    todaySpendRow,
  ] = await Promise.all([
    db
      .select()
      .from(schema.checkinLogs)
      .innerJoin(
        schema.accounts,
        eq(schema.checkinLogs.accountId, schema.accounts.id),
      )
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(
        and(
          gte(schema.checkinLogs.createdAt, todayStartUtc),
          lt(schema.checkinLogs.createdAt, todayEndUtc),
          eq(schema.sites.status, "active"),
        ),
      )
      .all(),
    db
      .select({
        totalUsed: sql<number>`coalesce(sum(coalesce(${schema.siteDayUsage.totalSiteSpend}, 0)), 0)`,
      })
      .from(schema.siteDayUsage)
      .innerJoin(schema.sites, eq(schema.siteDayUsage.siteId, schema.sites.id))
      .where(eq(schema.sites.status, "active"))
      .get(),
    db
      .select({
        total: sql<number>`count(*)`,
        success: sql<number>`coalesce(sum(case when ${schema.proxyLogs.status} = 'success' then 1 else 0 end), 0)`,
        failed: sql<number>`coalesce(sum(case when ${schema.proxyLogs.status} = 'success' then 0 else 1 end), 0)`,
        totalTokens: sql<number>`coalesce(sum(coalesce(${schema.proxyLogs.totalTokens}, 0)), 0)`,
      })
      .from(schema.proxyLogs)
      .innerJoin(
        schema.accounts,
        eq(schema.proxyLogs.accountId, schema.accounts.id),
      )
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(
        and(
          gte(schema.proxyLogs.createdAt, last24hDate),
          eq(schema.sites.status, "active"),
        ),
      )
      .get(),
    db
      .select({
        total: sql<number>`count(*)`,
        totalTokens: sql<number>`coalesce(sum(coalesce(${schema.proxyLogs.totalTokens}, 0)), 0)`,
      })
      .from(schema.proxyLogs)
      .innerJoin(
        schema.accounts,
        eq(schema.proxyLogs.accountId, schema.accounts.id),
      )
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(
        and(
          gte(schema.proxyLogs.createdAt, lastMinuteDate),
          eq(schema.sites.status, "active"),
        ),
      )
      .get(),
    db
      .select({
        todaySpend: sql<number>`coalesce(sum(coalesce(${schema.siteDayUsage.totalSiteSpend}, 0)), 0)`,
      })
      .from(schema.siteDayUsage)
      .innerJoin(schema.sites, eq(schema.siteDayUsage.siteId, schema.sites.id))
      .where(
        and(
          eq(schema.siteDayUsage.localDay, today),
          eq(schema.sites.status, "active"),
        ),
      )
      .get(),
  ]);

  const todayCheckins = todayCheckinRows.map((row) => row.checkin_logs);
  const checkinFailed = todayCheckins.filter(
    (checkin) => checkin.status === "failed",
  ).length;
  const checkinSuccess = todayCheckins.length - checkinFailed;
  const rewardByAccount: Record<number, number> = {};
  const successCountByAccount: Record<number, number> = {};
  const parsedRewardCountByAccount: Record<number, number> = {};
  for (const row of todayCheckinRows) {
    const checkin = row.checkin_logs;
    if (checkin.status !== "success") continue;
    const accountId = row.accounts.id;
    successCountByAccount[accountId] =
      (successCountByAccount[accountId] || 0) + 1;
    const rewardValue =
      parseCheckinRewardAmount(checkin.reward) ||
      parseCheckinRewardAmount(checkin.message);
    if (rewardValue <= 0) continue;
    rewardByAccount[accountId] =
      (rewardByAccount[accountId] || 0) + rewardValue;
    parsedRewardCountByAccount[accountId] =
      (parsedRewardCountByAccount[accountId] || 0) + 1;
  }

  const proxySuccess = Number(proxy24hRow?.success || 0);
  const proxyFailed = Number(proxy24hRow?.failed || 0);
  const proxyTotal = Number(proxy24hRow?.total || 0);
  const totalTokens = Number(proxy24hRow?.totalTokens || 0);
  const requestsPerMinute = Number(proxyPerformanceRow?.total || 0);
  const tokensPerMinute = Number(proxyPerformanceRow?.totalTokens || 0);
  const totalUsed = Number(totalUsedRow?.totalUsed || 0);
  const todaySpend = Number(todaySpendRow?.todaySpend || 0);
  const todayReward = accounts.reduce(
    (sum, account) =>
      sum +
      estimateRewardWithTodayIncomeFallback({
        day: today,
        successCount: successCountByAccount[account.id] || 0,
        parsedRewardCount: parsedRewardCountByAccount[account.id] || 0,
        rewardSum: rewardByAccount[account.id] || 0,
        extraConfig: account.extraConfig,
      }),
    0,
  );

  return {
    totalBalance,
    totalUsed: toRoundedMicroNumber(totalUsed),
    todaySpend: toRoundedMicroNumber(todaySpend),
    todayReward: toRoundedMicroNumber(todayReward),
    activeAccounts: activeCount,
    totalAccounts: accounts.length,
    todayCheckin: {
      success: checkinSuccess,
      failed: checkinFailed,
      total: todayCheckins.length,
    },
    proxy24h: {
      success: proxySuccess,
      failed: proxyFailed,
      total: proxyTotal,
      totalTokens,
    },
    performance: {
      windowSeconds: 60,
      requestsPerMinute,
      tokensPerMinute,
    },
  };
}

async function loadDashboardInsightsPayload(input: {
  modelDays: number;
  modelHours?: number | null;
  modelFromDay?: string | null;
  modelToDay?: string | null;
}): Promise<DashboardInsightsPayload> {
  const siteAvailabilityNow = getLocalHourAnchor();
  const siteAvailabilitySinceUtc = getLocalHourRangeStartUtc(
    SITE_AVAILABILITY_BUCKET_COUNT,
    siteAvailabilityNow,
  );

  const fromDay = (input.modelFromDay || "").trim();
  const toDay = (input.modelToDay || "").trim();
  const hasCustomRange =
    fromDay.length > 0 && toDay.length > 0 && fromDay <= toDay;
  const modelHours = Number.isFinite(input.modelHours)
    ? Math.max(1, Math.min(24 * 365, Math.floor(input.modelHours || 0)))
    : null;
  const analysisDays = modelHours
    ? Math.max(1, Math.ceil(modelHours / 24))
    : hasCustomRange
      ? Math.max(
          1,
          Math.floor(
            (new Date(`${toDay}T00:00:00`).getTime() -
              new Date(`${fromDay}T00:00:00`).getTime()) /
              (24 * 60 * 60 * 1000),
          ) + 1,
        )
      : Math.max(1, input.modelDays);

  const modelFromUtc = modelHours
    ? formatUtcSqlDateTime(new Date(Date.now() - modelHours * 60 * 60 * 1000))
    : hasCustomRange
      ? formatUtcSqlDateTime(new Date(`${fromDay}T00:00:00`))
      : formatUtcSqlDateTime(
          new Date(
            new Date().getTime() - Math.max(1, input.modelDays) * 24 * 60 * 60 * 1000,
          ),
        );

  const modelToUtc = hasCustomRange
    ? formatUtcSqlDateTime(
        new Date(new Date(`${toDay}T00:00:00`).getTime() + 24 * 60 * 60 * 1000),
      )
    : formatUtcSqlDateTime(new Date());

  const aggregateFromDay = hasCustomRange
    ? fromDay
    : getLocalRangeStartDayKey(analysisDays);
  const aggregateToDay = hasCustomRange
    ? toDay
    : getLocalDayRangeUtc().localDay;

  await runUsageAggregationProjectionPass();

  const [activeSites, siteAvailabilityRows, modelAnalysis] = await Promise.all([
    db
      .select({
        id: schema.sites.id,
        name: schema.sites.name,
        url: schema.sites.url,
        platform: schema.sites.platform,
        sortOrder: schema.sites.sortOrder,
        isPinned: schema.sites.isPinned,
      })
      .from(schema.sites)
      .where(eq(schema.sites.status, "active"))
      .all(),
    db
      .select()
      .from(schema.siteHourUsage)
      .where(gte(schema.siteHourUsage.bucketStartUtc, siteAvailabilitySinceUtc))
      .all(),
    modelHours
      ? (async () => {
          const [baseRows, checkpoint] = await Promise.all([
            db
              .select({
                bucketStartUtc: schema.modelHourUsage.bucketStartUtc,
                model: schema.modelHourUsage.model,
                totalCalls: sql<number>`coalesce(sum(${schema.modelHourUsage.totalCalls}), 0)`,
                successCalls: sql<number>`coalesce(sum(${schema.modelHourUsage.successCalls}), 0)`,
                totalTokens: sql<number>`coalesce(sum(${schema.modelHourUsage.totalTokens}), 0)`,
                totalSpend: sql<number>`coalesce(sum(${schema.modelHourUsage.totalSpend}), 0)`,
                totalLatencyMs: sql<number>`coalesce(sum(${schema.modelHourUsage.totalLatencyMs}), 0)`,
              })
              .from(schema.modelHourUsage)
              .innerJoin(
                schema.sites,
                eq(schema.modelHourUsage.siteId, schema.sites.id),
              )
              .where(
                and(
                  eq(schema.sites.status, "active"),
                  gte(schema.modelHourUsage.bucketStartUtc, modelFromUtc),
                  lt(schema.modelHourUsage.bucketStartUtc, modelToUtc),
                ),
              )
              .groupBy(
                schema.modelHourUsage.bucketStartUtc,
                schema.modelHourUsage.model,
              )
              .all(),
            db
              .select({
                lastProxyLogId: schema.analyticsProjectionCheckpoints.lastProxyLogId,
              })
              .from(schema.analyticsProjectionCheckpoints)
              .where(
                eq(
                  schema.analyticsProjectionCheckpoints.projectorKey,
                  USAGE_AGGREGATES_PROJECTOR_KEY,
                ),
              )
              .get(),
          ]);

          const watermarkId = Math.max(0, Number(checkpoint?.lastProxyLogId || 0));
          const tailLogs = await db
            .select({
              id: schema.proxyLogs.id,
              createdAt: schema.proxyLogs.createdAt,
              modelActual: schema.proxyLogs.modelActual,
              modelRequested: schema.proxyLogs.modelRequested,
              status: schema.proxyLogs.status,
              latencyMs: schema.proxyLogs.latencyMs,
              totalTokens: schema.proxyLogs.totalTokens,
              estimatedCost: proxyCostSqlExpression(),
            })
            .from(schema.proxyLogs)
            .innerJoin(
              schema.accounts,
              eq(schema.proxyLogs.accountId, schema.accounts.id),
            )
            .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
            .where(
              and(
                eq(schema.sites.status, "active"),
                gt(schema.proxyLogs.id, watermarkId),
                gte(schema.proxyLogs.createdAt, modelFromUtc),
                lt(schema.proxyLogs.createdAt, modelToUtc),
              ),
            )
            .all();

          const mergedDaily = new Map<string, ModelAnalysisDailyUsageRow>();
          for (const row of baseRows) {
            const localDay = toLocalDayKeyFromStoredUtc(row.bucketStartUtc);
            if (!localDay) continue;
            const model = String(row.model || "").trim() || "unknown";
            const key = `${localDay}::${model}`;
            mergedDaily.set(key, {
              localDay,
              model,
              totalCalls: Number(row.totalCalls || 0),
              successCalls: Number(row.successCalls || 0),
              totalTokens: Number(row.totalTokens || 0),
              totalSpend: Number(row.totalSpend || 0),
              totalLatencyMs: Number(row.totalLatencyMs || 0),
            });
          }

          for (const log of tailLogs) {
            const localDay = toLocalDayKeyFromStoredUtc(log.createdAt);
            if (!localDay) continue;
            const model = String(log.modelActual || log.modelRequested || "").trim() || "unknown";
            const key = `${localDay}::${model}`;
            const current = mergedDaily.get(key) || {
              localDay,
              model,
              totalCalls: 0,
              successCalls: 0,
              totalTokens: 0,
              totalSpend: 0,
              totalLatencyMs: 0,
            };
            current.totalCalls += 1;
            if (String(log.status || "").toLowerCase() === "success") {
              current.successCalls += 1;
            }
            current.totalTokens += Number(log.totalTokens || 0);
            current.totalSpend += Number(log.estimatedCost || 0);
            current.totalLatencyMs += Number(log.latencyMs || 0);
            mergedDaily.set(key, current);
          }

          return buildModelAnalysisFromDailyUsage(Array.from(mergedDaily.values()), {
            days: analysisDays,
          });
        })()
      : (async () => {
          const [baseRows, checkpoint] = await Promise.all([
          db
            .select({
              localDay: schema.modelDayUsage.localDay,
              model: schema.modelDayUsage.model,
              totalCalls: sql<number>`coalesce(sum(${schema.modelDayUsage.totalCalls}), 0)`,
              successCalls: sql<number>`coalesce(sum(${schema.modelDayUsage.successCalls}), 0)`,
              totalTokens: sql<number>`coalesce(sum(${schema.modelDayUsage.totalTokens}), 0)`,
              totalSpend: sql<number>`coalesce(sum(${schema.modelDayUsage.totalSpend}), 0)`,
              totalLatencyMs: sql<number>`coalesce(sum(${schema.modelDayUsage.totalLatencyMs}), 0)`,
            })
            .from(schema.modelDayUsage)
            .innerJoin(
              schema.sites,
              eq(schema.modelDayUsage.siteId, schema.sites.id),
            )
            .where(
              and(
                eq(schema.sites.status, "active"),
                gte(schema.modelDayUsage.localDay, aggregateFromDay),
                lte(schema.modelDayUsage.localDay, aggregateToDay),
              ),
            )
            .groupBy(schema.modelDayUsage.localDay, schema.modelDayUsage.model)
            .all(),
          db
            .select({
              lastProxyLogId: schema.analyticsProjectionCheckpoints.lastProxyLogId,
            })
            .from(schema.analyticsProjectionCheckpoints)
            .where(
              eq(
                schema.analyticsProjectionCheckpoints.projectorKey,
                USAGE_AGGREGATES_PROJECTOR_KEY,
              ),
            )
            .get(),
        ]);

        const watermarkId = Math.max(0, Number(checkpoint?.lastProxyLogId || 0));
        const tailLogs = await db
          .select({
            id: schema.proxyLogs.id,
            createdAt: schema.proxyLogs.createdAt,
            modelActual: schema.proxyLogs.modelActual,
            modelRequested: schema.proxyLogs.modelRequested,
            status: schema.proxyLogs.status,
            latencyMs: schema.proxyLogs.latencyMs,
            totalTokens: schema.proxyLogs.totalTokens,
            estimatedCost: proxyCostSqlExpression(),
          })
          .from(schema.proxyLogs)
          .innerJoin(
            schema.accounts,
            eq(schema.proxyLogs.accountId, schema.accounts.id),
          )
          .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
          .where(
            and(
              eq(schema.sites.status, "active"),
              gt(schema.proxyLogs.id, watermarkId),
              gte(schema.proxyLogs.createdAt, modelFromUtc),
              lt(schema.proxyLogs.createdAt, modelToUtc),
            ),
          )
          .all();
          const tailRows: ModelAnalysisDailyUsageRow[] = [];
          const tailMap = new Map<string, ModelAnalysisDailyUsageRow>();
          for (const log of tailLogs) {
            if (Number(log.id || 0) <= watermarkId) continue;
            const localDay = toLocalDayKeyFromStoredUtc(log.createdAt);
            if (!localDay) continue;
            const model = String(log.modelActual || log.modelRequested || "").trim() || "unknown";
            const key = `${localDay}::${model}`;
            const current = tailMap.get(key) || {
              localDay,
              model,
              totalCalls: 0,
              successCalls: 0,
              totalTokens: 0,
              totalSpend: 0,
              totalLatencyMs: 0,
            };
            current.totalCalls += 1;
            if (String(log.status || "").toLowerCase() === "success") {
              current.successCalls += 1;
            }
            current.totalTokens += Number(log.totalTokens || 0);
            current.totalSpend += Number(log.estimatedCost || 0);
            current.totalLatencyMs += Number(log.latencyMs || 0);
            tailMap.set(key, current);
          }
          tailRows.push(...tailMap.values());

          return buildModelAnalysisFromDailyUsage(
            mergeDailyUsageRows(baseRows, tailRows),
            {
              days: analysisDays,
            },
          );
        })(),
  ]);

  const sortedSites = activeSites.sort(
    (left: SiteAvailabilitySiteRow, right: SiteAvailabilitySiteRow) => {
      const leftPinned = left.isPinned ? 1 : 0;
      const rightPinned = right.isPinned ? 1 : 0;
      if (leftPinned !== rightPinned) return rightPinned - leftPinned;
      const leftOrder = Number(left.sortOrder || 0);
      const rightOrder = Number(right.sortOrder || 0);
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return String(left.name || "").localeCompare(String(right.name || ""));
    },
  );
  const activeSiteIdSet = new Set(sortedSites.map((site) => site.id));

  return {
    siteAvailability: buildSiteAvailabilitySummariesFromHourlyAggregates(
      sortedSites,
      siteAvailabilityRows
        .filter((row) => activeSiteIdSet.has(row.siteId))
        .map((row) => ({
          siteId: row.siteId,
          hourStartUtc: row.bucketStartUtc,
          totalRequests: row.totalCalls,
          successCount: row.successCalls,
          failedCount: row.failedCalls,
          totalLatencyMs: row.totalLatencyMs,
          latencyCount: row.latencyCount,
        })),
      siteAvailabilityNow,
    ),
    modelAnalysis,
  };
}

export async function getDashboardSummarySnapshot(options?: {
  forceRefresh?: boolean;
}): Promise<SnapshotEnvelope<DashboardSummaryPayload>> {
  return readSnapshotCache({
    namespace: "dashboard-summary",
    key: "default",
    ttlMs: DASHBOARD_SUMMARY_TTL_MS,
    forceRefresh: options?.forceRefresh,
    persistence: dashboardSummaryPersistence,
    loader: loadDashboardSummaryPayload,
  });
}

export async function getDashboardInsightsSnapshot(options?: {
  forceRefresh?: boolean;
  modelDays?: number;
  modelHours?: number;
  modelFromDay?: string | null;
  modelToDay?: string | null;
}): Promise<SnapshotEnvelope<DashboardInsightsPayload>> {
  const modelDays = Number.isFinite(options?.modelDays)
    ? Math.max(1, Math.min(365, Math.floor(options?.modelDays || 7)))
    : 7;
  const modelFromDay = (options?.modelFromDay || "").trim() || null;
  const modelToDay = (options?.modelToDay || "").trim() || null;
  const modelHours = Number.isFinite(options?.modelHours)
    ? Math.max(1, Math.min(24 * 365, Math.floor(options?.modelHours || 0)))
    : null;
  const hasCustomRange = !!(
    !modelHours &&
    modelFromDay &&
    modelToDay &&
    modelFromDay <= modelToDay
  );

  const cacheKey = modelHours
    ? `model-hours:${modelHours}`
    : hasCustomRange
      ? `model-range:${modelFromDay}:${modelToDay}`
      : `model-days:${modelDays}`;

  return readSnapshotCache({
    namespace: "dashboard-insights",
    key: cacheKey,
    ttlMs: DASHBOARD_INSIGHTS_TTL_MS,
    forceRefresh: options?.forceRefresh,
    persistence: createDashboardInsightsPersistence(cacheKey),
    loader: () =>
      loadDashboardInsightsPayload({
        modelDays,
        modelHours,
        modelFromDay,
        modelToDay,
      }),
  });
}
