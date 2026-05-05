export interface ChannelBanditScoreCandidate {
  channelId: number;
  siteId: number;
  priority: number;
  alpha: number;
  beta: number;
  latencyLogMu: number;
  latencyLogSigma2: number;
  latencyN: number;
  expectedCost: number;
  manualWeight: number;
  coldStartLatencyMs: number;
}

export interface ChannelBanditScoreBreakdown {
  index: number;
  theta: number;
  latencyMs: number;
  expectedCost: number;
  logScore: number;
}

export interface ChannelBanditSelectParams {
  scoreThetaWeight: number;
  scoreLatencyWeight: number;
  scoreCostWeight: number;
  scoreManualWeight: number;
  thetaMin: number;
  thetaMax: number;
  latencyMinMs: number;
  latencyMaxMs: number;
  expectedCostMin: number;
  expectedCostMax: number;
  manualWeightMin: number;
  manualWeightMax: number;
  coldStartLatencyN: number;
  tsSamplingEnabled: boolean;
  p2cEnabled: boolean;
}

export interface ChannelBanditSelectResult {
  selectedIndex: number;
  breakdown: ChannelBanditScoreBreakdown[];
  explored: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sanitizePositive(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function sampleStandardNormal(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u <= Number.EPSILON) {
    u = rng();
  }
  while (v <= Number.EPSILON) {
    v = rng();
  }
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function sampleGamma(shape: number, rng: () => number): number {
  const normalizedShape = sanitizePositive(shape, 1e-6);
  if (normalizedShape < 1) {
    const u = Math.max(Number.EPSILON, rng());
    return sampleGamma(normalizedShape + 1, rng) * Math.pow(u, 1 / normalizedShape);
  }

  const d = normalizedShape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    const x = sampleStandardNormal(rng);
    const v = Math.pow(1 + c * x, 3);
    if (v <= 0) continue;
    const u = rng();
    if (u < 1 - 0.0331 * Math.pow(x, 4)) {
      return d * v;
    }
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
      return d * v;
    }
  }
}

function sampleBeta(alpha: number, beta: number, rng: () => number): number {
  const a = sanitizePositive(alpha, 1e-6);
  const b = sanitizePositive(beta, 1e-6);
  const x = sampleGamma(a, rng);
  const y = sampleGamma(b, rng);
  if (x <= 0 && y <= 0) return 0.5;
  return x / (x + y);
}

function sampleLogNormal(mu: number, sigma2: number, rng: () => number): number {
  const safeSigma2 = Math.max(1e-9, sigma2);
  const sampledLog = mu + Math.sqrt(safeSigma2) * sampleStandardNormal(rng);
  return Math.exp(sampledLog);
}

function computeScore(
  candidate: ChannelBanditScoreCandidate,
  params: ChannelBanditSelectParams,
  rng: () => number,
): ChannelBanditScoreBreakdown {
  const theta = params.tsSamplingEnabled
    ? sampleBeta(candidate.alpha, candidate.beta, rng)
    : (candidate.alpha / (candidate.alpha + candidate.beta));

  const sampledLatencyMs = params.tsSamplingEnabled
    ? sampleLogNormal(candidate.latencyLogMu, candidate.latencyLogSigma2, rng)
    : Math.exp(candidate.latencyLogMu + candidate.latencyLogSigma2 / 2);

  const effectiveLatencyMs = candidate.latencyN < params.coldStartLatencyN
    ? candidate.coldStartLatencyMs
    : sampledLatencyMs;

  const clampedTheta = clamp(theta, params.thetaMin, params.thetaMax);
  const clampedLatency = clamp(effectiveLatencyMs, params.latencyMinMs, params.latencyMaxMs);
  const clampedCost = clamp(candidate.expectedCost, params.expectedCostMin, params.expectedCostMax);
  const clampedManualWeight = clamp(candidate.manualWeight, params.manualWeightMin, params.manualWeightMax);

  const logScore = (
    params.scoreThetaWeight * Math.log(clampedTheta)
    - params.scoreLatencyWeight * Math.log(clampedLatency)
    - params.scoreCostWeight * Math.log(clampedCost)
    + params.scoreManualWeight * Math.log(clampedManualWeight)
  );

  return {
    index: -1,
    theta: clampedTheta,
    latencyMs: clampedLatency,
    expectedCost: clampedCost,
    logScore,
  };
}

function pickDistinctIndex(size: number, exclude: number, rng: () => number): number {
  if (size <= 1) return 0;
  let picked = exclude;
  while (picked === exclude) {
    picked = Math.floor(rng() * size);
  }
  return picked;
}

export function selectChannelByBandit(
  candidates: ChannelBanditScoreCandidate[],
  params: ChannelBanditSelectParams,
  rng: () => number = Math.random,
): ChannelBanditSelectResult | null {
  if (candidates.length === 0) return null;

  const breakdown = candidates.map((candidate, index) => ({
    ...computeScore(candidate, params, rng),
    index,
  }));

  if (candidates.length <= 2 || !params.p2cEnabled) {
    const selected = breakdown.reduce((best, item) => (item.logScore > best.logScore ? item : best), breakdown[0]!);
    return {
      selectedIndex: selected.index,
      breakdown,
      explored: false,
    };
  }

  const first = Math.floor(rng() * candidates.length);
  const second = pickDistinctIndex(candidates.length, first, rng);
  const firstBreakdown = breakdown[first]!;
  const secondBreakdown = breakdown[second]!;

  const winner = firstBreakdown.logScore >= secondBreakdown.logScore
    ? firstBreakdown
    : secondBreakdown;

  return {
    selectedIndex: winner.index,
    breakdown,
    explored: true,
  };
}
