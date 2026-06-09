import type { IncomingMessage } from 'node:http';
import WebSocket from 'ws';
import {
  extractResponsesTerminalResponseId,
  isResponsesPreviousResponseNotFoundError,
  isResponsesToolCallMismatchError,
  shouldInferResponsesPreviousResponseId,
  stripResponsesPreviousResponseId,
  withResponsesPreviousResponseId,
} from '../../transformers/openai/responses/continuation.js';
import {
  isContextWindowExceededError,
  clearSessionTokenUsage,
  evaluateContextBudget,
  estimateResponsesInputTokens,
  getSessionTokenUsage,
  recordSessionTokenUsage,
  trimResponsesInputToTokenBudget,
} from '../capabilities/contextWindowGuard.js';
import {
  buildCodexWebsocketHandshakeHeaders,
  buildCodexWebsocketRequestBody,
  toCodexWebsocketUrl,
} from './codexWebsocketHeaders.js';
import {
  clearCodexSessionResponseId,
  clearLayer1TrimmedSession,
  getCodexSessionResponseId,
  markLayer1TrimmedSession,
  setCodexSessionResponseId,
} from './codexSessionResponseStore.js';
import { clearSessionBaseline } from '../capabilities/sessionInputBaseline.js';
import { config } from '../../config.js';
import { createCodexWebsocketSessionStore } from './codexWebsocketSessionStore.js';
import type {
  CodexWebsocketActiveRequest,
  CodexWebsocketRuntimeResult,
  CodexWebsocketRuntimeSendInput,
  CodexWebsocketSession,
  CodexWebsocketSessionStore,
  CodexWebsocketTimelineEvent,
} from './types.js';

const CODEX_WS_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const CODEX_WS_HANDSHAKE_TIMEOUT_MS = 30 * 1000;
const CODEX_WS_MAX_SEND_RETRIES = 1;
const CODEX_WS_HEARTBEAT_INTERVAL_MS = 30 * 1000; // Send ping every 30s to keep connection alive

type CodexWebsocketDisconnectReason =
  | 'read_error'
  | 'write_error'
  | 'send_error'
  | 'idle_timeout'
  | 'upstream_error'
  | 'upstream_closed'
  | 'unexpected_binary'
  | 'session_closed'
  | 'auth_closed';

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function emitTimeline(
  session: CodexWebsocketSession,
  event: CodexWebsocketTimelineEvent['event'],
  input?: {
    reason?: string;
    payload?: unknown;
    onTimeline?: (event: CodexWebsocketTimelineEvent) => void;
  },
): void {
  try {
    input?.onTimeline?.({
      event,
      timestamp: new Date().toISOString(),
      sessionId: session.sessionId,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
    });
  } catch {
    // Timeline hooks are observational and must not affect proxy behavior.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isTerminalEvent(payload: Record<string, unknown>): boolean {
  const type = asTrimmedString(payload.type);
  return type === 'response.completed'
    || type === 'response.failed'
    || type === 'response.incomplete'
    || type === 'error';
}

function isRuntimeErrorEvent(payload: Record<string, unknown>): boolean {
  const type = asTrimmedString(payload.type);
  return type === 'error';
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function extractFailureTerminalStatus(payload: Record<string, unknown>): number {
  const response = isRecord(payload.response) ? payload.response : null;
  const responseError = response && isRecord(response.error) ? response.error : null;
  const topLevelError = isRecord(payload.error) ? payload.error : null;
  const candidates = [
    payload.status,
    payload.statusCode,
    payload.code,
    topLevelError?.status,
    topLevelError?.statusCode,
    topLevelError?.code,
    responseError?.status,
    responseError?.statusCode,
    responseError?.code,
  ];
  for (const candidate of candidates) {
    const status = asFiniteNumber(candidate);
    if (status !== undefined) return status;
  }
  return 502;
}

function extractTerminalErrorMessage(payload: Record<string, unknown>): string {
  const type = asTrimmedString(payload.type);
  if (type === 'error' && isRecord(payload.error)) {
    return asTrimmedString(payload.error.message) || 'upstream websocket error';
  }
  if ((type === 'response.failed' || type === 'response.incomplete') && isRecord(payload.response)) {
    if (isRecord(payload.response.error)) {
      return asTrimmedString(payload.response.error.message) || `upstream ${type}`;
    }
    if (isRecord(payload.response.incomplete_details)) {
      return asTrimmedString(payload.response.incomplete_details.reason) || `upstream ${type}`;
    }
  }
  return `upstream ${type || 'websocket error'}`;
}

export class CodexWebsocketRuntimeError extends Error {
  events: Array<Record<string, unknown>>;
  status?: number;
  payload?: unknown;
  isUpgradeRequired426?: boolean;

  constructor(
    message: string,
    options?: {
      events?: Array<Record<string, unknown>>;
      status?: number;
      payload?: unknown;
      isUpgradeRequired426?: boolean;
    },
  ) {
    super(message);
    this.name = 'CodexWebsocketRuntimeError';
    this.events = options?.events ?? [];
    this.status = options?.status;
    this.payload = options?.payload;
    this.isUpgradeRequired426 = options?.isUpgradeRequired426;
  }
}

function pickHeaderValue(headers: Record<string, string>, names: string[]): string {
  for (const name of names) {
    const expected = name.trim().toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.trim().toLowerCase() !== expected) continue;
      const normalized = asTrimmedString(value);
      if (normalized) return normalized;
    }
  }
  return '';
}

function resolveRuntimeAuthId(input: CodexWebsocketRuntimeSendInput): string | null {
  const explicit = asTrimmedString(input.authId);
  if (explicit) return explicit;
  return pickHeaderValue(input.headers, [
    'chatgpt-account-id',
    'ChatGPT-Account-ID',
    'authorization',
  ]) || null;
}

function runtimeErrorReason(error: CodexWebsocketRuntimeError): string {
  return isRecord(error.payload) ? asTrimmedString(error.payload.reason) : '';
}

function shouldRetryFreshSocketFailure(error: CodexWebsocketRuntimeError): boolean {
  const reason = runtimeErrorReason(error);
  if (!(
    reason === 'send_error'
    || reason === 'write_error'
    || reason === 'read_error'
    || reason === 'upstream_closed'
    || reason === 'connect_error'
    || reason === 'connect_closed_before_open'
  )) {
    return false;
  }
  const payload = isRecord(error.payload) ? error.payload : null;
  if (payload?.reusedSession !== false) return false;
  if (typeof payload.eventCount === 'number' && payload.eventCount > 0) return false;
  return error.events.length === 0;
}

async function waitForSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return;
  if (socket.readyState !== WebSocket.CONNECTING) {
    throw new Error('upstream websocket is not open');
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      socket.off('open', onOpen);
      socket.off('error', onError);
      socket.off('close', onClose);
      socket.off('unexpected-response', onUnexpectedResponse);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(new CodexWebsocketRuntimeError(error.message || 'upstream websocket connect error', {
        status: 502,
        payload: {
          reason: 'connect_error',
          reusedSession: false,
          eventCount: 0,
          socketReadyState: socket.readyState,
          rawErrorName: error.name,
          rawErrorMessage: error.message,
        },
      }));
    };
    const onClose = (code: number, reasonBuffer: Buffer) => {
      cleanup();
      const closeReason = reasonBuffer.toString('utf8');
      reject(new CodexWebsocketRuntimeError(closeReason || `upstream websocket closed before opening (${code})`, {
        status: 502,
        payload: {
          reason: 'connect_closed_before_open',
          reusedSession: false,
          eventCount: 0,
          socketReadyState: socket.readyState,
          closeCode: code,
          closeReason,
        },
      }));
    };
    const onUnexpectedResponse = (_request: unknown, response: IncomingMessage) => {
      cleanup();
      response.resume();
      const upstreamStatus = response.statusCode || 502;
      const status = upstreamStatus >= 400 ? upstreamStatus : 502;
      const is426 = status === 426;
      const statusMessage = response.statusMessage || '';
      reject(new CodexWebsocketRuntimeError(
        upstreamStatus >= 400
          ? (statusMessage || `upstream websocket upgrade failed with status ${upstreamStatus}`)
          : `upstream websocket upgrade failed: expected 101, got HTTP ${upstreamStatus}${statusMessage ? ` ${statusMessage}` : ''}`,
        {
          status,
          isUpgradeRequired426: is426,
          payload: {
            upstreamStatus,
          },
        },
      ));
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.once('unexpected-response', onUnexpectedResponse);
  });
}

async function closeSocket(socket: WebSocket | null): Promise<void> {
  if (!socket) return;
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    const onClose = () => resolve();
    socket.once('close', onClose);
    try {
      socket.close();
    } catch {
      socket.off('close', onClose);
      resolve();
    }
    setTimeout(() => {
      socket.off('close', onClose);
      resolve();
    }, 200);
  });
}

function clearSessionSocket(session: CodexWebsocketSession, socket: WebSocket): void {
  if (session.socket !== socket) return;
  if (session.heartbeatTimer) {
    clearInterval(session.heartbeatTimer);
    session.heartbeatTimer = null;
  }
  session.socket = null;
  session.socketUrl = null;
  if (session.readLoopSocket === socket) {
    session.readLoopSocket = null;
  }
}

function clearActiveRequest(session: CodexWebsocketSession, active: CodexWebsocketActiveRequest): void {
  if (active.idleTimer) {
    clearTimeout(active.idleTimer);
    active.idleTimer = null;
  }
  if (session.activeRequest === active) {
    session.activeRequest = null;
  }
}

function notifyUpstreamDisconnect(
  session: CodexWebsocketSession,
  error: Error,
  reason: CodexWebsocketDisconnectReason,
): void {
  if (session.upstreamDisconnect.fired) return;
  session.upstreamDisconnect.fired = true;
  session.upstreamDisconnect.error = error;
  emitTimeline(session, reason === 'upstream_error' ? 'error' : 'disconnect', {
    reason,
    payload: { message: error.message, name: error.name },
    onTimeline: session.activeRequest?.onTimeline,
  });
  session.upstreamDisconnect.resolve(error);
}

function invalidateUpstreamConnection(
  session: CodexWebsocketSession,
  socket: WebSocket,
  reason: CodexWebsocketDisconnectReason,
  error: Error,
  details?: Record<string, unknown>,
): void {
  const active = session.activeRequest;
  if (active && active.socket === socket) {
    clearActiveRequest(session, active);
    const message = reason === 'upstream_closed'
      ? 'stream closed before response.completed'
      : error.message || 'upstream websocket error';
    active.reject(new CodexWebsocketRuntimeError(message, {
      events: [...active.events],
      status: reason === 'idle_timeout' ? 408 : 502,
      payload: {
        reason,
        reusedSession: active.reusedSession,
        eventCount: active.events.length,
        socketReadyState: socket.readyState,
        ...(details ?? {}),
      },
    }));
  }
  clearSessionSocket(session, socket);
  notifyUpstreamDisconnect(session, error, reason);
  void closeSocket(socket);
}

function subscribeUpstreamDisconnect(session: CodexWebsocketSession, callback: (error: Error) => void): void {
  void session.upstreamDisconnect.promise.then((error) => {
    try {
      callback(error);
    } catch {
      // ignore subscriber errors
    }
  });
}

function buildContinuationAwareRuntimeBody(
  sessionId: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const rememberedResponseId = getCodexSessionResponseId(sessionId);
  if (!shouldInferResponsesPreviousResponseId(body, rememberedResponseId)) {
    return body;
  }
  return withResponsesPreviousResponseId(body, rememberedResponseId);
}

function rememberSessionResponseId(sessionId: string, payload: unknown): void {
  const responseId = extractResponsesTerminalResponseId(payload);
  if (!responseId) return;
  setCodexSessionResponseId(sessionId, responseId);
}

function rejectActiveRequest(
  session: CodexWebsocketSession,
  active: CodexWebsocketActiveRequest,
  message: string,
  options?: { status?: number; payload?: unknown; reason?: CodexWebsocketDisconnectReason },
): void {
  clearActiveRequest(session, active);
  emitTimeline(session, 'error', {
    reason: options?.reason,
    payload: options?.payload ?? { message },
    onTimeline: active.onTimeline,
  });
  active.reject(new CodexWebsocketRuntimeError(message, {
    events: [...active.events],
    status: options?.status,
    payload: options?.payload,
  }));
}

function resolveActiveRequest(session: CodexWebsocketSession, active: CodexWebsocketActiveRequest): void {
  clearActiveRequest(session, active);
  active.resolve({
    events: [...active.events],
    reusedSession: active.reusedSession,
  });
}

function resetActiveIdleTimer(session: CodexWebsocketSession, active: CodexWebsocketActiveRequest): void {
  if (active.idleTimer) clearTimeout(active.idleTimer);
  active.idleTimer = setTimeout(() => {
    if (session.activeRequest !== active) return;
    invalidateUpstreamConnection(
      session,
      active.socket,
      'idle_timeout',
      new Error(`upstream websocket idle timeout (${CODEX_WS_IDLE_TIMEOUT_MS}ms)`),
    );
  }, CODEX_WS_IDLE_TIMEOUT_MS);
}

function routeUpstreamMessage(session: CodexWebsocketSession, socket: WebSocket, payload: WebSocket.RawData): void {
  const active = session.activeRequest;
  if (!active || active.socket !== socket) return;

  try {
    const parsed = JSON.parse(String(payload));
    if (!isRecord(parsed)) return;
    session.lastActivityMs = Date.now();
    active.events.push(parsed);
    emitTimeline(session, 'response', { payload: parsed, onTimeline: active.onTimeline });
    try {
      active.onEvent?.(parsed);
    } catch {
      // Ignore downstream stream callback failures; runtime terminal handling
      // is governed by websocket protocol terminal events.
    }
    if (!isTerminalEvent(parsed)) {
      resetActiveIdleTimer(session, active);
      return;
    }
    if (
      isRuntimeErrorEvent(parsed)
      || isResponsesPreviousResponseNotFoundError({
        payload: parsed,
        rawErrText: extractTerminalErrorMessage(parsed),
      })
    ) {
      const message = extractTerminalErrorMessage(parsed);
      clearSessionSocket(session, socket);
      void closeSocket(socket);
      rejectActiveRequest(session, active, message, {
        status: extractFailureTerminalStatus(parsed),
        payload: parsed,
        reason: 'upstream_error',
      });
      return;
    }
    rememberSessionResponseId(session.sessionId, parsed);
    // Track token usage for context window guard (Layer 1 prediction)
    try {
      const response = isRecord(parsed) && isRecord(parsed.response) ? parsed.response : parsed;
      const usage = isRecord(response) ? response.usage : undefined;
      if (isRecord(usage) && typeof usage.prompt_tokens === 'number') {
        recordSessionTokenUsage({
          sessionId: session.sessionId,
          promptTokens: usage.prompt_tokens as number,
          completionTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens as number : 0,
          totalTokens: typeof usage.total_tokens === 'number' ? usage.total_tokens as number : 0,
          responseId: extractResponsesTerminalResponseId(parsed),
          succeeded: true,
        });
      }
    } catch {
      // Non-critical: token tracking failure should not break the request
    }
    resolveActiveRequest(session, active);
  } catch {
    // Ignore malformed frames and wait for a terminal event.
  }
}

function startUpstreamReadLoop(session: CodexWebsocketSession, socket: WebSocket): void {
  if (session.readLoopSocket === socket) return;
  session.readLoopSocket = socket;
  socket.on('message', (payload: WebSocket.RawData) => {
    routeUpstreamMessage(session, socket, payload);
  });
  socket.on('ping', (payload: Buffer) => {
    try {
      socket.pong(payload);
    } catch {
      // Ping/pong is best-effort; socket errors are handled by the read loop.
    }
  });
  socket.on('close', (code: number, reasonBuffer: Buffer) => {
    if (socket.readyState !== WebSocket.CLOSED) return;
    if (session.socket !== socket && session.activeRequest?.socket !== socket) return;
    const closeReason = reasonBuffer.toString('utf8');
    invalidateUpstreamConnection(
      session,
      socket,
      'upstream_closed',
      new Error(closeReason || `upstream websocket closed (${code})`),
      { closeCode: code, closeReason },
    );
  });
  socket.on('error', (error: Error) => {
    if (session.socket !== socket && session.activeRequest?.socket !== socket) return;
    invalidateUpstreamConnection(session, socket, 'read_error', error, {
      rawErrorName: error.name,
      rawErrorMessage: error.message,
    });
  });
}

async function ensureSessionSocket(
  session: CodexWebsocketSession,
  input: CodexWebsocketRuntimeSendInput,
): Promise<{ socket: WebSocket; reusedSession: boolean }> {
  const requestUrl = toCodexWebsocketUrl(input.requestUrl);
  const existing = session.socket;
  if (
    existing
    && session.socketUrl === requestUrl
    && existing.readyState === WebSocket.OPEN
  ) {
    session.authId = resolveRuntimeAuthId(input);
    session.lastActivityMs = Date.now();
    return {
      socket: existing,
      reusedSession: true,
    };
  }

  if (existing) {
    clearSessionSocket(session, existing);
    await closeSocket(existing);
  }

  const nextSocket = new WebSocket(requestUrl, {
    headers: buildCodexWebsocketHandshakeHeaders(input.headers),
    handshakeTimeout: CODEX_WS_HANDSHAKE_TIMEOUT_MS,
    agent: input.agent as never,
  });
  startUpstreamReadLoop(session, nextSocket);
  await waitForSocketOpen(nextSocket);
  session.socket = nextSocket;
  session.socketUrl = requestUrl;
  session.authId = resolveRuntimeAuthId(input);
  session.lastActivityMs = Date.now();

  // Start heartbeat to keep connection alive between requests
  if (session.heartbeatTimer) clearInterval(session.heartbeatTimer);
  session.heartbeatTimer = setInterval(() => {
    const currentSocket = session.socket;
    if (!currentSocket || currentSocket.readyState !== WebSocket.OPEN) {
      if (session.heartbeatTimer) {
        clearInterval(session.heartbeatTimer);
        session.heartbeatTimer = null;
      }
      return;
    }
    try {
      currentSocket.ping();
    } catch {
      // Best-effort: ping failure will be caught by the read loop
    }
  }, CODEX_WS_HEARTBEAT_INTERVAL_MS);

  emitTimeline(session, 'reconnect', {
    reason: 'connected',
    payload: { requestUrl },
    onTimeline: input.onTimeline,
  });

  return {
    socket: nextSocket,
    reusedSession: false,
  };
}

async function sendSessionRequestAttempt(
  session: CodexWebsocketSession,
  input: CodexWebsocketRuntimeSendInput & {
    body: Record<string, unknown>;
  },
): Promise<CodexWebsocketRuntimeResult> {
  const { socket, reusedSession } = await ensureSessionSocket(session, input);
  return new Promise<CodexWebsocketRuntimeResult>((resolve, reject) => {
    const active: CodexWebsocketActiveRequest = {
      socket,
      events: [],
      reusedSession,
      idleTimer: null,
      onEvent: input.onEvent,
      onTimeline: input.onTimeline,
      resolve,
      reject,
    };
    session.activeRequest = active;
    resetActiveIdleTimer(session, active);
    emitTimeline(session, 'request', {
      payload: input.body,
      onTimeline: input.onTimeline,
    });

    socket.send(JSON.stringify(buildCodexWebsocketRequestBody(input.body)), (error?: Error) => {
      if (!error) return;
      invalidateUpstreamConnection(
        session,
        socket,
        'send_error',
        error.message ? error : new Error('failed to send upstream websocket request'),
      );
    });
  });
}

async function sendSessionRequest(
  session: CodexWebsocketSession,
  input: CodexWebsocketRuntimeSendInput,
): Promise<CodexWebsocketRuntimeResult> {
  let currentBody = buildContinuationAwareRuntimeBody(session.sessionId, input.body);

  // ── Layer 1: Pre-request predictive trimming ──────────────────────
  // Same logic as openAiResponsesSurface — predict whether this request
  // will exceed the context window and proactively trim the input.
  if (config.contextWindowGuardEnabled) {
    const modelName = typeof currentBody.model === 'string' ? currentBody.model : '';
    const sessionUsage = getSessionTokenUsage(session.sessionId);
    const budgetDecision = evaluateContextBudget({
      model: modelName,
      inputTokensEstimate: estimateResponsesInputTokens(currentBody.input),
      sessionUsage,
    });
    const predictedTokens = budgetDecision.predictedPromptTokens;
    const estimatedInputTokens = budgetDecision.inputTokensEstimate;
    const effectiveTokens = budgetDecision.effectiveTokens;
    const trimTarget = budgetDecision.trimTargetTokens;

    if (budgetDecision.shouldTrim && isRecord(currentBody) && Array.isArray(currentBody.input)) {
      const trimResult = trimResponsesInputToTokenBudget(currentBody, trimTarget, effectiveTokens);
      if (trimResult.itemsRemoved > 0) {
        console.warn(
          '[codex-ws] Layer 1 predictive trim — removing oldest items',
          {
            sessionId: session.sessionId,
            predictedTokens,
            estimatedInputTokens,
            effectiveTokens,
            trimTarget,
            itemsRemoved: trimResult.itemsRemoved,
          },
        );
        currentBody = trimResult.body as Record<string, unknown>;
        // Strip previous_response_id since context changed
        const stripped = stripResponsesPreviousResponseId(currentBody);
        if (stripped.removed) {
          currentBody = stripped.body;
          clearCodexSessionResponseId(session.sessionId);
        }
        clearSessionBaseline(session.sessionId);
        // Mark session as trimmed — prevent recording response ID
        markLayer1TrimmedSession(session.sessionId);
      }
    } else if (budgetDecision.shouldResetContinuation) {
      const stripped = stripResponsesPreviousResponseId(currentBody);
      if (stripped.removed) {
        currentBody = stripped.body;
        clearCodexSessionResponseId(session.sessionId);
        clearSessionBaseline(session.sessionId);
      }
    } else {
      // No trimming needed — clear the Layer 1 trimmed flag
      clearLayer1TrimmedSession(session.sessionId);
    }
  }

  let previousResponseRecoveryTried = false;
  let contextOverflowRecoveryTried = false;

  for (;;) {
    try {
      return await sendSessionRequestAttempt(session, {
        ...input,
        body: currentBody,
      });
    } catch (error) {
      if (
        error instanceof CodexWebsocketRuntimeError
        && error.isUpgradeRequired426
      ) {
        throw error;
      }

      // ── Layer 3: Context window exceeded recovery ─────────────────
      // Mirrors Codex native: ContextWindowExceeded is fatal, clear session,
      // strip previous_response_id, trim input, retry once.
      if (
        !contextOverflowRecoveryTried
        && error instanceof CodexWebsocketRuntimeError
        && isContextWindowExceededError(error.message)
      ) {
        console.warn(
          '[codex-ws] context window exceeded — clearing session and trimming input',
          { sessionId: session.sessionId },
        );
        contextOverflowRecoveryTried = true;
        clearCodexSessionResponseId(session.sessionId);
        clearSessionTokenUsage(session.sessionId);
        clearLayer1TrimmedSession(session.sessionId);
        const overflowRecovery = stripResponsesPreviousResponseId(currentBody);
        let recoveredBody = overflowRecovery.body;
        // Layer 4: Trim input array to fit within context budget
        if (isRecord(recoveredBody) && Array.isArray(recoveredBody.input)) {
          const modelName = typeof recoveredBody.model === 'string' ? recoveredBody.model : '';
          const budgetDecision = evaluateContextBudget({
            model: modelName,
            inputTokensEstimate: estimateResponsesInputTokens(recoveredBody.input),
          });
          const trimResult = trimResponsesInputToTokenBudget(
            recoveredBody,
            budgetDecision.trimTargetTokens,
            budgetDecision.contextWindow,
          );
          if (trimResult.itemsRemoved > 0) {
            recoveredBody = trimResult.body;
          }
        }
        currentBody = recoveredBody;
        continue;
      }

      // ── Previous response not found recovery (existing logic) ───────
      if (
        previousResponseRecoveryTried
        || !(error instanceof CodexWebsocketRuntimeError)
        || !isResponsesPreviousResponseNotFoundError({
          payload: error.payload ?? error.events[error.events.length - 1],
          rawErrText: error.message,
        })
      ) {
        // ── Tool call mismatch recovery ───────────────────────────────
        // "No tool call found" or "No tool output found" — session state
        // is inconsistent (usually after WS reconnection). Clear session
        // and strip previous_response_id, then retry once.
        if (
          !previousResponseRecoveryTried
          && error instanceof CodexWebsocketRuntimeError
          && isResponsesToolCallMismatchError({
            payload: error.payload ?? error.events[error.events.length - 1],
            rawErrText: error.message,
          })
        ) {
          const toolCallRecovery = stripResponsesPreviousResponseId(currentBody);
          if (toolCallRecovery.removed) {
            previousResponseRecoveryTried = true;
            clearCodexSessionResponseId(session.sessionId);
            clearSessionTokenUsage(session.sessionId);
            clearLayer1TrimmedSession(session.sessionId);
            currentBody = toolCallRecovery.body;
            console.warn(
              '[codex-ws] tool call mismatch — clearing session and retrying',
              { sessionId: session.sessionId },
            );
            continue;
          }
        }

        if (
          error instanceof CodexWebsocketRuntimeError
          && session.socket === null
          && CODEX_WS_MAX_SEND_RETRIES > 0
          && !previousResponseRecoveryTried
          && shouldRetryFreshSocketFailure(error)
        ) {
          console.warn(
            '[codex-ws] fresh websocket failed before upstream events — reconnecting once',
            { sessionId: session.sessionId, reason: runtimeErrorReason(error), payload: error.payload },
          );
          try {
            return await sendSessionRequestAttempt(session, {
              ...input,
              body: currentBody,
            });
          } catch {
            throw error;
          }
        }
        throw error;
      }

      const previousResponseRecovery = stripResponsesPreviousResponseId(currentBody);
      if (!previousResponseRecovery.removed) {
        throw error;
      }

      previousResponseRecoveryTried = true;
      clearCodexSessionResponseId(session.sessionId);
      clearSessionTokenUsage(session.sessionId);
      clearLayer1TrimmedSession(session.sessionId);
      currentBody = previousResponseRecovery.body;
    }
  }
}

export function createCodexWebsocketRuntime(input?: {
  sessionStore?: CodexWebsocketSessionStore;
}) {
  const sessionStore = input?.sessionStore || createCodexWebsocketSessionStore();
  let sweepCounter = 0;

  return {
    async sendRequest(payload: CodexWebsocketRuntimeSendInput): Promise<CodexWebsocketRuntimeResult> {
      sweepCounter += 1;
      if (sweepCounter % 100 === 0) {
        sessionStore.sweepExpired();
      }

      const sessionId = payload.sessionId.trim();
      if (!sessionId) {
        throw new CodexWebsocketRuntimeError('missing websocket session id');
      }

      const session = sessionStore.getOrCreate(sessionId);
      const run = session.queue
        .catch(() => undefined)
        .then(() => sendSessionRequest(session, payload));
      session.queue = run.then(() => undefined, () => undefined);
      return run;
    },

    async closeSession(sessionId: string): Promise<void> {
      const session = sessionStore.take(sessionId);
      if (!session) return;
      await session.queue.catch(() => undefined);
      const socket = session.socket;
      if (socket) {
        clearSessionSocket(session, socket);
        await closeSocket(socket);
      }
      session.activeRequest = null;
    },

    async closeAllSessions(): Promise<void> {
      const sessions = sessionStore.list();
      for (const session of sessions) {
        await this.closeSession(session.sessionId);
      }
    },

    subscribeUpstreamDisconnect(sessionId: string, callback: (error: Error) => void): void {
      const normalized = sessionId.trim();
      if (!normalized) return;
      const session = sessionStore.getOrCreate(normalized);
      subscribeUpstreamDisconnect(session, callback);
    },

    waitForUpstreamDisconnect(sessionId: string): Promise<Error> | null {
      const normalized = sessionId.trim();
      if (!normalized) return null;
      const session = sessionStore.getOrCreate(normalized);
      return session.upstreamDisconnect.promise;
    },

    closeSessionsForAuthFilter(predicate: (session: CodexWebsocketSession) => boolean): void {
      const sessions = sessionStore.list();
      for (const session of sessions) {
        if (!predicate(session)) continue;
        sessionStore.take(session.sessionId);
        const socket = session.socket;
        if (!socket) continue;
        clearSessionSocket(session, socket);
        void closeSocket(socket);
      }
    },
  };
}
