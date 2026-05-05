import { eq } from 'drizzle-orm';
import { db, runtimeDbDialect, schema } from '../../db/index.js';

export type ChannelRoutingStateRecord = {
  channelId: number;
  successAlpha: number;
  successBeta: number;
  latencyLogMu: number;
  latencyLogSigma2: number;
  latencyN: number;
  promptEwma: number;
  completionEwma: number;
  cacheReadEwma: number;
  cacheCreationEwma: number;
  pricingSnapshot: unknown;
  manualWeight: number;
  version: number;
  updatedAt: string;
};

function toJsonString(value: unknown): string | null {
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

export async function loadAllChannelRoutingStateRows(): Promise<ChannelRoutingStateRecord[]> {
  const rows = await db.select().from(schema.channelRoutingState).all();
  return rows.map((row) => ({
    channelId: row.channelId,
    successAlpha: row.successAlpha,
    successBeta: row.successBeta,
    latencyLogMu: row.latencyLogMu,
    latencyLogSigma2: row.latencyLogSigma2,
    latencyN: row.latencyN,
    promptEwma: row.promptEwma,
    completionEwma: row.completionEwma,
    cacheReadEwma: row.cacheReadEwma,
    cacheCreationEwma: row.cacheCreationEwma,
    pricingSnapshot: row.pricingSnapshot,
    manualWeight: row.manualWeight,
    version: row.version,
    updatedAt: row.updatedAt || new Date().toISOString(),
  }));
}

async function upsertRowMySql(row: ChannelRoutingStateRecord): Promise<void> {
  const existing = await db.select({ channelId: schema.channelRoutingState.channelId })
    .from(schema.channelRoutingState)
    .where(eq(schema.channelRoutingState.channelId, row.channelId))
    .get();

  const serializedPricingSnapshot = toJsonString(row.pricingSnapshot);
  if (existing) {
    await db.update(schema.channelRoutingState).set({
      successAlpha: row.successAlpha,
      successBeta: row.successBeta,
      latencyLogMu: row.latencyLogMu,
      latencyLogSigma2: row.latencyLogSigma2,
      latencyN: row.latencyN,
      promptEwma: row.promptEwma,
      completionEwma: row.completionEwma,
      cacheReadEwma: row.cacheReadEwma,
      cacheCreationEwma: row.cacheCreationEwma,
      pricingSnapshot: serializedPricingSnapshot,
      manualWeight: row.manualWeight,
      version: row.version,
      updatedAt: row.updatedAt,
    }).where(eq(schema.channelRoutingState.channelId, row.channelId)).run();
    return;
  }

  await db.insert(schema.channelRoutingState).values({
    channelId: row.channelId,
    successAlpha: row.successAlpha,
    successBeta: row.successBeta,
    latencyLogMu: row.latencyLogMu,
    latencyLogSigma2: row.latencyLogSigma2,
    latencyN: row.latencyN,
    promptEwma: row.promptEwma,
    completionEwma: row.completionEwma,
    cacheReadEwma: row.cacheReadEwma,
    cacheCreationEwma: row.cacheCreationEwma,
    pricingSnapshot: serializedPricingSnapshot,
    manualWeight: row.manualWeight,
    version: row.version,
    updatedAt: row.updatedAt,
  }).run();
}

export async function upsertChannelRoutingStateRows(rows: ChannelRoutingStateRecord[]): Promise<void> {
  if (rows.length <= 0) return;

  if (runtimeDbDialect === 'mysql') {
    for (const row of rows) {
      await upsertRowMySql(row);
    }
    return;
  }

  for (const row of rows) {
    const serializedPricingSnapshot = toJsonString(row.pricingSnapshot);
    await (db.insert(schema.channelRoutingState)
      .values({
        channelId: row.channelId,
        successAlpha: row.successAlpha,
        successBeta: row.successBeta,
        latencyLogMu: row.latencyLogMu,
        latencyLogSigma2: row.latencyLogSigma2,
        latencyN: row.latencyN,
        promptEwma: row.promptEwma,
        completionEwma: row.completionEwma,
        cacheReadEwma: row.cacheReadEwma,
        cacheCreationEwma: row.cacheCreationEwma,
        pricingSnapshot: serializedPricingSnapshot,
        manualWeight: row.manualWeight,
        version: row.version,
        updatedAt: row.updatedAt,
      }) as any)
      .onConflictDoUpdate({
        target: schema.channelRoutingState.channelId,
        set: {
          successAlpha: row.successAlpha,
          successBeta: row.successBeta,
          latencyLogMu: row.latencyLogMu,
          latencyLogSigma2: row.latencyLogSigma2,
          latencyN: row.latencyN,
          promptEwma: row.promptEwma,
          completionEwma: row.completionEwma,
          cacheReadEwma: row.cacheReadEwma,
          cacheCreationEwma: row.cacheCreationEwma,
          pricingSnapshot: serializedPricingSnapshot,
          manualWeight: row.manualWeight,
          version: row.version,
          updatedAt: row.updatedAt,
        },
      })
      .run();
  }
}
