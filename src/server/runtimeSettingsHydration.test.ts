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
    config.codexContextCompactionAutoEnabled = false;
    config.codexContextCompactionSoftTokens = 50000;
    config.codexContextCompactionTargetTokens = 30000;
    config.codexContextCompactionCooldownTurns = 3;
    config.codexContextCompactionUnsupportedTtlMs = 600000;
    config.codexContextCompactionMaxAttemptsPerSession = 8;
    config.contextWindowGuardEnabled = true;
    config.contextWindowGuardAutoCompactPercent = 80;
    config.contextWindowGuardTrimTargetPercent = 75;
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
      ['codex_context_compaction_auto_enabled', JSON.stringify(true)],
      ['codex_context_compaction_soft_tokens', JSON.stringify(64000)],
      ['codex_context_compaction_target_tokens', JSON.stringify(28000)],
      ['codex_context_compaction_cooldown_turns', JSON.stringify(5)],
      ['codex_context_compaction_unsupported_ttl_ms', JSON.stringify(900000)],
      ['codex_context_compaction_max_attempts_per_session', JSON.stringify(12)],
      ['context_window_guard_enabled', JSON.stringify(false)],
      ['context_window_guard_auto_compact_percent', JSON.stringify(70)],
      ['context_window_guard_trim_target_percent', JSON.stringify(55)],
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
    expect(config.codexContextCompactionAutoEnabled).toBe(true);
    expect(config.codexContextCompactionSoftTokens).toBe(64000);
    expect(config.codexContextCompactionTargetTokens).toBe(28000);
    expect(config.codexContextCompactionCooldownTurns).toBe(5);
    expect(config.codexContextCompactionUnsupportedTtlMs).toBe(900000);
    expect(config.codexContextCompactionMaxAttemptsPerSession).toBe(12);
    expect(config.contextWindowGuardEnabled).toBe(false);
    expect(config.contextWindowGuardAutoCompactPercent).toBe(70);
    expect(config.contextWindowGuardTrimTargetPercent).toBe(55);
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

  it('hydrates legacy double-encoded global model allowlist values', () => {
    config.globalAllowedModels = [];

    applyRuntimeSettings(new Map([
      ['global_allowed_models', JSON.stringify(JSON.stringify(['model-alpha', ' model-beta ', 'model-gamma']))],
    ]));

    expect(config.globalAllowedModels).toEqual(['model-alpha', 'model-beta', 'model-gamma']);
  });
});
