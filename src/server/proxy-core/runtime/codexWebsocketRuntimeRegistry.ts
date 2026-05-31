import type { CodexWebsocketSession } from './types.js';

type CodexWebsocketRuntimeWithAuthCleanup = {
  closeSessionsForAuthFilter(predicate: (session: CodexWebsocketSession) => boolean): void;
};

const registeredRuntimes = new Set<CodexWebsocketRuntimeWithAuthCleanup>();

export function registerCodexWebsocketRuntime<T extends CodexWebsocketRuntimeWithAuthCleanup>(runtime: T): T {
  registeredRuntimes.add(runtime);
  return runtime;
}

export function closeCodexWebsocketSessionsForAuthIdentifiers(identifiers: Array<string | number | null | undefined>): void {
  const normalized = new Set(
    identifiers
      .map((identifier) => String(identifier ?? '').trim())
      .filter((identifier) => identifier.length > 0),
  );
  if (normalized.size <= 0) return;

  for (const runtime of registeredRuntimes) {
    runtime.closeSessionsForAuthFilter((session) => normalized.has(String(session.authId ?? '').trim()));
  }
}
