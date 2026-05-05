declare module 'prom-client' {
  export class Counter<T extends string = string> {
    constructor(input: unknown);
    inc(labels?: Record<string, string>, value?: number): void;
  }

  export class Gauge<T extends string = string> {
    constructor(input: unknown);
    set(value: number): void;
    set(labels: Record<string, string>, value: number): void;
  }

  export class Histogram<T extends string = string> {
    constructor(input: unknown);
    observe(value: number): void;
    observe(labels: Record<string, string>, value: number): void;
  }

  export class Registry {
    static OPENMETRICS_CONTENT_TYPE: string;
    getSingleMetric(name: string): unknown;
    metrics(): Promise<string>;
    resetMetrics(): void;
  }

  export const register: Registry;

  export function collectDefaultMetrics(input?: unknown): void;
}
