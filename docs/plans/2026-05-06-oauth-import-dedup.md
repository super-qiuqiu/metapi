# OAuth 导入去重重构实施计划

> **For Hermes:** 使用 subagent-driven-development 逐任务实施。

**目标：** 统一 OAuth 身份解析与去重，消除五个缺陷，使 import/callback/backup 三条路径共享单一身份真相源。

**架构：** OauthIdentityResolver 统一 fingerprint + UNIQUE 约束兜底 + Dialect-Aware Upsert (SQLite/PG: ON CONFLICT; MySQL: findExisting+事务) + 批内去重 + 四态返回语义。

**技术栈：** Drizzle ORM v0.45.2, SQLite/MySQL(TiDB)/PG 三方言, React (前端适配)

---

## Task 1: 创建 OauthIdentityResolver 模块

**目标：** 抽取身份解析和 fingerprint 生成逻辑到独立模块，import/backup/callback 三处共用。

**文件：**
- 创建: `src/server/services/oauth/oauthIdentityResolver.ts`

**Step 1: 定义 Resolver 接口和类型**

```typescript
// src/server/services/oauth/oauthIdentityResolver.ts
import type { OAuthProviderId } from './service.js';

/** OAuth 身份的规范指纹 — 三条路径共用 */
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

/**
 * 统一身份解析入口。
 * 合并 resolveImportedOauthIdentity + resolveImportedNativeOauthIdentity
 * 的 provider/accountKey/email/projectId 推导逻辑。
 */
export function resolveOauthIdentity(input: {
  provider: OAuthProviderId;
  credentials: Record<string, unknown>;
  explicitEmail?: string;
  explicitAccountKey?: string;
  explicitAccountId?: string;
  explicitProjectId?: string;
  disabled?: boolean;
}): {
  fingerprint: OauthFingerprint;
  name: string;
  email?: string;
  disabled: boolean;
  exchange: { /* 同现有 */ };
} {
  // ... 从 resolveImportedOauthIdentity + resolveImportedNativeOauthIdentity 抽取
}
```

**Step 2: 实现 `resolveOauthIdentity`**

从 `resolveImportedOauthIdentity`（service.ts:207）和 `resolveImportedNativeOauthIdentity`（service.ts:286）抽取核心逻辑。两条路径的 provider/accountKey/email 推导优先级链合并为一条。

**验证：** `npx tsc --noEmit` 编译通过。

---

## Task 2: Schema 升级 — index → uniqueIndex + 迁移脚本

**目标：** 将 `accounts_oauth_identity_idx` 从普通索引改为唯一索引，并提供数据合并迁移。

**文件：**
- 修改: `src/server/db/schema.ts:81`
- 创建: `drizzle/0026_oauth_identity_unique.sql`
- 修改: `drizzle/meta/_journal.json`
- 自动生成: `src/server/db/generated/*.sql`, `schemaContract.json`

**Step 1: 修改 schema.ts 第 81 行**

```typescript
// 旧
oauthIdentityIdx: index('accounts_oauth_identity_idx').on(table.oauthProvider, table.oauthAccountKey, table.oauthProjectId),
// 新
oauthIdentityUnique: uniqueIndex('accounts_oauth_identity_unique').on(table.oauthProvider, table.oauthAccountKey, table.oauthProjectId),
```

**Step 2: 创建迁移 SQL**

`drizzle/0026_oauth_identity_unique.sql`:

```sql
-- 1. 合并重复行：保留 updated_at 最大的
-- 先删除重复行的 model_availability（外键 ON DELETE CASCADE 应该自动处理，但显式更安全）
DELETE FROM `model_availability`
WHERE `account_id` IN (
  SELECT dup.`id` FROM `accounts` dup
  INNER JOIN (
    SELECT `oauth_provider`, `oauth_account_key`, COALESCE(`oauth_project_id`, '') AS `pid`,
           MAX(`updated_at`) AS `max_updated`
    FROM `accounts`
    WHERE `oauth_provider` IS NOT NULL AND `oauth_account_key` IS NOT NULL
    GROUP BY `oauth_provider`, `oauth_account_key`, `pid`
    HAVING COUNT(*) > 1
  ) dup_group ON dup.`oauth_provider` = dup_group.`oauth_provider`
    AND dup.`oauth_account_key` = dup_group.`oauth_account_key`
    AND COALESCE(dup.`oauth_project_id`, '') = dup_group.`pid`
    AND dup.`updated_at` < dup_group.`max_updated`
  WHERE dup.`oauth_provider` IS NOT NULL AND dup.`oauth_account_key` IS NOT NULL
);

-- 2. 删除重复的 accounts 行
DELETE FROM `accounts`
WHERE `id` IN (
  SELECT dup.`id` FROM `accounts` dup
  INNER JOIN (
    SELECT `oauth_provider`, `oauth_account_key`, COALESCE(`oauth_project_id`, '') AS `pid`,
           MAX(`updated_at`) AS `max_updated`
    FROM `accounts`
    WHERE `oauth_provider` IS NOT NULL AND `oauth_account_key` IS NOT NULL
    GROUP BY `oauth_provider`, `oauth_account_key`, `pid`
    HAVING COUNT(*) > 1
  ) dup_group ON dup.`oauth_provider` = dup_group.`oauth_provider`
    AND dup.`oauth_account_key` = dup_group.`oauth_account_key`
    AND COALESCE(dup.`oauth_project_id`, '') = dup_group.`pid`
    AND dup.`updated_at` < dup_group.`max_updated`
  WHERE dup.`oauth_provider` IS NOT NULL AND dup.`oauth_account_key` IS NOT NULL
);

-- 3. 删除旧普通索引
DROP INDEX IF EXISTS `accounts_oauth_identity_idx`;

-- 4. 创建唯一索引
CREATE UNIQUE INDEX `accounts_oauth_identity_unique` ON `accounts` (`oauth_provider`, `oauth_account_key`, `oauth_project_id`);
```

**Step 3: 更新 _journal.json 末尾追加**

```json
{ "version": "6", "tag": "0026_oauth_identity_unique", "when": 1746528000000 }
```

**Step 4: 重新生成 schema artifacts**

```bash
npm run db:generate
```

**验证：**
- `npx vitest run src/server/db/schemaParity.test.ts` 通过
- `npx vitest run src/server/db/migrate.test.ts` 通过

---

## Task 3: 重构 upsertOauthAccount 为 Dialect-Aware Upsert

**目标：** 按 dialect 分支实现原子 upsert，返回 `created` 信号。

**文件：**
- 修改: `src/server/services/oauth/service.ts:546-679`

**Step 1: 重写 upsertOauthAccount 内部逻辑**

```typescript
async function upsertOauthAccount(input: { /* 同现有签名 */ }) {
  const site = await ensureOauthSite(input.definition);
  const username = buildUsername({ /* ... */ });

  // rebind 路径不走 upsert，保持原逻辑
  if (input.rebindAccountId) { /* ... 原有 rebind 逻辑 ... */ }

  if (runtimeDbDialect === 'mysql') {
    // MySQL/TiDB 路径：findExisting + 事务内 UPDATE/INSERT
    return db.transaction(async (tx) => {
      const existing = await findExistingOauthAccountTx(tx, { /* ... */ });
      const oauth = buildOauthInfo(existing?.extraConfig, { /* ... */ });
      const extraConfig = mergeAccountExtraConfig(existing?.extraConfig, { /* ... */ });

      if (existing) {
        await tx.update(schema.accounts).set({ /* ... */ })
          .where(eq(schema.accounts.id, existing.id)).run();
        const account = await tx.select().from(schema.accounts)
          .where(eq(schema.accounts.id, existing.id)).get();
        return { account: account!, site, created: false, previousAccount: existing };
      }

      const sortOrder = await getNextAccountSortOrderTx(tx);
      const inserted = await tx.insert(schema.accounts).values({ /* ... */ }).run();
      const accountId = requireInsertedRowId(inserted, '...');
      const account = await tx.select().from(schema.accounts)
        .where(eq(schema.accounts.id, accountId)).get();
      return { account: account!, site, created: true, previousAccount: null };
    });
  }

  // SQLite / PostgreSQL: INSERT ON CONFLICT DO UPDATE
  const existing = await findExistingOauthAccount({ /* ... */ });
  const oauth = buildOauthInfo(existing?.extraConfig, { /* ... */ });
  const extraConfig = mergeAccountExtraConfig(existing?.extraConfig, { /* ... */ });

  if (existing) {
    // UPDATE 路径
    await db.update(schema.accounts).set({ /* ... */ })
      .where(eq(schema.accounts.id, existing.id)).run();
    const account = await db.select().from(schema.accounts)
      .where(eq(schema.accounts.id, existing.id)).get();
    return { account: account!, site, created: false, previousAccount: existing };
  }

  // INSERT 路径（ON CONFLICT DO UPDATE 作为兜底）
  const sortOrder = await getNextAccountSortOrder();
  try {
    const result = await ( colorado: db.insert(schema.accounts).values({ /* ... */ }) as any)
      .onConflictDoUpdate({
        target: [schema.accounts.oauthProvider, schema.accounts.oauthAccountKey, schema.accounts.oauthProjectId],
        set: { /* ... 同 UPDATE set ... */ },
      })
      .returning()
      .get();
    // 判断 created：如果 changes > 0 且 lastInsertRowid > 0 → 新建
    // 否则 → ON CONFLICT 触发了 update
    const account = Array.isArray(result) ? result[0] : result;
    return { account, site, created: /* 需要通过 changes 判断 */, previousAccount: null };
  } catch (conflictError) {
    // ON CONFLICT 执行后仍可能需要回查
    // 更稳健方案：先 SELECT，不存在才 INSERT ON CONFLICT
    // ...
  }
}
```

注意：SQLite/PG 路径的 `onConflictDoUpdate` 需要 `returning()` 或 `$returningId()` 来拿行 ID。但 SQLite 的 `better-sqlite3` 驱动不支持 `RETURNING` 子句。因此 **SQLite 路径也需要先查后写 + 事务**——唯一区别是 SQLite 用 `BEGIN IMMEDIATE` 获取写锁，而 MySQL 用 `SELECT ... FOR UPDATE`。

**最终决策**：三种方言统一走 **findExisting + 事务内 INSERT/UPDATE**，UNIQUE 约束作为兜底保护。这样代码最简洁，也最稳健。

**验证：** `npx vitest run src/server/routes/api/oauth.test.ts` 通过。

---

## Task 4: 批内去重 + 四态返回语义

**目标：** 在 importOauthConnectionsFromNativeJson 中增加批内 fingerprint 去重，返回四态。

**文件：**
- 修改: `src/server/services/oauth/service.ts:1028-1104`
- 修改: `src/web/api.ts:733-745` (OAuthImportResponse 类型)

**Step 1: 批内去重**

在 `importOauthConnectionsFromNativeJson` 入口，对 `payloadItems` 按 fingerprint 去重：

```typescript
const dedupedItems = new Map<string, ResolvedIdentity>();
const skippedInBatch: Array<{ name: string; provider?: string }> = [];

for (const rawPayload of payloadItems) {
  const resolved = resolveImportedNativeOauthIdentity(rawPayload);
  const key = fingerprintKey({
    provider: resolved.provider,
    accountKey: resolved.exchange.accountKey ?? null,
    projectId: resolved.exchange.projectId ?? null,
  });
  if (dedupedItems.has(key)) {
    skippedInBatch.push({ name: resolved.name, provider: resolved.provider });
  }
  dedupedItems.set(key, resolved);
}
```

**Step 2: 四态返回**

```typescript
items.push({
  name: resolvedIdentity.name,
  status: persisted.created ? 'imported' : 'updated',
  provider: resolvedIdentity.provider,
  accountId: persisted.account?.id,
});

for (const skipped of skippedInBatch) {
  items.push({ name: skipped.name, status: 'skipped', provider: skipped.provider });
}

return {
  success: failed === 0,
  imported: items.filter(i => i.status === 'imported').length,
  updated: items.filter(i => i.status === 'updated').length,
  skipped: items.filter(i => i.status === 'skipped').length,
  failed,
  items,
};
```

**Step 3: 更新前端类型**

`src/web/api.ts`:
```typescript
export type OAuthImportResponse = {
  success: boolean;
  imported: number;
  updated: number;    // 新增
  skipped: number;
  failed: number;
  items: Array<{
    name: string;
    status: "imported" | "updated" | "skipped" | "failed";
    accountId?: number;
    provider?: string;
    message?: string;
  }>;
};
```

**验证：** 编译通过，手动测试单条/批量导入。

---

## Task 5: 统一 backup fingerprint 到 Resolver

**目标：** backup 的 fingerprint 生成也走 OauthIdentityResolver，消除维度不对齐。

**文件：**
- 修改: `src/server/services/backupService.ts:297-326`

**Step 1: 替换 fingerprint 生成**

```typescript
import { fingerprintFromAccount, fingerprintKey } from './oauth/oauthIdentityResolver.js';

// 旧: `oauth::${input.siteKey}::${oauthProvider}::${oauthAccountKey}::${oauthProjectId}`
// 新: 使用 Resolver
const fp = fingerprintFromAccount({
  oauthProvider: row.oauthProvider,
  oauthAccountKey: row.oauthAccountKey,
  oauthProjectId: row.oauthProjectId,
});
if (fp) {
  return `oauth::${fingerprintKey(fp)}`;
}
```

注意：这会改变 backup fingerprint 格式。旧格式备份文件无法与新格式互操作。需确认是否有在途的 restore 操作。

**验证：** `npx vitest run src/server/services/backupService.test.ts` 通过（需更新相关断言）。

---

## Task 6: 前端展示适配

**目标：** OAuthManagement.tsx 的导入结果展示适配四态。

**文件：**
- 修改: `src/web/pages/OAuthManagement.tsx:1480-1492`

**Step 1: 更新 toast 逻辑**

```typescript
// 旧
const importMessage = result.failed > 0
  ? `批量导入完成，成功 ${result.imported} 个，失败 ${result.failed} 个`
  : `已添加 ${result.imported} 个 OAuth 连接`;

// 新
const parts: string[] = [];
if (result.imported > 0) parts.push(`新增 ${result.imported} 个`);
if (result.updated > 0) parts.push(`更新 ${result.updated} 个`);
if (result.skipped > 0) parts.push(`跳过 ${result.skipped} 个`);
if (result.failed > 0) parts.push(`失败 ${result.failed} 个`);

const importMessage = parts.length > 0
  ? parts.join('，')
  : '没有需要导入的连接';
```

**验证：** 手动测试导入 JSON。

---

## Task 7: 迁移脚本验证 + 集成测试

**目标：** 确保迁移在三种方言下都能正确执行。

**Step 1: 验证 SQLite 迁移**

```bash
npx vitest run src/server/db/migrate.test.ts
```

**Step 2: 验证 MySQL upgrade SQL 生成**

```bash
npm run db:generate
# 检查 generated/mysql.upgrade.sql 包含 UNIQUE INDEX
```

**Step 3: 运行全部 OAuth 测试**

```bash
npx vitest run src/server/routes/api/oauth.test.ts
npx vitest run src/server/services/oauth/
```

**Step 4: 运行 schema 一致性测试**

```bash
npx vitest run src/server/db/schemaParity.test.ts
```

**验证：** 全部通过。

---

## 依赖关系

```
Task 1 (Resolver) ──→ Task 4 (批内去重 + 四态)
                  ──→ Task 5 (backup 统一)
Task 2 (Schema)  ──→ Task 3 (Dialect-Aware Upsert)
Task 3           ──→ Task 4
Task 4           ──→ Task 6 (前端适配)
Task 1,2,3,4,5   ──→ Task 7 (集成验证)
```

推荐执行顺序：1 → 2 → 3 → 4 → 5 → 6 → 7
