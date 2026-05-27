import type WebSocket from 'ws';

export type CodexWebsocketRuntimeSendInput = {
  sessionId: string;
  requestUrl: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  agent?: unknown;
  onEvent?: (event: Record<string, unknown>) => void;
};

export type CodexWebsocketRuntimeResult = {
  events: Array<Record<string, unknown>>;
  reusedSession: boolean;
};

export type CodexWebsocketSession = {
  sessionId: string;
  socket: WebSocket | null;
  socketUrl: string | null;
  queue: Promise<unknown>;
  upstreamDisconnectOnce: {
    fired: boolean;
    subscribers: Array<(error: Error) => void>;
  };
  createdAtMs: number;
  lastActivityMs: number;
};

export type CodexWebsocketSessionStore = {
  getOrCreate(sessionId: string): CodexWebsocketSession;
  take(sessionId: string): CodexWebsocketSession | null;
  list(): CodexWebsocketSession[];
  sweepExpired(nowMs?: number): void;
};
