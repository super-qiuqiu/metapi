import { describe, expect, it } from 'vitest';
import { resolveResponsesContinuityKey } from './responsesContinuity.js';

describe('resolveResponsesContinuityKey', () => {
  it('prefers client session id when present', () => {
    expect(resolveResponsesContinuityKey({
      clientSessionId: 'sess-client-1',
      body: { session_id: 'sess-body-1' },
      headers: { session_id: 'sess-header-1' },
    })).toBe('sess-client-1');
  });

  it('falls back to body continuity fields before headers', () => {
    expect(resolveResponsesContinuityKey({
      clientSessionId: null,
      body: { conversation_id: 'conv-body-1' },
      headers: { session_id: 'sess-header-1' },
    })).toBe('conv-body-1');
  });

  it('reads continuity fields from headers case-insensitively', () => {
    expect(resolveResponsesContinuityKey({
      clientSessionId: null,
      body: null,
      headers: { Conversation_Id: 'conv-header-1' },
    })).toBe('conv-header-1');
  });
});
