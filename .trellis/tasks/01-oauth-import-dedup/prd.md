# OAuth 导入去重重构 PRD

## 目标

统一 OAuth 身份解析与去重逻辑，消除当前 find-then-write 模式的五个缺陷（批内无去重、无 skipped 语义、竞态窗口、数据库无兜底、与 backup fingerprint 不对齐），使 import/callback/backup 三条路径共享单一身份真相源。

## 背景

当前部署方案：Render（MySQL 兼容 TiDB Serverless）+ UptimeRobot。这意味着：
- **主要方言为 MySQL**（TiDB），SQLite/PG 为开发/测试环境
- MySQL 不支持 partial unique index（WHERE 子句）
- TiDB 兼容 MySQL 5.7 语法
- 无持久化磁盘，容器重启后 SQLite 数据丢失——线上只有 MySQL 路径有意义

## 当前缺陷清单

| # | 缺陷 | 影响 |
|---|------|------|
| 1 | 批内无去重 | 同请求重复 items 导致 imported 计数虚高 |
| 2 | 无 skipped/updated 语义 | 前端无法区分新建 vs 更新 |
| 3 | findExisting 与 INSERT/UPDATE 之间无事务 | 并发导入可产生幽灵重复行 |
| 4 | `accounts_oauth_identity_idx` 仅普通索引 | 数据库层不拦截重复 |
| 5 | backup fingerprint 含 siteKey，import 不含 | 两条路径去重维度不对齐 |

## 技术方案

### 架构：统一 Identity Resolver + UNIQUE 约束 + Dialect-Aware Upsert

```
┌──────────────────────────────────────┐
│       OauthIdentityResolver           │
│  统一 fingerprint:                    │
│  provider + accountKey + projectId    │
├──────────┬──────────┬────────────────┤
│  import  │ callback │  backup restore │
└──────────┴──────────┴────────────────┘
         │
    ┌────▼─────┐
    │  batch   │  批内 fingerprint 去重
    │  dedupe  │
    └────┬─────┘
         │
    ┌────▼──────────────────┐
    │  upsertOauthAccount   │  统一封装
    │  SQLite/PG: ON CONFLICT│  UNIQUE 约束兜底
    │  MySQL: findExisting+tx│
    └───────────────────────┘
```

### 关键设计决策

#### 1. UNIQUE 约束策略

**问题**：`oauthAccountKey` 和 `oauthProvider` 可能为 NULL（非 OAuth 账号），MySQL 不支持 partial unique index。

**方案**：
- 在 Drizzle schema 中将 `accounts_oauth_identity_idx` 改为 `uniqueIndex()`
- MySQL 中 NULL ≠ NULL，UNIQUE 约束允许多个 NULL 行——非 OAuth 账号不受影响
- 应用层 `OauthIdentityResolver` 在 accountKey 为空时走 email+provider 兜底匹配（现有逻辑保留，但在事务内执行）
- **对齐 backup**：backup fingerprint 中的 siteKey 从 provider 推导（与 `ensureOauthSite` 逻辑一致），统一到同一组维度

#### 2. Dialect-Aware Upsert（运行时分支）

复用 `upsertSetting.ts` 的 dialect 分支模式，对外暴露统一接口：

**SQLite / PostgreSQL**：`INSERT … ON CONFLICT (oauth_provider, oauth_account_key, oauth_project_id) DO UPDATE SET …` + `$returningId()` 拿到行 ID 回查完整数据。`created` 信号通过 `changes` 判断。

**MySQL / TiDB**：`findExistingOauthAccount` + 事务内 UPDATE/INSERT。不走 `ON DUPLICATE KEY UPDATE`，原因：
1. MySQL `affectedRows=0` 在数据无变化时语义 ambiguous
2. `ON DUPLICATE KEY UPDATE` 触发所有 UNIQUE 索引检查，与 site.platform+url 唯一索引交叉风险
3. findExisting + 事务在 MySQL InnoDB 下行锁保护完备，功能与 ON CONFLICT 等价

封装函数签名：
```typescript
async function upsertOauthAccount(input: { ... }): Promise<{
  account: typeof schema.accounts.$inferSelect;
  site: typeof schema.sites.$inferSelect;
  created: boolean;
  previousAccount: typeof schema.accounts.$inferSelect | null;
}>
```

MySQL 路径关键变更：`findExisting` 和后续 UPDATE/INSERT 包裹在 `db.transaction()` 内。

#### 3. 批内去重

在 `importOauthConnectionsFromNativeJson` 入口处，对 `payloadItems` 按 `(provider, accountKey, projectId)` 三元组构建 Map，相同 key 的后者覆盖前者（保留最新凭证），丢弃的条目标记为 `skipped`。

#### 4. 四态返回语义

| 状态 | 含义 | 条件 |
|------|------|------|
| `imported` | 新建 | upsert 返回 created=true |
| `updated` | 更新已有 | upsert 返回 created=false |
| `skipped` | 批内重复丢弃 | 批内去重时被覆盖 |
| `failed` | 失败 | 异常 |

#### 5. 迁移策略

新增 Drizzle 迁移 `0026_oauth_identity_unique`：
1. 对已有重复行做合并：按 `(oauth_provider, oauth_account_key, oauth_project_id)` 分组，保留 `updated_at` 最大的那条，将其余重复行的 `model_availability` 迁移到保留行后删除
2. `DROP INDEX accounts_oauth_identity_idx`
3. `CREATE UNIQUE INDEX accounts_oauth_identity_unique ON accounts (oauth_provider, oauth_account_key, oauth_project_id)`

MySQL/TiDB 路径通过 `schemaIntrospection.ts` 的 upgrade SQL 执行相同逻辑。

## 受影响文件

| 文件 | 变更类型 |
|------|----------|
| `src/server/db/schema.ts` | `index()` → `uniqueIndex()` |
| `src/server/services/oauth/service.ts` | 重构 upsertOauthAccount、importOauthConnectionsFromNativeJson |
| `src/server/services/oauth/oauthIdentityResolver.ts` | **新建**：统一身份解析 + fingerprint 生成 |
| `src/server/services/oauth/oauthAccount.ts` | 迁移身份匹配逻辑到 Resolver |
| `src/server/services/backupService.ts` | fingerprint 统一到 Resolver |
| `src/web/api.ts` | `OAuthImportResponse` 类型增加 `updated` 字段 |
| `src/web/pages/OAuthManagement.tsx` | 导入结果展示适配四态 |
| `drizzle/0026_oauth_identity_unique.sql` | **新建**迁移 |
| `src/server/db/generated/*.sql` | 重新生成 |

## 验收标准

- [ ] 同一 `(provider, accountKey, projectId)` 的重复导入返回 `updated` 而非 `imported`
- [ ] 批内 items 数组含重复条目时，被覆盖的条目标记为 `skipped`
- [ ] 并发导入同一身份不会产生重复行（UNIQUE 约束兜底）
- [ ] backup 服务的 fingerprint 与 import 使用相同维度
- [ ] OAuth callback 路径也走 Resolver（无功能变更，仅统一入口）
- [ ] TiDB/MySQL 路径下事务内 upsert 正常工作
- [ ] 已有数据库迁移不破坏数据（合并重复行 + 创建唯一索引）
- [ ] 前端 toast 展示 "新增 X 个，更新 Y 个，跳过 Z 个"

## 范围外

- 不改变 `rebind` 流程（它有独立的 `rebindAccountId` 弹出路径）
- 不改变 OAuth provider 注册/发现逻辑
- 不引入实时 WebSocket 去重（导入是低频操作）
- 不做迁移回滚方案（UNIQUE 约束一旦创建不可降级到普通索引是可接受的）
