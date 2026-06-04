/**
 * Session Input Baseline Store — enables incremental input diffing
 * mirroring Codex CLI's `get_incremental_items()` logic.
 *
 * When a Codex client sends a request over HTTP SSE, it typically includes
 * the *entire* conversation history as `input`.  This wastes tokens because
 * the upstream already has the previous response cached (referenced via
 * `previous_response_id`).
 *
 * Codex CLI's WebSocket path avoids this by computing an incremental delta:
 *   baseline = last_request.input + last_response.output_items
 *   if new_request.input starts with baseline → only send the suffix
 *
 * This module replicates that logic in the proxy layer so HTTP SSE requests
 * also benefit from token savings.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type InputItem = Record<string, unknown>;

type SessionBaselineEntry = {
  /** The full `input` array sent in the last successful request. */
  lastRequestInput: InputItem[];
  /** Output items returned by the last successful response (from `output` array). */
  lastResponseOutputItems: InputItem[];
  /** The response ID of the last successful response. */
  lastResponseId: string;
  /** Model name from the last request (for validation). */
  lastModel: string;
  /** Timestamp for TTL-based eviction. */
  updatedAtMs: number;
};

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const MAX_SESSION_BASELINE_ENTRIES = 2_000;
const SESSION_BASELINE_TTL_MS = 30 * 60 * 1000; // 30 minutes

const sessionBaselines = new Map<string, SessionBaselineEntry>();

function sweepExpiredEntries(nowMs = Date.now()): void {
  for (const [key, entry] of sessionBaselines.entries()) {
    if ((entry.updatedAtMs + SESSION_BASELINE_TTL_MS) <= nowMs) {
      sessionBaselines.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/**
 * Records the baseline after a successful request/response pair.
 * This is the "before" state that the next request will be diffed against.
 */
export function recordSessionBaseline(input: {
  sessionId: string;
  requestInput: InputItem[];
  responseOutputItems: InputItem[];
  responseId: string;
  model: string;
}): void {
  const nowMs = Date.now();
  sweepExpiredEntries(nowMs);
  const key = input.sessionId.trim();
  if (!key) return;

  sessionBaselines.set(key, {
    lastRequestInput: input.requestInput,
    lastResponseOutputItems: input.responseOutputItems,
    lastResponseId: input.responseId,
    lastModel: input.model,
    updatedAtMs: nowMs,
  });

  while (sessionBaselines.size > MAX_SESSION_BASELINE_ENTRIES) {
    const oldestKey = sessionBaselines.keys().next().value;
    if (!oldestKey) break;
    sessionBaselines.delete(oldestKey);
  }
}

/**
 * Clears the baseline for a session (e.g., after context overflow or compact).
 */
export function clearSessionBaseline(sessionId: string): void {
  const key = sessionId.trim();
  if (!key) return;
  sessionBaselines.delete(key);
}

// ---------------------------------------------------------------------------
// Incremental diff
// ---------------------------------------------------------------------------

/**
 * Attempts to compute an incremental input delta for the given request,
 * mirroring Codex CLI's `get_incremental_items()` logic.
 *
 * Returns `null` if incremental is not possible (e.g., no baseline, input
 * doesn't start with baseline, or model changed).
 *
 * When incremental IS possible, returns the previous_response_id to use
 * and the trimmed input array (only the new items).
 */
export function tryComputeIncrementalInput(input: {
  sessionId: string;
  newInput: InputItem[];
  model: string;
}): {
  previousResponseId: string;
  incrementalInput: InputItem[];
  baselineLength: number;
  savedItems: number;
} | null {
  sweepExpiredEntries();
  const key = input.sessionId.trim();
  if (!key) return null;

  const baseline = sessionBaselines.get(key);
  if (!baseline) return null;

  // Model must match — different model = different context, can't reuse
  if (baseline.lastModel !== input.model) return null;

  // Reconstruct the expected baseline:
  // baseline = lastRequestInput + lastResponseOutputItems
  const expectedBaseline: InputItem[] = [
    ...baseline.lastRequestInput,
    ...baseline.lastResponseOutputItems,
  ];

  const baselineLen = expectedBaseline.length;
  const newInputLen = input.newInput.length;

  // The new input must be at least as long as the baseline
  if (newInputLen < baselineLen) return null;

  // Check if newInput starts with expectedBaseline
  // Use a lightweight comparison (shallow equality on key fields)
  if (!inputStartsWithBaseline(input.newInput, expectedBaseline)) {
    return null;
  }

  // Nothing new? Don't send an empty request
  if (baselineLen === newInputLen) return null;

  const incrementalInput = input.newInput.slice(baselineLen);
  const savedItems = baselineLen; // items we don't need to resend

  return {
    previousResponseId: baseline.lastResponseId,
    incrementalInput,
    baselineLength: baselineLen,
    savedItems,
  };
}

// ---------------------------------------------------------------------------
// Shallow item comparison
// ---------------------------------------------------------------------------

/**
 * Checks if `input` starts with `baseline` using shallow comparison.
 * This mirrors Codex's `request.input.starts_with(&baseline)` check.
 *
 * We compare by JSON-serializing each item for correctness — this is not
 * performance-critical since baseline sizes are bounded by context window.
 */
function inputStartsWithBaseline(
  input: InputItem[],
  baseline: InputItem[],
): boolean {
  if (baseline.length === 0) return true;
  if (input.length < baseline.length) return false;

  for (let i = 0; i < baseline.length; i++) {
    if (!shallowItemEqual(input[i], baseline[i])) return false;
  }
  return true;
}

function shallowItemEqual(a: InputItem, b: InputItem): boolean {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) return false;
    const aVal = a[aKeys[i]];
    const bVal = b[bKeys[i]];
    // Fast path for primitive values
    if (typeof aVal === 'string' && typeof bVal === 'string') {
      if (aVal !== bVal) return false;
      continue;
    }
    if (typeof aVal === 'number' && typeof bVal === 'number') {
      if (aVal !== bVal) return false;
      continue;
    }
    if (typeof aVal === 'boolean' && typeof bVal === 'boolean') {
      if (aVal !== bVal) return false;
      continue;
    }
    // For complex values (arrays, objects), fall back to JSON comparison
    // This is expensive but correct — and only happens for mismatched items
    try {
      if (JSON.stringify(aVal) !== JSON.stringify(bVal)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Output item extraction from response payloads
// ---------------------------------------------------------------------------

/**
 * Extracts output items from a Responses API response payload.
 * These become part of the baseline for the next incremental diff.
 */
export function extractResponseOutputItems(payload: unknown): InputItem[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];

  const obj = payload as Record<string, unknown>;

  // Direct response object with `output` array
  if (Array.isArray(obj.output)) {
    return obj.output.filter(isInputItem);
  }

  // SSE event with nested response
  if (obj.response && typeof obj.response === 'object' && !Array.isArray(obj.response)) {
    const resp = obj.response as Record<string, unknown>;
    if (Array.isArray(resp.output)) {
      return resp.output.filter(isInputItem);
    }
  }

  return [];
}

function isInputItem(value: unknown): value is InputItem {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
