import type { CodexWebsocketSession, CodexWebsocketSessionStore } from './types.js';

const MAX_CODEX_WS_SESSIONS = 10_000;
const CODEX_WS_SESSION_TTL_MS = 30 * 60 * 1000;

export function createCodexWebsocketSessionStore(): CodexWebsocketSessionStore {
  const sessions = new Map<string, CodexWebsocketSession>();

  return {
    getOrCreate(sessionId) {
      const normalized = sessionId.trim();
      const existing = sessions.get(normalized);
      if (existing) {
        existing.lastActivityMs = Date.now();
        return existing;
      }

      const nowMs = Date.now();
      const created: CodexWebsocketSession = {
        sessionId: normalized,
        socket: null,
        socketUrl: null,
        queue: Promise.resolve(),
        upstreamDisconnectOnce: {
          fired: false,
          subscribers: [],
        },
        createdAtMs: nowMs,
        lastActivityMs: nowMs,
      };
      sessions.set(normalized, created);
      return created;
    },
    take(sessionId) {
      const normalized = sessionId.trim();
      if (!normalized) return null;
      const existing = sessions.get(normalized) || null;
      if (existing) {
        sessions.delete(normalized);
      }
      return existing;
    },
    list() {
      return [...sessions.values()];
    },
    sweepExpired(nowMs = Date.now()) {
      for (const [key, session] of sessions.entries()) {
        if (session.queue !== Promise.resolve()) continue;
        if (session.socket) continue;
        if (nowMs - session.lastActivityMs < CODEX_WS_SESSION_TTL_MS) continue;
        sessions.delete(key);
      }
      while (sessions.size > MAX_CODEX_WS_SESSIONS) {
        const oldestKey = sessions.keys().next().value;
        if (!oldestKey) break;
        sessions.delete(oldestKey);
      }
    },
  };
}
