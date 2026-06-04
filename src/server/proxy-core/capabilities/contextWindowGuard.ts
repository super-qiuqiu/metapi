/**
 * Context Window Guard — 4-layer protection mirroring OpenAI Codex's native
 * compaction strategy, plus proxy-specific enhancements.
 *
 * Layer 1  Pre-request auto-compact trigger  — check token usage before sending
 * Layer 2  Mid-turn compact detection         — (future: post-sampling check)
 * Layer 3  Context-exceeded fatal handling    — clear session, no retry
 * Layer 4  History trimming on recovery        — remove oldest items progressively
 *
 * Beyond Codex native:
 *   - Per-session token tracking in the proxy layer
 *   - Failed response ID filtering (Codex only records completed responses)
 *   - Input array truncation when previous_response_id is stripped
 *   - Model-aware context window sizes
 */

import { config } from '../../config.js';

// ---------------------------------------------------------------------------
// Model context window registry
// ---------------------------------------------------------------------------

export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // Codex cloud models (from OpenAI Codex source: models-manager)
  'gpt-5.5':            272_000,
  'gpt-5.4-mini':       128_000,
  'codex-auto-review':  128_000,
  // GPT-5.x series
  'gpt-5.4':            272_000,
  'gpt-5.3-codex':      272_000,
  'gpt-5.2-codex':      272_000,
  // Legacy
  'o4-mini':            200_000,
  'o3':                 200_000,
  'o3-mini':            200_000,
  'gpt-4o':             128_000,
  'gpt-4o-mini':        128_000,
};

const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * Returns the known context window for a model, or a sensible default.
 */
export function getModelContextWindow(model: string): number {
  const normalized = (model || '').trim().toLowerCase();
  // Exact match first
  if (MODEL_CONTEXT_WINDOWS[normalized]) return MODEL_CONTEXT_WINDOWS[normalized];
  // Prefix match (e.g. "gpt-5.5-2026-05-01")
  for (const [key, value] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (normalized.startsWith(key)) return value;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

// ---------------------------------------------------------------------------
// Auto-compact threshold configuration
// ---------------------------------------------------------------------------

/** Percentage of context window at which auto-compact should trigger. */
const AUTO_COMPACT_TRIGGER_PERCENT = () => config.contextWindowGuardAutoCompactPercent;

/** Percentage of context window at which hard trim should trigger. */
const HARD_TRIM_TRIGGER_PERCENT = () => config.contextWindowGuardHardTrimPercent;

/** Target percentage of context window after trimming. */
const TRIM_TARGET_PERCENT = () => config.contextWindowGuardTrimTargetPercent;

/**
 * Returns true when the current token usage exceeds the auto-compact
 * trigger threshold for the given model.
 */
export function shouldTriggerAutoCompact(
  promptTokens: number,
  model: string,
): boolean {
  if (promptTokens <= 0) return false;
  const contextWindow = getModelContextWindow(model);
  const threshold = Math.trunc(contextWindow * AUTO_COMPACT_TRIGGER_PERCENT() / 100);
  return promptTokens >= threshold;
}

// ---------------------------------------------------------------------------
// Input array trimming (Layer 4 — progressive history removal)
// ---------------------------------------------------------------------------

/**
 * Removes the oldest non-system items from a Responses API `input` array
 * until the estimated prompt token count is below `targetTokens`.
 *
 * Preservation rules (mirrors Codex's `history.remove_first_item()`):
 *   - Always keep the first item if it looks like a system/developer message.
 *   - Never remove the last item (the current user turn).
 *   - Remove from the second item forward until budget is met.
 *
 * Returns the trimmed body (shallow copy with a new `input` array).
 */
export function trimResponsesInputToTokenBudget(
  body: Record<string, unknown>,
  targetTokens: number,
  currentTokens: number,
): { body: Record<string, unknown>; itemsRemoved: number } {
  const input = body.input;
  if (!Array.isArray(input) || input.length <= 2) {
    return { body, itemsRemoved: 0 };
  }
  if (currentTokens <= targetTokens) {
    return { body, itemsRemoved: 0 };
  }

  // Estimate tokens per item (rough: 3 chars per token for code-heavy content)
  const estimateTokens = (item: unknown): number => {
    try {
      const json = JSON.stringify(item);
      return Math.ceil((json || '').length / 3);
    } catch {
      return 500; // fallback estimate per item
    }
  };

  // Identify the range of removable items (skip first system-like & last user turn)
  const removableStartIndex = isSystemLikeItem(input[0]) ? 1 : 0;
  const removableEndIndex = input.length - 1; // exclusive; last item always kept

  if (removableStartIndex >= removableEndIndex) {
    return { body, itemsRemoved: 0 };
  }

  let trimmedTokens = currentTokens;
  const newInput = [...input];
  let itemsRemoved = 0;

  // Remove from the oldest removable item forward
  for (let i = removableStartIndex; i < removableEndIndex && trimmedTokens > targetTokens; i++) {
    const itemTokens = estimateTokens(newInput[i]);
    // Mark for removal by splicing — we track removals relative to original
    trimmedTokens -= itemTokens;
    itemsRemoved++;
  }

  if (itemsRemoved === 0) {
    return { body, itemsRemoved: 0 };
  }

  // Build the trimmed input: keep first (system-like), skip removed, keep last
  const keptInput: unknown[] = [];
  // Always keep the first item if system-like
  if (removableStartIndex === 1) {
    keptInput.push(input[0]);
  }
  // Add items from the end (most recent) first, skipping removed ones from the front
  const removedEndExclusive = removableStartIndex + itemsRemoved;
  for (let i = removedEndExclusive; i < input.length; i++) {
    keptInput.push(input[i]);
  }

  return {
    body: { ...body, input: keptInput },
    itemsRemoved,
  };
}

function isSystemLikeItem(item: unknown): boolean {
  if (!isRecord(item)) return false;
  const role = typeof item.role === 'string' ? item.role.trim().toLowerCase() : '';
  const type = typeof item.type === 'string' ? item.type.trim().toLowerCase() : '';
  return role === 'system' || role === 'developer' || type === 'system' || type === 'developer';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Layer 1 — Pre-request context check
// ---------------------------------------------------------------------------

/**
 * Evaluates whether an outgoing request is likely to exceed the model's
 * context window based on accumulated session token usage.
 *
 * When the threshold is crossed, returns a trimming plan; otherwise null.
 */
export function evaluatePreRequestContextBudget(input: {
  promptTokens: number;
  model: string;
  sessionId: string | null;
}): {
  shouldCompact: boolean;
  shouldTrim: boolean;
  currentTokens: number;
  contextWindow: number;
  triggerThreshold: number;
} {
  const contextWindow = getModelContextWindow(input.model);
  const triggerThreshold = Math.trunc(contextWindow * AUTO_COMPACT_TRIGGER_PERCENT() / 100);
  const shouldCompact = input.promptTokens >= triggerThreshold;
  // Hard trim when at configured percentage — we must avoid sending a request that will definitely fail
  const shouldTrim = input.promptTokens >= Math.trunc(contextWindow * HARD_TRIM_TRIGGER_PERCENT() / 100);

  return {
    shouldCompact,
    shouldTrim,
    currentTokens: input.promptTokens,
    contextWindow,
    triggerThreshold,
  };
}

// ---------------------------------------------------------------------------
// Layer 3 — Context-exceeded response classification
// ---------------------------------------------------------------------------

const CONTEXT_EXCEEDED_PATTERNS: RegExp[] = [
  /context_length_exceeded/i,
  /exceeds\s+the\s+context/i,
  /context\s*window/i,
  /input\s+too\s+long/i,
  /maximum\s+context/i,
];

/**
 * Returns true if the error text indicates the model's context window was
 * exceeded.  This is more precise than the generic `isClientContinuationFailure`
 * because it only matches context-overflow errors (not `previous_response_not_found`,
 * which is a *consequence* of overflow, not the cause).
 */
export function isContextWindowExceededError(errorText: string | null | undefined): boolean {
  const text = (errorText || '').trim();
  if (!text) return false;
  return CONTEXT_EXCEEDED_PATTERNS.some((pattern) => pattern.test(text));
}

// ---------------------------------------------------------------------------
// Per-session token usage tracker (beyond Codex native)
// ---------------------------------------------------------------------------

interface SessionTokenEntry {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  updatedAtMs: number;
  responseId: string | null;
  succeeded: boolean;     // ← Beyond Codex: only record token usage from successful responses
  prevPromptTokens: number; // Previous successful request's promptTokens (for growth rate)
}

const MAX_SESSION_TOKEN_ENTRIES = 200;
const SESSION_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

const sessionTokenUsage = new Map<string, SessionTokenEntry>();

function sweepExpiredSessionTokenEntries(nowMs = Date.now()): void {
  for (const [key, entry] of sessionTokenUsage.entries()) {
    if ((entry.updatedAtMs + SESSION_TOKEN_TTL_MS) <= nowMs) {
      sessionTokenUsage.delete(key);
    }
  }
}

/**
 * Records token usage for a completed (or failed) request on a session.
 * Key difference from Codex native: we track **both** success and failure,
 * but `succeeded` flag allows downstream logic to only trust successful
 * response IDs for `previous_response_id` chaining.
 */
export function recordSessionTokenUsage(input: {
  sessionId: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  responseId: string | null;
  succeeded: boolean;
}): void {
  const nowMs = Date.now();
  sweepExpiredSessionTokenEntries(nowMs);
  const key = input.sessionId.trim();
  if (!key) return;

  // Capture previous promptTokens for growth rate calculation
  const prevEntry = sessionTokenUsage.get(key);
  const prevPromptTokens = prevEntry?.succeeded
    ? prevEntry.promptTokens
    : (prevEntry?.prevPromptTokens || 0);

  sessionTokenUsage.set(key, {
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
    totalTokens: input.totalTokens,
    updatedAtMs: nowMs,
    responseId: input.responseId,
    succeeded: input.succeeded,
    prevPromptTokens,
  });

  // Evict oldest when at capacity
  while (sessionTokenUsage.size > MAX_SESSION_TOKEN_ENTRIES) {
    const oldestKey = sessionTokenUsage.keys().next().value;
    if (!oldestKey) break;
    sessionTokenUsage.delete(oldestKey);
  }
}

/**
 * Retrieves the accumulated token usage for a session.
 * Only counts tokens from **successful** responses (mirrors Codex's
 * behavior of only recording `last_response` on `response.completed`).
 */
export function getSessionTokenUsage(sessionId: string): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  lastResponseId: string | null;
  lastSucceeded: boolean;
  prevPromptTokens: number;
  growthRate: number; // promptTokens - prevPromptTokens
  predictedNextPromptTokens: number; // promptTokens + growthRate
} | null {
  sweepExpiredSessionTokenEntries();
  const key = sessionId.trim();
  if (!key) return null;
  const entry = sessionTokenUsage.get(key);
  if (!entry) return null;
  const growthRate = entry.succeeded
    ? Math.max(entry.promptTokens - entry.prevPromptTokens, 0)
    : Math.max(entry.prevPromptTokens ? entry.prevPromptTokens * 0.5 : 50_000, 0);
  return {
    promptTokens: entry.promptTokens,
    completionTokens: entry.completionTokens,
    totalTokens: entry.totalTokens,
    lastResponseId: entry.responseId,
    lastSucceeded: entry.succeeded,
    prevPromptTokens: entry.prevPromptTokens,
    growthRate,
    predictedNextPromptTokens: entry.promptTokens + growthRate,
  };
}

/**
 * Clears token usage for a session (e.g., after context overflow recovery).
 */
export function clearSessionTokenUsage(sessionId: string): void {
  const key = sessionId.trim();
  if (!key) return;
  sessionTokenUsage.delete(key);
}

// ---------------------------------------------------------------------------
// Beyond Codex: Safe response ID memory
// ---------------------------------------------------------------------------

/**
 * Determines whether a response ID should be remembered for
 * `previous_response_id` chaining.
 *
 * Codex native only records on `response.completed`; failed responses
 * are never used as `previous_response_id`.  The proxy must match this
 * behavior to avoid the "Previous response not found" cascade.
 *
 * Additionally, we refuse to remember response IDs from responses that
 * indicate context overflow — those responses may have been allocated an
 * ID by the upstream but are not usable for continuation.
 */
export function shouldRememberResponseId(payload: unknown): {
  shouldRemember: boolean;
  reason: string;
} {
  if (!isRecord(payload)) {
    return { shouldRemember: false, reason: 'payload is not a record' };
  }

  // Check response status — only 'completed' responses are safe to chain
  const status = typeof payload.status === 'string'
    ? payload.status.trim().toLowerCase()
    : '';

  if (status === 'completed') {
    return { shouldRemember: true, reason: 'response completed successfully' };
  }

  // Explicit failure statuses — never chain
  if (status === 'failed' || status === 'incomplete') {
    // Check if the failure is due to context overflow
    const errorText = extractErrorText(payload);
    if (isContextWindowExceededError(errorText)) {
      return { shouldRemember: false, reason: 'response failed due to context window exceeded' };
    }
    return { shouldRemember: false, reason: `response status is '${status}'` };
  }

  // Check for error objects — even with status 'in_progress', an error means no chaining
  const errorObj = payload.error;
  if (isRecord(errorObj)) {
    const errorCode = typeof errorObj.code === 'string' ? errorObj.code.trim().toLowerCase() : '';
    if (errorCode === 'context_length_exceeded') {
      return { shouldRemember: false, reason: 'error code is context_length_exceeded' };
    }
    if (errorCode) {
      return { shouldRemember: false, reason: `error code '${errorCode}'` };
    }
  }

  // For SSE stream events, check the event type
  const type = typeof payload.type === 'string' ? payload.type.trim().toLowerCase() : '';
  if (type === 'response.completed') {
    return { shouldRemember: true, reason: 'SSE event type is response.completed' };
  }
  if (type === 'response.failed' || type === 'response.incomplete') {
    return { shouldRemember: false, reason: `SSE event type is '${type}'` };
  }

  // Default: don't remember unknown statuses to be safe
  return { shouldRemember: false, reason: `unknown status '${status || type || '(none)'}'` };
}

function extractErrorText(payload: Record<string, unknown>): string {
  const fragments: string[] = [];
  const collect = (obj: unknown) => {
    if (!isRecord(obj)) return;
    for (const key of ['message', 'code', 'reason'] as const) {
      const val = obj[key];
      if (typeof val === 'string' && val.trim()) fragments.push(val.trim());
    }
    if (isRecord(obj.error)) collect(obj.error);
    if (isRecord(obj.response)) collect(obj.response);
  };
  collect(payload);
  return fragments.join(' ');
}
