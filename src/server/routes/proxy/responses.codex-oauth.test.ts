/**
 * @vitest-environment node
 */
// Force HTTP path for codex upstream — the websocket path requires a real WS server.
process.env.CODEX_UPSTREAM_WEBSOCKET_ENABLED = 'false';

import { zstdCompressSync } from 'node:zlib';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../config.js';
import { resetCodexHttpSessionQueue } from '../../proxy-core/runtime/codexHttpSessionQueue.js';
import { resetCodexSessionResponseStore } from '../../proxy-core/runtime/codexSessionResponseStore.js';

const fetchMock = vi.fn();
const selectChannelMock = vi.fn();
const selectNextChannelMock = vi.fn();
const selectPreferredChannelMock = vi.fn();
const recordSuccessMock = vi.fn();
const recordFailureMock = vi.fn();
const refreshModelsAndRebuildRoutesMock = vi.fn();
const reportProxyAllFailedMock = vi.fn();
const reportTokenExpiredMock = vi.fn();
const resolveProxyUsageWithSelfLogFallbackMock = vi.fn(async ({ usage }: any) => ({
  ...usage,
  estimatedCostFromQuota: 0,
  recoveredFromSelfLog: false,
}));
const refreshOauthAccessTokenSingleflightMock = vi.fn();
const recordOauthQuotaHeadersSnapshotMock = vi.fn<(input: unknown) => Promise<void>>(async (_input) => undefined);
const recordOauthQuotaResetHintMock = vi.fn<(input: unknown) => Promise<void>>(async (_input) => undefined);
const insertedProxyLogs: Record<string, unknown>[] = [];
const originalProxyEmptyContentFailEnabled = config.proxyEmptyContentFailEnabled;
const originalProxyStickySessionEnabled = config.proxyStickySessionEnabled;
const originalProxySessionChannelConcurrencyLimit = config.proxySessionChannelConcurrencyLimit;
const originalProxySessionChannelQueueWaitMs = config.proxySessionChannelQueueWaitMs;
const originalCodexUpstreamWebsocketEnabled = config.codexUpstreamWebsocketEnabled;
const originalCodexContextCompactionAutoEnabled = config.codexContextCompactionAutoEnabled;
const originalCodexContextCompactionSoftTokens = config.codexContextCompactionSoftTokens;
const originalCodexContextCompactionTargetTokens = config.codexContextCompactionTargetTokens;
const originalCodexContextCompactionCooldownTurns = config.codexContextCompactionCooldownTurns;
const dbInsertMock = vi.fn((_arg?: any) => ({
  values: (values: Record<string, unknown>) => {
    insertedProxyLogs.push(values);
    return {
      run: () => undefined,
    };
  },
}));

const CODEX_DEFAULT_INSTRUCTIONS = 'You are a helpful coding assistant.';

vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof import('undici')>('undici');
  return {
    ...actual,
    fetch: (...args: unknown[]) => fetchMock(...args),
  };
});

vi.mock('../../services/tokenRouter.js', () => ({
  tokenRouter: {
    selectChannel: (...args: unknown[]) => selectChannelMock(...args),
    selectNextChannel: (...args: unknown[]) => selectNextChannelMock(...args),
    selectPreferredChannel: (...args: unknown[]) => selectPreferredChannelMock(...args),
    recordSuccess: (...args: unknown[]) => recordSuccessMock(...args),
    recordFailure: (...args: unknown[]) => recordFailureMock(...args),
  },
}));

vi.mock('../../services/modelService.js', () => ({
  refreshModelsAndRebuildRoutes: (...args: unknown[]) => refreshModelsAndRebuildRoutesMock(...args),
}));

vi.mock('../../services/alertService.js', () => ({
  reportProxyAllFailed: (...args: unknown[]) => reportProxyAllFailedMock(...args),
  reportTokenExpired: (...args: unknown[]) => reportTokenExpiredMock(...args),
}));

vi.mock('../../services/alertRules.js', () => ({
  isTokenExpiredError: ({ status }: { status?: number }) => status === 401,
}));

vi.mock('../../services/modelPricingService.js', () => ({
  estimateProxyCost: async () => 0,
  buildProxyBillingDetails: async () => null,
  fetchModelPricingCatalog: async () => null,
}));

vi.mock('../../services/proxyRetryPolicy.js', () => ({
  isClientContinuationFailure: (text: string | null | undefined) => {
    const t = (text || '').trim().toLowerCase();
    if (!t) return false;
    return /context\s*window/i.test(t) || t.includes('exceeds the context')
      || t.includes('previous_response_not_found') || /previous\s+response.*not\s+found/i.test(t)
      || t.includes('missing required parameter') || t.includes('[objectparam]')
      || t.includes('tool-output-only continuation cannot be safely replayed')
      || t.includes('unable to safely recover continuation');
  },
  isContextWindowExceededRetryPolicy: (text: string | null | undefined) => {
    const t = (text || '').trim().toLowerCase();
    return /context\s*window/i.test(t) || t.includes('exceeds the context');
  },
  shouldRetryProxyRequest: () => false,
  shouldAbortSameSiteEndpointFallback: () => false,
  RETRYABLE_TIMEOUT_PATTERNS: [/(request timed out|connection timed out|read timeout|\btimed out\b)/i],
}));

vi.mock('../../services/proxyUsageFallbackService.js', () => ({
  resolveProxyUsageWithSelfLogFallback: (arg: any) => resolveProxyUsageWithSelfLogFallbackMock(arg),
}));

vi.mock('../../services/oauth/refreshSingleflight.js', () => ({
  refreshOauthAccessTokenSingleflight: (...args: unknown[]) => refreshOauthAccessTokenSingleflightMock(...args),
}));

vi.mock('../../services/oauth/quota.js', () => ({
  recordOauthQuotaHeadersSnapshot: async (input: unknown) => recordOauthQuotaHeadersSnapshotMock(input),
  recordOauthQuotaResetHint: async (input: unknown) => recordOauthQuotaResetHintMock(input),
}));

vi.mock('../../db/index.js', () => ({
  db: {
    insert: (arg: any) => dbInsertMock(arg),
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            all: async () => [],
          }),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          run: async () => undefined,
        }),
      }),
    }),
  },
  hasProxyLogBillingDetailsColumn: async () => false,
  hasProxyLogClientColumns: async () => false,
  hasProxyLogDownstreamApiKeyIdColumn: async () => false,
  hasProxyLogStreamTimingColumns: async () => false,
  hasProxyLogTransportColumns: async () => false,
  schema: {
    proxyLogs: {},
    siteApiEndpoints: {
      id: {},
      siteId: {},
      sortOrder: {},
    },
  },
}));

describe('responses proxy codex oauth refresh', () => {
  let app: FastifyInstance;

  const createDeferred = <T>() => {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  const waitFor = async (predicate: () => boolean, timeoutMs = 1000) => {
    const startedAt = Date.now();
    while (!predicate()) {
      if ((Date.now() - startedAt) >= timeoutMs) {
        throw new Error('Timed out waiting for test condition');
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  const createSseResponse = (chunks: string[], status = 200) => {
    const encoder = new TextEncoder();
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }), {
      status,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    });
  };

  const createCompressedSseResponse = (chunks: string[], status = 200) => new Response(
    zstdCompressSync(Buffer.from(chunks.join(''))),
    {
      status,
      headers: {
        'content-encoding': 'zstd',
        'content-type': 'text/event-stream; charset=utf-8',
      },
    },
  );

  beforeAll(async () => {
    const { responsesProxyRoute } = await import('./responses.js');
    app = Fastify();
    await app.register(responsesProxyRoute);
  });

  beforeEach(() => {
    resetCodexHttpSessionQueue();
    resetCodexSessionResponseStore();
    config.codexUpstreamWebsocketEnabled = false;
    config.proxyEmptyContentFailEnabled = false;
    config.proxyStickySessionEnabled = originalProxyStickySessionEnabled;
    config.proxySessionChannelConcurrencyLimit = originalProxySessionChannelConcurrencyLimit;
    config.proxySessionChannelQueueWaitMs = originalProxySessionChannelQueueWaitMs;
    config.codexContextCompactionAutoEnabled = false;
    config.codexContextCompactionSoftTokens = 50_000;
    config.codexContextCompactionTargetTokens = 30_000;
    config.codexContextCompactionCooldownTurns = 3;
    (config as any).openAiServiceTierRules = undefined;
    fetchMock.mockReset();
    selectChannelMock.mockReset();
    selectNextChannelMock.mockReset();
    selectPreferredChannelMock.mockReset();
    recordSuccessMock.mockReset();
    recordFailureMock.mockReset();
    refreshModelsAndRebuildRoutesMock.mockReset();
    reportProxyAllFailedMock.mockReset();
    reportTokenExpiredMock.mockReset();
    resolveProxyUsageWithSelfLogFallbackMock.mockClear();
    refreshOauthAccessTokenSingleflightMock.mockReset();
    recordOauthQuotaHeadersSnapshotMock.mockClear();
    recordOauthQuotaResetHintMock.mockClear();
    dbInsertMock.mockClear();
    insertedProxyLogs.length = 0;

    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { name: 'codex-site', url: 'https://chatgpt.com/backend-api/codex', platform: 'codex' },
      account: {
        id: 33,
        username: 'codex-user@example.com',
        extraConfig: JSON.stringify({
          credentialMode: 'session',
          oauth: {
            provider: 'codex',
            accountId: 'chatgpt-account-123',
            email: 'codex-user@example.com',
            planType: 'plus',
          },
        }),
      },
      tokenName: 'default',
      tokenValue: 'expired-access-token',
      actualModel: 'gpt-5.2-codex',
    });
    selectPreferredChannelMock.mockReturnValue(null);
    selectNextChannelMock.mockReturnValue(null);
    selectPreferredChannelMock.mockReturnValue(null);
    refreshOauthAccessTokenSingleflightMock.mockResolvedValue({
      accessToken: 'fresh-access-token',
      accountId: 33,
      accountKey: 'chatgpt-account-123',
    });
  });

  afterAll(async () => {
    config.codexUpstreamWebsocketEnabled = originalCodexUpstreamWebsocketEnabled;
    config.proxyEmptyContentFailEnabled = originalProxyEmptyContentFailEnabled;
    config.proxyStickySessionEnabled = originalProxyStickySessionEnabled;
    config.proxySessionChannelConcurrencyLimit = originalProxySessionChannelConcurrencyLimit;
    config.proxySessionChannelQueueWaitMs = originalProxySessionChannelQueueWaitMs;
    config.codexContextCompactionAutoEnabled = originalCodexContextCompactionAutoEnabled;
    config.codexContextCompactionSoftTokens = originalCodexContextCompactionSoftTokens;
    config.codexContextCompactionTargetTokens = originalCodexContextCompactionTargetTokens;
    config.codexContextCompactionCooldownTurns = originalCodexContextCompactionCooldownTurns;
    if (app) {
      await app.close();
    }
  });

  it('refreshes codex oauth token and retries the same responses request on 401', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'expired token', type: 'invalid_request_error' },
      }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'resp_codex_refreshed',
        object: 'response',
        model: 'gpt-5.2-codex',
        status: 'completed',
        output_text: 'ok after codex token refresh',
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: {
        'user-agent': 'CodexClient/1.0',
        'Chatgpt-Account-Id': 'spoofed-account',
      },
      payload: {
        model: 'gpt-5.2-codex',
        input: 'hello codex',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(refreshOauthAccessTokenSingleflightMock).toHaveBeenCalledWith(33);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [firstUrl, firstOptions] = fetchMock.mock.calls[0] as [string, any];
    const [secondUrl, secondOptions] = fetchMock.mock.calls[1] as [string, any];
    expect(firstUrl).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(secondUrl).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(firstOptions.headers.Authorization).toBe('Bearer expired-access-token');
    expect(secondOptions.headers.Authorization).toBe('Bearer fresh-access-token');
    expect(secondOptions.headers.Originator || secondOptions.headers.originator).toBe('codex_cli_rs');
    expect(secondOptions.headers['Chatgpt-Account-Id'] || secondOptions.headers['chatgpt-account-id']).toBe('chatgpt-account-123');
    expect(secondOptions.headers.Version || secondOptions.headers.version).toBe('0.133.0');
    expect(String(secondOptions.headers.Session_id || secondOptions.headers.session_id || '')).toMatch(/^[0-9a-f-]{36}$/i);
    expect(secondOptions.headers.Conversation_id || secondOptions.headers.conversation_id).toBeUndefined();
    expect(secondOptions.headers['User-Agent'] || secondOptions.headers['user-agent']).toBe('CodexClient/1.0');
    expect(secondOptions.headers.Accept || secondOptions.headers.accept).toBe('text/event-stream');
    expect(secondOptions.headers.Connection || secondOptions.headers.connection).toBe('Keep-Alive');
    expect(response.json()?.output_text).toContain('ok after codex token refresh');
  });

  it('auto compact preflight uses the codex compact URL and minimal request body', async () => {
    config.codexContextCompactionAutoEnabled = true;
    config.codexContextCompactionSoftTokens = 1_000;
    config.codexContextCompactionTargetTokens = 30_000;
    config.codexContextCompactionCooldownTurns = 0;
    const input = Array.from({ length: 8 }, (_, index) => ({
      role: 'user',
      content: `turn ${index} ${'x'.repeat(500)}`,
    }));

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'cmp_auto_1',
        object: 'response.compaction',
        input_tokens: 900,
        output_tokens: 20,
        total_tokens: 920,
        output: [
          {
            id: 'rs_auto_1',
            type: 'compaction',
            encrypted_content: 'enc-auto-compact',
          },
        ],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'resp_auto_compacted',
        object: 'response',
        model: 'gpt-5.2-codex',
        status: 'completed',
        output_text: 'ok after auto compact',
        usage: { input_tokens: 1200, output_tokens: 20, total_tokens: 1220 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: {
        session_id: 'session-auto-compact-url-1',
        'user-agent': 'CodexClient/1.0',
      },
      payload: {
        model: 'gpt-5.2-codex',
        input,
        stream_options: { include_obfuscation: true },
        store: true,
        temperature: 0.2,
        service_tier: 'priority',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [compactUrl, compactOptions] = fetchMock.mock.calls[0] as [string, any];
    const [responsesUrl, responsesOptions] = fetchMock.mock.calls[1] as [string, any];
    expect(compactUrl).toBe('https://chatgpt.com/backend-api/codex/responses/compact');
    expect(responsesUrl).toBe('https://chatgpt.com/backend-api/codex/responses');

    const compactBody = JSON.parse(String(compactOptions.body));
    expect(Object.keys(compactBody).sort()).toEqual(['input', 'instructions', 'model']);
    expect(compactBody.model).toBe('gpt-5.2-codex');
    expect(compactBody.instructions).toBe(CODEX_DEFAULT_INSTRUCTIONS);
    expect(compactBody.input).toHaveLength(8);
    expect(compactBody.input[0]).toMatchObject({
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: expect.stringContaining('turn 0'),
        },
      ],
    });
    expect(compactOptions.headers.Accept || compactOptions.headers.accept).toBe('application/json');

    const responsesBody = JSON.parse(String(responsesOptions.body));
    expect(responsesBody.previous_response_id).toBeUndefined();
    expect(responsesBody.input).toEqual([
      {
        id: 'rs_auto_1',
        type: 'compaction',
        encrypted_content: 'enc-auto-compact',
      },
      ...compactBody.input.slice(-6),
    ]);
  });

  it('auto compact uses target tokens to limit the replayed tail', async () => {
    config.codexContextCompactionAutoEnabled = true;
    config.codexContextCompactionSoftTokens = 1_000;
    config.codexContextCompactionTargetTokens = 1_000;
    config.codexContextCompactionCooldownTurns = 0;
    const input = Array.from({ length: 8 }, (_, index) => ({
      role: 'user',
      content: `turn ${index} ${'x'.repeat(900)}`,
    }));

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'cmp_auto_target_1',
        object: 'response.compaction',
        output: [
          {
            id: 'rs_auto_target_1',
            type: 'compaction',
            encrypted_content: 'enc-auto-target-compact',
          },
        ],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'resp_auto_target_compacted',
        object: 'response',
        model: 'gpt-5.2-codex',
        status: 'completed',
        output_text: 'ok after target compact',
        usage: { input_tokens: 900, output_tokens: 20, total_tokens: 920 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: {
        session_id: 'session-auto-compact-target-1',
        'user-agent': 'CodexClient/1.0',
      },
      payload: {
        model: 'gpt-5.2-codex',
        input,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [, responsesOptions] = fetchMock.mock.calls[1] as [string, any];
    const responsesBody = JSON.parse(String(responsesOptions.body));
    expect(responsesBody.input[0]).toMatchObject({
      id: 'rs_auto_target_1',
      type: 'compaction',
    });
    expect(responsesBody.input.length).toBeLessThan(7);
    expect(JSON.stringify(responsesBody.input)).toContain('turn 7');
  });

  it('refreshes codex oauth token and retries the same responses request on 403', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'forbidden account mismatch', type: 'invalid_request_error' },
      }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'resp_codex_refreshed_403',
        object: 'response',
        model: 'gpt-5.2-codex',
        status: 'completed',
        output_text: 'ok after codex forbidden refresh',
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: {
        'user-agent': 'CodexClient/1.0',
      },
      payload: {
        model: 'gpt-5.2-codex',
        input: 'hello codex',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(refreshOauthAccessTokenSingleflightMock).toHaveBeenCalledWith(33);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, secondOptions] = fetchMock.mock.calls[1] as [string, any];
    expect(secondOptions.headers.Authorization).toBe('Bearer fresh-access-token');
    expect(response.json()?.output_text).toContain('ok after codex forbidden refresh');
  });

  it('infers official codex originator from desktop user-agent when downstream originator is absent', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'resp_codex_desktop_originator',
      object: 'response',
      model: 'gpt-5.2-codex',
      status: 'completed',
      output_text: 'desktop originator preserved',
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: {
        'user-agent': 'Mozilla/5.0 codex_chatgpt_desktop/1.2.3',
      },
      payload: {
        model: 'gpt-5.2-codex',
        input: 'hello desktop codex',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0] as [string, any];
    expect(options.headers.Originator || options.headers.originator).toBe('codex_chatgpt_desktop');
  });

  it('canonicalizes official codex originator aliases before proxying upstream', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'resp_codex_originator_alias',
      object: 'response',
      model: 'gpt-5.2-codex',
      status: 'completed',
      output_text: 'originator alias preserved',
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: {
        originator: 'Codex Desktop',
      },
      payload: {
        model: 'gpt-5.2-codex',
        input: 'hello codex',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0] as [string, any];
    expect(options.headers.Originator || options.headers.originator).toBe('codex_chatgpt_desktop');
  });

  it('does not refresh codex oauth token on non-auth 403 responses', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      error: { message: 'quota exceeded for workspace', type: 'usage_limit_reached' },
    }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.2-codex',
        input: 'hello codex',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(refreshOauthAccessTokenSingleflightMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.json()).toMatchObject({
      error: {
        message: expect.stringContaining('quota exceeded for workspace'),
      },
    });
  });

  it('retries oauth responses requests with a normalized upstream URL after refresh', async () => {
    selectChannelMock.mockReturnValue({
      channel: { id: 11, routeId: 22 },
      site: { name: 'openai-site', url: 'https://gateway.example.com/v1/', platform: 'openai' },
      account: {
        id: 33,
        username: 'oauth-user@example.com',
        extraConfig: JSON.stringify({
          credentialMode: 'session',
          oauth: {
            provider: 'codex',
            accountId: 'chatgpt-account-123',
            email: 'oauth-user@example.com',
            planType: 'plus',
          },
        }),
      },
      tokenName: 'default',
      tokenValue: 'expired-access-token',
      actualModel: 'gpt-4.1-mini',
    });

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'expired token', type: 'invalid_request_error' },
      }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'resp_openai_refreshed',
        object: 'response',
        model: 'gpt-4.1-mini',
        status: 'completed',
        output_text: 'ok after refresh',
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-4.1-mini',
        input: 'hello oauth',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(refreshOauthAccessTokenSingleflightMock).toHaveBeenCalledWith(33);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [firstUrl, firstOptions] = fetchMock.mock.calls[0] as [string, any];
    const [secondUrl, secondOptions] = fetchMock.mock.calls[1] as [string, any];
    expect(firstUrl).toBe('https://gateway.example.com/v1/responses');
    expect(secondUrl).toBe('https://gateway.example.com/v1/responses');
    expect(firstOptions.headers.Authorization).toBe('Bearer expired-access-token');
    expect(secondOptions.headers.Authorization).toBe('Bearer fresh-access-token');
    expect(response.json()?.output_text).toBe('ok after refresh');
  });

  it('sends a non-empty default instructions field to codex responses when downstream body has no system prompt', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'resp_codex_no_system',
      object: 'response',
      model: 'gpt-5.2-codex',
      status: 'completed',
      output_text: 'ok without system prompt',
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.2-codex',
        input: 'hello codex',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, options] = fetchMock.mock.calls[0] as [string, any];
    const forwardedBody = JSON.parse(options.body);
    expect(forwardedBody.instructions).toBe(CODEX_DEFAULT_INSTRUCTIONS);
    expect(forwardedBody.prompt_cache_key).toBeUndefined();
    expect(forwardedBody.stream).toBe(true);
    expect(forwardedBody.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello codex' }],
      },
    ]);
  });

  it('extracts codex system input into top-level instructions before proxying upstream', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'resp_codex_system_to_instructions',
      object: 'response',
      model: 'gpt-5.2-codex',
      status: 'completed',
      output_text: 'ok with extracted instructions',
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.2-codex',
        instructions: 'keep edits narrow',
        input: [
          {
            type: 'message',
            role: 'system',
            content: [{ type: 'input_text', text: 'be precise' }],
          },
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello codex' }],
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const [, options] = fetchMock.mock.calls[0] as [string, any];
    const forwardedBody = JSON.parse(options.body);
    expect(forwardedBody.instructions).toBe('be precise\n\nkeep edits narrow');
    expect(forwardedBody.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello codex' }],
      },
    ]);
  });

  it('preserves explicit prompt_cache_key for codex responses requests without converting it into codex session headers', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'resp_codex_with_cache_key',
      object: 'response',
      model: 'gpt-5.2-codex',
      status: 'completed',
      output_text: 'ok with cache key',
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.2-codex',
        prompt_cache_key: 'codex-cache-123',
        input: 'hello codex',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, options] = fetchMock.mock.calls[0] as [string, any];
    const forwardedBody = JSON.parse(options.body);
    expect(String(options.headers.Session_id || options.headers.session_id || '')).toMatch(/^[0-9a-f-]{36}$/i);
    expect(options.headers.Conversation_id || options.headers.conversation_id).toBeUndefined();
    expect(forwardedBody.prompt_cache_key).toBe('codex-cache-123');
  });

  it('infers previous_response_id for codex tool-output follow-up turns on the same downstream session', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'resp_codex_prev_1',
        object: 'response',
        model: 'gpt-5.2-codex',
        status: 'completed',
        output_text: 'tool call issued',
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'resp_codex_prev_2',
        object: 'response',
        model: 'gpt-5.2-codex',
        status: 'completed',
        output_text: 'tool result accepted',
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const headers = {
      session_id: 'session-http-prev-1',
      'user-agent': 'CodexClient/1.0',
    };

    const firstResponse = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers,
      payload: {
        model: 'gpt-5.2-codex',
        input: 'start codex tool flow',
      },
    });
    expect(firstResponse.statusCode).toBe(200);

    const secondResponse = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers,
      payload: {
        model: 'gpt-5.2-codex',
        input: [
          {
            id: 'tool_out_1',
            type: 'function_call_output',
            call_id: 'call_1',
            output: '{"ok":true}',
          },
        ],
      },
    });

    expect(secondResponse.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [, secondOptions] = fetchMock.mock.calls[1] as [string, any];
    const secondBody = JSON.parse(secondOptions.body);
    expect(secondBody.previous_response_id).toBe('resp_codex_prev_1');
    expect(secondBody.input).toEqual([
      {
        id: 'tool_out_1',
        type: 'function_call_output',
        call_id: 'call_1',
        output: '{"ok":true}',
      },
    ]);
  });

  it('rejects external HTTP previous_response_id without touching upstream', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.2-codex',
        previous_response_id: 'msg_wrong_1',
        input: 'hello',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('msg_*');
    expect(response.json().error.message).toContain('HTTP /v1/responses');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects orphan external HTTP function_call_output but keeps codex session inference allowed', async () => {
    const rejected = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.2-codex',
        input: [
          {
            type: 'function_call_output',
            call_id: 'call_orphan',
            output: '{"ok":true}',
          },
        ],
      },
    });

    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.message).toContain('Responses WebSocket v2');
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'resp_codex_preflight_ok',
      object: 'response',
      model: 'gpt-5.2-codex',
      status: 'completed',
      output_text: 'accepted',
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const allowed = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: {
        session_id: 'session-preflight-codex',
        'user-agent': 'CodexClient/1.0',
      },
      payload: {
        model: 'gpt-5.2-codex',
        input: [
          {
            type: 'function_call_output',
            call_id: 'call_codex',
            output: '{"ok":true}',
          },
        ],
      },
    });

    expect(allowed.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('filters HTTP service_tier by selected account policy before forwarding upstream', async () => {
    (config as any).openAiServiceTierRules = [{
      action: 'filter',
      tiers: ['priority'],
      platforms: ['codex'],
      accountTypes: ['plus'],
    }];
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'resp_codex_tier_filtered',
      object: 'response',
      model: 'gpt-5.2-codex',
      status: 'completed',
      output_text: 'tier filtered',
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.2-codex',
        service_tier: 'fast',
        input: 'hello',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0] as [string, any];
    const forwardedBody = JSON.parse(options.body);
    expect(forwardedBody.service_tier).toBeUndefined();
  });

  it('blocks HTTP service_tier by selected account policy without touching upstream', async () => {
    (config as any).openAiServiceTierRules = [{
      action: 'block',
      tiers: ['priority'],
      platforms: ['codex'],
      accountTypes: ['plus'],
    }];

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.2-codex',
        service_tier: 'fast',
        input: 'hello',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('service_tier');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('infers previous_response_id for codex tool-output follow-up turns when the client only sends conversation_id', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'resp_codex_prev_conv_1',
        object: 'response',
        model: 'gpt-5.2-codex',
        status: 'completed',
        output_text: 'tool call issued',
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'resp_codex_prev_conv_2',
        object: 'response',
        model: 'gpt-5.2-codex',
        status: 'completed',
        output_text: 'tool result accepted',
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const headers = {
      conversation_id: 'conversation-http-prev-1',
      'user-agent': 'CodexClient/1.0',
    };

    const firstResponse = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers,
      payload: {
        model: 'gpt-5.2-codex',
        input: 'start codex tool flow',
      },
    });
    expect(firstResponse.statusCode).toBe(200);

    const secondResponse = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers,
      payload: {
        model: 'gpt-5.2-codex',
        input: [
          {
            id: 'tool_out_conv_1',
            type: 'function_call_output',
            call_id: 'call_conv_1',
            output: '{"ok":true}',
          },
        ],
      },
    });

    expect(secondResponse.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [, firstOptions] = fetchMock.mock.calls[0] as [string, any];
    const [, secondOptions] = fetchMock.mock.calls[1] as [string, any];
    const secondBody = JSON.parse(secondOptions.body);
    expect(firstOptions.headers.Session_id || firstOptions.headers.session_id).toBe('conversation-http-prev-1');
    expect(secondOptions.headers.Session_id || secondOptions.headers.session_id).toBe('conversation-http-prev-1');
    expect(secondBody.previous_response_id).toBe('resp_codex_prev_conv_1');
  });

  it('reuses previous_response_id for codex tool-output follow-up turns after channel/account drift on the same downstream session', async () => {
    const firstSelected = {
      channel: { id: 11, routeId: 22 },
      site: { name: 'codex-site', url: 'https://chatgpt.com/backend-api/codex', platform: 'codex' },
      account: {
        id: 33,
        username: 'codex-user-a@example.com',
        extraConfig: JSON.stringify({
          credentialMode: 'session',
          oauth: {
            provider: 'codex',
            accountId: 'chatgpt-account-123',
            email: 'codex-user-a@example.com',
            planType: 'plus',
          },
        }),
      },
      tokenName: 'default-a',
      tokenValue: 'expired-access-token-a',
      actualModel: 'gpt-5.2-codex',
    };
    const secondSelected = {
      channel: { id: 12, routeId: 23 },
      site: { name: 'codex-site', url: 'https://chatgpt.com/backend-api/codex', platform: 'codex' },
      account: {
        id: 34,
        username: 'codex-user-b@example.com',
        extraConfig: JSON.stringify({
          credentialMode: 'session',
          oauth: {
            provider: 'codex',
            accountId: 'chatgpt-account-456',
            email: 'codex-user-b@example.com',
            planType: 'plus',
          },
        }),
      },
      tokenName: 'default-b',
      tokenValue: 'expired-access-token-b',
      actualModel: 'gpt-5.2-codex',
    };

    selectChannelMock
      .mockReset()
      .mockReturnValueOnce(firstSelected)
      .mockReturnValueOnce(secondSelected);
    selectPreferredChannelMock
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'resp_codex_prev_drift_1',
        object: 'response',
        model: 'gpt-5.2-codex',
        status: 'completed',
        output_text: 'tool call issued',
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'resp_codex_prev_drift_2',
        object: 'response',
        model: 'gpt-5.2-codex',
        status: 'completed',
        output_text: 'tool result accepted after drift',
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const headers = {
      session_id: 'session-http-prev-drift',
      'user-agent': 'CodexClient/1.0',
    };

    const firstResponse = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers,
      payload: {
        model: 'gpt-5.2-codex',
        input: 'start codex tool flow',
      },
    });
    expect(firstResponse.statusCode).toBe(200);

    const secondResponse = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers,
      payload: {
        model: 'gpt-5.2-codex',
        input: [
          {
            id: 'tool_out_drift_1',
            type: 'function_call_output',
            call_id: 'call_1',
            output: '{"ok":true}',
          },
        ],
      },
    });

    expect(secondResponse.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(selectChannelMock).toHaveBeenCalledTimes(2);
    expect(selectPreferredChannelMock).toHaveBeenCalledTimes(2);

    const [, firstOptions] = fetchMock.mock.calls[0] as [string, any];
    const [, secondOptions] = fetchMock.mock.calls[1] as [string, any];
    const secondBody = JSON.parse(secondOptions.body);
    expect(firstOptions.headers['Chatgpt-Account-Id'] || firstOptions.headers['chatgpt-account-id']).toBe('chatgpt-account-123');
    expect(secondOptions.headers['Chatgpt-Account-Id'] || secondOptions.headers['chatgpt-account-id']).toBe('chatgpt-account-456');
    expect(secondBody.previous_response_id).toBe('resp_codex_prev_drift_1');
    expect(secondBody.input).toEqual([
      {
        id: 'tool_out_drift_1',
        type: 'function_call_output',
        call_id: 'call_1',
        output: '{"ok":true}',
      },
    ]);
  });

  it('does not retry codex responses requests across channels for continuation context errors', async () => {
    // Context-window errors arrive inside a streaming response (response.failed),
    // not as a non-stream 400.  The proxy must log the failure but NOT record
    // a channel failure or clear the sticky session.
    fetchMock.mockResolvedValueOnce(createSseResponse([
      'event: response.created\n',
      'data: {"type":"response.created","response":{"id":"resp_ctx_win","model":"gpt-5.4","created_at":1706000000,"status":"in_progress","output":[]}}\n\n',
      'event: response.failed\n',
      'data: {"type":"response.failed","response":{"id":"resp_ctx_win","model":"gpt-5.4","status":"failed","error":{"message":"Your input exceeds the context window of this model. Please adjust your input and try again.","code":"context_window_exceeded"}}}\n\n',
      'data: [DONE]\n\n',
    ]));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.4',
        input: 'hello codex',
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('response.failed');
    expect(response.body).toContain('context_window');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Continuation/context errors are NOT channel failures — must not penalize.
    expect(recordFailureMock).not.toHaveBeenCalled();
  });

  it('drops stale previous_response_id and retries codex responses requests once', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          message: 'previous_response_not_found',
          code: 'previous_response_not_found',
          type: 'invalid_request_error',
        },
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'resp_codex_prev_recovered',
        object: 'response',
        model: 'gpt-5.2-codex',
        status: 'completed',
        output_text: 'recovered after dropping stale previous_response_id',
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: {
        session_id: 'session-http-prev-recovery',
      },
      payload: {
        model: 'gpt-5.2-codex',
        previous_response_id: 'resp_stale',
        input: [
          {
            id: 'tool_out_retry_1',
            type: 'function_call_output',
            call_id: 'call_retry_1',
            output: '{"retry":true}',
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('HTTP /v1/responses');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops unsupported parameters and retries responses request once', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        detail: 'Unsupported parameter: temperature',
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'resp_codex_param_recovered',
        object: 'response',
        model: 'gpt-5.3-codex',
        status: 'completed',
        output_text: 'recovered after dropping unsupported temperature',
        usage: { input_tokens: 6, output_tokens: 2, total_tokens: 8 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.3-codex',
        input: 'hello',
        temperature: 0.7,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [, firstOptions] = fetchMock.mock.calls[0] as [string, any];
    const [, secondOptions] = fetchMock.mock.calls[1] as [string, any];
    const firstBody = JSON.parse(firstOptions.body);
    const secondBody = JSON.parse(secondOptions.body);

    expect(firstBody.temperature).toBe(0.7);
    expect(secondBody.temperature).toBeUndefined();
    expect(secondBody.input).toEqual(firstBody.input);
  });

  it('retries unsupported-parameter recovery at most once', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({
        detail: 'Unsupported parameter: temperature',
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        detail: 'Unsupported parameter: top_p',
      }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.3-codex',
        input: 'hello',
        temperature: 0.7,
        top_p: 0.8,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [, secondOptions] = fetchMock.mock.calls[1] as [string, any];
    const secondBody = JSON.parse(secondOptions.body);
    expect(secondBody.temperature).toBeUndefined();
    expect(secondBody.top_p).toBe(0.8);
  });

  it('strips generic downstream headers before forwarding codex responses upstream', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'resp_codex_header_filter',
      object: 'response',
      model: 'gpt-5.2-codex',
      status: 'completed',
      output_text: 'ok with filtered headers',
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: {
        'openai-beta': 'responses-2025-03-11',
        'x-openai-client-user-agent': '{"client":"openclaw"}',
        origin: 'https://openclaw.example',
        referer: 'https://openclaw.example/app',
        'user-agent': 'OpenClaw/1.0',
        version: '0.202.0',
        session_id: 'session-from-client',
      },
      payload: {
        model: 'gpt-5.2-codex',
        input: 'hello codex',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, options] = fetchMock.mock.calls[0] as [string, any];
    expect(options.headers.Version || options.headers.version).toBe('0.202.0');
    expect(options.headers.Session_id || options.headers.session_id).toBe('session-from-client');
    expect(options.headers['User-Agent'] || options.headers['user-agent']).toBe('OpenClaw/1.0');
    expect(options.headers['openai-beta']).toBeUndefined();
    expect(options.headers['x-openai-client-user-agent']).toBeUndefined();
    expect(options.headers.origin).toBeUndefined();
    expect(options.headers.referer).toBeUndefined();
  });

  it('serializes concurrent codex HTTP responses requests that share the same session id', async () => {
    const firstUpstream = createDeferred<Response>();
    fetchMock
      .mockImplementationOnce(() => firstUpstream.promise)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'resp_codex_serial_2',
        object: 'response',
        model: 'gpt-5.2-codex',
        status: 'completed',
        output_text: 'second request finished',
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const firstResponsePromise = app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: {
        session_id: 'session-http-serial-1',
      },
      payload: {
        model: 'gpt-5.2-codex',
        input: 'first request',
      },
    });

    await waitFor(() => fetchMock.mock.calls.length === 1);

    const secondResponsePromise = app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: {
        session_id: 'session-http-serial-1',
      },
      payload: {
        model: 'gpt-5.2-codex',
        input: 'second request',
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    firstUpstream.resolve(new Response(JSON.stringify({
      id: 'resp_codex_serial_1',
      object: 'response',
      model: 'gpt-5.2-codex',
      status: 'completed',
      output_text: 'first request finished',
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const firstResponse = await firstResponsePromise;
    expect(firstResponse.statusCode).toBe(200);
    expect(firstResponse.json()).toMatchObject({
      output_text: 'first request finished',
    });

    await waitFor(() => fetchMock.mock.calls.length === 2);

    const secondResponse = await secondResponsePromise;
    expect(secondResponse.statusCode).toBe(200);
    expect(secondResponse.json()).toMatchObject({
      output_text: 'second request finished',
    });

    const [, firstOptions] = fetchMock.mock.calls[0] as [string, any];
    const [, secondOptions] = fetchMock.mock.calls[1] as [string, any];
    expect(firstOptions.headers.Session_id || firstOptions.headers.session_id).toBe('session-http-serial-1');
    expect(secondOptions.headers.Session_id || secondOptions.headers.session_id).toBe('session-http-serial-1');
  });

  it('does not gate codex responses requests without a downstream session id behind the session lease queue', async () => {
    config.proxyStickySessionEnabled = true;
    config.proxySessionChannelConcurrencyLimit = 1;
    config.proxySessionChannelQueueWaitMs = 20;

    const firstUpstream = createDeferred<Response>();
    fetchMock
      .mockImplementationOnce(() => firstUpstream.promise)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'resp_codex_parallel_2',
        object: 'response',
        model: 'gpt-5.2-codex',
        status: 'completed',
        output_text: 'second request finished',
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const firstResponsePromise = app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.2-codex',
        input: 'first request',
      },
    });

    await waitFor(() => fetchMock.mock.calls.length === 1);

    const secondResponsePromise = app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.2-codex',
        input: 'second request',
      },
    });

    await waitFor(() => fetchMock.mock.calls.length === 2);

    firstUpstream.resolve(new Response(JSON.stringify({
      id: 'resp_codex_parallel_1',
      object: 'response',
      model: 'gpt-5.2-codex',
      status: 'completed',
      output_text: 'first request finished',
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const [firstResponse, secondResponse] = await Promise.all([
      firstResponsePromise,
      secondResponsePromise,
    ]);
    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
  });

  it('records codex usage_limit_reached reset hints on upstream 429 failures', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      error: {
        type: 'usage_limit_reached',
        resets_at: 1773800400,
        message: 'quota exceeded',
      },
    }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.2-codex',
        input: 'hello codex',
      },
    });

    expect(response.statusCode).toBe(429);
    expect(recordOauthQuotaResetHintMock).toHaveBeenCalledWith({
      accountId: 33,
      statusCode: 429,
      errorText: JSON.stringify({
        error: {
          type: 'usage_limit_reached',
          resets_at: 1773800400,
          message: 'quota exceeded',
        },
      }),
    });
  });

  it('forces codex upstream responses requests to stream and aggregates the SSE payload for non-stream downstream callers', async () => {
    fetchMock.mockResolvedValue(createSseResponse([
      'event: response.created\n',
      'data: {"type":"response.created","response":{"id":"resp_codex_stream","model":"gpt-5.4","created_at":1706000000,"status":"in_progress","output":[]}}\n\n',
      'event: response.output_item.added\n',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_codex_stream","type":"message","role":"assistant","status":"in_progress","content":[]}}\n\n',
      'event: response.output_text.delta\n',
      'data: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_codex_stream","delta":"pong"}\n\n',
      'event: response.completed\n',
      'data: {"type":"response.completed","response":{"id":"resp_codex_stream","model":"gpt-5.4","status":"completed","usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}\n\n',
      'data: [DONE]\n\n',
    ]));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.4',
        input: 'hello codex',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, options] = fetchMock.mock.calls[0] as [string, any];
    const forwardedBody = JSON.parse(options.body);
    expect(forwardedBody.stream).toBe(true);
    expect(forwardedBody.instructions).toBe(CODEX_DEFAULT_INSTRUCTIONS);
    expect(forwardedBody.store).toBe(false);
    expect(forwardedBody.max_output_tokens).toBeUndefined();

    expect(response.json()).toMatchObject({
      id: 'resp_codex_stream',
      model: 'gpt-5.4',
      status: 'completed',
      output_text: 'pong',
      usage: {
        input_tokens: 3,
        output_tokens: 1,
        total_tokens: 4,
      },
    });
  });

  it('records streaming codex baselines so full-history follow-up turns send only incremental input', async () => {
    const firstUserMessage = {
      id: 'msg_user_1',
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'first question' }],
    };
    const firstAssistantMessage = {
      id: 'msg_assistant_1',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'first answer' }],
    };
    const secondUserMessage = {
      id: 'msg_user_2',
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'second question' }],
    };

    fetchMock
      .mockResolvedValueOnce(createSseResponse([
        'event: response.created\n',
        'data: {"type":"response.created","response":{"id":"resp_stream_incremental_1","model":"gpt-5.2-codex","created_at":1706000000,"status":"in_progress","output":[]}}\n\n',
        'event: response.output_item.added\n',
        'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_assistant_1","type":"message","role":"assistant","status":"in_progress","content":[]}}\n\n',
        'event: response.output_text.delta\n',
        'data: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_assistant_1","delta":"first answer"}\n\n',
        'event: response.completed\n',
        'data: {"type":"response.completed","response":{"id":"resp_stream_incremental_1","model":"gpt-5.2-codex","status":"completed","usage":{"input_tokens":1000,"output_tokens":10,"total_tokens":1010}}}\n\n',
        'data: [DONE]\n\n',
      ]))
      .mockResolvedValueOnce(createSseResponse([
        'event: response.created\n',
        'data: {"type":"response.created","response":{"id":"resp_stream_incremental_2","model":"gpt-5.2-codex","created_at":1706000001,"status":"in_progress","output":[]}}\n\n',
        'event: response.completed\n',
        'data: {"type":"response.completed","response":{"id":"resp_stream_incremental_2","model":"gpt-5.2-codex","status":"completed","output":[{"id":"msg_assistant_2","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"second answer"}]}],"usage":{"input_tokens":20,"output_tokens":8,"total_tokens":28}}}\n\n',
        'data: [DONE]\n\n',
      ]));

    const headers = { session_id: 'stream-incremental-session-1' };
    const firstResponse = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers,
      payload: {
        model: 'gpt-5.2-codex',
        stream: true,
        input: [firstUserMessage],
      },
    });
    const secondResponse = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers,
      payload: {
        model: 'gpt-5.2-codex',
        stream: true,
        input: [firstUserMessage, firstAssistantMessage, secondUserMessage],
      },
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [, firstOptions] = fetchMock.mock.calls[0] as [string, any];
    const [, secondOptions] = fetchMock.mock.calls[1] as [string, any];
    const firstForwardedBody = JSON.parse(firstOptions.body);
    const secondForwardedBody = JSON.parse(secondOptions.body);

    expect(firstForwardedBody.input).toEqual([firstUserMessage]);
    expect(secondForwardedBody.previous_response_id).toBe('resp_stream_incremental_1');
    expect(secondForwardedBody.input).toEqual([secondUserMessage]);
  });

  it('rebinds sticky channels after websocket transport fast-path successes', async () => {
    config.proxyStickySessionEnabled = true;

    const selected = {
      channel: { id: 11, routeId: 22 },
      site: { name: 'codex-site', url: 'https://chatgpt.com/backend-api/codex', platform: 'codex' },
      account: {
        id: 33,
        username: 'codex-user@example.com',
        extraConfig: JSON.stringify({
          credentialMode: 'session',
          oauth: {
            provider: 'codex',
            accountId: 'chatgpt-account-123',
            email: 'codex-user@example.com',
            planType: 'plus',
          },
        }),
      },
      tokenName: 'default',
      tokenValue: 'expired-access-token',
      actualModel: 'gpt-5.2-codex',
    };
    selectChannelMock.mockReturnValue(selected);
    selectPreferredChannelMock.mockReturnValue(selected);

    const stickyHeaders = {
      'x-metapi-responses-websocket-transport': '1',
      session_id: 'session-sticky-fast-path-1',
    };
    const ssePayload = createSseResponse([
      'event: response.created\n',
      'data: {"type":"response.created","response":{"id":"resp_codex_fast_path","model":"gpt-5.4","created_at":1706000000,"status":"in_progress","output":[]}}\n\n',
      'event: response.completed\n',
      'data: {"type":"response.completed","response":{"id":"resp_codex_fast_path","model":"gpt-5.4","status":"completed","usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}\n\n',
      'data: [DONE]\n\n',
    ]);
    fetchMock.mockResolvedValue(ssePayload);

    const firstResponse = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: stickyHeaders,
      payload: {
        model: 'gpt-5.4',
        input: 'hello codex',
        stream: true,
      },
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(firstResponse.body).toContain('event: response.completed');
    expect(selectPreferredChannelMock).not.toHaveBeenCalled();

    const secondResponse = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: stickyHeaders,
      payload: {
        model: 'gpt-5.4',
        input: 'hello again',
        stream: true,
      },
    });

    expect(secondResponse.statusCode).toBe(200);
    expect(selectPreferredChannelMock).toHaveBeenCalledTimes(1);
    expect(selectPreferredChannelMock.mock.calls[0]?.[0]).toBe('gpt-5.4');
    expect(selectPreferredChannelMock.mock.calls[0]?.[1]).toBe(11);
  });

  it('decodes zstd-compressed codex responses SSE before relaying native downstream streams', async () => {
    fetchMock.mockResolvedValue(createCompressedSseResponse([
      'event: response.created\n',
      'data: {"type":"response.created","response":{"id":"resp_codex_zstd_stream","model":"gpt-5.4","created_at":1706000000,"status":"in_progress","output":[]}}\n\n',
      'event: response.output_item.added\n',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_codex_zstd_stream","type":"message","role":"assistant","status":"in_progress","content":[]}}\n\n',
      'event: response.output_text.delta\n',
      'data: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_codex_zstd_stream","delta":"你好，来自 zstd responses SSE"}\n\n',
      'event: response.completed\n',
      'data: {"type":"response.completed","response":{"id":"resp_codex_zstd_stream","model":"gpt-5.4","status":"completed","usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}\n\n',
      'data: [DONE]\n\n',
    ]));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.4',
        input: 'hello codex',
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('event: response.output_text.delta');
    expect(response.body).toContain('你好，来自 zstd responses SSE');
    expect(response.body).not.toContain('(�/�');
    expect(response.body).toContain('data: [DONE]');
  });

  it('preserves codex-required instructions and store fields across responses compatibility retries', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'upstream_error', type: 'upstream_error' },
    }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.2-codex',
        input: 'hello codex',
        metadata: { trace: 'compatibility-retry' },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);

    const [, firstOptions] = fetchMock.mock.calls[0] as [string, any];
    const [, secondOptions] = fetchMock.mock.calls[1] as [string, any];
    const firstBody = JSON.parse(firstOptions.body);
    const secondBody = JSON.parse(secondOptions.body);

    expect(firstBody.instructions).toBe(CODEX_DEFAULT_INSTRUCTIONS);
    expect(firstBody.store).toBe(false);
    expect(firstBody.stream).toBe(true);
    expect(firstBody.max_output_tokens).toBeUndefined();
    expect(secondBody.instructions).toBe(CODEX_DEFAULT_INSTRUCTIONS);
    expect(secondBody.store).toBe(false);
    expect(secondBody.stream).toBe(true);
    expect(secondBody.max_output_tokens).toBeUndefined();
  });

  it('does not record success when a streaming responses request ends with response.failed', async () => {
    fetchMock.mockResolvedValue(createSseResponse([
      'event: response.created\n',
      'data: {"type":"response.created","response":{"id":"resp_codex_failed","model":"gpt-5.4","created_at":1706000000,"status":"in_progress","output":[]}}\n\n',
      'event: response.failed\n',
      'data: {"type":"response.failed","response":{"id":"resp_codex_failed","model":"gpt-5.4","status":"failed","error":{"message":"tool execution failed"}}}\n\n',
      'data: [DONE]\n\n',
    ]));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.4',
        input: 'hello codex',
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('response.failed');
    expect(response.body).not.toContain('response.completed');
    expect(recordSuccessMock).not.toHaveBeenCalled();
    expect(recordFailureMock).toHaveBeenCalledTimes(1);
    expect(insertedProxyLogs.at(-1)).toMatchObject({
      status: 'failed',
      httpStatus: 200,
    });
    expect(String(insertedProxyLogs.at(-1)?.errorMessage || '')).toContain('tool execution failed');
  });

  it('does not record success when a native responses stream closes before response.completed', async () => {
    fetchMock.mockResolvedValue(createSseResponse([
      'event: response.created\n',
      'data: {"type":"response.created","response":{"id":"resp_codex_truncated","model":"gpt-5.4","created_at":1706000000,"status":"in_progress","output":[]}}\n\n',
      'event: response.output_item.added\n',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_codex_truncated","type":"message","role":"assistant","status":"in_progress","content":[]}}\n\n',
      'event: response.output_text.delta\n',
      'data: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_codex_truncated","delta":"partial"}\n\n',
      'data: [DONE]\n\n',
    ]));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.4',
        input: 'hello codex',
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('event: response.failed');
    expect(response.body).not.toContain('event: response.completed');
    expect(recordSuccessMock).not.toHaveBeenCalled();
    expect(recordFailureMock).toHaveBeenCalledTimes(1);
    expect(insertedProxyLogs.at(-1)).toMatchObject({
      status: 'failed',
      httpStatus: 200,
    });
    expect(String(insertedProxyLogs.at(-1)?.errorMessage || '')).toContain('stream closed before response.completed');
  });

  it('does not record success when a native responses stream completes with empty content and empty usage while empty-content failure is enabled', async () => {
    config.proxyEmptyContentFailEnabled = true;

    fetchMock.mockResolvedValue(createSseResponse([
      'event: response.created\n',
      'data: {"type":"response.created","response":{"id":"resp_codex_empty","model":"gpt-5.4","created_at":1706000000,"status":"in_progress","output":[]}}\n\n',
      'event: response.completed\n',
      'data: {"type":"response.completed","response":{"id":"resp_codex_empty","model":"gpt-5.4","status":"completed","output":[],"usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}}}\n\n',
      'data: [DONE]\n\n',
    ]));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.4',
        input: 'hello codex',
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('event: response.failed');
    expect(response.body).not.toContain('event: response.completed');
    expect(recordSuccessMock).not.toHaveBeenCalled();
    expect(recordFailureMock).toHaveBeenCalledTimes(1);
    expect(insertedProxyLogs.at(-1)).toMatchObject({
      status: 'failed',
      httpStatus: 200,
    });
    expect(String(insertedProxyLogs.at(-1)?.errorMessage || '')).toContain('empty content');
  });

  it('does not record success when a native responses stream completes with prompt tokens only and no output', async () => {
    config.proxyEmptyContentFailEnabled = true;

    fetchMock.mockResolvedValue(createSseResponse([
      'event: response.created\n',
      'data: {"type":"response.created","response":{"id":"resp_codex_prompt_only","model":"gpt-5.4","created_at":1706000000,"status":"in_progress","output":[]}}\n\n',
      'event: response.completed\n',
      'data: {"type":"response.completed","response":{"id":"resp_codex_prompt_only","model":"gpt-5.4","status":"completed","output":[],"output_text":"","usage":{"input_tokens":5,"output_tokens":0,"total_tokens":5}}}\n\n',
      'data: [DONE]\n\n',
    ]));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.4',
        input: 'hello codex',
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('event: response.failed');
    expect(response.body).not.toContain('event: response.completed');
    expect(recordSuccessMock).not.toHaveBeenCalled();
    expect(recordFailureMock).toHaveBeenCalledTimes(1);
    expect(insertedProxyLogs.at(-1)).toMatchObject({
      status: 'failed',
      httpStatus: 200,
    });
    expect(String(insertedProxyLogs.at(-1)?.errorMessage || '')).toContain('empty content');
  });

  it('does not retry or mark failure after converting a non-stream upstream payload into SSE when post-stream usage accounting fails', async () => {
    resolveProxyUsageWithSelfLogFallbackMock.mockRejectedValueOnce(new Error('usage accounting failed'));
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'resp_nonstream_final',
      object: 'response',
      model: 'gpt-5.4',
      status: 'completed',
      output: [
        {
          id: 'msg_nonstream_final',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: 'pong',
            },
          ],
        },
      ],
      output_text: 'pong',
      usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.4',
        input: 'hello codex',
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('event: response.completed');
    expect(response.body).toContain('"output_text":"pong"');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recordFailureMock).not.toHaveBeenCalled();
    expect(recordSuccessMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry or mark failure after streaming SSE success when post-stream usage accounting fails', async () => {
    resolveProxyUsageWithSelfLogFallbackMock.mockRejectedValueOnce(new Error('usage accounting failed'));
    fetchMock.mockResolvedValue(createSseResponse([
      'event: response.created\n',
      'data: {"type":"response.created","response":{"id":"resp_codex_stream_ok","model":"gpt-5.4","created_at":1706000000,"status":"in_progress","output":[]}}\n\n',
      'event: response.output_item.added\n',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_codex_stream_ok","type":"message","role":"assistant","status":"in_progress","content":[]}}\n\n',
      'event: response.output_text.delta\n',
      'data: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_codex_stream_ok","delta":"pong"}\n\n',
      'event: response.completed\n',
      'data: {"type":"response.completed","response":{"id":"resp_codex_stream_ok","model":"gpt-5.4","status":"completed","usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}\n\n',
      'data: [DONE]\n\n',
    ]));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.4',
        input: 'hello codex',
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('event: response.completed');
    expect(response.body).toContain('"id":"resp_codex_stream_ok"');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recordFailureMock).not.toHaveBeenCalled();
    expect(recordSuccessMock).toHaveBeenCalledTimes(1);
  });

  it('replays raw codex SSE when upstream mislabels a streaming responses body as application/json', async () => {
    fetchMock.mockResolvedValue(new Response([
      'event: response.created\n',
      'data: {"type":"response.created","response":{"id":"resp_codex_stream_header_miss","model":"gpt-5.4","created_at":1706000000,"status":"in_progress","output":[]}}\n\n',
      'event: response.output_item.added\n',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_codex_stream_header_miss","type":"message","role":"assistant","status":"in_progress","content":[]}}\n\n',
      'event: response.output_text.delta\n',
      'data: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_codex_stream_header_miss","delta":"pong"}\n\n',
      'event: response.completed\n',
      'data: {"type":"response.completed","response":{"id":"resp_codex_stream_header_miss","model":"gpt-5.4","status":"completed","usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}\n\n',
      'data: [DONE]\n\n',
    ].join(''), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      payload: {
        model: 'gpt-5.4',
        input: 'hello codex',
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('event: response.output_text.delta');
    expect(response.body).toContain('"delta":"pong"');
    expect(response.body).not.toContain('"output_text":"event: response.created');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recordFailureMock).not.toHaveBeenCalled();
    expect(recordSuccessMock).toHaveBeenCalledTimes(1);
  });
});
