import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
  register,
} from 'prom-client';

type LabelValues = Record<string, string>;

let initialized = false;

function ensureInitialized(): void {
  if (initialized) return;
  collectDefaultMetrics({ register });
  initialized = true;
}

function getOrCreateCounter(name: string, help: string, labelNames: string[] = []): Counter<string> {
  const existing = register.getSingleMetric(name);
  if (existing instanceof Counter) {
    return existing as Counter<string>;
  }
  return new Counter({ name, help, labelNames, registers: [register] });
}

function getOrCreateGauge(name: string, help: string, labelNames: string[] = []): Gauge<string> {
  const existing = register.getSingleMetric(name);
  if (existing instanceof Gauge) {
    return existing as Gauge<string>;
  }
  return new Gauge({ name, help, labelNames, registers: [register] });
}

function getOrCreateHistogram(
  name: string,
  help: string,
  labelNames: string[] = [],
  buckets?: number[],
): Histogram<string> {
  const existing = register.getSingleMetric(name);
  if (existing instanceof Histogram) {
    return existing as Histogram<string>;
  }
  return new Histogram({
    name,
    help,
    labelNames,
    buckets,
    registers: [register],
  });
}

ensureInitialized();

const selectedChannelTotal = getOrCreateCounter(
  'router_selected_channel_total',
  'Total number of router channel selections',
  ['model', 'site', 'strategy', 'algorithm'],
);

const explorationRate = getOrCreateGauge(
  'router_exploration_rate',
  'Current exploration rate (P2C and Thompson sampling path)',
  ['model'],
);

const fallbackLegacyTotal = getOrCreateCounter(
  'router_fallback_legacy_total',
  'Total number of times router falls back to legacy algorithm',
  ['reason'],
);

const failureClassTotal = getOrCreateCounter(
  'router_failure_class_total',
  'Total number of channel failures grouped by class',
  ['class'],
);

const expectedVsActualCostError = getOrCreateHistogram(
  'router_expected_vs_actual_cost_error',
  'Absolute error between expected routing cost and actual billed cost',
  ['model', 'site'],
  [0, 0.000001, 0.00001, 0.0001, 0.001, 0.01, 0.1, 1, 10],
);

const usageContractViolationTotal = getOrCreateCounter(
  'router_usage_contract_violation_total',
  'Total number of routing usage contract violations',
  ['reason'],
);

const stateFlushTotal = getOrCreateCounter(
  'router_state_flush_total',
  'Total number of channel routing state flush operations',
);

const stateFlushFailTotal = getOrCreateCounter(
  'router_state_flush_fail_total',
  'Total number of failed channel routing state flush operations',
);

const stateFlushDurationMs = getOrCreateHistogram(
  'router_state_flush_duration_ms',
  'Duration of channel routing state flush operations in milliseconds',
  [],
  [1, 2, 5, 10, 20, 50, 100, 200, 500, 1_000, 5_000],
);

const stateRecoveredChannels = getOrCreateGauge(
  'router_state_recovered_channels',
  'Number of routing channel states recovered from persisted snapshot at startup',
);

const ewmaStateStalenessSeconds = getOrCreateGauge(
  'ewma_state_staleness_seconds',
  'Current EWMA state staleness seconds by channel',
  ['channel_id'],
);

const scoreComponentHistogram = getOrCreateHistogram(
  'router_score_component_histogram',
  'Histogram for router score components (theta, latency, cost)',
  ['component'],
  [0, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 100, 1_000],
);

export const channelRoutingMetrics = {
  register,
  selectedChannelTotal,
  explorationRate,
  fallbackLegacyTotal,
  failureClassTotal,
  expectedVsActualCostError,
  usageContractViolationTotal,
  stateFlushTotal,
  stateFlushFailTotal,
  stateFlushDurationMs,
  stateRecoveredChannels,
  ewmaStateStalenessSeconds,
  scoreComponentHistogram,
};

export function incSelectedChannel(labels: {
  model: string;
  site: string;
  strategy: string;
  algorithm: string;
}): void {
  selectedChannelTotal.inc(labels);
}

export function setExplorationRate(model: string, value: number): void {
  const safeValue = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  explorationRate.set({ model }, safeValue);
}

export function incFallbackLegacy(reason: string): void {
  fallbackLegacyTotal.inc({ reason: reason || 'unknown' });
}

export function incFailureClass(failureClass: string): void {
  failureClassTotal.inc({ class: failureClass || 'unknown' });
}

export function observeExpectedVsActualCostError(labels: {
  model: string;
  site: string;
}, expectedCost: number, actualCost: number): void {
  if (!Number.isFinite(expectedCost) || !Number.isFinite(actualCost)) return;
  expectedVsActualCostError.observe(labels, Math.abs(expectedCost - actualCost));
}

export function incUsageContractViolation(reason: string): void {
  usageContractViolationTotal.inc({ reason: reason || 'unknown' });
}

export function observeStateFlush(durationMs: number, ok: boolean): void {
  if (ok) {
    stateFlushTotal.inc();
  } else {
    stateFlushFailTotal.inc();
  }
  if (Number.isFinite(durationMs) && durationMs >= 0) {
    stateFlushDurationMs.observe(durationMs);
  }
}

export function setRecoveredChannels(count: number): void {
  stateRecoveredChannels.set(Math.max(0, Math.trunc(count)));
}

export function setEwmaStateStaleness(channelId: number, stalenessSeconds: number): void {
  if (!Number.isFinite(channelId) || channelId <= 0) return;
  const value = Number.isFinite(stalenessSeconds) ? Math.max(0, stalenessSeconds) : 0;
  ewmaStateStalenessSeconds.set({ channel_id: String(Math.trunc(channelId)) }, value);
}

export function observeScoreComponent(component: 'theta' | 'latency' | 'cost', value: number): void {
  if (!Number.isFinite(value) || value < 0) return;
  scoreComponentHistogram.observe({ component }, value);
}

export async function renderChannelRoutingMetrics(): Promise<string> {
  return await register.metrics();
}

export function getChannelRoutingMetricsContentType(): string {
  return Registry.OPENMETRICS_CONTENT_TYPE;
}

export function resetChannelRoutingMetricsForTests(): void {
  register.resetMetrics();
}

export function hasMetric(name: string): boolean {
  return !!register.getSingleMetric(name);
}

export function incCounterByName(name: string, labels: LabelValues = {}, amount = 1): void {
  const metric = register.getSingleMetric(name);
  if (metric instanceof Counter) {
    (metric as Counter<string>).inc(labels, amount);
  }
}
