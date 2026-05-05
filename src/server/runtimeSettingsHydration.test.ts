import { afterEach, describe, expect, it } from 'vitest';

import { config } from './config.js';
import { applyRuntimeSettings } from './runtimeSettingsHydration.js';

const originalConfig = structuredClone(config);

afterEach(() => {
  Object.assign(config, structuredClone(originalConfig));
});

describe('applyRuntimeSettings', () => {
  it('hydrates persisted runtime settings that should survive restarts', () => {
    config.disableCrossProtocolFallback = false;
    config.responsesCompactFallbackToResponsesEnabled = false;
    config.responsesRequireContinuitySession = false;
    config.responsesStrictPreviousResponseRecovery = false;
    config.webhookEnabled = true;
    config.barkEnabled = true;
    config.serverChanEnabled = true;
    config.globalAllowedModels = [];
    config.routingBanditGuardrailBaselineEnabled = false;
    config.routingBanditGuardrailBaselineMinSamples = 60;
    config.routingBanditGuardrailMaxRetryableFailureRateDelta = 0.01;
    config.routingBanditGuardrailMaxP95LatencyMultiplier = 1.1;

    applyRuntimeSettings(new Map([
      ['disable_cross_protocol_fallback', JSON.stringify(true)],
      ['responses_compact_fallback_to_responses_enabled', JSON.stringify(true)],
      ['responses_require_continuity_session', JSON.stringify(true)],
      ['responses_strict_previous_response_recovery', JSON.stringify(true)],
      ['webhook_enabled', JSON.stringify(false)],
      ['bark_enabled', JSON.stringify(false)],
      ['serverchan_enabled', JSON.stringify(false)],
      ['global_allowed_models', JSON.stringify(['gpt-5.4', ' claude-3.7-sonnet '])],
      ['routing_bandit_guardrail_baseline_enabled', JSON.stringify(true)],
      ['routing_bandit_guardrail_baseline_min_samples', JSON.stringify(180)],
      ['routing_bandit_guardrail_max_retryable_failure_rate_delta', JSON.stringify(0.05)],
      ['routing_bandit_guardrail_max_p95_latency_multiplier', JSON.stringify(1.35)],
    ]));

    expect(config.disableCrossProtocolFallback).toBe(true);
    expect(config.responsesCompactFallbackToResponsesEnabled).toBe(true);
    expect(config.responsesRequireContinuitySession).toBe(true);
    expect(config.responsesStrictPreviousResponseRecovery).toBe(true);
    expect(config.webhookEnabled).toBe(false);
    expect(config.barkEnabled).toBe(false);
    expect(config.serverChanEnabled).toBe(false);
    expect(config.globalAllowedModels).toEqual(['gpt-5.4', 'claude-3.7-sonnet']);
    expect(config.routingBanditGuardrailBaselineEnabled).toBe(true);
    expect(config.routingBanditGuardrailBaselineMinSamples).toBe(180);
    expect(config.routingBanditGuardrailMaxRetryableFailureRateDelta).toBe(0.05);
    expect(config.routingBanditGuardrailMaxP95LatencyMultiplier).toBe(1.35);
  });

  it('normalizes smtpPort to a positive integer during hydration', () => {
    config.smtpPort = 587;

    applyRuntimeSettings(new Map([
      ['smtp_port', JSON.stringify(587.9)],
    ]));

    expect(config.smtpPort).toBe(587);
  });
});
