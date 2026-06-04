import { TextEncoder } from 'node:util';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { createCodexWebsocketRuntime, CodexWebsocketRuntimeError } from '../runtime/codexWebsocketRuntime.js';
import { registerCodexWebsocketRuntime } from '../runtime/codexWebsocketRuntimeRegistry.js';
import { createCodexWebsocketSessionStore } from '../runtime/codexWebsocketSessionStore.js';
import { config } from '../../config.js';
import type { BuiltEndpointRequest } from '../orchestration/endpointFlow.js';

const sharedSessionStore = createCodexWebsocketSessionStore();
const codexWsBridgeRuntime = registerCodexWebsocketRuntime(createCodexWebsocketRuntime({ sessionStore: sharedSessionStore }));
const CODEX_WS_BRIDGE_VERSION = '0.130.0';
const CODEX_WS_BRIDGE_USER_AGENT = 'codex-tui/0.130.0 (Windows 10.0.26200; x86_64) WindowsTerminal (codex-tui; 0.130.0)';
const CODEX_WS_BRIDGE_ORIGINATOR = 'codex-tui';

export async function dispatchCodexWebsocketRequest(
  endpointRequest: BuiltEndpointRequest,
  targetUrl: string | undefined,
  baseUrl: string,
  isStream: boolean,
  sessionId: string,
  proxyUrl?: string | null,
): Promise<Response> {
  const requestUrl = targetUrl
    ? targetUrl
    : `${baseUrl.replace(/\/+$/, '')}${endpointRequest.path}`;

  const wsSessionId = sessionId || `http-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const wsAgent = buildWebsocketProxyAgent(proxyUrl);

  if (!config.codexUpstreamWebsocketEnabled) {
    return new Response(JSON.stringify({
      error: { message: 'Codex WebSocket upstream is not enabled', type: 'server_error' },
    }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }

  try {
    const accountId = pickHeaderValue(endpointRequest.headers as Record<string, string>, [
      'chatgpt-account-id',
      'Chatgpt-Account-Id',
    ]);

    const runtimeHeaders = {
      ...(endpointRequest.headers as Record<string, string>),
      Version: CODEX_WS_BRIDGE_VERSION,
      'User-Agent': CODEX_WS_BRIDGE_USER_AGENT,
      Originator: CODEX_WS_BRIDGE_ORIGINATOR,
      ...(accountId ? {
        'chatgpt-account-id': accountId,
        'Chatgpt-Account-Id': accountId,
      } : {}),
    };

    if (isStream) {
      return await buildCodexWsStreamingResponse({
        wsSessionId,
        requestUrl,
        runtimeHeaders,
        body: endpointRequest.body as Record<string, unknown>,
        agent: wsAgent,
      });
    }

    const result = await sendCodexWsBridgeRequestWithSameAccountRetries({
      sessionId: wsSessionId,
      requestUrl,
      headers: runtimeHeaders,
      body: endpointRequest.body as Record<string, unknown>,
      authId: accountId || null,
      agent: wsAgent,
    });

    return buildCodexWsResponse(result.events, isStream);
  } catch (error) {
    const runtimeError = error instanceof CodexWebsocketRuntimeError
      ? error
      : new CodexWebsocketRuntimeError(
        error instanceof Error
          ? error.message || 'upstream websocket request failed'
          : 'upstream websocket request failed',
        {
          payload: error && typeof error === 'object'
            ? {
              raw_error_type: (error as { name?: unknown }).name ?? null,
              raw_error_message: (error as { message?: unknown }).message ?? null,
              raw_error_stack: (error as { stack?: unknown }).stack ?? null,
            }
            : null,
        },
      );

    const errorEvents = runtimeError.events && runtimeError.events.length > 0
      ? runtimeError.events
      : [{
        type: 'error',
        status: runtimeError.status || 502,
        error: {
          message: runtimeError.message,
          raw_error_type: runtimeError.name,
          payload: runtimeError.payload ?? null,
        },
      }];

    return buildCodexWsResponse(errorEvents, isStream, runtimeError.status || 502);
  }
}

function pickHeaderValue(headers: Record<string, string>, keys: string[]): string {
  for (const key of keys) {
    const expected = key.trim().toLowerCase();
    for (const [candidateKey, candidateValue] of Object.entries(headers)) {
      if (candidateKey.trim().toLowerCase() !== expected) continue;
      const value = (candidateValue || '').trim();
      if (value) return value;
    }
  }
  return '';
}

function buildWebsocketProxyAgent(proxyUrl?: string | null): unknown {
  const normalized = (proxyUrl || '').trim();
  if (!normalized) return undefined;
  try {
    const parsed = new URL(normalized);
    const protocol = parsed.protocol.toLowerCase();
    if (
      protocol === 'socks:'
      || protocol === 'socks4:'
      || protocol === 'socks4a:'
      || protocol === 'socks5:'
      || protocol === 'socks5h:'
    ) {
      return new SocksProxyAgent(parsed);
    }
    if (protocol === 'http:' || protocol === 'https:') {
      return new HttpsProxyAgent(parsed);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function buildCodexWsResponse(
  events: Array<Record<string, unknown>>,
  isStream: boolean,
  statusOverride?: number,
): Response {
  if (isStream) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(stream, {
      status: statusOverride || 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }

  const finalEvent = events.find((e) => {
    const type = typeof e.type === 'string' ? e.type : '';
    return type === 'response.completed' || type === 'error';
  }) || events[events.length - 1] || { type: 'error', error: { message: 'empty response' } };

  const inferredErrorStatus = (
    typeof finalEvent.status === 'number'
    && Number.isFinite(finalEvent.status)
    && finalEvent.status >= 100
    && finalEvent.status <= 599
      ? Math.trunc(finalEvent.status)
      : null
  );
  const status = statusOverride || inferredErrorStatus || 200;
  return new Response(JSON.stringify(finalEvent), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function buildCodexWsStreamingResponse(input: {
  wsSessionId: string;
  requestUrl: string;
  runtimeHeaders: Record<string, string>;
  body: Record<string, unknown>;
  agent?: unknown;
}): Promise<Response> {
  const encoder = new TextEncoder();
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  let responseStarted = false;
  let initialResponseResolved = false;
  let resolveInitialResponse: (response: Response) => void = () => undefined;
  let writeChain = Promise.resolve();
  let lastSseEvent: Record<string, unknown> | null = null;
  const initialResponse = new Promise<Response>((resolve) => {
    resolveInitialResponse = resolve;
  });

  const resolveStreamingResponse = () => {
    if (initialResponseResolved) return;
    initialResponseResolved = true;
    resolveInitialResponse(new Response(stream.readable, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));
  };

  const enqueueSse = (event: Record<string, unknown>) => {
    lastSseEvent = event;
    responseStarted = true;
    resolveStreamingResponse();
    writeChain = writeChain.then(() => writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)));
  };

  void (async () => {
    try {
      await sendCodexWsBridgeRequestWithSameAccountRetries({
        sessionId: input.wsSessionId,
        requestUrl: input.requestUrl,
        headers: input.runtimeHeaders,
        body: input.body,
        authId: pickHeaderValue(input.runtimeHeaders, ['chatgpt-account-id', 'Chatgpt-Account-Id']) || null,
        agent: input.agent,
        onEvent: (event) => {
          enqueueSse(event);
        },
      }, () => !responseStarted);
    } catch (error) {
      const runtimeError = normalizeCodexWsRuntimeError(error);
      if (!responseStarted) {
        initialResponseResolved = true;
        await writer.abort(runtimeError).catch(() => undefined);
        resolveInitialResponse(buildCodexWsErrorResponse(runtimeError));
        return;
      }
      const errorEvent = buildCodexWsErrorEvent(runtimeError);
      if (lastSseEvent !== errorEvent) {
        enqueueSse(errorEvent);
      }
    }

    resolveStreamingResponse();
    await writeChain.catch(() => undefined);
    await writer.write(encoder.encode('data: [DONE]\n\n')).catch(() => undefined);
    await writer.close().catch(() => undefined);
  })();

  return await initialResponse;
}

function normalizeCodexWsRuntimeError(error: unknown): CodexWebsocketRuntimeError {
  if (error instanceof CodexWebsocketRuntimeError) return error;
  return new CodexWebsocketRuntimeError(
    error instanceof Error
      ? error.message || 'upstream websocket request failed'
      : 'upstream websocket request failed',
    {
      payload: error && typeof error === 'object'
        ? {
          raw_error_type: (error as { name?: unknown }).name ?? null,
          raw_error_message: (error as { message?: unknown }).message ?? null,
          raw_error_stack: (error as { stack?: unknown }).stack ?? null,
        }
        : null,
    },
  );
}

function buildCodexWsErrorEvent(runtimeError: CodexWebsocketRuntimeError): Record<string, unknown> {
  return runtimeError.events && runtimeError.events.length > 0
    ? runtimeError.events[runtimeError.events.length - 1]
    : {
      type: 'error',
      status: runtimeError.status || 502,
      error: {
        message: runtimeError.message,
        raw_error_type: runtimeError.name,
        payload: runtimeError.payload ?? null,
      },
    };
}

function buildCodexWsErrorResponse(runtimeError: CodexWebsocketRuntimeError): Response {
  return new Response(JSON.stringify(buildCodexWsErrorEvent(runtimeError)), {
    status: runtimeError.status || 502,
    headers: { 'Content-Type': 'application/json' },
  });
}

function isCodexWsSameAccountRetryableError(runtimeError: CodexWebsocketRuntimeError): boolean {
  const status = typeof runtimeError.status === 'number' ? runtimeError.status : 502;
  return runtimeError.events.length === 0 && (status >= 500 || status === 408);
}

async function sendCodexWsBridgeRequestWithSameAccountRetries(
  input: Parameters<typeof codexWsBridgeRuntime.sendRequest>[0],
  canRetry?: (error: CodexWebsocketRuntimeError) => boolean,
) {
  const maxSameAccountRetries = Math.max(0, Math.trunc(config.codexUpstreamWebsocketSameAccountRetries || 0));
  let sameAccountAttempt = 0;
  for (;;) {
    try {
      return await codexWsBridgeRuntime.sendRequest(input);
    } catch (error) {
      const runtimeError = normalizeCodexWsRuntimeError(error);
      if (
        sameAccountAttempt < maxSameAccountRetries
        && isCodexWsSameAccountRetryableError(runtimeError)
        && (!canRetry || canRetry(runtimeError))
      ) {
        sameAccountAttempt += 1;
        continue;
      }
      throw runtimeError;
    }
  }
}
