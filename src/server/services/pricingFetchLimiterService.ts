type ConcurrencyLimiter = {
  limit: <T>(fn: () => Promise<T>) => Promise<T>;
};

function createConcurrencyLimiter(concurrency: number): ConcurrencyLimiter {
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

type CircuitBreakerState = {
  failures: number;
  lastFailureAt: number;
  open: boolean;
};

function createCircuitBreaker(threshold: number, cooldownMs: number) {
  const breakers = new Map<string, CircuitBreakerState>();

  function getState(key: string): CircuitBreakerState {
    let state = breakers.get(key);
    if (!state) {
      state = { failures: 0, lastFailureAt: 0, open: false };
      breakers.set(key, state);
    }
    return state;
  }

  function recordSuccess(key: string): void {
    const state = getState(key);
    state.failures = 0;
    state.open = false;
  }

  function recordFailure(key: string): void {
    const state = getState(key);
    state.failures++;
    state.lastFailureAt = Date.now();
    if (state.failures >= threshold) {
      state.open = true;
    }
  }

  function isOpen(key: string): boolean {
    const state = getState(key);
    if (!state.open) return false;
    if (Date.now() - state.lastFailureAt > cooldownMs) {
      state.open = false;
      state.failures = 0;
      return false;
    }
    return true;
  }

  return { recordSuccess, recordFailure, isOpen };
}

type PricinigFetchDedupedLimiterOptions = {
  concurrency: number;
  circuitThreshold: number;
  circuitCooldownMs: number;
};

export function createPricingFetchDedupedLimiter(
  options?: Partial<PricinigFetchDedupedLimiterOptions>,
) {
  const concurrency = options?.concurrency ?? 6;
  const circuitThreshold = options?.circuitThreshold ?? 3;
  const circuitCooldownMs = options?.circuitCooldownMs ?? 30_000;

  const limiter = createConcurrencyLimiter(concurrency);
  const breaker = createCircuitBreaker(circuitThreshold, circuitCooldownMs);
  const inFlight = new Map<string, Promise<unknown>>();

  async function dedupedLimitedFetch<T>(
    key: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const existing = inFlight.get(key);
    if (existing) return existing as Promise<T>;

    if (breaker.isOpen(key)) {
      return null as T;
    }

    const promise = limiter.limit(async () => {
      try {
        const result = await fn();
        breaker.recordSuccess(key);
        return result;
      } catch (error) {
        breaker.recordFailure(key);
        throw error;
      } finally {
        inFlight.delete(key);
      }
    });

    inFlight.set(key, promise);
    return promise as Promise<T>;
  }

  return { dedupedLimitedFetch };
}
