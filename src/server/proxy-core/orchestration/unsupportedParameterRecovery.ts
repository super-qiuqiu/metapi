function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function extractUnsupportedParameterName(rawErrText: string): string | null {
  const trimmed = String(rawErrText || '').trim();
  if (!trimmed) return null;

  const candidates: string[] = [trimmed];
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const detail = typeof parsed.detail === 'string' ? parsed.detail.trim() : '';
    if (detail) candidates.push(detail);
    if (isRecord(parsed.error)) {
      const message = typeof parsed.error.message === 'string' ? parsed.error.message.trim() : '';
      if (message) candidates.push(message);
      const detailText = typeof parsed.error.detail === 'string' ? parsed.error.detail.trim() : '';
      if (detailText) candidates.push(detailText);
    }
  } catch {
    // non-json payload, fallback to regex on raw text
  }

  for (const candidate of candidates) {
    const matched = candidate.match(/unsupported\s+parameter\s*:\s*["'`]?([a-zA-Z0-9_.-]+)/i);
    if (matched?.[1]) {
      return matched[1].trim();
    }
  }

  return null;
}

export function dropUnsupportedParameterFromBody(
  body: Record<string, unknown>,
  parameter: string,
): Record<string, unknown> | null {
  const normalized = parameter.trim();
  if (!normalized) return null;
  if (!Object.prototype.hasOwnProperty.call(body, normalized)) return null;
  const nextBody = { ...body };
  delete nextBody[normalized];
  return nextBody;
}
