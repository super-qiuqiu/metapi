import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { config } from '../../config.js';
import {
  estimateResponsesInputTokens,
  evaluateContextBudget,
  shouldAttemptSoftContextCompact,
} from './contextWindowGuard.js';

describe('contextWindowGuard token decisions', () => {
  const originalAutoCompactPercent = config.contextWindowGuardAutoCompactPercent;
  const originalTrimTargetPercent = config.contextWindowGuardTrimTargetPercent;

  beforeEach(() => {
    config.contextWindowGuardAutoCompactPercent = 80;
    config.contextWindowGuardTrimTargetPercent = 75;
  });

  afterEach(() => {
    config.contextWindowGuardAutoCompactPercent = originalAutoCompactPercent;
    config.contextWindowGuardTrimTargetPercent = originalTrimTargetPercent;
  });

  it('estimates Responses input tokens with the shared JSON-length heuristic', () => {
    const estimate = estimateResponsesInputTokens([{ role: 'user', content: 'x'.repeat(297) }]);

    expect(estimate).toBeGreaterThanOrEqual(100);
  });

  it('uses upstream prompt usage as a soft compact trigger even when current input is small', () => {
    const decision = shouldAttemptSoftContextCompact({
      clientInputTokensEstimate: 12_000,
      sessionUsage: {
        promptTokens: 60_189,
        prevPromptTokens: 50_577,
        growthRate: 9_612,
        predictedNextPromptTokens: 69_801,
        lastSucceeded: true,
      },
      softTokens: 50_000,
    });

    expect(decision).toEqual({
      shouldAttempt: true,
      reason: 'upstream prompt tokens 60189 >= soft threshold 50000',
    });
  });

  it('falls back to predicted prompt usage for soft compact decisions', () => {
    const decision = shouldAttemptSoftContextCompact({
      clientInputTokensEstimate: 12_000,
      sessionUsage: {
        promptTokens: 48_000,
        prevPromptTokens: 30_000,
        growthRate: 18_000,
        predictedNextPromptTokens: 66_000,
        lastSucceeded: true,
      },
      softTokens: 50_000,
    });

    expect(decision).toEqual({
      shouldAttempt: true,
      reason: 'predicted prompt tokens 66000 >= soft threshold 50000',
    });
  });

  it('separates continuation reset from upstream compact attempts', () => {
    const decision = evaluateContextBudget({
      model: 'gpt-5.5',
      inputTokensEstimate: 17_198,
      sessionUsage: {
        promptTokens: 220_000,
        prevPromptTokens: 180_000,
        growthRate: 40_000,
        predictedNextPromptTokens: 260_000,
        lastSucceeded: true,
      },
    });

    expect(decision.shouldTrim).toBe(true);
    expect(decision.shouldResetContinuation).toBe(false);
    expect(decision.trimReason).toBe('predicted 260000 tokens >= 204000 trim target');
  });
});
