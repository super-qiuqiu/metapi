import type { OAuthProviderId } from './providers.js';

// ─── OAuth 身份的规范指纹 — 三条路径共用 ────────────────────────

export interface OauthFingerprint {
  provider: OAuthProviderId;
  accountKey: string | null;
  projectId: string | null;
}

/** 从 fingerprint 生成字符串键，用于 Map 去重 */
export function fingerprintKey(fp: OauthFingerprint): string {
  return `${fp.provider}::${fp.accountKey ?? ''}::${fp.projectId ?? ''}`;
}

/** 从已有 accounts 行提取 fingerprint（backup 回放 + 去重查询用） */
export function fingerprintFromAccount(row: {
  oauthProvider: string | null;
  oauthAccountKey: string | null;
  oauthProjectId: string | null;
}): OauthFingerprint | null {
  if (!row.oauthProvider) return null;
  return {
    provider: row.oauthProvider as OAuthProviderId,
    accountKey: row.oauthAccountKey,
    projectId: row.oauthProjectId || null,
  };
}

// ─── 辅助工具函数 ────────────────────────────────────────────────

export function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function asPositiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

export function decodeJwtPayload(token?: string): Record<string, unknown> | null {
  const raw = asNonEmptyString(token);
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  try {
    const parsed = JSON.parse(Buffer.from(parts[1] || '', 'base64url').toString('utf8')) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ─── resolveOauthIdentity ────────────────────────────────────────

/** 统一身份解析结果 */
export interface OauthIdentityResult {
  fingerprint: OauthFingerprint;
  name: string;
  email?: string;
  disabled: boolean;
  exchange: {
    accessToken: string;
    refreshToken?: string;
    tokenExpiresAt?: number;
    email?: string;
    accountKey?: string;
    accountId?: string;
    planType?: string;
    projectId?: string;
    idToken?: string;
    providerData?: Record<string, unknown>;
  };
}

/**
 * 合并 resolveImportedOauthIdentity + resolveImportedNativeOauthIdentity
 * 的核心逻辑到统一入口。
 *
 * 路径 1（credentials 解析）：从 JWT claims 和 credential 字段派生
 *   email / accountKey / planType / projectId / providerData / accessToken / refreshToken /
 *   tokenExpiresAt / idToken / accountId
 *
 * 路径 2（显式字段覆盖）：explicitEmail / explicitAccountKey / explicitAccountId /
 *   explicitProjectId 覆盖派生值
 *
 * fingerprint 从最终的 accountKey 和 projectId 生成；
 * name 推导优先级链：explicitEmail || explicitAccountKey || explicitAccountId ||
 *   derived.email || derived.accountKey || derived.accountId || provider
 */
export function resolveOauthIdentity(input: {
  provider: OAuthProviderId;
  credentials: Record<string, unknown>;
  explicitEmail?: string;
  explicitAccountKey?: string;
  explicitAccountId?: string;
  explicitProjectId?: string;
  disabled?: boolean;
}): OauthIdentityResult {
  const { provider, credentials, disabled } = input;

  // ── 路径 1: 从 credentials / JWT 派生字段 ────────────────────
  const idToken = asNonEmptyString(credentials.id_token);
  const claims = decodeJwtPayload(idToken);
  const openAiAuth = isRecord(claims?.['https://api.openai.com/auth'])
    ? claims?.['https://api.openai.com/auth'] as Record<string, unknown>
    : null;

  const accessToken = asNonEmptyString(credentials.access_token)
    || asNonEmptyString(credentials.session_token);
  if (!accessToken) {
    throw new Error('oauth credentials missing access_token/session_token');
  }

  const derivedEmail = asNonEmptyString(credentials.email)
    || asNonEmptyString(claims?.email);
  const derivedAccountKey = asNonEmptyString(credentials.chatgpt_account_id)
    || asNonEmptyString(credentials.account_key)
    || asNonEmptyString(credentials.account_id)
    || asNonEmptyString(openAiAuth?.chatgpt_account_id)
    || derivedEmail;
  const derivedPlanType = asNonEmptyString(credentials.plan_type)
    || asNonEmptyString(openAiAuth?.chatgpt_plan_type);
  const derivedTokenExpiresAt = asPositiveInteger(credentials.expires_at)
    || asPositiveInteger(credentials.token_expires_at);
  const derivedProviderData = isRecord(credentials.provider_data)
    ? credentials.provider_data as Record<string, unknown>
    : undefined;
  const derivedProjectId = asNonEmptyString(credentials.project_id)
    || asNonEmptyString(credentials.cloudaicompanionProject);

  // ── 路径 2: 显式字段覆盖 ─────────────────────────────────────
  const finalEmail = input.explicitEmail || derivedEmail;
  const finalAccountKey = input.explicitAccountKey || derivedAccountKey;
  const finalAccountId = input.explicitAccountId || finalAccountKey;
  const finalProjectId = input.explicitProjectId || derivedProjectId;

  // ── 组装 exchange ─────────────────────────────────────────────
  const exchange: OauthIdentityResult['exchange'] = {
    accessToken,
    ...(asNonEmptyString(credentials.refresh_token) ? { refreshToken: asNonEmptyString(credentials.refresh_token) } : {}),
    ...(derivedTokenExpiresAt ? { tokenExpiresAt: derivedTokenExpiresAt } : {}),
    ...(idToken ? { idToken } : {}),
    ...(finalEmail ? { email: finalEmail } : {}),
    ...(finalAccountKey ? { accountKey: finalAccountKey, accountId: finalAccountId } : {}),
    ...(finalAccountId && !finalAccountKey ? { accountId: finalAccountId } : {}),
    ...(derivedPlanType ? { planType: derivedPlanType } : {}),
    ...(finalProjectId ? { projectId: finalProjectId } : {}),
    ...(derivedProviderData ? { providerData: derivedProviderData } : {}),
  };

  // 确保 accountKey / accountId 互相填充
  if (!exchange.accountKey && exchange.accountId) {
    exchange.accountKey = exchange.accountId;
  }
  if (!exchange.accountId && exchange.accountKey) {
    exchange.accountId = exchange.accountKey;
  }

  // ── 生成 fingerprint ──────────────────────────────────────────
  const fingerprint: OauthFingerprint = {
    provider,
    accountKey: exchange.accountKey ?? null,
    projectId: exchange.projectId ?? null,
  };

  // ── 推导 name ─────────────────────────────────────────────────
  // 优先级链：explicitEmail || explicitAccountKey || explicitAccountId ||
  //   derivedEmail || derivedAccountKey || provider
  // 注：原 resolveImportedOauthIdentity 中 derived.accountId === derived.accountKey，
  //     故 derivedAccountKey 已覆盖 accountId fallback。
  const name =
    input.explicitEmail
    || input.explicitAccountKey
    || input.explicitAccountId
    || derivedEmail
    || derivedAccountKey
    || provider;

  return {
    fingerprint,
    name,
    ...(finalEmail ? { email: finalEmail } : {}),
    disabled: disabled === true,
    exchange,
  };
}
