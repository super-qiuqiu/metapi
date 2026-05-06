import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import {
  getOauthInfoFromAccount,
  buildOauthInfoFromAccount,
  buildStoredOauthStateFromAccount,
} from './oauthAccount.js';
import { mergeAccountExtraConfig } from '../accountExtraConfig.js';
import { refreshOauthAccessToken } from './service.js';

type RefreshResult = Awaited<ReturnType<typeof refreshOauthAccessToken>>;

/** Enriched result that includes the new refreshToken for cross-account propagation. */
type EnrichedRefreshResult = RefreshResult & {
  /** The new refresh token returned by the upstream provider (after rotation). */
  newRefreshToken?: string;
  /** The old refresh token that was used — used as the singleflight key. */
  oldRefreshToken?: string;
};

// Level 1: accountId → in-flight promise
const accountInFlight = new Map<number, Promise<EnrichedRefreshResult>>();

// Level 2: refreshToken → in-flight promise (prevents concurrent rotation of the same token)
const tokenInFlight = new Map<string, Promise<EnrichedRefreshResult>>();

/**
 * Refresh an OAuth access token with two-level singleflight deduplication:
 *
 * Level 1 (accountId): Same accountId concurrent calls share one refresh.
 * Level 2 (refreshToken): Different accountIds sharing the same refreshToken
 *   wait for the first refresh to complete, then copy the new tokens into
 *   their own DB row — without issuing a second HTTP request to the provider.
 *   This is critical for providers that use refresh token rotation (e.g. Codex/OpenAI),
 *   where re-using an old refreshToken triggers `refresh_token_reused` and
 *   irreversibly invalidates the entire session.
 */
export async function refreshOauthAccessTokenSingleflight(accountId: number): Promise<RefreshResult> {
  // --- Level 1: accountId dedup ---
  const existingAccount = accountInFlight.get(accountId);
  if (existingAccount) {
    return existingAccount;
  }

  // --- Level 2: refreshToken dedup ---
  // Read current account's refreshToken to check for cross-account conflicts.
  const account = await db.select().from(schema.accounts)
    .where(eq(schema.accounts.id, accountId))
    .get();

  const oauth = account ? getOauthInfoFromAccount(account) : null;
  const currentRefreshToken = oauth?.refreshToken;

  if (currentRefreshToken) {
    const existingToken = tokenInFlight.get(currentRefreshToken);
    if (existingToken) {
      // Another accountId is already refreshing this exact refreshToken.
      // Wait for it, then apply the new tokens to *this* accountId without
      // making another HTTP request.
      const promise = applyRefreshResultFromOtherAccount(accountId, account!, existingToken);
      accountInFlight.set(accountId, promise);
      try {
        return await promise;
      } finally {
        accountInFlight.delete(accountId);
      }
    }
  }

  // --- No in-flight conflict: perform the actual refresh ---
  const promise = (async (): Promise<EnrichedRefreshResult> => {
    const result = await refreshOauthAccessToken(accountId);

    // After refresh, read back the new refreshToken from the updated DB row
    let newRefreshToken: string | undefined;
    try {
      const updated = await db.select().from(schema.accounts)
        .where(eq(schema.accounts.id, accountId))
        .get();
      if (updated) {
        const updatedOauth = getOauthInfoFromAccount(updated);
        newRefreshToken = updatedOauth?.refreshToken;
      }
    } catch {
      // best effort
    }

    return {
      ...result,
      newRefreshToken,
      oldRefreshToken: currentRefreshToken || undefined,
    };
  })();

  // Register in both maps
  accountInFlight.set(accountId, promise);
  if (currentRefreshToken) {
    tokenInFlight.set(currentRefreshToken, promise);
  }

  try {
    return await promise;
  } finally {
    accountInFlight.delete(accountId);
    if (currentRefreshToken) {
      // Clean up token map after all waiters have had a chance to observe
      void promise.then(
        () => { tokenInFlight.delete(currentRefreshToken); },
        () => { tokenInFlight.delete(currentRefreshToken); },
      );
    }
  }
}

/**
 * Wait for another account's refresh to complete, then apply the resulting
 * tokens to *this* account's DB row. No HTTP request to the provider.
 */
async function applyRefreshResultFromOtherAccount(
  accountId: number,
  currentAccount: typeof schema.accounts.$inferSelect,
  otherRefresh: Promise<EnrichedRefreshResult>,
): Promise<EnrichedRefreshResult> {
  const otherResult = await otherRefresh;

  const currentOauth = getOauthInfoFromAccount(currentAccount);
  if (!currentOauth) {
    throw new Error('oauth info missing for account ' + accountId);
  }

  // Build updated oauth state using the new tokens from the other account's refresh
  const nextOauth = buildOauthInfoFromAccount(currentAccount, {
    provider: currentOauth.provider,
    accountId: currentOauth.accountId,
    accountKey: currentOauth.accountKey || currentOauth.accountId,
    email: currentOauth.email,
    planType: currentOauth.planType,
    projectId: currentOauth.projectId,
    refreshToken: otherResult.newRefreshToken || currentOauth.refreshToken,
    tokenExpiresAt: currentOauth.tokenExpiresAt,
    idToken: currentOauth.idToken,
  });

  const extraConfig = mergeAccountExtraConfig(currentAccount.extraConfig, {
    credentialMode: 'session',
    oauth: buildStoredOauthStateFromAccount(currentAccount, nextOauth),
  });

  await db.update(schema.accounts).set({
    accessToken: otherResult.accessToken,
    oauthProvider: currentOauth.provider,
    oauthAccountKey: nextOauth.accountKey || nextOauth.accountId || null,
    extraConfig,
    status: 'active',
    updatedAt: new Date().toISOString(),
  }).where(eq(schema.accounts.id, accountId)).run();

  return {
    accountId,
    accessToken: otherResult.accessToken,
    accountKey: nextOauth.accountKey || nextOauth.accountId,
    extraConfig,
    newRefreshToken: otherResult.newRefreshToken,
    oldRefreshToken: otherResult.oldRefreshToken,
  };
}
