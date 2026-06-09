import { TextDecoder } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../config.js';
import { reportProxyAllFailed } from '../../services/alertService.js';
import { hasProxyUsagePayload, mergeProxyUsage, parseProxyUsage } from '../../services/proxyUsageParser.js';
import { openAiResponsesTransformer } from '../../transformers/openai/responses/index.js';
import {
  extractResponsesTerminalResponseId,
  isResponsesPreviousResponseNotFoundError,
  isResponsesToolCallMismatchError,
  shouldInferResponsesPreviousResponseId,
  stripResponsesPreviousResponseId,
  withResponsesPreviousResponseId,
} from '../../transformers/openai/responses/continuation.js';
import {
  buildUpstreamEndpointRequest,
  resolveUpstreamEndpointCandidates,
  type UpstreamEndpoint,
} from '../../services/upstreamEndpointRuntime.js';
import {
  getUpstreamEndpointRuntimeStateSnapshot,
  recordUpstreamEndpointFailure,
  recordUpstreamEndpointSuccess,
} from '../../services/upstreamEndpointRuntimeMemory.js';
import { ensureModelAllowedForDownstreamKey, getDownstreamRoutingPolicy, recordDownstreamCostUsage } from '../../routes/proxy/downstreamPolicy.js';
import { executeEndpointFlow, type BuiltEndpointRequest } from '../orchestration/endpointFlow.js';
import { buildUpstreamUrl } from '../orchestration/upstreamRequest.js';
import {
  dropUnsupportedParameterFromBody,
  extractUnsupportedParameterName,
} from '../orchestration/unsupportedParameterRecovery.js';
import { detectProxyFailure } from '../../services/proxyFailureJudge.js';
import { isClientContinuationFailure, isContextWindowExceededRetryPolicy, isPreviousResponseNotFoundError, shouldRetryProxyRequest, shouldAbortSameSiteEndpointFallback } from '../../services/proxyRetryPolicy.js';
import { getProxyAuthContext, getProxyResourceOwner } from '../../middleware/auth.js';
import { normalizeInputFileBlock } from '../../transformers/shared/inputFile.js';
import { promoteRequiredEndpointCandidateAfterProtocolError } from '../../transformers/shared/endpointCompatibility.js';
import {
  ProxyInputFileResolutionError,
  resolveResponsesBodyInputFiles,
} from '../../services/proxyInputFileResolver.js';
import {
  buildOauthProviderHeaders,
} from '../../services/oauth/service.js';
import { getOauthInfoFromAccount } from '../../services/oauth/oauthAccount.js';
import {
  collectResponsesFinalPayloadFromSse,
  collectResponsesFinalPayloadFromSseText,
  createSingleChunkStreamReader,
  looksLikeResponsesSseText,
} from '../runtime/responsesSseFinal.js';
import { dispatchCodexWebsocketRequest } from './codexWsBridge.js';
import {
  createGeminiCliStreamReader,
  unwrapGeminiCliPayload,
} from '../../transformers/gemini/generate-content/cliBridge.js';
import { isCodexResponsesSurface } from '../cliProfiles/codexProfile.js';
import { getObservedResponseMeta } from '../firstByteTimeout.js';
import { getRuntimeResponseReader, readRuntimeResponseText } from '../executors/types.js';
import { runCodexHttpSessionTask } from '../runtime/codexHttpSessionQueue.js';
import {
  buildCodexSessionResponseStoreKey,
  clearCodexSessionResponseId,
  clearLayer1TrimmedSession,
  getCodexSessionResponseId,
  markLayer1TrimmedSession,
  safeSetCodexSessionResponseId,
  setCodexSessionResponseId,
} from '../runtime/codexSessionResponseStore.js';
import {
  summarizeConversationFileInputsInOpenAiBody,
  summarizeConversationFileInputsInResponsesBody,
} from '../capabilities/conversationFileCapabilities.js';
import {
  ensureCompactResponsesJsonAcceptHeader,
  sanitizeCompactResponsesRequestBody,
  shouldForceResponsesUpstreamStream,
  shouldFallbackCompactResponsesToResponses,
} from '../capabilities/responsesCompact.js';
import { detectDownstreamClientContext } from '../downstreamClientContext.js';
import { validateExternalResponsesHttpRequest } from '../responsesPreflight.js';
import { applyOpenAiServiceTierPolicy } from '../serviceTierPolicy.js';
import { maybeHandleWebSearchOnlySimulation } from '../webSearchSimulation.js';
import { getProxyMaxChannelRetries } from '../../services/proxyChannelRetry.js';
import { resolveChannelProxyUrl } from '../../services/siteProxy.js';
import {
  acquireSurfaceChannelLease,
  bindSurfaceStickyChannel,
  buildSurfaceChannelBusyMessage,
  buildSurfaceStickySessionKey,
  clearSurfaceStickyChannel,
  createSurfaceFailureToolkit,
  createSurfaceDispatchRequest,
  getSurfaceStickyPreferredChannelId,
  recordSurfaceSuccess,
  selectSurfaceChannelForAttempt,
  trySurfaceOauthPreRefresh,
  trySurfaceOauthRefreshRecovery,
  type CodexContextTelemetry,
} from './sharedSurface.js';
import {
  buildSurfaceProxyDebugResponseHeaders,
  captureSurfaceProxyDebugSuccessResponseBody,
  parseSurfaceProxyDebugTextPayload,
  reserveSurfaceProxyDebugAttemptBase,
  safeFinalizeSurfaceProxyDebugTrace,
  safeInsertSurfaceProxyDebugAttempt,
  safeUpdateSurfaceProxyDebugAttempt,
  safeUpdateSurfaceProxyDebugCandidates,
  safeUpdateSurfaceProxyDebugSelection,
  startSurfaceProxyDebugTrace,
} from '../../services/proxyDebugTraceRuntime.js';
import { runWithSiteApiEndpointPool, SiteApiEndpointRequestError } from '../../services/siteApiEndpointService.js';
import {
  buildForcedChannelUnavailableMessage,
  canRetryChannelSelection,
  getTesterForcedChannelId,
} from '../channelSelection.js';
import { resolveResponsesContinuityKey } from '../responsesContinuity.js';
import {
  buildResponsesContinuationRecoveryError,
  hasReplayableResponsesContinuationContext,
  isResponsesContinuationRecoveryError,
} from '../responsesContinuationRecovery.js';
import {
  evaluateContextBudget,
  estimateResponsesInputTokens,
  getModelContextWindow,
  isContextWindowExceededError as isContextWindowExceededGuard,
  recordSessionTokenUsage,
  getSessionTokenUsage,
  clearSessionTokenUsage,
  trimResponsesInputToTokenBudget,
  shouldAttemptSoftContextCompact,
} from '../capabilities/contextWindowGuard.js';
import {
  tryComputeIncrementalInput,
  recordSessionBaseline,
  clearSessionBaseline,
  extractResponseOutputItems,
} from '../capabilities/sessionInputBaseline.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function getCodexSessionHeaderValue(headers: Record<string, string>): string {
  const normalizedEntries = Object.entries(headers).map(([rawKey, rawValue]) => [
    rawKey.trim().toLowerCase(),
    String(rawValue || '').trim(),
  ] as const);
  for (const preferredKey of ['session_id', 'session-id', 'conversation_id', 'conversation-id']) {
    const match = normalizedEntries.find(([normalizedKey, normalizedValue]) => (
      normalizedKey === preferredKey && normalizedValue
    ));
    if (match) {
      return match[1];
    }
  }
  return '';
}
function isResponsesWebsocketTransportRequest(headers: Record<string, unknown>): boolean {
  return Object.entries(headers)
    .some(([rawKey, rawValue]) => rawKey.trim().toLowerCase() === 'x-metapi-responses-websocket-transport'
      && String(rawValue).trim() === '1');
}

function isResponsesWebsocketHttpFallbackRequest(headers: Record<string, unknown>): boolean {
  return Object.entries(headers)
    .some(([rawKey, rawValue]) => rawKey.trim().toLowerCase() === 'x-metapi-responses-websocket-http-fallback'
      && String(rawValue).trim() === '1');
}

function safeRememberCodexSessionResponseId(sessionId: string, payload: unknown): void {
  if (!sessionId) return;
  safeSetCodexSessionResponseId(sessionId, payload);
}

function recordCodexSessionBaselineFromPayload(input: {
  sessionId: string;
  requestInput: Record<string, unknown>[] | null;
  payload: unknown;
  model: string;
}): void {
  if (!input.sessionId || !input.requestInput) return;
  const responseId = extractResponsesTerminalResponseId(input.payload);
  if (!responseId) return;
  if (getCodexSessionResponseId(input.sessionId) !== responseId) return;
  recordSessionBaseline({
    sessionId: input.sessionId,
    requestInput: input.requestInput,
    responseOutputItems: extractResponseOutputItems(input.payload),
    responseId,
    model: input.model,
  });
}

/**
 * Handles session cleanup when a context-window or continuation error is
 * detected in a path that bypasses tryRecover (stream failures, etc.).
 *
 * Layer 3: Context exceeded → clear session so subsequent requests don't
 * chain to a failed/nonexistent response.
 *
 * Returns true if the error was a context-window-exceeded error (caller
 * may want to adjust its own handling).
 */
function handleContinuationFailureSessionCleanup(
  errorText: string | null | undefined,
  codexSessionStoreKey: string,
): boolean {
  if (!codexSessionStoreKey) return false;

  if (isContextWindowExceededRetryPolicy(errorText)) {
    // Layer 3: Context overflow — clear session state completely
    clearCodexSessionResponseId(codexSessionStoreKey);
    clearSessionTokenUsage(codexSessionStoreKey);
    clearSessionBaseline(codexSessionStoreKey);
    clearLayer1TrimmedSession(codexSessionStoreKey);
    console.warn(
      '[responses] context window exceeded — cleared session state (stream/inline path)',
      { sessionId: codexSessionStoreKey },
    );
    return true;
  }

  if (isPreviousResponseNotFoundError(errorText)) {
    // Consequence of context overflow — clear the dangling response ID
    clearCodexSessionResponseId(codexSessionStoreKey);
    clearSessionTokenUsage(codexSessionStoreKey);
    clearSessionBaseline(codexSessionStoreKey);
    clearLayer1TrimmedSession(codexSessionStoreKey);
    console.warn(
      '[responses] previous response not found — cleared session state (stream/inline path)',
      { sessionId: codexSessionStoreKey },
    );
    return true;
  }

  return false;
}

function normalizeIncludeList(value: unknown): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
}

function hasExplicitInclude(body: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(body, 'include');
}

function hasResponsesReasoningRequest(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const relevantKeys = ['effort', 'budget_tokens', 'budgetTokens', 'max_tokens', 'maxTokens', 'summary'];
  return relevantKeys.some((key) => {
    const entry = value[key];
    if (typeof entry === 'string') return entry.trim().length > 0;
    return entry !== undefined && entry !== null;
  });
}

function carriesResponsesReasoningContinuity(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => carriesResponsesReasoningContinuity(item));
  }
  if (!isRecord(value)) return false;

  const type = typeof value.type === 'string' ? value.type.trim().toLowerCase() : '';
  if (type === 'reasoning') {
    if (typeof value.encrypted_content === 'string' && value.encrypted_content.trim()) {
      return true;
    }
    if (Array.isArray(value.summary) && value.summary.length > 0) {
      return true;
    }
  }

  if (typeof value.reasoning_signature === 'string' && value.reasoning_signature.trim()) {
    return true;
  }

  return carriesResponsesReasoningContinuity(value.input)
    || carriesResponsesReasoningContinuity(value.content);
}

function wantsNativeResponsesReasoning(body: unknown): boolean {
  if (!isRecord(body)) return false;
  const include = normalizeIncludeList(body.include);
  if (include.some((item) => item.toLowerCase() === 'reasoning.encrypted_content')) {
    return true;
  }
  if (carriesResponsesReasoningContinuity(body.input)) {
    return true;
  }
  if (hasExplicitInclude(body)) {
    return false;
  }
  return hasResponsesReasoningRequest(body.reasoning);
}

function carriesResponsesFileUrlInput(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => carriesResponsesFileUrlInput(item));
  }
  if (!isRecord(value)) return false;

  const normalizedFile = normalizeInputFileBlock(value);
  if (normalizedFile?.fileUrl) return true;

  return Object.values(value).some((entry) => carriesResponsesFileUrlInput(entry));
}

function finalizeRetryAsUpstreamFailure(status: number, message: string) {
  return {
    action: 'respond' as const,
    status,
    payload: {
      error: {
        message,
        type: 'upstream_error' as const,
      },
    },
  };
}

function finalizeRetryAsExecutionFailure(message: string) {
  return {
    action: 'respond' as const,
    status: 502,
    payload: {
      error: {
        message: `Upstream error: ${message}`,
        type: 'upstream_error' as const,
      },
    },
  };
}

function shouldRefreshOauthResponsesRequest(input: {
  oauthProvider?: string;
  status: number;
  response: { headers: { get(name: string): string | null } };
  rawErrText: string;
}): boolean {
  if (input.status === 401) return true;
  if (input.status !== 403 || input.oauthProvider !== 'codex') return false;
  const authenticate = input.response.headers.get('www-authenticate') || '';
  const combined = `${authenticate}\n${input.rawErrText || ''}`;
  return /\b(invalid_token|expired_token|expired|invalid|unauthorized|account mismatch|authentication)\b/i.test(combined);
}

type UsageSummary = ReturnType<typeof parseProxyUsage>;


type CodexAutoCompactSessionState = {
  turn: number;
  nextEligibleTurn: number;
  attempts: number;
  unsupportedUntilMs: number;
};

const codexAutoCompactSessions = new Map<string, CodexAutoCompactSessionState>();

function getCodexAutoCompactSessionState(sessionId: string): CodexAutoCompactSessionState {
  const key = sessionId.trim();
  const existing = codexAutoCompactSessions.get(key);
  if (existing) return existing;
  const created: CodexAutoCompactSessionState = {
    turn: 0,
    nextEligibleTurn: 0,
    attempts: 0,
    unsupportedUntilMs: 0,
  };
  codexAutoCompactSessions.set(key, created);
  return created;
}

function extractCompactOutputItems(payload: unknown): Record<string, unknown>[] {
  if (!isRecord(payload)) return [];
  if (Array.isArray(payload.output)) {
    return payload.output.filter((item): item is Record<string, unknown> => isRecord(item));
  }
  const response = payload.response;
  if (isRecord(response) && Array.isArray(response.output)) {
    return response.output.filter((item): item is Record<string, unknown> => isRecord(item));
  }
  return [];
}

function buildCompactedMainInput(
  inputItems: unknown[],
  compactItems: Record<string, unknown>[],
  targetTokens: number,
): unknown[] {
  if (compactItems.length === 0) return inputItems;
  const first = inputItems[0];
  const shouldKeepFirst = isRecord(first)
    && typeof first.role === 'string'
    && /^(system|developer)$/i.test(first.role.trim());
  const prefix = shouldKeepFirst ? [first] : [];
  const target = Math.max(1_000, Math.trunc(targetTokens));
  const estimateItems = (items: unknown[]) => estimateResponsesInputTokens(items) ?? Number.MAX_SAFE_INTEGER;
  const baseItems = [...prefix, ...compactItems];
  const maxTailCount = Math.max(1, Math.min(6, inputItems.length));
  const tailCandidates = inputItems.slice(Math.max(shouldKeepFirst ? 1 : 0, inputItems.length - maxTailCount));
  const tail: unknown[] = [];

  for (let index = tailCandidates.length - 1; index >= 0; index--) {
    const candidateTail = [tailCandidates[index], ...tail];
    const candidate = [...baseItems, ...candidateTail];
    if (tail.length === 0 || estimateItems(candidate) <= target) {
      tail.unshift(tailCandidates[index]);
    }
  }

  return [
    ...baseItems,
    ...tail,
  ];
}

function buildCodexContextTelemetry(input: {
  clientFullInputTokensEstimate: number | null;
  upstreamSentInputTokensEstimate?: number | null;
  upstreamPromptTokens?: number | null;
  contextStrategy?: CodexContextTelemetry['contextStrategy'];
  compactTriggered?: boolean;
  compactReason?: string | null;
  fallbackReason?: string | null;
  previousResponseIdUsed?: boolean | null;
  compactAttempted?: boolean | null;
  compactSucceeded?: boolean | null;
}): CodexContextTelemetry {
  const sentEstimate = input.upstreamSentInputTokensEstimate ?? null;
  const fullEstimate = input.clientFullInputTokensEstimate;
  const savedEstimate = (
    typeof fullEstimate === 'number'
    && typeof sentEstimate === 'number'
  ) ? Math.max(0, fullEstimate - sentEstimate) : null;
  return {
    clientFullInputTokensEstimate: fullEstimate,
    upstreamSentInputTokensEstimate: sentEstimate,
    upstreamPromptTokens: input.upstreamPromptTokens ?? null,
    contextStrategy: input.contextStrategy ?? 'full',
    compactTriggered: input.compactTriggered ?? false,
    compactReason: input.compactReason ?? null,
    fallbackReason: input.fallbackReason ?? null,
    savedInputTokensEstimate: savedEstimate,
    previousResponseIdUsed: input.previousResponseIdUsed ?? null,
    compactAttempted: input.compactAttempted ?? false,
    compactSucceeded: input.compactSucceeded ?? false,
  };
}

export async function handleOpenAiResponsesSurfaceRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  downstreamPath: '/v1/responses' | '/v1/responses/compact',
) {
    const body = request.body as Record<string, unknown>;
    const clientContext = detectDownstreamClientContext({
      downstreamPath,
      headers: request.headers as Record<string, unknown>,
      body,
    });
    const continuitySessionId = resolveResponsesContinuityKey({
      headers: request.headers as Record<string, unknown>,
      body,
      clientSessionId: clientContext.sessionId || null,
    });
    if (config.responsesRequireContinuitySession && !continuitySessionId) {
      return reply.code(400).send({
        error: {
          message: 'responses requests require session_id or conversation_id when continuity guard is enabled',
          type: 'invalid_request_error',
        },
      });
    }
    const defaultEncryptedReasoningInclude = isCodexResponsesSurface(
      request.headers as Record<string, unknown>,
    );
    if (!isResponsesWebsocketTransportRequest(request.headers as Record<string, unknown>)) {
      const preflight = validateExternalResponsesHttpRequest(body, {
        allowContinuationToolOutput: defaultEncryptedReasoningInclude,
      });
      if (!preflight.ok) {
        return reply.code(preflight.statusCode).send(preflight.payload);
      }
    }
    const parsedRequestEnvelope = openAiResponsesTransformer.transformRequest(body, {
      defaultEncryptedReasoningInclude,
    });
    if (parsedRequestEnvelope.error) {
      return reply.code(parsedRequestEnvelope.error.statusCode).send(parsedRequestEnvelope.error.payload);
    }
    const requestEnvelope = parsedRequestEnvelope.value!;
    const requestedModel = requestEnvelope.model;
    const isStream = requestEnvelope.stream;
    const isCompactRequest = downstreamPath === '/v1/responses/compact';
    if (isCompactRequest && isStream) {
      return reply.code(400).send({
        error: {
          message: 'stream is not supported on /v1/responses/compact',
          type: 'invalid_request_error',
        },
      });
    }
    if (!isCompactRequest) {
      const handledSearch = await maybeHandleWebSearchOnlySimulation({
        app: request.server,
        request,
        reply,
        downstreamFormat: 'responses',
        body: requestEnvelope.parsed.normalizedBody,
      });
      if (handledSearch) return;
    }
    if (!await ensureModelAllowedForDownstreamKey(request, reply, requestedModel)) return;
    const downstreamPolicy = getDownstreamRoutingPolicy(request);
    const forcedChannelId = getTesterForcedChannelId({
      headers: request.headers as Record<string, unknown>,
      clientIp: request.ip,
    });
    const downstreamApiKeyId = getProxyAuthContext(request)?.keyId ?? null;
    const maxRetries = getProxyMaxChannelRetries();
    const failureToolkit = createSurfaceFailureToolkit({
      warningScope: 'responses',
      downstreamPath,
      downstreamTransport: isResponsesWebsocketTransportRequest(request.headers as Record<string, unknown>) ? 'websocket' : 'http',
      upstreamTransport: 'http', // updated after channel selection
      maxRetries,
      clientContext,
      downstreamApiKeyId,
    });
    const stickySessionKey = buildSurfaceStickySessionKey({
      clientContext,
      requestedModel,
      downstreamPath,
      downstreamApiKeyId,
    });
    const debugTrace = await startSurfaceProxyDebugTrace({
      downstreamPath,
      clientKind: clientContext.clientKind,
      sessionId: clientContext.sessionId || null,
      traceHint: clientContext.traceHint || null,
      requestedModel,
      downstreamApiKeyId,
      requestHeaders: request.headers as Record<string, unknown>,
      requestBody: request.body,
    });
    const finalizeDebugFailure = async (status: number, payload: unknown, upstreamPath: string | null = null) => {
      await safeFinalizeSurfaceProxyDebugTrace(debugTrace, {
        finalStatus: 'failed',
        finalHttpStatus: status,
        finalUpstreamPath: upstreamPath,
        finalResponseHeaders: {
          'content-type': 'application/json',
        },
        finalResponseBody: payload,
      });
    };
    const finalizeDebugSuccess = async (status: number, upstreamPath: string | null, responseHeaders: unknown, responseBody: unknown) => {
      await safeFinalizeSurfaceProxyDebugTrace(debugTrace, {
        finalStatus: 'success',
        finalHttpStatus: status,
        finalUpstreamPath: upstreamPath,
        finalResponseHeaders: responseHeaders as Record<string, unknown> | null,
        finalResponseBody: responseBody,
      });
    };
    const excludeChannelIds: number[] = [];
    let retryCount = 0;
    let lastIncrementalOptimization: {
      previousResponseId: string;
      incrementalInput: unknown[];
      baselineLength: number;
      savedItems: number;
    } | null = null;

    while (retryCount <= maxRetries) {
      const stickyPreferredChannelId = retryCount === 0
        ? getSurfaceStickyPreferredChannelId(stickySessionKey)
        : null;
      const selected = await selectSurfaceChannelForAttempt({
        requestedModel,
        downstreamPolicy,
        excludeChannelIds,
        retryCount,
        stickySessionKey,
        forcedChannelId,
      });

      if (!selected) {
        const noChannelMessage = buildForcedChannelUnavailableMessage(forcedChannelId);
        await reportProxyAllFailed({
          model: requestedModel,
          reason: forcedChannelId ? noChannelMessage : 'No available channels after retries',
        });
        const payload = {
          error: { message: noChannelMessage, type: 'server_error' as const },
        };
        await finalizeDebugFailure(503, payload, null);
        return reply.code(503).send({
          error: { message: noChannelMessage, type: 'server_error' },
        });
      }

      excludeChannelIds.push(selected.channel.id);
      await safeUpdateSurfaceProxyDebugSelection(debugTrace, {
        stickySessionKey,
        stickyHitChannelId: (
          stickyPreferredChannelId && stickyPreferredChannelId === selected.channel.id
            ? stickyPreferredChannelId
            : null
        ),
        selectedChannelId: selected.channel.id,
        selectedRouteId: selected.channel.routeId ?? null,
        selectedAccountId: selected.account.id,
        selectedSiteId: selected.site.id,
        selectedSitePlatform: selected.site.platform,
      });

      const modelName = selected.actualModel || requestedModel;
      const oauth = getOauthInfoFromAccount(selected.account);
      const isCodexSite = String(selected.site.platform || '').trim().toLowerCase() === 'codex';
      const codexSessionId = isCodexSite
        ? getCodexSessionHeaderValue(request.headers as Record<string, string>)
        : '';
      const codexSessionStoreKey = (
        isCodexSite
        && codexSessionId
      )
        ? buildCodexSessionResponseStoreKey({
          sessionId: codexSessionId,
          siteId: selected.site.id,
          accountId: selected.account.id,
          channelId: selected.channel.id,
        })
        : '';
      const owner = getProxyResourceOwner(request);
      let normalizedResponsesBody: Record<string, unknown> = {
        ...requestEnvelope.parsed.normalizedBody,
        model: modelName,
        stream: isStream,
      };
      const serviceTierPolicy = applyOpenAiServiceTierPolicy({
        body: normalizedResponsesBody,
        context: {
          requestedModel,
          actualModel: modelName,
          sitePlatform: selected.site.platform,
          accountType: oauth?.planType,
        },
        rules: (config as any).openAiServiceTierRules,
      });
      if (!serviceTierPolicy.ok) {
        await finalizeDebugFailure(serviceTierPolicy.statusCode, serviceTierPolicy.payload, null);
        return reply.code(serviceTierPolicy.statusCode).send(serviceTierPolicy.payload);
      }
      normalizedResponsesBody = serviceTierPolicy.body;
      if (body.generate === false) {
        normalizedResponsesBody.generate = false;
      }
      if (owner) {
        try {
          normalizedResponsesBody = await resolveResponsesBodyInputFiles(normalizedResponsesBody, owner);
        } catch (error) {
          if (error instanceof ProxyInputFileResolutionError) {
            return reply.code(error.statusCode).send(error.payload);
          }
          throw error;
        }
      }
      const clientFullInputTokensEstimate = estimateResponsesInputTokens(normalizedResponsesBody.input);
      let contextTelemetry = buildCodexContextTelemetry({
        clientFullInputTokensEstimate,
        contextStrategy: isCompactRequest ? 'compact' : 'full',
        compactTriggered: isCompactRequest,
        compactReason: isCompactRequest ? 'explicit_compact_request' : null,
        compactAttempted: isCompactRequest,
      });
      const updateContextTelemetry = (patch: Partial<CodexContextTelemetry>) => {
        contextTelemetry = {
          ...contextTelemetry,
          ...patch,
        };
        if (
          typeof contextTelemetry.clientFullInputTokensEstimate === 'number'
          && typeof contextTelemetry.upstreamSentInputTokensEstimate === 'number'
        ) {
          contextTelemetry.savedInputTokensEstimate = Math.max(
            0,
            contextTelemetry.clientFullInputTokensEstimate - contextTelemetry.upstreamSentInputTokensEstimate,
          );
        }
      };
      const autoCompactSessionState = codexSessionStoreKey
        ? getCodexAutoCompactSessionState(codexSessionStoreKey)
        : null;
      const sessionContextUsage = codexSessionStoreKey
        ? getSessionTokenUsage(codexSessionStoreKey)
        : null;
      if (autoCompactSessionState) {
        autoCompactSessionState.turn += 1;
      }
      let autoCompactAttemptedThisRequest = false;
      const openAiBody = openAiResponsesTransformer.inbound.toOpenAiBody(
        normalizedResponsesBody,
        modelName,
        isStream,
        { defaultEncryptedReasoningInclude },
      );
      const conversationFileSummary = summarizeConversationFileInputsInOpenAiBody(openAiBody);
      const hasNonImageFileInput = conversationFileSummary.hasDocument;
      const prefersNativeResponsesReasoning = wantsNativeResponsesReasoning(normalizedResponsesBody);
      const responsesConversationFileSummary = summarizeConversationFileInputsInResponsesBody(normalizedResponsesBody);
      const requiresNativeResponsesFileUrl = responsesConversationFileSummary.hasRemoteDocumentUrl
        || carriesResponsesFileUrlInput(normalizedResponsesBody.input);
      const endpointCandidates: UpstreamEndpoint[] = isCompactRequest
        ? await resolveUpstreamEndpointCandidates(
          {
            site: selected.site,
            account: selected.account,
          },
          modelName,
          'responses',
          requestedModel,
          {
            hasNonImageFileInput,
            conversationFileSummary,
            wantsNativeResponsesReasoning: prefersNativeResponsesReasoning,
          },
          {
            requestKind: 'responses-compact',
            requiresNativeResponsesFileUrl,
          },
        )
        : await resolveUpstreamEndpointCandidates(
          {
            site: selected.site,
            account: selected.account,
          },
          modelName,
          'responses',
          requestedModel,
          {
            hasNonImageFileInput,
            conversationFileSummary,
            wantsNativeResponsesReasoning: prefersNativeResponsesReasoning,
          },
          {
            requiresNativeResponsesFileUrl,
          },
        );
      const endpointRuntimeContext = {
        siteId: selected.site.id,
        modelName,
        downstreamFormat: 'responses' as const,
        requestedModelHint: requestedModel,
        requestCapabilities: {
          hasNonImageFileInput,
          conversationFileSummary,
          wantsNativeResponsesReasoning: prefersNativeResponsesReasoning,
        },
      };
      await safeUpdateSurfaceProxyDebugCandidates(debugTrace, {
        endpointCandidates,
        endpointRuntimeState: getUpstreamEndpointRuntimeStateSnapshot(endpointRuntimeContext),
        decisionSummary: {
          retryCount,
          downstreamFormat: 'responses',
          stickySessionKey,
          stickyPreferredChannelId,
          oauthProvider: oauth?.provider || null,
          isCodexSite,
          requiresNativeResponsesFileUrl,
          isCompactRequest,
        },
      });
      const buildProviderHeaders = () => (
        buildOauthProviderHeaders({
          account: selected.account,
          downstreamHeaders: request.headers as Record<string, unknown>,
        })
      );
      const executeEndpointResultForSiteApiBaseUrl = async (siteApiBaseUrl: string) => {
        const websocketHttpFallbackRequest = isResponsesWebsocketHttpFallbackRequest(request.headers as Record<string, unknown>);
        // Update upstream transport now that we know the site platform
        failureToolkit.setUpstreamTransport(
          (isCodexSite && config.codexUpstreamWebsocketEnabled && !websocketHttpFallbackRequest) ? 'websocket' : 'http'
        );
        if (oauth) {
          await trySurfaceOauthPreRefresh({ selected });
        }
        const forceResponsesUpstreamStream = shouldForceResponsesUpstreamStream({
          sitePlatform: selected.site.platform,
          isCompactRequest,
        });
        // ── Layer 1: Pre-request context budget check ────────────────────
        // Check if the CURRENT request's input is approaching the model's
        // context window. If so, trim the input array to fit within budget.
        // This is the most effective token-saving measure — it directly
        // reduces prompt_tokens sent to the upstream.
        //
        // Unified strategy: combine session-level prediction with request-level estimation
        // to proactively trim input BEFORE sending to upstream.
        //
        // Key insight: prompt_tokens from upstream includes the FULL context
        // (previous_response_id's cached content + new input). The input array
        // alone may look small if previous_response_id is active, but the
        // effective token count is much higher. So we must use session-level
        // prompt_tokens (from last successful response) as the primary signal,
        // and predict whether this request will exceed the context window.
        let layer1ContextOverride: { skipPreviousResponseId: boolean; reason: string } | null = null;
        let layer1TrimmedInput: Record<string, unknown> | null = null;

        if (isCodexSite && codexSessionStoreKey && config.contextWindowGuardEnabled) {
          const budgetDecision = evaluateContextBudget({
            model: modelName,
            inputTokensEstimate: clientFullInputTokensEstimate,
            sessionUsage: sessionContextUsage,
          });
          const contextWindow = budgetDecision.contextWindow;
          const trimTarget = budgetDecision.trimTargetTokens;
          const predictedTokens = budgetDecision.predictedPromptTokens;
          const estimatedInputTokens = budgetDecision.inputTokensEstimate;
          const effectiveTokens = budgetDecision.effectiveTokens;
          const shouldTrimPredictive = budgetDecision.shouldTrimPredictive;
          const shouldTrim = budgetDecision.shouldTrim;

          console.info(
            '[responses] Layer 1 context budget check',
            {
              sessionId: codexSessionStoreKey,
              lastPromptTokens: sessionContextUsage?.promptTokens ?? 0,
              prevPromptTokens: sessionContextUsage?.prevPromptTokens ?? 0,
              growthRate: sessionContextUsage?.growthRate ?? 0,
              predictedTokens,
              estimatedInputTokens,
              effectiveTokens,
              contextWindow,
              trimTarget,
              shouldTrim,
              shouldResetContinuation: budgetDecision.shouldResetContinuation,
            },
          );

          if (shouldTrim) {
            console.warn(
              '[responses] Layer 1 trimming input',
              {
                sessionId: codexSessionStoreKey,
                predictedTokens,
                estimatedInputTokens,
                effectiveTokens,
                contextWindow,
                trimTarget,
                reason: shouldTrimPredictive
                  ? `predicted ${predictedTokens} tokens >= ${trimTarget} trim target`
                  : `input estimated at ${estimatedInputTokens} tokens >= ${trimTarget} trim target`,
              },
            );

            // Trim the input array
            if (isRecord(normalizedResponsesBody) && Array.isArray(normalizedResponsesBody.input)) {
              const trimResult = trimResponsesInputToTokenBudget(
                normalizedResponsesBody as Record<string, unknown>,
                trimTarget,
                effectiveTokens,
              );
              if (trimResult.itemsRemoved > 0) {
                layer1TrimmedInput = trimResult.body;
                updateContextTelemetry({
                  contextStrategy: 'trim',
                  fallbackReason: budgetDecision.trimReason,
                });
                layer1ContextOverride = {
                  skipPreviousResponseId: true,
                  reason: shouldTrimPredictive
                    ? `predicted ${predictedTokens} tokens >= ${trimTarget} — removed ${trimResult.itemsRemoved} oldest items`
                    : `input estimated at ${estimatedInputTokens} tokens >= ${trimTarget} — removed ${trimResult.itemsRemoved} oldest items`,
                };
                clearCodexSessionResponseId(codexSessionStoreKey);
                clearSessionBaseline(codexSessionStoreKey);
                // Mark session as trimmed — prevent safeRememberCodexSessionResponseId
                // from recording the trimmed response's ID (which would cause
                // unsafe previous_response_id injection on next request)
                markLayer1TrimmedSession(codexSessionStoreKey);
                // Don't clear sessionTokenUsage — we need it for growth prediction
                // The next success will update it with the trimmed request's actual prompt_tokens
              }
            } else {
              // Can't trim (no input array), just skip previous_response_id
              updateContextTelemetry({
                contextStrategy: 'fallback_no_previous_response',
                fallbackReason: shouldTrimPredictive
                  ? `predicted ${predictedTokens} tokens >= ${trimTarget} — skipping previous_response_id`
                  : `effective ${effectiveTokens} tokens >= ${trimTarget} — skipping previous_response_id`,
              });
              layer1ContextOverride = {
                skipPreviousResponseId: true,
                reason: shouldTrimPredictive
                  ? `predicted ${predictedTokens} tokens >= ${trimTarget} — skipping previous_response_id`
                  : `effective ${effectiveTokens} tokens >= ${trimTarget} — skipping previous_response_id`,
              };
              clearCodexSessionResponseId(codexSessionStoreKey);
              clearSessionBaseline(codexSessionStoreKey);
            }
          } else if (budgetDecision.shouldResetContinuation) {
            updateContextTelemetry({
              contextStrategy: 'fallback_no_previous_response',
              fallbackReason: `${budgetDecision.resetContinuationReason} — skipping previous_response_id`,
            });
            layer1ContextOverride = {
              skipPreviousResponseId: true,
              reason: `${budgetDecision.resetContinuationReason} — skipping previous_response_id`,
            };
            clearCodexSessionResponseId(codexSessionStoreKey);
            clearSessionBaseline(codexSessionStoreKey);
          } else {
            // No trimming needed — clear the Layer 1 trimmed flag so that
            // subsequent safeRememberCodexSessionResponseId can record IDs again.
            // This handles the case where a session was trimmed in a previous
            // turn but is now within budget.
            clearLayer1TrimmedSession(codexSessionStoreKey);
          }
        }
        // Apply Layer 1 trimmed input if applicable
        const layer1Body = layer1TrimmedInput
          ? layer1TrimmedInput as Record<string, unknown>
          : normalizedResponsesBody;
        const buildEndpointRequest = (endpoint: 'chat' | 'messages' | 'responses') => {
          const upstreamStream = isStream || (forceResponsesUpstreamStream && endpoint === 'responses');
          // Use layer1Body (potentially trimmed) instead of raw normalizedResponsesBody
          const activeBody = layer1TrimmedInput
            ? (layer1TrimmedInput as Record<string, unknown>)
            : normalizedResponsesBody;
          const shouldInjectPreviousResponseId = (
            endpoint === 'responses'
            && isCodexSite
            && codexSessionStoreKey
            && !layer1ContextOverride?.skipPreviousResponseId
            && shouldInferResponsesPreviousResponseId(
              activeBody,
              getCodexSessionResponseId(codexSessionStoreKey),
            )
          );
          // ── Incremental input optimization (省额度) ──────────────────────
          // Mirrors Codex CLI's `get_incremental_items()` — when the new
          // request's input starts with the previous baseline (last input +
          // model output items), we only send the suffix as input, paired
          // with previous_response_id. This dramatically reduces prompt tokens.
          let incrementalOptimization: {
            previousResponseId: string;
            incrementalInput: unknown[];
            baselineLength: number;
            savedItems: number;
          } | null = null;
          let responsesOriginalBody: Record<string, unknown>;

          if (isCodexSite && codexSessionStoreKey && !layer1ContextOverride?.skipPreviousResponseId) {
            const newInput = activeBody.input;
            if (Array.isArray(newInput)) {
              incrementalOptimization = tryComputeIncrementalInput({
                sessionId: codexSessionStoreKey,
                newInput: newInput as Record<string, unknown>[],
                model: modelName,
              });
            }
          }

          // Propagate to outer scope for baseline recording after success
          lastIncrementalOptimization = incrementalOptimization;

          if (incrementalOptimization) {
            // Incremental diff succeeded — send only the new items
            responsesOriginalBody = {
              ...activeBody,
              previous_response_id: incrementalOptimization.previousResponseId,
              input: incrementalOptimization.incrementalInput,
            };
            console.info(
              '[responses] incremental input optimization applied',
              {
                sessionId: codexSessionStoreKey,
                baselineLength: incrementalOptimization.baselineLength,
                savedItems: incrementalOptimization.savedItems,
                newInputLength: incrementalOptimization.incrementalInput.length,
                previousResponseId: incrementalOptimization.previousResponseId,
              },
            );
          } else if (shouldInjectPreviousResponseId) {
            // Fall back to just injecting previous_response_id (tool_output case)
            responsesOriginalBody = withResponsesPreviousResponseId(
              activeBody,
              getCodexSessionResponseId(codexSessionStoreKey)!,
            );
          } else {
            responsesOriginalBody = activeBody;
          }
          const endpointRequest = buildUpstreamEndpointRequest({
            endpoint,
            modelName,
            stream: upstreamStream,
            tokenValue: selected.tokenValue,
            oauthProvider: oauth?.provider,
            oauthProjectId: oauth?.projectId,
            sitePlatform: selected.site.platform,
            siteUrl: siteApiBaseUrl,
            openaiBody: openAiBody,
            downstreamFormat: 'responses',
            responsesOriginalBody,
            downstreamHeaders: request.headers as Record<string, unknown>,
            providerHeaders: buildProviderHeaders(),
            codexExplicitSessionId: codexSessionId || null,
            preserveResponsesPreviousResponseId: !!(
              isCodexSite
              && endpoint === 'responses'
              && isRecord(responsesOriginalBody)
              && typeof responsesOriginalBody.previous_response_id === 'string'
              && responsesOriginalBody.previous_response_id.trim()
              && !(typeof body.previous_response_id === 'string' && body.previous_response_id.trim().length > 0)
            ),
          });
          const upstreamPath = (
            isCompactRequest && endpoint === 'responses'
              ? `${endpointRequest.path}/compact`
              : endpointRequest.path
          );
          const baseRequestBody = (
            isCompactRequest && endpoint === 'responses'
              ? sanitizeCompactResponsesRequestBody(endpointRequest.body as Record<string, unknown>, {
                sitePlatform: selected.site.platform,
              })
              : endpointRequest.body as Record<string, unknown>
          );
          const requestBody = baseRequestBody;
          const sentInputTokensEstimate = isRecord(requestBody)
            ? estimateResponsesInputTokens(requestBody.input)
            : null;
          const strategy: CodexContextTelemetry['contextStrategy'] = isCompactRequest
            ? 'compact'
            : incrementalOptimization
              ? 'incremental'
              : layer1TrimmedInput
                ? 'trim'
                : layer1ContextOverride?.skipPreviousResponseId
                  ? 'fallback_no_previous_response'
                  : 'full';
          updateContextTelemetry({
            contextStrategy: strategy,
            upstreamSentInputTokensEstimate: sentInputTokensEstimate,
            previousResponseIdUsed: isRecord(requestBody) && typeof requestBody.previous_response_id === 'string' && requestBody.previous_response_id.trim().length > 0,
            compactTriggered: isCompactRequest || contextTelemetry.compactTriggered,
            compactAttempted: isCompactRequest || contextTelemetry.compactAttempted,
            compactReason: isCompactRequest ? 'explicit_compact_request' : contextTelemetry.compactReason ?? null,
          });
          const requestHeaders = (
            isCompactRequest && endpoint === 'responses'
              ? ensureCompactResponsesJsonAcceptHeader(endpointRequest.headers, {
                sitePlatform: selected.site.platform,
              })
              : endpointRequest.headers
          );
          return {
            endpoint,
            path: upstreamPath,
            headers: requestHeaders,
            body: requestBody,
            runtime: endpointRequest.runtime,
          };
        };
        const baseDispatchRequest = createSurfaceDispatchRequest({
          site: selected.site,
          siteUrl: siteApiBaseUrl,
          accountExtraConfig: selected.account.extraConfig,
        });
        const codexWsProxyUrl = resolveChannelProxyUrl(selected.site, selected.account.extraConfig);
        const dispatchRequest = async (
          endpointRequest: BuiltEndpointRequest,
          targetUrl?: string,
        ) => {
          const resolveSiblingTargetUrl = (requestPath: string) => {
            if (!targetUrl) return buildUpstreamUrl(siteApiBaseUrl, requestPath);
            if (targetUrl.endsWith(endpointRequest.path)) {
              return `${targetUrl.slice(0, -endpointRequest.path.length)}${requestPath}`;
            }
            return buildUpstreamUrl(siteApiBaseUrl, requestPath);
          };
          const dispatchCodexHttpRequest = (requestToDispatch: BuiltEndpointRequest, requestTargetUrl = targetUrl) => {
            const sessionId = getCodexSessionHeaderValue(requestToDispatch.headers);
            return runCodexHttpSessionTask(
              codexSessionStoreKey || sessionId,
              () => baseDispatchRequest(requestToDispatch, requestTargetUrl),
            );
          };
          if (!isCodexSite || !endpointRequest.path.startsWith('/responses')) {
            return baseDispatchRequest(endpointRequest, targetUrl);
          }
          const softCompactDecision = shouldAttemptSoftContextCompact({
            clientInputTokensEstimate: clientFullInputTokensEstimate,
            sessionUsage: sessionContextUsage,
            softTokens: config.codexContextCompactionSoftTokens,
          });
          if (
            !autoCompactAttemptedThisRequest
            && !isCompactRequest
            && endpointRequest.endpoint === 'responses'
            && endpointRequest.path.endsWith('/responses')
            && config.codexContextCompactionAutoEnabled
            && autoCompactSessionState
            && autoCompactSessionState.attempts < config.codexContextCompactionMaxAttemptsPerSession
            && autoCompactSessionState.turn >= autoCompactSessionState.nextEligibleTurn
            && autoCompactSessionState.unsupportedUntilMs <= Date.now()
            && softCompactDecision.shouldAttempt
            && isRecord(endpointRequest.body)
            && Array.isArray(endpointRequest.body.input)
          ) {
            autoCompactAttemptedThisRequest = true;
            autoCompactSessionState.attempts += 1;
            autoCompactSessionState.nextEligibleTurn = autoCompactSessionState.turn + config.codexContextCompactionCooldownTurns;
            updateContextTelemetry({
              contextStrategy: 'compact',
              compactTriggered: true,
              compactAttempted: true,
              compactReason: softCompactDecision.reason,
            });
            const compactRequest: BuiltEndpointRequest = {
              ...endpointRequest,
              path: `${endpointRequest.path}/compact`,
              headers: ensureCompactResponsesJsonAcceptHeader(endpointRequest.headers, {
                sitePlatform: selected.site.platform,
              }),
              body: sanitizeCompactResponsesRequestBody(endpointRequest.body, {
                sitePlatform: selected.site.platform,
              }),
            };
            try {
              const compactResponse = await dispatchCodexHttpRequest(
                compactRequest,
                resolveSiblingTargetUrl(compactRequest.path),
              );
              const compactText = await readRuntimeResponseText(compactResponse).catch(() => '');
              if (compactResponse.ok) {
                let compactPayload: unknown = compactText;
                try {
                  compactPayload = JSON.parse(compactText);
                } catch {
                  compactPayload = compactText;
                }
                const compactItems = extractCompactOutputItems(compactPayload);
                if (compactItems.length > 0) {
                  const compactedBody = {
                    ...endpointRequest.body,
                    previous_response_id: undefined,
                    input: buildCompactedMainInput(
                      endpointRequest.body.input,
                      compactItems,
                      config.codexContextCompactionTargetTokens,
                    ),
                  };
                  delete compactedBody.previous_response_id;
                  const compactedRequest: BuiltEndpointRequest = {
                    ...endpointRequest,
                    body: compactedBody,
                  };
                  updateContextTelemetry({
                    compactSucceeded: true,
                    upstreamSentInputTokensEstimate: estimateResponsesInputTokens(compactedBody.input),
                    previousResponseIdUsed: false,
                  });
                  clearSessionBaseline(codexSessionStoreKey);
                  clearCodexSessionResponseId(codexSessionStoreKey);
                  return dispatchCodexHttpRequest(compactedRequest);
                }
                updateContextTelemetry({
                  compactSucceeded: false,
                  fallbackReason: 'compact response did not contain reusable output items',
                });
              } else {
                if (shouldFallbackCompactResponsesToResponses({
                  status: compactResponse.status,
                  rawErrText: compactText,
                  requestPath: compactRequest.path,
                })) {
                  autoCompactSessionState.unsupportedUntilMs = Date.now() + config.codexContextCompactionUnsupportedTtlMs;
                }
                updateContextTelemetry({
                  compactSucceeded: false,
                  fallbackReason: `compact preflight failed with HTTP ${compactResponse.status}`,
                });
              }
            } catch (error: any) {
              updateContextTelemetry({
                compactSucceeded: false,
                fallbackReason: error?.message || 'compact preflight failed',
              });
            }
          }
          if (config.codexUpstreamWebsocketEnabled && !websocketHttpFallbackRequest && !isCompactRequest) {
            return dispatchCodexWebsocketRequest(
              endpointRequest,
              targetUrl,
              siteApiBaseUrl,
              isStream || forceResponsesUpstreamStream,
              codexSessionStoreKey || codexSessionId || '',
              codexWsProxyUrl,
            ) as unknown as ReturnType<typeof baseDispatchRequest>;
          }
          return dispatchCodexHttpRequest(endpointRequest);
        };
        const endpointStrategy = openAiResponsesTransformer.compatibility.createEndpointStrategy({
          isStream: isStream || forceResponsesUpstreamStream,
          requiresNativeResponsesFileUrl,
          sitePlatform: selected.site.platform,
          dispatchRequest,
        });
        const tryRecover = async (ctx: Parameters<NonNullable<typeof endpointStrategy.tryRecover>>[0]) => {
          if (oauth && shouldRefreshOauthResponsesRequest({
            oauthProvider: oauth.provider,
            status: ctx.response.status,
            response: ctx.response,
            rawErrText: ctx.rawErrText || '',
          })) {
            const recovered = await trySurfaceOauthRefreshRecovery({
              ctx,
              selected,
              siteUrl: siteApiBaseUrl,
              buildRequest: (endpoint) => buildEndpointRequest(endpoint),
              dispatchRequest,
            });
            if (recovered?.upstream?.ok) {
              return recovered;
            }
          }
          // ── Layer 3: Context window exceeded recovery ─────────────────
          // When the upstream returns a context_length_exceeded error, we must:
          //   1. Clear the session response ID (the failed response is not chainable)
          //   2. Strip previous_response_id if present
          //   3. Trim the input array to fit within context budget (Layer 4)
          //   4. Retry once with the trimmed request
          // This mirrors Codex native: ContextWindowExceeded is a fatal error
          // that requires session state cleanup.
          if (
            ctx.request.endpoint === 'responses'
            && isContextWindowExceededRetryPolicy(ctx.rawErrText)
          ) {
            console.warn(
              '[responses] context window exceeded — clearing session and trimming input',
              {
                model: selected.actualModel || requestedModel || '',
                platform: selected.site.platform || '',
                sessionId: codexSessionStoreKey || '',
              },
            );
            // Step 1: Clear the failed response ID so it won't be used for chaining
            if (codexSessionStoreKey) {
              clearCodexSessionResponseId(codexSessionStoreKey);
              clearSessionTokenUsage(codexSessionStoreKey);
              clearSessionBaseline(codexSessionStoreKey);
              clearLayer1TrimmedSession(codexSessionStoreKey);
            }
            // Step 2: Strip previous_response_id — the referenced response was
            // either never created (context overflow) or is unusable
            const contextOverflowRecovery = stripResponsesPreviousResponseId(ctx.request.body);
            let recoveredBody = contextOverflowRecovery.body;
            // Step 3: Trim input array to fit within model's context window (Layer 4)
            if (isRecord(recoveredBody) && Array.isArray(recoveredBody.input)) {
              const contextWindow = getModelContextWindow(modelName);
              const targetTokens = Math.trunc(contextWindow * config.contextWindowGuardTrimTargetPercent / 100);
              const trimResult = trimResponsesInputToTokenBudget(
                recoveredBody,
                targetTokens,
                contextWindow, // Use full context window as current estimate (we don't know exact tokens)
              );
              if (trimResult.itemsRemoved > 0) {
                console.warn(
                  '[responses] trimmed input array for context recovery',
                  {
                    itemsRemoved: trimResult.itemsRemoved,
                    targetTokens,
                    contextWindow,
                  },
                );
                recoveredBody = trimResult.body;
              }
            }
            // Step 4: Retry once with the cleaned-up request
            if (contextOverflowRecovery.removed || recoveredBody !== ctx.request.body) {
              const recoveredRequest = {
                ...ctx.request,
                body: recoveredBody,
              };
              const recoveredResponse = await dispatchRequest(recoveredRequest, ctx.targetUrl);
              if (recoveredResponse.ok) {
                return {
                  upstream: recoveredResponse,
                  upstreamPath: recoveredRequest.path,
                  request: recoveredRequest,
                  targetUrl: ctx.targetUrl,
                };
              }
              ctx.request = recoveredRequest;
              ctx.response = recoveredResponse;
              ctx.rawErrText = await readRuntimeResponseText(recoveredResponse).catch(() => 'unknown error');
              // If the retry also failed with context overflow, give up — don't loop
              if (isContextWindowExceededRetryPolicy(ctx.rawErrText)) {
                console.warn('[responses] context recovery retry also exceeded context — giving up');
              }
            }
            // Fall through to other recovery strategies or final failure
          }
          // ── Previous response not found recovery (existing logic) ───────
          if (
            ctx.request.endpoint === 'responses'
            && isResponsesPreviousResponseNotFoundError({
              rawErrText: ctx.rawErrText,
            })
          ) {
            if (codexSessionStoreKey) {
              clearCodexSessionResponseId(codexSessionStoreKey);
              clearSessionTokenUsage(codexSessionStoreKey);
              clearSessionBaseline(codexSessionStoreKey);
              clearLayer1TrimmedSession(codexSessionStoreKey);
            }
            const previousResponseRecovery = stripResponsesPreviousResponseId(ctx.request.body);
            if (
              config.responsesStrictPreviousResponseRecovery
              && !previousResponseRecovery.removed
            ) {
              throw buildResponsesContinuationRecoveryError({
                reason: 'missing_previous_response_id_on_recovery',
              });
            }
            if (previousResponseRecovery.removed) {
              const hasReplayableContext = hasReplayableResponsesContinuationContext(previousResponseRecovery.body);
              if (config.responsesStrictPreviousResponseRecovery && !hasReplayableContext) {
                throw buildResponsesContinuationRecoveryError({
                  reason: 'tool_output_only_without_replay_context',
                });
              }
              // Layer 4 enhancement: also trim input when recovering from
              // previous_response_not_found, since the root cause may be
              // context overflow that caused the original response to fail
              let recoveredBody = previousResponseRecovery.body;
              if (isRecord(recoveredBody) && Array.isArray(recoveredBody.input)) {
                const contextWindow = getModelContextWindow(modelName);
                const targetTokens = Math.trunc(contextWindow * config.contextWindowGuardTrimTargetPercent / 100);
                const trimResult = trimResponsesInputToTokenBudget(
                  recoveredBody,
                  targetTokens,
                  contextWindow,
                );
                if (trimResult.itemsRemoved > 0) {
                  console.warn(
                    '[responses] trimmed input during previous_response_not_found recovery',
                    { itemsRemoved: trimResult.itemsRemoved },
                  );
                  recoveredBody = trimResult.body;
                }
              }
              const recoveredRequest = {
                ...ctx.request,
                body: recoveredBody,
              };
              const recoveredResponse = await dispatchRequest(recoveredRequest, ctx.targetUrl);
              if (recoveredResponse.ok) {
                return {
                  upstream: recoveredResponse,
                  upstreamPath: recoveredRequest.path,
                  request: recoveredRequest,
                  targetUrl: ctx.targetUrl,
                };
              }
              ctx.request = recoveredRequest;
              ctx.response = recoveredResponse;
              ctx.rawErrText = await readRuntimeResponseText(recoveredResponse).catch(() => 'unknown error');
            }
          }
          // ── Tool call mismatch recovery ────────────────────────────
          // "No tool call found" or "No tool output found" — session state
          // is inconsistent. Clear session and strip previous_response_id.
          if (
            ctx.request.endpoint === 'responses'
            && isResponsesToolCallMismatchError({
              rawErrText: ctx.rawErrText,
            })
          ) {
            if (codexSessionStoreKey) {
              clearCodexSessionResponseId(codexSessionStoreKey);
              clearSessionTokenUsage(codexSessionStoreKey);
              clearSessionBaseline(codexSessionStoreKey);
              clearLayer1TrimmedSession(codexSessionStoreKey);
            }
            const toolCallRecovery = stripResponsesPreviousResponseId(ctx.request.body);
            if (toolCallRecovery.removed) {
              const recoveredRequest = {
                ...ctx.request,
                body: toolCallRecovery.body,
              };
              const recoveredResponse = await dispatchRequest(recoveredRequest, ctx.targetUrl);
              if (recoveredResponse.ok) {
                return {
                  upstream: recoveredResponse,
                  upstreamPath: recoveredRequest.path,
                  request: recoveredRequest,
                  targetUrl: ctx.targetUrl,
                };
              }
              ctx.request = recoveredRequest;
              ctx.response = recoveredResponse;
              ctx.rawErrText = await readRuntimeResponseText(recoveredResponse).catch(() => 'unknown error');
            }
          }
          const compactFallbackEnabled = config.responsesCompactFallbackToResponsesEnabled;
          if (
            isCompactRequest
            && compactFallbackEnabled
            && ctx.request.endpoint === 'responses'
            && ctx.request.path.endsWith('/responses/compact')
            && shouldFallbackCompactResponsesToResponses({
              status: ctx.response.status,
              rawErrText: ctx.rawErrText,
              requestPath: ctx.request.path,
            })
          ) {
            const normalizedSitePlatform = String(selected.site.platform || '').trim().toLowerCase();
            const recoveredUpstreamStream = shouldForceResponsesUpstreamStream({
              sitePlatform: selected.site.platform,
              isCompactRequest: false,
            });
            const recoveredHeaders = { ...ctx.request.headers } as Record<string, string>;
            delete (recoveredHeaders as Record<string, unknown>).Accept;
            if (recoveredUpstreamStream) {
              recoveredHeaders.accept = 'text/event-stream';
            }
            const recoveredBody = isRecord(ctx.request.body)
              ? { ...ctx.request.body }
              : ctx.request.body;
            if (isRecord(recoveredBody)) {
              if (recoveredUpstreamStream) {
                recoveredBody.stream = true;
              }
              if (normalizedSitePlatform === 'codex' || normalizedSitePlatform === 'sub2api') {
                recoveredBody.store = false;
              }
            }
            const recoveredRequest = {
              ...ctx.request,
              path: ctx.request.path.replace(/\/compact$/, ''),
              headers: recoveredHeaders,
              body: recoveredBody,
            };
            const recoveredResponse = await dispatchRequest(recoveredRequest);
            if (recoveredResponse.ok) {
              return {
                upstream: recoveredResponse,
                upstreamPath: recoveredRequest.path,
                request: recoveredRequest,
              };
            }
            ctx.request = recoveredRequest;
            ctx.response = recoveredResponse;
            ctx.rawErrText = await readRuntimeResponseText(recoveredResponse).catch(() => 'unknown error');
          }

          const unsupportedParameter = extractUnsupportedParameterName(ctx.rawErrText);
          if (
            unsupportedParameter
            && isRecord(ctx.request.body)
          ) {
            const recoveredBody = dropUnsupportedParameterFromBody(ctx.request.body, unsupportedParameter);
            if (recoveredBody) {
              console.warn(
                '[responses] removed unsupported upstream parameter and retried once',
                {
                  model: selected.actualModel || requestedModel || '',
                  platform: selected.site.platform || '',
                  parameter: unsupportedParameter,
                  endpoint: ctx.request.path,
                },
              );
              const recoveredRequest = {
                ...ctx.request,
                body: recoveredBody,
              };
              const recoveredResponse = await dispatchRequest(recoveredRequest, ctx.targetUrl);
              if (recoveredResponse.ok) {
                return {
                  upstream: recoveredResponse,
                  upstreamPath: recoveredRequest.path,
                  request: recoveredRequest,
                  targetUrl: ctx.targetUrl,
                };
              }
              ctx.request = recoveredRequest;
              ctx.response = recoveredResponse;
              ctx.rawErrText = await readRuntimeResponseText(recoveredResponse).catch(() => 'unknown error');
            }
          }
          return endpointStrategy.tryRecover(ctx);
        };

        const debugAttemptBase = reserveSurfaceProxyDebugAttemptBase(debugTrace, endpointCandidates.length);
        return executeEndpointFlow({
          siteUrl: siteApiBaseUrl,
          disableCrossProtocolFallback: isCompactRequest || config.disableCrossProtocolFallback,
          firstByteTimeoutMs: Math.max(0, Math.trunc((config.proxyFirstByteTimeoutSec || 0) * 1000)),
          endpointCandidates,
          buildRequest: (endpoint) => buildEndpointRequest(endpoint),
          dispatchRequest,
          tryRecover,
          shouldAbortRemainingEndpoints: (ctx) => shouldAbortSameSiteEndpointFallback(
            ctx.response.status,
            ctx.rawErrText || ctx.errText,
          ),
          onAttemptFailure: async (ctx) => {
            const memoryWrite = isCompactRequest
              ? null
              : recordUpstreamEndpointFailure({
                ...endpointRuntimeContext,
                endpoint: ctx.request.endpoint,
                status: ctx.response.status,
                errorText: ctx.rawErrText,
              });
            await safeInsertSurfaceProxyDebugAttempt(debugTrace, {
              attemptIndex: debugAttemptBase + ctx.endpointIndex,
              endpoint: ctx.request.endpoint,
              requestPath: ctx.request.path,
              targetUrl: ctx.targetUrl,
              runtimeExecutor: ctx.request.runtime?.executor || 'default',
              requestHeaders: ctx.request.headers,
              requestBody: ctx.request.body,
              responseStatus: ctx.response.status,
              responseHeaders: buildSurfaceProxyDebugResponseHeaders(ctx.response),
              responseBody: parseSurfaceProxyDebugTextPayload(ctx.rawErrText),
              rawErrorText: ctx.rawErrText,
              recoverApplied: ctx.recoverApplied === true,
              downgradeDecision: false,
              downgradeReason: null,
              memoryWrite,
            });
          },
          onAttemptSuccess: async (ctx) => {
            const memoryWrite = isCompactRequest
              ? null
              : recordUpstreamEndpointSuccess({
                ...endpointRuntimeContext,
                endpoint: ctx.request.endpoint,
              });
            const responseBody = await captureSurfaceProxyDebugSuccessResponseBody(debugTrace, ctx);
            await safeInsertSurfaceProxyDebugAttempt(debugTrace, {
              attemptIndex: debugAttemptBase + ctx.endpointIndex,
              endpoint: ctx.request.endpoint,
              requestPath: ctx.request.path,
              targetUrl: ctx.targetUrl,
              runtimeExecutor: ctx.request.runtime?.executor || 'default',
              requestHeaders: ctx.request.headers,
              requestBody: ctx.request.body,
              responseStatus: ctx.response.status,
              responseHeaders: buildSurfaceProxyDebugResponseHeaders(ctx.response),
              responseBody,
              rawErrorText: null,
              recoverApplied: ctx.recoverApplied === true,
              downgradeDecision: false,
              downgradeReason: null,
              memoryWrite,
            });
          },
          shouldDowngrade: endpointStrategy.shouldDowngrade,
          onDowngrade: async (ctx) => {
            promoteRequiredEndpointCandidateAfterProtocolError(endpointCandidates, {
              currentEndpoint: ctx.request.endpoint,
              upstreamErrorText: ctx.rawErrText,
            });
            await safeUpdateSurfaceProxyDebugAttempt(debugTrace, debugAttemptBase + ctx.endpointIndex, {
              downgradeDecision: true,
              downgradeReason: ctx.errText,
              rawErrorText: ctx.rawErrText,
            });
            return failureToolkit.log({
              selected,
              modelRequested: requestedModel,
              status: 'failed',
              httpStatus: ctx.response.status,
              latencyMs: Date.now() - startTime,
              errorMessage: ctx.errText,
              retryCount,
              contextTelemetry,
            });
          },
        });
      };

      const startTime = Date.now();
      const leaseResult = await acquireSurfaceChannelLease({
        stickySessionKey,
        selected,
      });
      if (leaseResult.status === 'timeout') {
        clearSurfaceStickyChannel({
          stickySessionKey,
          selected,
        });
      const busyMessage = buildSurfaceChannelBusyMessage(leaseResult.waitMs);
      await failureToolkit.log({
        selected,
        modelRequested: requestedModel,
        status: 'failed',
        httpStatus: 503,
        latencyMs: leaseResult.waitMs,
        errorMessage: busyMessage,
        retryCount,
        contextTelemetry,
      });
      if (retryCount < maxRetries && canRetryChannelSelection(retryCount, forcedChannelId)) {
        retryCount += 1;
        continue;
      }
        await finalizeDebugFailure(503, {
          error: {
            message: busyMessage,
            type: 'server_error',
          },
        });
        return reply.code(503).send({
          error: {
            message: busyMessage,
            type: 'server_error',
          },
        });
      }
      const channelLease = leaseResult.lease;

      try {
        const endpointResult = await runWithSiteApiEndpointPool(selected.site, async (target) => {
          const result = await executeEndpointResultForSiteApiBaseUrl(target.baseUrl);
          if (!result.ok) {
            const upstreamFailure = new SiteApiEndpointRequestError(result.errText || 'unknown error', {
              status: result.status || 502,
              rawErrText: result.rawErrText || result.errText || 'unknown error',
            }) as SiteApiEndpointRequestError & { siteApiEndpointUpstreamFailure?: boolean };
            upstreamFailure.siteApiEndpointUpstreamFailure = true;
            throw upstreamFailure;
          }
          return result;
        });

        const upstream = endpointResult.upstream;
        const successfulUpstreamPath = endpointResult.upstreamPath;
        const firstByteLatencyMs = getObservedResponseMeta(upstream)?.firstByteLatencyMs ?? null;
        const finalizeStreamSuccess = async (
          parsedUsage: UsageSummary,
          latency: number,
          streamDebugBody: unknown,
          upstreamUsagePresent: boolean,
          terminalPayload: unknown | null = null,
        ) => {
          try {
            updateContextTelemetry({
              upstreamPromptTokens: parsedUsage.promptTokens,
              compactSucceeded: isCompactRequest ? true : contextTelemetry.compactSucceeded ?? false,
            });
            await recordSurfaceSuccess({
              selected,
              requestedModel,
              modelName,
              parsedUsage,
              upstreamUsagePresent,
              upstreamHeaders: upstream.headers,
              requestStartedAtMs: startTime,
              isStream: true,
              firstByteLatencyMs,
              latencyMs: latency,
              retryCount,
              upstreamPath: successfulUpstreamPath,
              contextTelemetry,
              logSuccess: failureToolkit.log,
              recordDownstreamCost: (estimatedCost) => {
                recordDownstreamCostUsage(request, estimatedCost);
              },
              bestEffortMetrics: {
                errorLabel: '[responses] post-stream bookkeeping failed:',
              },
            });
            // Track token usage for context window guard (Layer 1 & 2)
            if (codexSessionStoreKey) {
              recordSessionTokenUsage({
                sessionId: codexSessionStoreKey,
                promptTokens: parsedUsage.promptTokens,
                completionTokens: parsedUsage.completionTokens,
                totalTokens: parsedUsage.totalTokens,
                responseId: null, // Stream: response ID is captured by safeRememberCodexSessionResponseId
                succeeded: true,
              });
              recordCodexSessionBaselineFromPayload({
                sessionId: codexSessionStoreKey,
                requestInput: Array.isArray(normalizedResponsesBody.input)
                  ? normalizedResponsesBody.input as Record<string, unknown>[]
                  : null,
                payload: terminalPayload,
                model: modelName,
              });
            }
          } catch (error) {
            console.error('[responses] post-stream success logging failed:', error);
          }
          await finalizeDebugSuccess(
            200,
            successfulUpstreamPath,
            buildSurfaceProxyDebugResponseHeaders(upstream),
            streamDebugBody,
          );
        };

        if (isStream) {
          const upstreamContentType = (upstream.headers.get('content-type') || '').toLowerCase();
          const startSseResponse = () => {
            reply.hijack();
            reply.raw.statusCode = 200;
            reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
            reply.raw.setHeader('Connection', 'keep-alive');
            reply.raw.setHeader('X-Accel-Buffering', 'no');
          };

          let parsedUsage: UsageSummary = {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            promptTokensIncludeCache: null,
          };
          let upstreamUsagePresent = false;
          const writeLines = (lines: string[]) => {
            for (const line of lines) reply.raw.write(line);
          };
          const websocketTransportRequest = isResponsesWebsocketTransportRequest(request.headers as Record<string, unknown>);
          const streamSession = openAiResponsesTransformer.proxyStream.createSession({
            modelName,
            successfulUpstreamPath,
            getUsage: () => parsedUsage,
            onParsedPayload: (payload) => {
              if (payload && typeof payload === 'object') {
                upstreamUsagePresent = upstreamUsagePresent || hasProxyUsagePayload(payload);
                parsedUsage = mergeProxyUsage(parsedUsage, parseProxyUsage(payload));
                if (codexSessionStoreKey) {
                  safeRememberCodexSessionResponseId(codexSessionStoreKey, payload);
                }
              }
            },
            writeLines,
            writeRaw: (chunk) => {
              reply.raw.write(chunk);
            },
          });
          if (!upstreamContentType.includes('text/event-stream')) {
            const rawText = await readRuntimeResponseText(upstream);
            if (looksLikeResponsesSseText(rawText)) {
              startSseResponse();
              const streamResult = await streamSession.run(
                createSingleChunkStreamReader(rawText),
                reply.raw,
              );
              const latency = Date.now() - startTime;
	              if (streamResult.status === 'failed') {
                const streamErrorMessage = streamResult.errorMessage || 'stream processing failed';
                if (isClientContinuationFailure(streamErrorMessage)) {
                  // Client continuation errors are not channel failures
                  handleContinuationFailureSessionCleanup(streamErrorMessage, codexSessionStoreKey);
                  // do NOT clear sticky session or record channel failure.
                  await failureToolkit.log({
                    selected,
                    modelRequested: requestedModel,
                    status: 'failed',
                    httpStatus: 200,
                    isStream: true,
                    latencyMs: latency,
                    errorMessage: streamErrorMessage,
                    retryCount,
                    promptTokens: parsedUsage.promptTokens,
                    completionTokens: parsedUsage.completionTokens,
                    totalTokens: parsedUsage.totalTokens,
                    upstreamPath: successfulUpstreamPath,
                    contextTelemetry,
                  });
                  await finalizeDebugFailure(502, {
                    error: { message: streamErrorMessage, type: 'stream_error' },
                  }, successfulUpstreamPath);
                  return;
                }
	                clearSurfaceStickyChannel({
	                  stickySessionKey,
	                  selected,
	                });
              await failureToolkit.recordStreamFailure({
	                  selected,
	                  requestedModel,
                  modelName,
                  errorMessage: streamErrorMessage,
                  latencyMs: latency,
                  retryCount,
                  promptTokens: parsedUsage.promptTokens,
                  completionTokens: parsedUsage.completionTokens,
                  totalTokens: parsedUsage.totalTokens,
                  upstreamPath: successfulUpstreamPath,
                  contextTelemetry,
                });
                await finalizeDebugFailure(502, {
                  error: {
                    message: streamErrorMessage,
                    type: 'stream_error',
                  },
                }, successfulUpstreamPath);
                return;
	              }

                await finalizeStreamSuccess(
                  parsedUsage,
                  latency,
                  debugTrace?.options.captureStreamChunks ? rawText : { stream: true, usage: parsedUsage },
                  upstreamUsagePresent,
                  streamResult.terminalPayload,
                );
	              bindSurfaceStickyChannel({
	                stickySessionKey,
	                selected,
	              });
	              return;
	            }
            let upstreamData: unknown = rawText;
            try {
              upstreamData = JSON.parse(rawText);
            } catch {
              upstreamData = rawText;
            }
            if (String(selected.site.platform || '').trim().toLowerCase() === 'gemini-cli') {
              upstreamData = unwrapGeminiCliPayload(upstreamData);
            }
            if (codexSessionStoreKey) {
              safeRememberCodexSessionResponseId(codexSessionStoreKey, upstreamData);
            }

            parsedUsage = parseProxyUsage(upstreamData);
            upstreamUsagePresent = upstreamUsagePresent || hasProxyUsagePayload(upstreamData);
            const latency = Date.now() - startTime;
            const failure = detectProxyFailure({ rawText, usage: parsedUsage });
	            if (failure) {
              if (isClientContinuationFailure(rawText)) {
                // Client continuation errors are not channel failures
                  handleContinuationFailureSessionCleanup(rawText, codexSessionStoreKey);
                // do NOT clear sticky session, record failure, or cross-channel retry.
                await failureToolkit.log({
                  selected,
                  modelRequested: requestedModel,
                  status: 'failed',
                  httpStatus: 200,
                  isStream: true,
                  latencyMs: latency,
                  errorMessage: failure.reason,
                  retryCount,
                  promptTokens: parsedUsage.promptTokens,
                  completionTokens: parsedUsage.completionTokens,
                  totalTokens: parsedUsage.totalTokens,
                  upstreamPath: successfulUpstreamPath,
                  contextTelemetry,
                });
                await finalizeDebugFailure(
                  failure.status,
                  { error: { message: failure.reason, type: 'upstream_error' } },
                  successfulUpstreamPath,
                );
                return reply.code(failure.status).send({
                  error: { message: failure.reason, type: 'upstream_error' },
                });
              }
	              clearSurfaceStickyChannel({
	                stickySessionKey,
	                selected,
	              });
	              const failureOutcome = await failureToolkit.handleDetectedFailure({
	                selected,
	                requestedModel,
	                modelName,
                failure,
                latencyMs: latency,
                retryCount,
                promptTokens: parsedUsage.promptTokens,
                completionTokens: parsedUsage.completionTokens,
                totalTokens: parsedUsage.totalTokens,
                upstreamPath: successfulUpstreamPath,
	              });
	              const terminalFailureOutcome = failureOutcome.action === 'retry'
	                ? (canRetryChannelSelection(retryCount, forcedChannelId)
	                  ? null
	                  : finalizeRetryAsUpstreamFailure(failure.status, failure.reason))
	                : failureOutcome;
	              if (!terminalFailureOutcome) {
	                retryCount += 1;
	                continue;
	              }
	              await finalizeDebugFailure(
	                terminalFailureOutcome.status,
	                terminalFailureOutcome.payload,
	                successfulUpstreamPath,
	              );
	              return reply.code(terminalFailureOutcome.status).send(terminalFailureOutcome.payload);
            }

            startSseResponse();
            const streamResult = streamSession.consumeUpstreamFinalPayload(upstreamData, rawText, reply.raw);
	            if (streamResult.status === 'failed') {
              const streamErrorMessage = streamResult.errorMessage || 'stream processing failed';
              if (isClientContinuationFailure(streamErrorMessage)) {
                handleContinuationFailureSessionCleanup(streamErrorMessage, codexSessionStoreKey);
                await failureToolkit.log({
                  selected,
                  modelRequested: requestedModel,
                  status: 'failed',
                  httpStatus: 200,
                  isStream: true,
                  latencyMs: latency,
                  errorMessage: streamErrorMessage,
                  retryCount,
                  promptTokens: parsedUsage.promptTokens,
                  completionTokens: parsedUsage.completionTokens,
                  totalTokens: parsedUsage.totalTokens,
                  upstreamPath: successfulUpstreamPath,
                  contextTelemetry,
                });
                await finalizeDebugFailure(502, {
                  error: { message: streamErrorMessage, type: 'stream_error' },
                }, successfulUpstreamPath);
                return;
              }
	              clearSurfaceStickyChannel({
	                stickySessionKey,
	                selected,
	              });
              await failureToolkit.recordStreamFailure({
	                selected,
	                requestedModel,
                modelName,
                errorMessage: streamErrorMessage,
                latencyMs: latency,
                retryCount,
                promptTokens: parsedUsage.promptTokens,
                completionTokens: parsedUsage.completionTokens,
                totalTokens: parsedUsage.totalTokens,
                upstreamPath: successfulUpstreamPath,
                runtimeFailureStatus: 502,
              });
              await finalizeDebugFailure(502, {
                error: {
                  message: streamErrorMessage,
                  type: 'stream_error',
                },
              }, successfulUpstreamPath);
              return;
	            }

            await finalizeStreamSuccess(
                parsedUsage,
                latency,
                debugTrace?.options.captureStreamChunks ? rawText : upstreamData,
                upstreamUsagePresent,
                streamResult.terminalPayload,
              );
	            bindSurfaceStickyChannel({
	              stickySessionKey,
	              selected,
	            });
	            return;
	          }

          startSseResponse();

          let replayReader: ReturnType<typeof createSingleChunkStreamReader> | null = null;
          if (websocketTransportRequest) {
            const rawText = await readRuntimeResponseText(upstream);
            if (looksLikeResponsesSseText(rawText)) {
              try {
                const collectedPayload = collectResponsesFinalPayloadFromSseText(rawText, modelName).payload;
                upstreamUsagePresent = upstreamUsagePresent || hasProxyUsagePayload(collectedPayload);
                parsedUsage = mergeProxyUsage(parsedUsage, parseProxyUsage(collectedPayload));
                const createdPayload = {
                  ...collectedPayload,
                  status: 'in_progress',
                  output: [],
                  output_text: '',
                };
                const terminalEventType = String(collectedPayload.status || '').trim().toLowerCase() === 'incomplete'
                  ? 'response.incomplete'
                  : 'response.completed';
                writeLines([
                  `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: createdPayload })}\n\n`,
                  `event: ${terminalEventType}\ndata: ${JSON.stringify({ type: terminalEventType, response: collectedPayload })}\n\n`,
                  'data: [DONE]\n\n',
                ]);
                if (codexSessionStoreKey) {
                  safeRememberCodexSessionResponseId(codexSessionStoreKey, collectedPayload);
                }
                reply.raw.end();
                const latency = Date.now() - startTime;
                await finalizeStreamSuccess(
                  parsedUsage,
                  latency,
                  debugTrace?.options.captureStreamChunks ? rawText : collectedPayload,
                  upstreamUsagePresent,
                  collectedPayload,
                );
                bindSurfaceStickyChannel({
                  stickySessionKey,
                  selected,
                });
                return;
              } catch {
                // Fall through to the generic stream session for response.failed/error terminals.
              }

              const streamResult = await streamSession.run(
                createSingleChunkStreamReader(rawText),
                reply.raw,
              );
              const latency = Date.now() - startTime;
              if (streamResult.status === 'failed') {
                const streamErrorMessage = streamResult.errorMessage || 'stream processing failed';
                if (isClientContinuationFailure(streamErrorMessage)) {
                  handleContinuationFailureSessionCleanup(streamErrorMessage, codexSessionStoreKey);
                await failureToolkit.log({
                    selected,
                    modelRequested: requestedModel,
                    status: 'failed',
                    httpStatus: 200,
                    isStream: true,
                    latencyMs: latency,
                    errorMessage: streamErrorMessage,
                    retryCount,
                    promptTokens: parsedUsage.promptTokens,
                    completionTokens: parsedUsage.completionTokens,
                    totalTokens: parsedUsage.totalTokens,
                    upstreamPath: successfulUpstreamPath,
                    contextTelemetry,
                  });
                  await finalizeDebugFailure(502, {
                    error: { message: streamErrorMessage, type: 'stream_error' },
                  }, successfulUpstreamPath);
                  return;
                }
                await failureToolkit.recordStreamFailure({
                  selected,
                  requestedModel,
                  modelName,
                  errorMessage: streamErrorMessage,
                  latencyMs: latency,
                  retryCount,
                  promptTokens: parsedUsage.promptTokens,
                  completionTokens: parsedUsage.completionTokens,
                  totalTokens: parsedUsage.totalTokens,
                  upstreamPath: successfulUpstreamPath,
                  runtimeFailureStatus: 502,
                });
                await finalizeDebugFailure(502, {
                  error: {
                    message: streamErrorMessage,
                    type: 'stream_error',
                  },
                }, successfulUpstreamPath);
                return;
              }

              await finalizeStreamSuccess(
                parsedUsage,
                latency,
                debugTrace?.options.captureStreamChunks ? rawText : { stream: true, usage: parsedUsage },
                upstreamUsagePresent,
                streamResult.terminalPayload,
              );
              return;
            }

            replayReader = createSingleChunkStreamReader(rawText);
          }

          const upstreamReader = replayReader ?? getRuntimeResponseReader(upstream);
          const baseReader = String(selected.site.platform || '').trim().toLowerCase() === 'gemini-cli' && upstreamReader
            ? createGeminiCliStreamReader(upstreamReader)
            : upstreamReader;
          let rawText = '';
          const decoder = new TextDecoder();
          const reader = baseReader
            ? {
              async read() {
                const result = await baseReader.read();
                if (result.value) {
                  rawText += decoder.decode(result.value, { stream: true });
                }
                return result;
              },
              async cancel(reason?: unknown) {
                return baseReader.cancel(reason);
              },
              releaseLock() {
                return baseReader.releaseLock();
              },
            }
            : baseReader;
          const streamResult = await streamSession.run(reader, reply.raw);
          rawText += decoder.decode();

          const latency = Date.now() - startTime;
	          if (streamResult.status === 'failed') {
            const streamErrorMessage = streamResult.errorMessage || 'stream processing failed';
            if (isClientContinuationFailure(streamErrorMessage)) {
              handleContinuationFailureSessionCleanup(streamErrorMessage, codexSessionStoreKey);
                await failureToolkit.log({
                selected,
                modelRequested: requestedModel,
                status: 'failed',
                httpStatus: 200,
                isStream: true,
                latencyMs: latency,
                errorMessage: streamErrorMessage,
                retryCount,
                promptTokens: parsedUsage.promptTokens,
                completionTokens: parsedUsage.completionTokens,
                totalTokens: parsedUsage.totalTokens,
                upstreamPath: successfulUpstreamPath,
                contextTelemetry,
              });
              await finalizeDebugFailure(502, {
                error: { message: streamErrorMessage, type: 'stream_error' },
              }, successfulUpstreamPath);
              return;
            }
	            clearSurfaceStickyChannel({
	              stickySessionKey,
	              selected,
	            });
	            await failureToolkit.recordStreamFailure({
	              selected,
	              requestedModel,
              modelName,
              errorMessage: streamErrorMessage,
              latencyMs: latency,
              retryCount,
              promptTokens: parsedUsage.promptTokens,
              completionTokens: parsedUsage.completionTokens,
              totalTokens: parsedUsage.totalTokens,
              upstreamPath: successfulUpstreamPath,
              runtimeFailureStatus: 502,
              contextTelemetry,
            });
            await finalizeDebugFailure(502, {
              error: {
                message: streamErrorMessage,
                type: 'stream_error',
              },
            }, successfulUpstreamPath);
            return;
          }

          // Once SSE has been hijacked and bytes may already be on the wire, we
          // must not attempt to convert stream failures into a fresh HTTP error
          // response or retry on another channel. Responses stream failures are
	          // handled in-band by the proxy stream session.

          await finalizeStreamSuccess(
              parsedUsage,
              latency,
              debugTrace?.options.captureStreamChunks ? rawText : { stream: true, usage: parsedUsage },
              upstreamUsagePresent,
              streamResult.terminalPayload,
            );
	          bindSurfaceStickyChannel({
	            stickySessionKey,
	            selected,
	          });
	          return;
	        }

        const upstreamContentType = (upstream.headers.get('content-type') || '').toLowerCase();
        let rawText = '';
        let upstreamData: unknown;
        if (
          upstreamContentType.includes('text/event-stream')
          && (
            successfulUpstreamPath.endsWith('/responses')
            || successfulUpstreamPath.endsWith('/responses/compact')
          )
        ) {
          const collected = await collectResponsesFinalPayloadFromSse(upstream, modelName);
          rawText = collected.rawText;
          upstreamData = collected.payload;
        } else {
          rawText = await readRuntimeResponseText(upstream);
          if (looksLikeResponsesSseText(rawText)) {
            upstreamData = collectResponsesFinalPayloadFromSseText(rawText, modelName).payload;
          } else {
            upstreamData = rawText;
            try {
              upstreamData = JSON.parse(rawText);
            } catch {
              upstreamData = rawText;
            }
          }
        }
        if (String(selected.site.platform || '').trim().toLowerCase() === 'gemini-cli') {
          upstreamData = unwrapGeminiCliPayload(upstreamData);
        }
        if (codexSessionStoreKey) {
          safeRememberCodexSessionResponseId(codexSessionStoreKey, upstreamData);
        }
        const latency = Date.now() - startTime;
        const parsedUsage = parseProxyUsage(upstreamData);
        const upstreamUsagePresent = hasProxyUsagePayload(upstreamData);
        const failure = detectProxyFailure({ rawText, usage: parsedUsage });
	        if (failure) {
          if (isClientContinuationFailure(rawText)) {
            // Client continuation errors are not channel failures
                  handleContinuationFailureSessionCleanup(rawText, codexSessionStoreKey);
            // do NOT clear sticky session, record failure, or cross-channel retry.
            await failureToolkit.log({
              selected,
              modelRequested: requestedModel,
              status: 'failed',
              httpStatus: 200,
              isStream: false,
              latencyMs: latency,
              errorMessage: failure.reason,
              retryCount,
              promptTokens: parsedUsage.promptTokens,
              completionTokens: parsedUsage.completionTokens,
              totalTokens: parsedUsage.totalTokens,
              upstreamPath: successfulUpstreamPath,
            });
            await finalizeDebugFailure(
              failure.status,
              { error: { message: failure.reason, type: 'upstream_error' } },
              successfulUpstreamPath,
            );
            return reply.code(failure.status).send({
              error: { message: failure.reason, type: 'upstream_error' },
            });
          }
	          clearSurfaceStickyChannel({
	            stickySessionKey,
	            selected,
	          });
	          const failureOutcome = await failureToolkit.handleDetectedFailure({
	            selected,
	            requestedModel,
	            modelName,
            failure,
            latencyMs: latency,
            retryCount,
            promptTokens: parsedUsage.promptTokens,
            completionTokens: parsedUsage.completionTokens,
            totalTokens: parsedUsage.totalTokens,
            upstreamPath: successfulUpstreamPath,
	          });
	          const terminalFailureOutcome = failureOutcome.action === 'retry'
	            ? (canRetryChannelSelection(retryCount, forcedChannelId)
	              ? null
	              : finalizeRetryAsUpstreamFailure(failure.status, failure.reason))
	            : failureOutcome;
	          if (!terminalFailureOutcome) {
	            retryCount += 1;
	            continue;
	          }
	          await finalizeDebugFailure(
	            terminalFailureOutcome.status,
	            terminalFailureOutcome.payload,
	            successfulUpstreamPath,
	          );
	          return reply.code(terminalFailureOutcome.status).send(terminalFailureOutcome.payload);
        }
        const normalized = openAiResponsesTransformer.transformFinalResponse(
          upstreamData,
          modelName,
          rawText,
        );
        const downstreamData = openAiResponsesTransformer.outbound.serializeFinal({
          upstreamPayload: upstreamData,
          normalized,
          usage: parsedUsage,
          serializationMode: isCompactRequest ? 'compact' : 'response',
        });
        try {
          updateContextTelemetry({
            upstreamPromptTokens: parsedUsage.promptTokens,
            compactSucceeded: isCompactRequest ? true : contextTelemetry.compactSucceeded ?? false,
          });
          await recordSurfaceSuccess({
            selected,
            requestedModel,
            modelName,
            parsedUsage,
            upstreamUsagePresent,
            upstreamHeaders: upstream.headers,
            requestStartedAtMs: startTime,
            isStream: false,
            firstByteLatencyMs,
            latencyMs: latency,
            retryCount,
            upstreamPath: successfulUpstreamPath,
            contextTelemetry,
            logSuccess: failureToolkit.log,
            recordDownstreamCost: (estimatedCost) => {
              recordDownstreamCostUsage(request, estimatedCost);
            },
            bestEffortMetrics: {
              errorLabel: '[responses] post-response bookkeeping failed:',
            },
          });
          // Track token usage for context window guard (Layer 1 & 2)
          if (codexSessionStoreKey) {
            safeRememberCodexSessionResponseId(codexSessionStoreKey, upstreamData);
            recordSessionTokenUsage({
              sessionId: codexSessionStoreKey,
              promptTokens: parsedUsage.promptTokens,
              completionTokens: parsedUsage.completionTokens,
              totalTokens: parsedUsage.totalTokens,
              responseId: extractResponsesTerminalResponseId(upstreamData) || null,
              succeeded: true,
            });
            // Record baseline for incremental input optimization
            const responseOutputItems = extractResponseOutputItems(upstreamData);
            const responseId = extractResponsesTerminalResponseId(upstreamData);
            const requestInput = Array.isArray(normalizedResponsesBody.input)
              ? normalizedResponsesBody.input as Record<string, unknown>[]
              : [];
            if (responseId) {
              recordSessionBaseline({
                sessionId: codexSessionStoreKey,
                requestInput,
                responseOutputItems,
                responseId,
                model: modelName,
              });
            }
          }
	        } catch (error) {
	          console.error('[responses] post-response success logging failed:', error);
	        }
	        await finalizeDebugSuccess(
            upstream.status,
            successfulUpstreamPath,
            buildSurfaceProxyDebugResponseHeaders(upstream),
            downstreamData,
          );
	        bindSurfaceStickyChannel({
	          stickySessionKey,
	          selected,
	        });
	        return reply.send(downstreamData);
	      } catch (err: any) {
	        clearSurfaceStickyChannel({
	          stickySessionKey,
	          selected,
	        });
          if (isResponsesContinuationRecoveryError(err)) {
            await failureToolkit.log({
              selected,
              modelRequested: requestedModel,
              status: 'failed',
              httpStatus: err.status,
              latencyMs: Date.now() - startTime,
              errorMessage: err.message,
              retryCount,
              contextTelemetry,
            });
            await finalizeDebugFailure(
              err.status,
              err.payload,
              null,
            );
            return reply.code(err.status).send(err.payload);
          }
          const endpointFailureStatus = typeof err?.status === 'number' ? err.status : null;
          const isSiteApiEndpointFailure = (
            err instanceof SiteApiEndpointRequestError
            || err?.name === 'SiteApiEndpointRequestError'
            || err?.siteApiEndpointUpstreamFailure === true
            || (endpointFailureStatus !== null && endpointFailureStatus >= 500)
          );
          if (isSiteApiEndpointFailure) {
            const responseErrorText = err?.rawErrText || err?.message || 'unknown error';
            if (isClientContinuationFailure(responseErrorText)) {
              // Client continuation errors are not channel failures
                  handleContinuationFailureSessionCleanup(responseErrorText, codexSessionStoreKey);
              // do NOT clear sticky session, record failure, or cross-channel retry.
              await failureToolkit.log({
                selected,
                modelRequested: requestedModel,
                status: 'failed',
                httpStatus: endpointFailureStatus || 502,
                latencyMs: Date.now() - startTime,
                errorMessage: err?.message || 'unknown error',
                retryCount,
                contextTelemetry,
              });
              await finalizeDebugFailure(
                endpointFailureStatus || 502,
                { error: { message: err?.message || 'unknown error', type: 'upstream_error' } },
                null,
              );
              return reply.code(endpointFailureStatus || 502).send({
                error: { message: err?.message || 'unknown error', type: 'upstream_error' },
              });
            }
            const failureOutcome = await failureToolkit.handleUpstreamFailure({
              selected,
          requestedModel,
          modelName,
          status: endpointFailureStatus || 502,
          errText: err?.message || 'unknown error',
          rawErrText: responseErrorText,
          isStream,
          latencyMs: Date.now() - startTime,
          retryCount,
          contextTelemetry,
        });
            const terminalFailureOutcome = failureOutcome.action === 'retry'
              ? (canRetryChannelSelection(retryCount, forcedChannelId)
                ? null
                : finalizeRetryAsUpstreamFailure(endpointFailureStatus || 502, err?.message || 'unknown error'))
              : failureOutcome;
            if (!terminalFailureOutcome) {
              retryCount += 1;
              continue;
            }
            await finalizeDebugFailure(
              terminalFailureOutcome.status,
              terminalFailureOutcome.payload,
              null,
            );
            return reply.code(terminalFailureOutcome.status).send(terminalFailureOutcome.payload);
          }
	        const failureOutcome = await failureToolkit.handleExecutionError({
	          selected,
	          requestedModel,
            modelName,
            errorMessage: err?.message || 'network failure',
            isStream,
            latencyMs: Date.now() - startTime,
            retryCount,
            contextTelemetry,
          });
          const terminalFailureOutcome = failureOutcome.action === 'retry'
            ? (isClientContinuationFailure(err?.message || 'network failure')
              ? finalizeRetryAsExecutionFailure(err?.message || 'network failure')
              : (canRetryChannelSelection(retryCount, forcedChannelId)
                ? null
                : finalizeRetryAsExecutionFailure(err?.message || 'network failure')))
            : failureOutcome;
          if (!terminalFailureOutcome) {
            retryCount += 1;
            continue;
	        }
		        await finalizeDebugFailure(
	            terminalFailureOutcome.status,
	            terminalFailureOutcome.payload,
	            null,
	          );
		        return reply.code(terminalFailureOutcome.status).send(terminalFailureOutcome.payload);
	      } finally {
	        channelLease.release();
	      }
	    }
}
