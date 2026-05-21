import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getLocalDayRangeUtc, formatLocalDateTime, getResolvedTimeZone } from './localTimeService.js';
import { parseCheckinRewardAmount } from './checkinRewardParser.js';
import { estimateRewardWithTodayIncomeFallback } from './todayIncomeRewardService.js';
import { runUsageAggregationProjectionPass } from './usageAggregationService.js';

export type DailySummaryMetrics = {
  localDay: string;
  generatedAtLocal: string;
  timeZone: string;
  totalAccounts: number;
  activeAccounts: number;
  lowBalanceAccounts: number;
  checkinTotal: number;
  checkinSuccess: number;
  checkinSkipped: number;
  checkinFailed: number;
  proxyTotal: number;
  proxySuccess: number;
  proxyFailed: number;
  proxyTotalTokens: number;
  todaySpend: number;
  todayReward: number;
};

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export async function collectDailySummaryMetrics(now = new Date()): Promise<DailySummaryMetrics> {
  await runUsageAggregationProjectionPass();

  const { localDay, startUtc, endUtc } = getLocalDayRangeUtc(now);

  const [accountRows, todayCheckinRows, todayProxyRow, todaySpendRow] = await Promise.all([
    db.select({
      id: schema.accounts.id,
      balance: schema.accounts.balance,
      status: schema.accounts.status,
      extraConfig: schema.accounts.extraConfig,
    }).from(schema.accounts)
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(eq(schema.sites.status, 'active'))
      .all(),
    db.select({
      status: schema.checkinLogs.status,
      reward: schema.checkinLogs.reward,
      message: schema.checkinLogs.message,
      accountId: schema.accounts.id,
    }).from(schema.checkinLogs)
      .innerJoin(schema.accounts, eq(schema.checkinLogs.accountId, schema.accounts.id))
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(and(
        gte(schema.checkinLogs.createdAt, startUtc),
        lt(schema.checkinLogs.createdAt, endUtc),
        eq(schema.sites.status, 'active'),
      ))
      .all(),
    db.select({
      total: sql<number>`coalesce(sum(${schema.siteDayUsage.totalCalls}), 0)`,
      success: sql<number>`coalesce(sum(${schema.siteDayUsage.successCalls}), 0)`,
      failed: sql<number>`coalesce(sum(${schema.siteDayUsage.failedCalls}), 0)`,
      totalTokens: sql<number>`coalesce(sum(${schema.siteDayUsage.totalTokens}), 0)`,
    }).from(schema.siteDayUsage)
      .innerJoin(schema.sites, eq(schema.siteDayUsage.siteId, schema.sites.id))
      .where(and(
        eq(schema.siteDayUsage.localDay, localDay),
        eq(schema.sites.status, 'active'),
      ))
      .get(),
    db.select({
      todaySpend: sql<number>`coalesce(sum(coalesce(${schema.siteDayUsage.totalSiteSpend}, 0)), 0)`,
    }).from(schema.siteDayUsage)
      .innerJoin(schema.sites, eq(schema.siteDayUsage.siteId, schema.sites.id))
      .where(and(
        eq(schema.siteDayUsage.localDay, localDay),
        eq(schema.sites.status, 'active'),
      ))
      .get(),
  ]);

  const activeAccounts = accountRows.filter((a: { status: string | null }) => a.status === 'active').length;
  const lowBalanceAccounts = accountRows.filter((a: { balance: number | null }) => (a.balance || 0) < 1).length;

  const checkinSkipped = todayCheckinRows.filter((r: { status: string | null }) => r.status === 'skipped').length;
  const checkinFailed = todayCheckinRows.filter((r: { status: string | null }) => r.status === 'failed').length;
  const checkinSuccess = todayCheckinRows.length - checkinSkipped - checkinFailed;

  const rewardByAccount: Record<number, number> = {};
  const successCountByAccount: Record<number, number> = {};
  const parsedRewardCountByAccount: Record<number, number> = {};
  for (const row of todayCheckinRows) {
    if (row.status !== 'success') continue;
    const accountId = row.accountId;
    successCountByAccount[accountId] = (successCountByAccount[accountId] || 0) + 1;
    const rewardValue = parseCheckinRewardAmount(row.reward) || parseCheckinRewardAmount(row.message);
    if (rewardValue <= 0) continue;
    rewardByAccount[accountId] = (rewardByAccount[accountId] || 0) + rewardValue;
    parsedRewardCountByAccount[accountId] = (parsedRewardCountByAccount[accountId] || 0) + 1;
  }

  const proxyTotal = Number(todayProxyRow?.total || 0);
  const proxySuccess = Number(todayProxyRow?.success || 0);
  const proxyFailed = Number(todayProxyRow?.failed || 0);
  const proxyTotalTokens = Number(todayProxyRow?.totalTokens || 0);
  const todaySpend = Number(todaySpendRow?.todaySpend || 0);

  const todayReward = accountRows.reduce((sum: number, account: { id: number; extraConfig: string | null }) =>
    sum + estimateRewardWithTodayIncomeFallback({
      day: localDay,
      successCount: successCountByAccount[account.id] || 0,
      parsedRewardCount: parsedRewardCountByAccount[account.id] || 0,
      rewardSum: rewardByAccount[account.id] || 0,
      extraConfig: account.extraConfig,
    }), 0);

  return {
    localDay,
    generatedAtLocal: formatLocalDateTime(now),
    timeZone: getResolvedTimeZone(),
    totalAccounts: accountRows.length,
    activeAccounts,
    lowBalanceAccounts,
    checkinTotal: todayCheckinRows.length,
    checkinSuccess: Math.max(0, checkinSuccess),
    checkinSkipped,
    checkinFailed,
    proxyTotal,
    proxySuccess,
    proxyFailed,
    proxyTotalTokens,
    todaySpend: round6(todaySpend),
    todayReward: round6(todayReward),
  };
}

export function buildDailySummaryNotification(metrics: DailySummaryMetrics): { title: string; message: string } {
  const net = round6(metrics.todayReward - metrics.todaySpend);
  const title = `每日总结 ${metrics.localDay}`;
  const message = [
    `日期: ${metrics.localDay}`,
    `生成时间: ${metrics.generatedAtLocal} (${metrics.timeZone})`,
    '',
    `账号概览: 总计 ${metrics.totalAccounts} | 活跃 ${metrics.activeAccounts} | 低余额(<$1) ${metrics.lowBalanceAccounts}`,
    `签到统计: 总计 ${metrics.checkinTotal} | 成功 ${metrics.checkinSuccess} | 跳过 ${metrics.checkinSkipped} | 失败 ${metrics.checkinFailed}`,
    `代理统计: 总计 ${metrics.proxyTotal} | 成功 ${metrics.proxySuccess} | 失败 ${metrics.proxyFailed} | Tokens ${metrics.proxyTotalTokens.toLocaleString()}`,
    `费用统计: 支出 $${metrics.todaySpend.toFixed(6)} | 奖励 $${metrics.todayReward.toFixed(6)} | 净值 $${net.toFixed(6)}`,
  ].join('\n');
  return { title, message };
}
