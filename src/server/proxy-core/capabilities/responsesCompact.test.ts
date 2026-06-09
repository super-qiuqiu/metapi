import { describe, expect, it } from 'vitest';

import {
  ensureCompactResponsesJsonAcceptHeader,
  sanitizeCompactResponsesRequestBody,
  shouldForceResponsesUpstreamStream,
} from './responsesCompact.js';

describe('sanitizeCompactResponsesRequestBody', () => {
  it('keeps only the official compact DTO fields for codex compact requests', () => {
    expect(sanitizeCompactResponsesRequestBody({
      model: 'gpt-5.2',
      stream: true,
      stream_options: { include_obfuscation: true },
      store: false,
      temperature: 0.2,
      service_tier: 'priority',
      input: 'hello',
      instructions: 'compact this conversation',
      previous_response_id: 'resp_123',
    }, {
      sitePlatform: 'codex',
    })).toEqual({
      model: 'gpt-5.2',
      input: 'hello',
      instructions: 'compact this conversation',
      previous_response_id: 'resp_123',
    });
  });

  it('keeps only the official compact DTO fields for sub2api compact requests', () => {
    expect(sanitizeCompactResponsesRequestBody({
      model: 'gpt-5.2',
      stream: true,
      stream_options: { include_obfuscation: true },
      store: false,
      metadata: { ignored: true },
      input: 'hello',
    }, {
      sitePlatform: 'sub2api',
    })).toEqual({
      model: 'gpt-5.2',
      input: 'hello',
    });
  });

  it('keeps store for unrelated compact platforms while still removing stream fields', () => {
    expect(sanitizeCompactResponsesRequestBody({
      stream: true,
      stream_options: { include_obfuscation: true },
      store: false,
      input: 'hello',
    }, {
      sitePlatform: 'openai',
    })).toEqual({
      store: false,
      input: 'hello',
    });
  });
});

describe('shouldForceResponsesUpstreamStream', () => {
  it('forces non-compact responses streaming for codex and sub2api', () => {
    expect(shouldForceResponsesUpstreamStream({
      sitePlatform: 'codex',
      isCompactRequest: false,
    })).toBe(true);
    expect(shouldForceResponsesUpstreamStream({
      sitePlatform: 'sub2api',
      isCompactRequest: false,
    })).toBe(true);
  });

  it('does not force compact or unrelated platforms', () => {
    expect(shouldForceResponsesUpstreamStream({
      sitePlatform: 'codex',
      isCompactRequest: true,
    })).toBe(false);
    expect(shouldForceResponsesUpstreamStream({
      sitePlatform: 'openai',
      isCompactRequest: false,
    })).toBe(false);
  });
});

describe('ensureCompactResponsesJsonAcceptHeader', () => {
  it('adds application/json accept for codex and sub2api compact requests when missing', () => {
    expect(ensureCompactResponsesJsonAcceptHeader({}, {
      sitePlatform: 'codex',
    })).toEqual({
      accept: 'application/json',
    });
    expect(ensureCompactResponsesJsonAcceptHeader({}, {
      sitePlatform: 'sub2api',
    })).toEqual({
      accept: 'application/json',
    });
  });

  it('forces compact requests back to application/json even when callers asked for SSE', () => {
    expect(ensureCompactResponsesJsonAcceptHeader({
      Accept: 'text/event-stream',
    }, {
      sitePlatform: 'codex',
    })).toEqual({
      accept: 'application/json',
    });
  });

  it('preserves unrelated platforms', () => {
    expect(ensureCompactResponsesJsonAcceptHeader({}, {
      sitePlatform: 'openai',
    })).toEqual({});
  });
});
