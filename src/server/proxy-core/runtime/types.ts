import type WebSocket from 'ws';

export type CodexWebsocketRuntimeSendInput = {
  sessionId: string;
  requestUrl: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  authId?: string | null;
  agent?: unknown;
  onEvent?: (event: Record<string, unknown>) => void;
  onTimeline?: (event: CodexWebsocketTimelineEvent) => void;
};

export type CodexWebsocketRuntimeResult = {
  events: Array<Record<string, unknown>>;
  reusedSession: boolean;
};

export type CodexWebsocketSession = {
  sessionId: string;
  authId: string | null;
  socket: WebSocket | null;
  socketUrl: string | null;
  readLoopSocket: WebSocket | null;
  activeRequest: CodexWebsocketActiveRequest | null;
  queue: Promise<unknown>;
  upstreamDisconnect: CodexWebsocketDisconnectSignal;
  createdAtMs: number;
  lastActivityMs: number;
};

export type CodexWebsocketActiveRequest = {
  socket: WebSocket;
  events: Array<Record<string, unknown>>;
  reusedSession: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  onEvent?: (event: Record<string, unknown>) => void;
  onTimeline?: (event: CodexWebsocketTimelineEvent) => void;
  resolve: (result: CodexWebsocketRuntimeResult) => void;
  reject: (error: Error) => void;
};

export type CodexWebsocketDisconnectSignal = {
  fired: boolean;
  error: Error | null;
  promise: Promise<Error>;
  resolve: (error: Error) => void;
};

export type CodexWebsocketTimelineEvent = {
  event: 'request' | 'response' | 'disconnect' | 'error' | 'reconnect';
  timestamp: string;
  sessionId: string;
  reason?: string;
  payload?: unknown;
};

export type CodexWebsocketSessionStore = {
  getOrCreate(sessionId: string): CodexWebsocketSession;
  take(sessionId: string): CodexWebsocketSession | null;
  list(): CodexWebsocketSession[];
  sweepExpired(nowMs?: number): void;
};
