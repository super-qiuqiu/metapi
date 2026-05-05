function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asHeaderValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!Array.isArray(value)) return '';
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

export function resolveResponsesContinuityKey(input: {
  headers?: Record<string, unknown> | null;
  body?: Record<string, unknown> | null;
  clientSessionId?: string | null;
}): string {
  const fromClientContext = asTrimmedString(input.clientSessionId);
  if (fromClientContext) return fromClientContext;

  const body = input.body || null;
  if (body) {
    for (const key of ['session_id', 'session-id', 'conversation_id', 'conversation-id']) {
      const value = asTrimmedString(body[key]);
      if (value) return value;
    }
  }

  const headers = input.headers || null;
  if (!headers) return '';
  const normalizedHeaders = Object.entries(headers).map(([rawKey, rawValue]) => [
    rawKey.trim().toLowerCase(),
    asHeaderValue(rawValue),
  ] as const);
  for (const key of ['session_id', 'session-id', 'conversation_id', 'conversation-id']) {
    const match = normalizedHeaders.find(([normalizedKey, normalizedValue]) => (
      normalizedKey === key && normalizedValue
    ));
    if (match) return match[1];
  }
  return '';
}
