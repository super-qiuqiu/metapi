import { config } from '../../config.js';
import {
  incUsageContractViolation,
  observeExpectedVsActualCostError,
  observeScoreComponent,
  observeStateFlush,
  setEwmaStateStaleness,
  setRecoveredChannels,
} from './channelRoutingMetrics.js';
import {
  type ChannelBanditScoreBreakdown,
  selectChannelByBandit,
} from './channelBanditSelector.js';
import {
  loadAllChannelRoutingStateRows,
  upsertChannelRoutingStateRows,
  type ChannelRoutingStateRecord,
} from './channelRoutingStateRepo.js';

const DEFAULT_ALPHA = 2;
const DEFAULT_BETA = 2;
const DEFAULT_SIGMA2 = 0.8;
const DEFAULT_VERSION = 1;
const DEFAULT_MANUAL_WEIGHT = 1;
const MIN_EPSILON = 1e-6;
const MIN_LATENCY_MS = 50;
const MAX_LATENCY_MS = 120_000;
const MAX_EXPECTED_COST = 1_000;
const MIN_EXPECTED_COST = 1e-6;
const FLUSH_MIN_INTERVAL_MS = 5_000;
const FLUSH_MAX_INTERVAL_MS = 60_000;
const SNAPSHOT_MAX_STALE_MS = 24 * 60 * 60 * 1000;

type ChannelUsageSample = {
  promptTokens?: number | null;
  completionTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  promptTokensIncludeCache?: boolean | null;
};

export type RoutingFailureClass = 'retryable_upstream' | 'throttling' | 'caller_fault';

export type PricingSnapshot = {
  quotaType: 0 | 1;
  referenceUnitCost: number;
  groupMultiplier: number;
  inputRate?: number;
  outputRate?: number;
  cacheReadRate?: number;
  cacheCreationRate?: number;
};

type BanditState = {
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
  pricingSnapshot: PricingSnapshot | null;
  manualWeight: number;
  version: number;
  updatedAtMs: number;
  dirty: boolean;
};

export type BanditCandidateInput = {
  channelId: number;
  siteId: number;
  priority: number;
  successCount: number;
  failCount: number;
  totalLatencyMs: number;
  accountUnitCost: number | null;
  fallbackUnitCost: number;
  manualWeight: number;
};

type SelectResult = {
  selectedIndex: number;
  explored: boolean;
  breakdown: ChannelBanditScoreBreakdown[];
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toFiniteNumber(value: unknown, fallback = 0): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toPositiveNumber(value: unknown, fallback: number): number {
  return Math.max(0, toFiniteNumber(value, fallback));
}

function toPositiveInt(value: unknown, fallback = 0): number {
  return Math.max(0, Math.trunc(toFiniteNumber(value, fallback)));
}

function toIsoString(ms: number): string {
  return new Date(ms).toISOString();
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function parsePricingSnapshot(raw: unknown): PricingSnapshot | null {
  const record = parseJsonObject(raw);
  if (!record) return null;
  const quotaType = toPositiveInt(record.quotaType, 0) === 1 ? 1 : 0;
  const referenceUnitCost = clamp(toPositiveNumber(record.referenceUnitCost, config.routingFallbackUnitCost), MIN_EXPECTED_COST, MAX_EXPECTED_COST);
  const groupMultiplier = clamp(toPositiveNumber(record.groupMultiplier, 1), 0.01, 100);
  const inputRate = toPositiveNumber(record.inputRate, 0);
  const outputRate = toPositiveNumber(record.outputRate, 0);
  const cacheReadRate = toPositiveNumber(record.cacheReadRate, 0);
  const cacheCreationRate = toPositiveNumber(record.cacheCreationRate, 0);

  return {
    quotaType,
    referenceUnitCost,
    groupMultiplier,
    ...(inputRate > 0 ? { inputRate } : {}),
    ...(outputRate > 0 ? { outputRate } : {}),
    ...(cacheReadRate > 0 ? { cacheReadRate } : {}),
    ...(cacheCreationRate > 0 ? { cacheCreationRate } : {}),
  };
}

function resolveInitialLatencyMs(candidate: BanditCandidateInput): number {
  const successCount = toPositiveInt(candidate.successCount, 0);
  const totalLatencyMs = toPositiveNumber(candidate.totalLatencyMs, 0);
  if (successCount <= 0 || totalLatencyMs <= 0) return 2_000;
  return clamp(totalLatencyMs / successCount, MIN_LATENCY_MS, MAX_LATENCY_MS);
}

function usageFromState(state: BanditState): ChannelUsageSample {
  return {
    promptTokens: state.promptEwma,
    completionTokens: state.completionEwma,
    cacheReadTokens: state.cacheReadEwma,
    cacheCreationTokens: state.cacheCreationEwma,
    promptTokensIncludeCache: true,
  };
}

function sanitizeUsage(sample?: ChannelUsageSample | null): {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  nonCacheInputTokens: number;
  violated: boolean;
  violationReason: string;
} {
  const promptTokens = toPositiveInt(sample?.promptTokens, 0);
  const completionTokens = toPositiveInt(sample?.completionTokens, 0);
  let cacheReadTokens = toPositiveInt(sample?.cacheReadTokens, 0);
  let cacheCreationTokens = toPositiveInt(sample?.cacheCreationTokens, 0);

  let violated = false;
  let violationReason = 'ok';

  if (cacheReadTokens + cacheCreationTokens > promptTokens) {
    violated = true;
    violationReason = 'cache_tokens_exceed_prompt';
    const totalCache = cacheReadTokens + cacheCreationTokens;
    const ratio = totalCache > 0 ? (promptTokens / totalCache) : 0;
    cacheReadTokens = Math.floor(cacheReadTokens * ratio);
    cacheCreationTokens = Math.floor(cacheCreationTokens * ratio);
  }

  const nonCacheInputTokens = Math.max(0, promptTokens - cacheReadTokens - cacheCreationTokens);
  return {
    promptTokens,
    completionTokens,
    cacheReadTokens,
    cacheCreationTokens,
    nonCacheInputTokens,
    violated,
    violationReason,
  };
}

function resolveExpectedCost(state: BanditState, usage: ChannelUsageSample | null): number {
  const snapshot = state.pricingSnapshot;
  if (!snapshot) {
    return clamp(config.routingFallbackUnitCost, MIN_EXPECTED_COST, MAX_EXPECTED_COST);
  }

  if (snapshot.quotaType === 1) {
    return clamp(snapshot.referenceUnitCost * snapshot.groupMultiplier, MIN_EXPECTED_COST, MAX_EXPECTED_COST);
  }

  const normalized = sanitizeUsage(usage);
  if (normalized.violated) {
    incUsageContractViolation(normalized.violationReason);
  }

  if (
    snapshot.inputRate
    || snapshot.outputRate
    || snapshot.cacheReadRate
    || snapshot.cacheCreationRate
  ) {
    const perMillionCost = (
      normalized.nonCacheInputTokens * (snapshot.inputRate || 0)
      + normalized.cacheReadTokens * (snapshot.cacheReadRate || 0)
      + normalized.cacheCreationTokens * (snapshot.cacheCreationRate || 0)
      + normalized.completionTokens * (snapshot.outputRate || 0)
    ) / 1_000_000;
    const estimated = perMillionCost * snapshot.groupMultiplier;
    return clamp(estimated, MIN_EXPECTED_COST, MAX_EXPECTED_COST);
  }

  return clamp(snapshot.referenceUnitCost * snapshot.groupMultiplier, MIN_EXPECTED_COST, MAX_EXPECTED_COST);
}

function decayState(state: BanditState, nowMs: number): void {
  const elapsedMs = nowMs - state.updatedAtMs;
  if (elapsedMs <= 0) return;

  const elapsedMinutes = elapsedMs / 60_000;
  const decayFactor = Math.pow(0.99, elapsedMinutes);
  const oldAlpha = state.successAlpha;
  const oldBeta = state.successBeta;
  const oldSigma = state.latencyLogSigma2;

  state.successAlpha = Math.max(DEFAULT_ALPHA, state.successAlpha * decayFactor);
  state.successBeta = Math.max(DEFAULT_BETA, state.successBeta * decayFactor);
  state.latencyLogSigma2 = clamp(state.latencyLogSigma2 + (elapsedMinutes * 0.0025), 0.05, 2.5);

  if (
    Math.abs(state.successAlpha - oldAlpha) > 1e-6
    || Math.abs(state.successBeta - oldBeta) > 1e-6
    || Math.abs(state.latencyLogSigma2 - oldSigma) > 1e-6
  ) {
    state.dirty = true;
    state.updatedAtMs = nowMs;
  }
}

export class ChannelBanditStore {
  private readonly states = new Map<number, BanditState>();
  private readonly dirtyChannelIds = new Set<number>();
  private loaded = false;
  private loadingPromise: Promise<void> | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loadingPromise) return await this.loadingPromise;

    this.loadingPromise = (async () => {
      const rows = await loadAllChannelRoutingStateRows();
      for (const row of rows) {
        const updatedAtMs = Number.isFinite(Date.parse(row.updatedAt))
          ? Date.parse(row.updatedAt)
          : Date.now();
        this.states.set(row.channelId, {
          channelId: row.channelId,
          successAlpha: Math.max(DEFAULT_ALPHA, toPositiveNumber(row.successAlpha, DEFAULT_ALPHA)),
          successBeta: Math.max(DEFAULT_BETA, toPositiveNumber(row.successBeta, DEFAULT_BETA)),
          latencyLogMu: toFiniteNumber(row.latencyLogMu, Math.log(2_000)),
          latencyLogSigma2: clamp(toPositiveNumber(row.latencyLogSigma2, DEFAULT_SIGMA2), 0.05, 3),
          latencyN: toPositiveInt(row.latencyN, 0),
          promptEwma: toPositiveNumber(row.promptEwma, 0),
          completionEwma: toPositiveNumber(row.completionEwma, 0),
          cacheReadEwma: toPositiveNumber(row.cacheReadEwma, 0),
          cacheCreationEwma: toPositiveNumber(row.cacheCreationEwma, 0),
          pricingSnapshot: parsePricingSnapshot(row.pricingSnapshot),
          manualWeight: clamp(toPositiveNumber(row.manualWeight, DEFAULT_MANUAL_WEIGHT), 0.5, 2),
          version: toPositiveInt(row.version, DEFAULT_VERSION) || DEFAULT_VERSION,
          updatedAtMs,
          dirty: false,
        });
      }
      setRecoveredChannels(rows.length);
      this.loaded = true;
      this.startBackgroundFlush();
    })().finally(() => {
      this.loadingPromise = null;
    });

    await this.loadingPromise;
  }

  private startBackgroundFlush(): void {
    if (this.flushTimer || process.env.NODE_ENV === 'test') return;
    const intervalMs = clamp(
      Math.trunc(toFiniteNumber(config.routingBanditFlushIntervalMs, 30_000)),
      FLUSH_MIN_INTERVAL_MS,
      FLUSH_MAX_INTERVAL_MS,
    );
    this.flushTimer = setInterval(() => {
      void this.flushDirty().catch((error) => {
        console.warn('[routing-bandit] flush failed', error);
      });
    }, intervalMs);
    this.flushTimer.unref?.();

    process.once('beforeExit', () => {
      void this.flushDirty();
    });
  }

  private getOrCreateState(candidate: BanditCandidateInput): BanditState {
    const existing = this.states.get(candidate.channelId);
    if (existing) {
      existing.manualWeight = clamp(candidate.manualWeight, 0.5, 2);
      return existing;
    }

    const successCount = toPositiveInt(candidate.successCount, 0);
    const failCount = toPositiveInt(candidate.failCount, 0);
    const avgLatencyMs = resolveInitialLatencyMs(candidate);
    const accountUnitCost = candidate.accountUnitCost;
    const referenceUnitCost = Number.isFinite(accountUnitCost as number) && (accountUnitCost as number) > 0
      ? Math.max(accountUnitCost as number, MIN_EXPECTED_COST)
      : Math.max(candidate.fallbackUnitCost, MIN_EXPECTED_COST);

    const state: BanditState = {
      channelId: candidate.channelId,
      successAlpha: DEFAULT_ALPHA + successCount,
      successBeta: DEFAULT_BETA + failCount,
      latencyLogMu: Math.log(clamp(avgLatencyMs, MIN_LATENCY_MS, MAX_LATENCY_MS)),
      latencyLogSigma2: DEFAULT_SIGMA2,
      latencyN: successCount,
      promptEwma: 0,
      completionEwma: 0,
      cacheReadEwma: 0,
      cacheCreationEwma: 0,
      pricingSnapshot: {
        quotaType: 1,
        referenceUnitCost,
        groupMultiplier: 1,
      },
      manualWeight: clamp(candidate.manualWeight, 0.5, 2),
      version: DEFAULT_VERSION,
      updatedAtMs: Date.now(),
      dirty: true,
    };

    this.states.set(candidate.channelId, state);
    this.dirtyChannelIds.add(candidate.channelId);
    return state;
  }

  private markDirty(state: BanditState): void {
    state.dirty = true;
    this.dirtyChannelIds.add(state.channelId);
  }

  async flushDirty(): Promise<void> {
    if (!this.loaded || this.dirtyChannelIds.size <= 0) return;

    const startedAtMs = Date.now();
    const rows: ChannelRoutingStateRecord[] = [];
    for (const channelId of this.dirtyChannelIds) {
      const state = this.states.get(channelId);
      if (!state) continue;
      rows.push({
        channelId: state.channelId,
        successAlpha: state.successAlpha,
        successBeta: state.successBeta,
        latencyLogMu: state.latencyLogMu,
        latencyLogSigma2: state.latencyLogSigma2,
        latencyN: state.latencyN,
        promptEwma: state.promptEwma,
        completionEwma: state.completionEwma,
        cacheReadEwma: state.cacheReadEwma,
        cacheCreationEwma: state.cacheCreationEwma,
        pricingSnapshot: state.pricingSnapshot,
        manualWeight: state.manualWeight,
        version: state.version,
        updatedAt: toIsoString(state.updatedAtMs),
      });
    }

    if (rows.length <= 0) return;

    try {
      await upsertChannelRoutingStateRows(rows);
      this.dirtyChannelIds.clear();
      for (const row of rows) {
        const state = this.states.get(row.channelId);
        if (state) state.dirty = false;
      }
      observeStateFlush(Date.now() - startedAtMs, true);
    } catch (error) {
      observeStateFlush(Date.now() - startedAtMs, false);
      throw error;
    }
  }

  async selectCandidate(inputs: BanditCandidateInput[]): Promise<SelectResult | null> {
    await this.ensureLoaded();
    if (inputs.length <= 0) return null;

    const nowMs = Date.now();
    const scoreCandidates = inputs.map((candidate) => {
      const state = this.getOrCreateState(candidate);
      const snapshotStaleSeconds = Math.max(0, Math.floor((nowMs - state.updatedAtMs) / 1_000));
      setEwmaStateStaleness(candidate.channelId, snapshotStaleSeconds);

      if ((nowMs - state.updatedAtMs) > SNAPSHOT_MAX_STALE_MS) {
        state.latencyLogSigma2 = clamp(Math.max(state.latencyLogSigma2, 1.25), 0.05, 3);
        this.markDirty(state);
      }
      decayState(state, nowMs);

      const expectedCost = config.routingBanditFeatures.expectedCost === false
        ? 1
        : resolveExpectedCost(state, usageFromState(state));

      return {
        channelId: candidate.channelId,
        siteId: candidate.siteId,
        priority: candidate.priority,
        alpha: Math.max(DEFAULT_ALPHA, state.successAlpha),
        beta: Math.max(DEFAULT_BETA, state.successBeta),
        latencyLogMu: state.latencyLogMu,
        latencyLogSigma2: state.latencyLogSigma2,
        latencyN: state.latencyN,
        expectedCost,
        manualWeight: clamp(state.manualWeight, 0.5, 2),
        coldStartLatencyMs: resolveInitialLatencyMs(candidate),
      };
    });

    const result = selectChannelByBandit(scoreCandidates, {
      scoreThetaWeight: toFiniteNumber(config.routingBanditWeights.theta, 1),
      scoreLatencyWeight: toFiniteNumber(config.routingBanditWeights.latency, 0.25),
      scoreCostWeight: toFiniteNumber(config.routingBanditWeights.cost, 0.45),
      scoreManualWeight: toFiniteNumber(config.routingBanditWeights.manual, 0.15),
      thetaMin: 0.05,
      thetaMax: 0.995,
      latencyMinMs: MIN_LATENCY_MS,
      latencyMaxMs: MAX_LATENCY_MS,
      expectedCostMin: MIN_EXPECTED_COST,
      expectedCostMax: MAX_EXPECTED_COST,
      manualWeightMin: 0.5,
      manualWeightMax: 2,
      coldStartLatencyN: 5,
      tsSamplingEnabled: config.routingBanditFeatures.tsSampling !== false,
      p2cEnabled: config.routingBanditFeatures.p2c !== false,
    });
    if (!result) return null;

    const selectedBreakdown = result.breakdown[result.selectedIndex];
    if (selectedBreakdown) {
      observeScoreComponent('theta', selectedBreakdown.theta);
      observeScoreComponent('latency', selectedBreakdown.latencyMs);
      observeScoreComponent('cost', selectedBreakdown.expectedCost);
    }

    return {
      selectedIndex: result.selectedIndex,
      explored: result.explored,
      breakdown: result.breakdown,
    };
  }

  async recordSuccess(
    channelId: number,
    latencyMs: number,
    actualCost: number,
    usage?: ChannelUsageSample | null,
    labels?: { model?: string | null; siteId?: number | null },
  ): Promise<void> {
    await this.ensureLoaded();
    const state = this.states.get(channelId);
    if (!state) return;

    const nowMs = Date.now();
    const sanitized = sanitizeUsage(usage);
    if (sanitized.violated) {
      incUsageContractViolation(sanitized.violationReason);
    }

    if (config.routingBanditFeatures.ewmaHealth) {
      state.successAlpha += 1;

      const clampedLatency = clamp(toPositiveNumber(latencyMs, 0), MIN_LATENCY_MS, MAX_LATENCY_MS);
      const logLatency = Math.log(clampedLatency);
      state.latencyN += 1;
      const alpha = 1 / Math.min(64, Math.max(1, state.latencyN));
      const delta = logLatency - state.latencyLogMu;
      state.latencyLogMu += alpha * delta;
      state.latencyLogSigma2 = clamp((1 - alpha) * state.latencyLogSigma2 + alpha * (delta * delta), 0.05, 3);
    }

    const ewmaAlpha = 0.3;
    state.promptEwma = state.promptEwma > 0
      ? ((1 - ewmaAlpha) * state.promptEwma + ewmaAlpha * sanitized.promptTokens)
      : sanitized.promptTokens;
    state.completionEwma = state.completionEwma > 0
      ? ((1 - ewmaAlpha) * state.completionEwma + ewmaAlpha * sanitized.completionTokens)
      : sanitized.completionTokens;
    state.cacheReadEwma = state.cacheReadEwma > 0
      ? ((1 - ewmaAlpha) * state.cacheReadEwma + ewmaAlpha * sanitized.cacheReadTokens)
      : sanitized.cacheReadTokens;
    state.cacheCreationEwma = state.cacheCreationEwma > 0
      ? ((1 - ewmaAlpha) * state.cacheCreationEwma + ewmaAlpha * sanitized.cacheCreationTokens)
      : sanitized.cacheCreationTokens;

    const normalizedActualCost = clamp(toPositiveNumber(actualCost, 0), 0, MAX_EXPECTED_COST);
    const expectedCost = resolveExpectedCost(state, usage ?? null);

    if (state.pricingSnapshot) {
      if (normalizedActualCost > 0) {
        state.pricingSnapshot.referenceUnitCost = state.pricingSnapshot.referenceUnitCost > 0
          ? ((1 - ewmaAlpha) * state.pricingSnapshot.referenceUnitCost + ewmaAlpha * normalizedActualCost)
          : normalizedActualCost;
      }
    }

    state.updatedAtMs = nowMs;
    this.markDirty(state);

    observeExpectedVsActualCostError({
      model: labels?.model?.trim() || 'unknown',
      site: labels?.siteId != null ? String(labels.siteId) : 'unknown',
    }, expectedCost, normalizedActualCost);
  }

  async recordFailure(channelId: number, failureClass: RoutingFailureClass): Promise<void> {
    await this.ensureLoaded();
    if (!config.routingBanditFeatures.ewmaHealth) return;
    const state = this.states.get(channelId);
    if (!state) return;

    if (failureClass === 'retryable_upstream') {
      state.successBeta += 1;
    } else if (failureClass === 'throttling') {
      state.successBeta += 0.4;
    }

    state.updatedAtMs = Date.now();
    this.markDirty(state);
  }

  async upsertPricingSnapshot(channelId: number, snapshot: PricingSnapshot): Promise<void> {
    await this.ensureLoaded();
    if (!Number.isFinite(channelId) || channelId <= 0) return;
    const state = this.states.get(channelId);
    if (!state) return;
    state.pricingSnapshot = {
      quotaType: snapshot.quotaType === 1 ? 1 : 0,
      referenceUnitCost: clamp(toPositiveNumber(snapshot.referenceUnitCost, config.routingFallbackUnitCost), MIN_EXPECTED_COST, MAX_EXPECTED_COST),
      groupMultiplier: clamp(toPositiveNumber(snapshot.groupMultiplier, 1), 0.01, 100),
      ...(snapshot.inputRate != null ? { inputRate: toPositiveNumber(snapshot.inputRate, 0) } : {}),
      ...(snapshot.outputRate != null ? { outputRate: toPositiveNumber(snapshot.outputRate, 0) } : {}),
      ...(snapshot.cacheReadRate != null ? { cacheReadRate: toPositiveNumber(snapshot.cacheReadRate, 0) } : {}),
      ...(snapshot.cacheCreationRate != null ? { cacheCreationRate: toPositiveNumber(snapshot.cacheCreationRate, 0) } : {}),
    };
    state.updatedAtMs = Date.now();
    this.markDirty(state);
  }

  async runDecay(nowMs = Date.now()): Promise<void> {
    await this.ensureLoaded();
    for (const state of this.states.values()) {
      const beforeUpdatedAt = state.updatedAtMs;
      decayState(state, nowMs);
      if (state.updatedAtMs !== beforeUpdatedAt) {
        this.markDirty(state);
      }
    }
  }

  resetForTests(): void {
    this.states.clear();
    this.dirtyChannelIds.clear();
    this.loaded = false;
    this.loadingPromise = null;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

export const channelBanditStore = new ChannelBanditStore();
