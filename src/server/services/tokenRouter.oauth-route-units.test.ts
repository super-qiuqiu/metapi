import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';

type DbModule = typeof import('../db/index.js');
type TokenRouterModule = typeof import('./tokenRouter.js');

describe('TokenRouter oauth route units', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let TokenRouter: TokenRouterModule['TokenRouter'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let tokenRouterTestUtils: TokenRouterModule['__tokenRouterTestUtils'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-token-router-oauth-route-units-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const tokenRouterModule = await import('./tokenRouter.js');
    db = dbModule.db;
    schema = dbModule.schema;
    TokenRouter = tokenRouterModule.TokenRouter;
    invalidateTokenRouterCache = tokenRouterModule.invalidateTokenRouterCache;
    tokenRouterTestUtils = tokenRouterModule.__tokenRouterTestUtils;
  });

  beforeEach(async () => {
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.oauthRouteUnitMembers).run();
    await db.delete(schema.oauthRouteUnits).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    invalidateTokenRouterCache();
  });

  afterAll(() => {
    invalidateTokenRouterCache();
    delete process.env.DATA_DIR;
  });

  it('round robins across healthy oauth route unit members while keeping a single outer channel', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'ChatGPT Codex OAuth',
      url: 'https://chatgpt.com/backend-api/codex',
      platform: 'codex',
      status: 'active',
    }).returning().get();

    const accountA = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'rr-a@example.com',
      accessToken: 'oauth-access-token-a',
      apiToken: null,
      status: 'active',
      oauthProvider: 'codex',
      oauthAccountKey: 'chatgpt-rr-a',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: { provider: 'codex', accountId: 'chatgpt-rr-a', email: 'rr-a@example.com' },
      }),
    }).returning().get();
    const accountB = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'rr-b@example.com',
      accessToken: 'oauth-access-token-b',
      apiToken: null,
      status: 'active',
      oauthProvider: 'codex',
      oauthAccountKey: 'chatgpt-rr-b',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: { provider: 'codex', accountId: 'chatgpt-rr-b', email: 'rr-b@example.com' },
      }),
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.4',
      enabled: true,
    }).returning().get();
    const routeUnit = await db.insert(schema.oauthRouteUnits).values({
      siteId: site.id,
      provider: 'codex',
      name: 'Codex RR Pool',
      strategy: 'round_robin',
      enabled: true,
    }).returning().get();
    await db.insert(schema.oauthRouteUnitMembers).values([
      { unitId: routeUnit.id, accountId: accountA.id, sortOrder: 0 },
      { unitId: routeUnit.id, accountId: accountB.id, sortOrder: 1 },
    ]).run();
    await db.insert(schema.modelAvailability).values([
      { accountId: accountA.id, modelName: 'gpt-5.4', available: true },
      { accountId: accountB.id, modelName: 'gpt-5.4', available: true },
    ]).run();
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: null,
      oauthRouteUnitId: routeUnit.id,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
    }).returning().get();

    const router = new TokenRouter();
    const first = await router.selectChannel('gpt-5.4');
    const second = await router.selectChannel('gpt-5.4');

    expect(first?.channel.id).toBe(channel.id);
    expect(second?.channel.id).toBe(channel.id);
    expect(first?.account.id).toBe(accountA.id);
    expect(second?.account.id).toBe(accountB.id);
  });

  it('sticks to the same oauth route unit member until it becomes unavailable', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'ChatGPT Codex OAuth',
      url: 'https://chatgpt.com/backend-api/codex',
      platform: 'codex',
      status: 'active',
    }).returning().get();

    const accountA = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'sticky-a@example.com',
      accessToken: 'oauth-access-token-a',
      apiToken: null,
      status: 'active',
      oauthProvider: 'codex',
      oauthAccountKey: 'chatgpt-sticky-a',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: { provider: 'codex', accountId: 'chatgpt-sticky-a', email: 'sticky-a@example.com' },
      }),
    }).returning().get();
    const accountB = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'sticky-b@example.com',
      accessToken: 'oauth-access-token-b',
      apiToken: null,
      status: 'active',
      oauthProvider: 'codex',
      oauthAccountKey: 'chatgpt-sticky-b',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: { provider: 'codex', accountId: 'chatgpt-sticky-b', email: 'sticky-b@example.com' },
      }),
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.4',
      routingStrategy: 'stable_first',
      enabled: true,
    }).returning().get();
    const routeUnit = await db.insert(schema.oauthRouteUnits).values({
      siteId: site.id,
      provider: 'codex',
      name: 'Codex Sticky Pool',
      strategy: 'stick_until_unavailable',
      enabled: true,
    }).returning().get();
    await db.insert(schema.oauthRouteUnitMembers).values([
      { unitId: routeUnit.id, accountId: accountA.id, sortOrder: 0 },
      { unitId: routeUnit.id, accountId: accountB.id, sortOrder: 1 },
    ]).run();
    await db.insert(schema.modelAvailability).values([
      { accountId: accountA.id, modelName: 'gpt-5.4', available: true },
      { accountId: accountB.id, modelName: 'gpt-5.4', available: true },
    ]).run();
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: null,
      oauthRouteUnitId: routeUnit.id,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
    }).returning().get();

    const router = new TokenRouter();
    const first = await router.selectChannel('gpt-5.4');
    const second = await router.selectChannel('gpt-5.4');
    expect(first?.account.id).toBe(accountA.id);
    expect(second?.account.id).toBe(accountA.id);

    await router.recordFailure(channel.id, { status: 503, errorText: 'unavailable' }, accountA.id);
    const third = await router.selectChannel('gpt-5.4');
    expect(third?.channel.id).toBe(channel.id);
    expect(third?.account.id).toBe(accountB.id);
  });

  it('keeps unrelated stable-first cache entries when pooled member state updates', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'ChatGPT Codex OAuth',
      url: 'https://chatgpt.com/backend-api/codex',
      platform: 'codex',
      status: 'active',
    }).returning().get();

    const accountA = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'cache-a@example.com',
      accessToken: 'oauth-cache-access-a',
      apiToken: null,
      status: 'active',
      oauthProvider: 'codex',
      oauthAccountKey: 'chatgpt-cache-a',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: { provider: 'codex', accountId: 'chatgpt-cache-a', email: 'cache-a@example.com' },
      }),
    }).returning().get();
    const accountB = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'cache-b@example.com',
      accessToken: 'oauth-cache-access-b',
      apiToken: null,
      status: 'active',
      oauthProvider: 'codex',
      oauthAccountKey: 'chatgpt-cache-b',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: { provider: 'codex', accountId: 'chatgpt-cache-b', email: 'cache-b@example.com' },
      }),
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.4',
      routingStrategy: 'weighted',
      enabled: true,
    }).returning().get();
    const routeUnit = await db.insert(schema.oauthRouteUnits).values({
      siteId: site.id,
      provider: 'codex',
      name: 'Cache Pool',
      strategy: 'round_robin',
      enabled: true,
    }).returning().get();
    await db.insert(schema.oauthRouteUnitMembers).values([
      { unitId: routeUnit.id, accountId: accountA.id, sortOrder: 0 },
      { unitId: routeUnit.id, accountId: accountB.id, sortOrder: 1 },
    ]).run();
    await db.insert(schema.modelAvailability).values([
      { accountId: accountA.id, modelName: 'gpt-5.4', available: true },
      { accountId: accountB.id, modelName: 'gpt-5.4', available: true },
    ]).run();
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: null,
      oauthRouteUnitId: routeUnit.id,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
    }).returning().get();

    tokenRouterTestUtils.rememberStableFirstSiteSelectionForKey('999:other-model', 77);
    expect(tokenRouterTestUtils.getStableFirstRotationCacheSize()).toBe(1);

    const router = new TokenRouter();
    const selected = await router.selectChannel('gpt-5.4');
    expect(selected?.channel.id).toBe(channel.id);
    expect(tokenRouterTestUtils.getStableFirstRotationCacheSize()).toBe(1);

    await router.recordFailure(channel.id, { status: 503, errorText: 'pooled unavailable' }, accountA.id);
    expect(tokenRouterTestUtils.getStableFirstRotationCacheSize()).toBe(1);
  });

  it('fails closed when a pooled channel has no loaded members', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'ChatGPT Codex OAuth',
      url: 'https://chatgpt.com/backend-api/codex',
      platform: 'codex',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'missing-members@example.com',
      accessToken: 'oauth-access-token-missing-members',
      apiToken: null,
      status: 'active',
      oauthProvider: 'codex',
      oauthAccountKey: 'chatgpt-missing-members',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: { provider: 'codex', accountId: 'chatgpt-missing-members', email: 'missing-members@example.com' },
      }),
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.4',
      enabled: true,
    }).returning().get();
    const routeUnit = await db.insert(schema.oauthRouteUnits).values({
      siteId: site.id,
      provider: 'codex',
      name: 'Broken Pool',
      strategy: 'round_robin',
      enabled: true,
    }).returning().get();
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: null,
      oauthRouteUnitId: routeUnit.id,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
    }).run();

    const router = new TokenRouter();
    const selected = await router.selectChannel('gpt-5.4');

    expect(selected).toBeNull();
  });

  it('uses the api token fallback for pooled oauth members when the access token is blank', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'ChatGPT Codex OAuth',
      url: 'https://chatgpt.com/backend-api/codex',
      platform: 'codex',
      status: 'active',
    }).returning().get();

    const accountA = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'fallback-a@example.com',
      accessToken: '   ',
      apiToken: 'oauth-api-token-a',
      status: 'active',
      oauthProvider: 'codex',
      oauthAccountKey: 'chatgpt-fallback-a',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: { provider: 'codex', accountId: 'chatgpt-fallback-a', email: 'fallback-a@example.com' },
      }),
    }).returning().get();
    const accountB = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'fallback-b@example.com',
      accessToken: 'oauth-access-token-b',
      apiToken: null,
      status: 'active',
      oauthProvider: 'codex',
      oauthAccountKey: 'chatgpt-fallback-b',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: { provider: 'codex', accountId: 'chatgpt-fallback-b', email: 'fallback-b@example.com' },
      }),
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.4',
      enabled: true,
    }).returning().get();
    const routeUnit = await db.insert(schema.oauthRouteUnits).values({
      siteId: site.id,
      provider: 'codex',
      name: 'Fallback Pool',
      strategy: 'round_robin',
      enabled: true,
    }).returning().get();
    await db.insert(schema.oauthRouteUnitMembers).values([
      { unitId: routeUnit.id, accountId: accountA.id, sortOrder: 0 },
      { unitId: routeUnit.id, accountId: accountB.id, sortOrder: 1 },
    ]).run();
    await db.insert(schema.modelAvailability).values([
      { accountId: accountA.id, modelName: 'gpt-5.4', available: true },
      { accountId: accountB.id, modelName: 'gpt-5.4', available: true },
    ]).run();
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: null,
      oauthRouteUnitId: routeUnit.id,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
    }).returning().get();

    const router = new TokenRouter();
    const selected = await router.selectChannel('gpt-5.4');

    expect(selected?.channel.id).toBe(channel.id);
    expect(selected?.account.id).toBe(accountA.id);
    expect(selected?.tokenValue).toBe('oauth-api-token-a');
  });

  it('does not immediately retry the same pooled member during failover when it just failed', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'ChatGPT Codex OAuth',
      url: 'https://chatgpt.com/backend-api/codex',
      platform: 'codex',
      status: 'active',
    }).returning().get();

    const accountA = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'failover-a@example.com',
      accessToken: 'oauth-access-token-a',
      apiToken: null,
      status: 'active',
      oauthProvider: 'codex',
      oauthAccountKey: 'chatgpt-failover-a',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: { provider: 'codex', accountId: 'chatgpt-failover-a', email: 'failover-a@example.com' },
      }),
    }).returning().get();
    const accountB = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'failover-b@example.com',
      accessToken: 'oauth-access-token-b',
      apiToken: null,
      status: 'disabled',
      oauthProvider: 'codex',
      oauthAccountKey: 'chatgpt-failover-b',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: { provider: 'codex', accountId: 'chatgpt-failover-b', email: 'failover-b@example.com' },
      }),
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.4',
      enabled: true,
    }).returning().get();
    const routeUnit = await db.insert(schema.oauthRouteUnits).values({
      siteId: site.id,
      provider: 'codex',
      name: 'Failover Pool',
      strategy: 'round_robin',
      enabled: true,
    }).returning().get();
    await db.insert(schema.oauthRouteUnitMembers).values([
      { unitId: routeUnit.id, accountId: accountA.id, sortOrder: 0 },
      { unitId: routeUnit.id, accountId: accountB.id, sortOrder: 1 },
    ]).run();
    await db.insert(schema.modelAvailability).values([
      { accountId: accountA.id, modelName: 'gpt-5.4', available: true },
      { accountId: accountB.id, modelName: 'gpt-5.4', available: true },
    ]).run();
    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: accountA.id,
      tokenId: null,
      oauthRouteUnitId: routeUnit.id,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: false,
    }).returning().get();

    const router = new TokenRouter();
    const first = await router.selectChannel('gpt-5.4');
    expect(first?.account.id).toBe(accountA.id);

    await router.recordFailure(channel.id, { status: 503, errorText: 'upstream unavailable' }, accountA.id);
    const failover = await router.selectNextChannel('gpt-5.4', [channel.id]);

    expect(failover).toBeNull();
  });

  describe('codex sticky account mode', () => {
    const originalStickyEnabled = config.codexStickyAccountEnabled;
    const originalQuotaThreshold = config.codexStickyAccountQuotaThresholdPercent;

    beforeAll(() => {
      config.codexStickyAccountEnabled = true;
      config.codexStickyAccountQuotaThresholdPercent = 10;
    });

    afterAll(() => {
      config.codexStickyAccountEnabled = originalStickyEnabled;
      config.codexStickyAccountQuotaThresholdPercent = originalQuotaThreshold;
    });

    it('sticks to the same codex account across calls when quota is healthy', async () => {
      const site = await db.insert(schema.sites).values({
        name: 'ChatGPT Codex OAuth',
        url: 'https://chatgpt.com/backend-api/codex',
        platform: 'codex',
        status: 'active',
      }).returning().get();

      const accountA = await db.insert(schema.accounts).values({
        siteId: site.id,
        username: 'sticky-healthy-a@example.com',
        accessToken: 'oauth-sticky-healthy-a',
        apiToken: null,
        status: 'active',
        oauthProvider: 'codex',
        oauthAccountKey: 'chatgpt-sticky-healthy-a',
        extraConfig: JSON.stringify({
          credentialMode: 'session',
          oauth: {
            provider: 'codex',
            accountId: 'chatgpt-sticky-healthy-a',
            email: 'sticky-healthy-a@example.com',
            quota: {
              status: 'supported',
              source: 'official',
              windows: {
                fiveHour: { supported: true, used: 50, limit: 100, remaining: 50 },
                sevenDay: { supported: true, used: 60, limit: 100, remaining: 40 },
              },
            },
          },
        }),
      }).returning().get();

      const accountB = await db.insert(schema.accounts).values({
        siteId: site.id,
        username: 'sticky-healthy-b@example.com',
        accessToken: 'oauth-sticky-healthy-b',
        apiToken: null,
        status: 'active',
        oauthProvider: 'codex',
        oauthAccountKey: 'chatgpt-sticky-healthy-b',
        extraConfig: JSON.stringify({
          credentialMode: 'session',
          oauth: {
            provider: 'codex',
            accountId: 'chatgpt-sticky-healthy-b',
            email: 'sticky-healthy-b@example.com',
            quota: {
              status: 'supported',
              source: 'official',
              windows: {
                fiveHour: { supported: true, used: 30, limit: 100, remaining: 70 },
                sevenDay: { supported: true, used: 20, limit: 100, remaining: 80 },
              },
            },
          },
        }),
      }).returning().get();

      const route = await db.insert(schema.tokenRoutes).values({
        modelPattern: 'gpt-5.4-sticky',
        routingStrategy: 'round_robin',
        enabled: true,
      }).returning().get();
      const routeUnit = await db.insert(schema.oauthRouteUnits).values({
        siteId: site.id,
        provider: 'codex',
        name: 'Codex Sticky Pool',
        strategy: 'round_robin',
        enabled: true,
      }).returning().get();
      await db.insert(schema.oauthRouteUnitMembers).values([
        { unitId: routeUnit.id, accountId: accountA.id, sortOrder: 0 },
        { unitId: routeUnit.id, accountId: accountB.id, sortOrder: 1 },
      ]).run();
      await db.insert(schema.modelAvailability).values([
        { accountId: accountA.id, modelName: 'gpt-5.4-sticky', available: true },
        { accountId: accountB.id, modelName: 'gpt-5.4-sticky', available: true },
      ]).run();
      await db.insert(schema.routeChannels).values({
        routeId: route.id,
        accountId: accountA.id,
        tokenId: null,
        oauthRouteUnitId: routeUnit.id,
        priority: 0,
        weight: 10,
        enabled: true,
        manualOverride: false,
      }).run();

      const router = new TokenRouter();
      const first = await router.selectChannel('gpt-5.4-sticky');
      const second = await router.selectChannel('gpt-5.4-sticky');
      // Even though strategy is round_robin, sticky account mode should pick the
      // same account on both calls (account B has higher remaining so it goes
      // first, then sticks).
      expect(first?.account.id).toBeDefined();
      expect(second?.account.id).toBe(first?.account.id);
    });

    it('switches to another codex account when sticky account quota drops below threshold', async () => {
      const site = await db.insert(schema.sites).values({
        name: 'ChatGPT Codex OAuth',
        url: 'https://chatgpt.com/backend-api/codex',
        platform: 'codex',
        status: 'active',
      }).returning().get();

      // Account A: low quota (7% remaining — below 10% threshold)
      const accountA = await db.insert(schema.accounts).values({
        siteId: site.id,
        username: 'sticky-low-a@example.com',
        accessToken: 'oauth-sticky-low-a',
        apiToken: null,
        status: 'active',
        oauthProvider: 'codex',
        oauthAccountKey: 'chatgpt-sticky-low-a',
        extraConfig: JSON.stringify({
          credentialMode: 'session',
          oauth: {
            provider: 'codex',
            accountId: 'chatgpt-sticky-low-a',
            email: 'sticky-low-a@example.com',
            quota: {
              status: 'supported',
              source: 'official',
              windows: {
                fiveHour: { supported: true, used: 93, limit: 100, remaining: 7 },
                sevenDay: { supported: true, used: 95, limit: 100, remaining: 5 },
              },
            },
          },
        }),
      }).returning().get();

      // Account B: healthy quota (40% remaining — above 10% threshold)
      const accountB = await db.insert(schema.accounts).values({
        siteId: site.id,
        username: 'sticky-low-b@example.com',
        accessToken: 'oauth-sticky-low-b',
        apiToken: null,
        status: 'active',
        oauthProvider: 'codex',
        oauthAccountKey: 'chatgpt-sticky-low-b',
        extraConfig: JSON.stringify({
          credentialMode: 'session',
          oauth: {
            provider: 'codex',
            accountId: 'chatgpt-sticky-low-b',
            email: 'sticky-low-b@example.com',
            quota: {
              status: 'supported',
              source: 'official',
              windows: {
                fiveHour: { supported: true, used: 60, limit: 100, remaining: 40 },
                sevenDay: { supported: true, used: 55, limit: 100, remaining: 45 },
              },
            },
          },
        }),
      }).returning().get();

      const route = await db.insert(schema.tokenRoutes).values({
        modelPattern: 'gpt-5.4-low-quota',
        routingStrategy: 'round_robin',
        enabled: true,
      }).returning().get();
      const routeUnit = await db.insert(schema.oauthRouteUnits).values({
        siteId: site.id,
        provider: 'codex',
        name: 'Codex Low Quota Pool',
        strategy: 'round_robin',
        enabled: true,
      }).returning().get();
      await db.insert(schema.oauthRouteUnitMembers).values([
        { unitId: routeUnit.id, accountId: accountA.id, sortOrder: 0 },
        { unitId: routeUnit.id, accountId: accountB.id, sortOrder: 1 },
      ]).run();
      await db.insert(schema.modelAvailability).values([
        { accountId: accountA.id, modelName: 'gpt-5.4-low-quota', available: true },
        { accountId: accountB.id, modelName: 'gpt-5.4-low-quota', available: true },
      ]).run();
      await db.insert(schema.routeChannels).values({
        routeId: route.id,
        accountId: accountA.id,
        tokenId: null,
        oauthRouteUnitId: routeUnit.id,
        priority: 0,
        weight: 10,
        enabled: true,
        manualOverride: false,
      }).run();

      const router = new TokenRouter();
      // First call: A has low quota (5% < 10%), so should pick B (higher remaining).
      const first = await router.selectChannel('gpt-5.4-low-quota');
      expect(first?.account.id).toBe(accountB.id);
      // Second call: still B (sticky, quota still healthy)
      const second = await router.selectChannel('gpt-5.4-low-quota');
      expect(second?.account.id).toBe(accountB.id);
    });
  });
});
