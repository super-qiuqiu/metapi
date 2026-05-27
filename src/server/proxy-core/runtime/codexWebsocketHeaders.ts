import { config } from '../../config.js';

function getHeaderValue(headers: Record<string, string>, key: string): string {
  const expected = key.trim().toLowerCase();
  for (const [candidateKey, candidateValue] of Object.entries(headers)) {
    if (candidateKey.trim().toLowerCase() !== expected) continue;
    return candidateValue;
  }
  return '';
}

export function buildCodexWebsocketHandshakeHeaders(headers: Record<string, string>): Record<string, string> {
  const next = { ...headers };
  const websocketBeta = (config.codexResponsesWebsocketBeta || '').trim() || 'responses_websockets=2026-02-06';
  const openAiBeta = getHeaderValue(next, 'openai-beta').trim();
  if (!openAiBeta) {
    next['OpenAI-Beta'] = websocketBeta;
  } else if (!openAiBeta.includes('responses_websockets=')) {
    next['OpenAI-Beta'] = `${openAiBeta},${websocketBeta}`;
  }

  const userAgent = getHeaderValue(next, 'user-agent').toLowerCase();
  const hasSessionId = getHeaderValue(next, 'session_id').trim() !== '';
  if (userAgent.includes('mac os') && !hasSessionId) {
    next['Session_id'] = crypto.randomUUID();
  }

  return next;
}

export function buildCodexWebsocketRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'response.create',
    ...body,
  };
}

export function toCodexWebsocketUrl(requestUrl: string): string {
  const parsed = new URL(requestUrl);
  if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
  if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
  return parsed.toString();
}
