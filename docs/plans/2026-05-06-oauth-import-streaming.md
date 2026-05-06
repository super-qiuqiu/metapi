# OAuth 批量导入 SSE 流式化实施计划

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** 将 OAuth 批量导入从同步 30s 超时请求改为 SSE 流式响应，叠加 5 项性能优化，73 条目导入从 ~76s 降至 ~3s。

**Architecture:** 新增 `POST /api/oauth/import/stream` SSE 端点，三阶段流水线（预缓存→串行 upsert+实时推送→分组并发 refresh+批量写入→增量 rebuildRoutes），前端用 `fetch+ReadableStream` 消费，实时展示双阶段进度。原接口保持不变向后兼容。

**Tech Stack:** Fastify SSE (raw write)、pLimit (并发池)、ReadableStream (前端消费)、Drizzle ORM (批量写入)

---

## Task 1: 抽取 modelService 的 discover 与 persist 阶段

**Objective:** 将 `refreshModelsForAccount` 拆为 `discoverOauthModels(account)` (网络探测，返回模型列表) 和 `persistModelAvailability(accountId, models)` (DB 写入) 两个独立函数，供流式导入的分组探测+批量写入使用。

**Files:**
- Modify: `src/server/services/modelService.ts:371-835`

**实现要点:**

1. 新增 `export async function discoverOauthModels(input: { accountId: number; allowInactive?: boolean })` — 复用 `refreshModelsForAccount` 的前半段逻辑（查询 account/site/oauth/proxyUrl、clearExistingAvailability、manualModelNames 收集），但只做一次 `retryOauthModelDiscoveryWithRefresh` 返回 `{ models: string[], discoveryAccount, checkedAt }` 不写 DB。失败时返回 `{ models: null, error: ModelRefreshResult }`。

2. 新增 `export async function persistModelAvailability(input: { accountId: number; models: string[]; checkedAt: string; discoveryAccount: any; latencyMs: number })` — 做 `insert modelAvailability` + `updateOauthModelDiscoveryState` + `setAccountRuntimeHealth`。失败时 `restorePreviousAvailability`。

3. `refreshModelsForAccount` 重构为 `discoverOauthModels` + `persistModelAvailability` 的组合调用，行为不变。确保现有 55 个 oauth 测试全过。

**验证:** `npx vitest run src/server/routes/api/oauth.test.ts -t "import"` 全过

---

## Task 2: 新增 `importOauthConnectionsStream` 服务函数

**Objective:** 在 `src/server/services/oauth/service.ts` 中实现三阶段流式导入核心逻辑，输出通过回调函数推送 SSE event，不依赖 Fastify。

**Files:**
- Create: `src/server/services/oauth/importStreamService.ts`
- Modify: `src/server/services/oauth/service.ts` (导出 ensureOauthSite 或复用)

**SSE Event 协议:**
```
event: item       — 单条 upsert 完成
event: checkpoint — Phase 1 全部完成（可断点续传）
event: refreshed  — 单条/单组模型刷新完成
event: error      — 单条刷新失败
event: done       — 全部完成
```

**实现要点:**

1. `OauthImportStreamCallbacks` 类型：
```ts
type OauthImportStreamCallbacks = {
  onItem: (item: { index: number; name: string; status: 'imported'|'updated'|'failed'; provider?: string; accountId?: number; message?: string }) => void;
  onCheckpoint: (data: { upsertedAccountIds: number[]; pendingRefreshIds: number[] }) => void;
  onRefreshed: (data: { index: number; accountId: number; modelCount: number; provider: string }) => void;
  onError: (data: { index: number; accountId?: number; provider?: string; message: string }) => void;
  onDone: (data: { imported: number; updated: number; skipped: number; failed: number }) => void;
  signal?: { aborted: boolean };
};
```

2. Phase 0 — 预缓存 ensureOauthSite:
- 按 provider 去重，调用 `ensureOauthProviderSite` 每种 provider 仅一次
- 结果存 `Map<string, Site>` 供后续 upsert 复用

3. Phase 1 — 串行 upsert（复用 fingerprint 去重 + upsertOauthAccount）:
- 跳过 `ensureOauthSite`（已缓存），直接 upsert
- 不调用 `activatePersistedOauthAccount`（它包含 refresh+rebuild），改为直接调用 `upsertOauthAccount` + 轻量状态设置
- 每条完成 → `onItem` 回调
- 全部完成 → `onCheckpoint` 回调

4. Phase 2 — 按 (provider, projectId) 分组并发 refresh:
- 对 Phase 1 产出的 accountIds 按 `(provider, projectId)` 分组
- 每组选一个代表账户做 `discoverOauthModels`（一次网络请求）
- 成功后，组内所有 accountId 批量调用 `persistModelAvailability`（共享同一份模型列表，各账户按自身 manualModelNames 过滤）
- 用 `pLimit(4)` 控制组间并发
- 每条完成 → `onRefreshed` 或 `onError`
- `signal.aborted` 检查：在每条/每组处理后检查，若中断则跳过剩余

5. Phase 3 — 增量 rebuildRoutes:
- 调用 `rebuildTokenRoutesFromAvailability()` — 暂时用全局版本（优化 4 增量 rebuild 放到后期）

6. → `onDone` 回调

**验证:** 编写单元测试，mock `discoverOauthModels`/`persistModelAvailability`/`upsertOauthAccount`，验证回调序列和分组逻辑

---

## Task 3: 新增 `POST /api/oauth/import/stream` SSE 路由

**Objective:** 新增 Fastify 端点，将 `importOauthConnectionsStream` 的回调桥接为 SSE 写入。

**Files:**
- Modify: `src/server/routes/api/oauth.ts`

**实现要点:**

1. 端点注册：
```ts
app.post<{ Body: unknown }>(
  '/api/oauth/import/stream',
  { preHandler: [limitOauthConnectionMutate] },
  async (request, reply) => { ... }
);
```

2. 解析 body — 复用 `parseOauthImportPayload`，校验逻辑同原 `/api/oauth/import`

3. SSE 响应设置：
```ts
reply.raw.writeHead(200, {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
});
```

4. 桥接回调 → SSE 写入：
```ts
const pushEvent = (event: string, data: unknown) => {
  if (aborted) return;
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};
```

5. 断连检测：
```ts
let aborted = false;
request.raw.on('close', () => { aborted = true; });
```

6. 调用 `importOauthConnectionsStream`，传入 callbacks + signal

7. rate limiter 复用 `oauthImportLimiter`

8. 错误处理：try/catch 包裹，捕获校验错误返回 400/500（在 SSE 建立前），SSE 建立后的错误通过 `event: error` 推送

**验证:** `npx vitest run src/server/routes/api/oauth.test.ts` 全过

---

## Task 4: 扩展前端 `streamSse` 支持 POST + 扩展事件

**Objective:** 让 `api.ts` 的 `streamSse` 支持 POST 请求 + 自定义事件名处理，新增 `importOAuthConnectionsStream` API 方法。

**Files:**
- Modify: `src/web/api.ts:170-242` (streamSse 函数)

**实现要点:**

1. `streamSse` 函数签名扩展：
```ts
async function streamSse(
  url: string,
  handlers: {
    onLog?: (entry: any) => void;
    onDone?: (payload: any) => void;
    onEvent?: (event: string, data: any) => void;  // 新增：通用事件回调
    signal?: AbortSignal;
  },
  options?: {
    method?: string;           // 新增：默认 GET
    body?: string;             // 新增：POST body
    headers?: Record<string, string>;  // 新增
    timeoutMs?: number;        // 新增：默认 120_000
  },
)
```

2. 在 `flushBuffer` 中，对未知 `eventName`（非 `log`/`done`）调用 `handlers.onEvent?.(eventName, payload)`

3. `fetchAuthenticatedResponse` 调用时传入 `method`/`body`/`headers`/`timeoutMs`

4. 新增 `importOAuthConnectionsStream` API 方法：
```ts
importOAuthConnectionsStream: (
  data: Record<string, unknown>,
  handlers: {
    onItem?: (item: any) => void;
    onCheckpoint?: (data: any) => void;
    onRefreshed?: (data: any) => void;
    onError?: (data: any) => void;
    onDone?: (data: any) => void;
    signal?: AbortSignal;
  },
) =>
  streamSse(
    "/api/oauth/import/stream",
    {
      onEvent: (event, payload) => {
        if (event === 'item') handlers.onItem?.(payload);
        else if (event === 'checkpoint') handlers.onCheckpoint?.(payload);
        else if (event === 'refreshed') handlers.onRefreshed?.(payload);
        else if (event === 'error') handlers.onError?.(payload);
      },
      onDone: handlers.onDone,
      signal: handlers.signal,
    },
    {
      method: "POST",
      body: JSON.stringify(Array.isArray(data.items) ? data : { data }),
      headers: { "Content-Type": "application/json" },
      timeoutMs: 300_000,  // 5 分钟，SSE 长连接
    },
  ),
```

**验证:** `npx tsc --noEmit` 编译通过

---

## Task 5: 重构 `OAuthManagement.tsx` 导入为 SSE 流式消费

**Objective:** 将 `handleImport` 函数从同步 `api.importOAuthConnections` 改为流式 `api.importOAuthConnectionsStream`，实时展示双阶段进度。

**Files:**
- Modify: `src/web/pages/OAuthManagement.tsx:1450-1506`

**实现要点:**

1. 新增状态：
```ts
const [importPhase, setImportPhase] = useState<'idle' | 'upserting' | 'refreshing' | 'done'>('idle');
const [importProgress, setImportProgress] = useState({ current: 0, total: 0 });
```

2. `handleImport` 重写：
```ts
const handleImport = async () => {
  // ... 前置校验同原逻辑 ...
  setImporting(true);
  setImportPhase('upserting');
  setImportProgress({ current: 0, total: validItems.length });

  try {
    const result = await api.importOAuthConnectionsStream(
      { items: parsedItems, ...importProxySettings },
      {
        onItem: (item) => {
          setImportProgress(prev => ({ ...prev, current: prev.current + 1 }));
        },
        onCheckpoint: () => {
          setImportPhase('refreshing');
          setImportProgress({ current: 0, total: validItems.length });
        },
        onRefreshed: (data) => {
          setImportProgress(prev => ({ ...prev, current: prev.current + 1 }));
        },
        onError: (data) => { /* 记录错误 */ },
        onDone: (data) => {
          setImportPhase('done');
          // 四态 toast 同原逻辑
          const parts: string[] = [];
          if (data.imported > 0) parts.push(`新增 ${data.imported} 个`);
          if (data.updated > 0) parts.push(`更新 ${data.updated} 个`);
          if (data.skipped > 0) parts.push(`跳过 ${data.skipped} 个`);
          if (data.failed > 0) parts.push(`失败 ${data.failed} 个`);
          // ...
          closeImportModal();
        },
      },
    );
  } catch (error: any) {
    // 降级：如果 stream 端点不存在（404），回退到原同步接口
    if (error?.message?.includes('404') || error?.message?.includes('Not Found')) {
      // 走原有 api.importOAuthConnections 逻辑
    } else {
      toast.error(error?.message || '导入 OAuth JSON 失败');
    }
  } finally {
    setImporting(false);
    setImportPhase('idle');
  }
};
```

3. 进度条 UI：在导入 modal 中显示当前阶段文字（"正在导入 X/N" / "正在刷新模型 X/N"）+ 线性进度条

4. 降级逻辑：SSE 失败时自动回退到原 `api.importOAuthConnections`（timeoutMs 可临时提升到 120_000），保证旧版本后端兼容

**验证:** 手动测试导入流程（dev server），验证进度展示和四态 toast

---

## Task 6: 批量写入 modelAvailability

**Objective:** 在 `importOauthConnectionsStream` 的 Phase 2 中，对同 (provider, projectId) 分组内的账户批量写入 modelAvailability，替代逐条 INSERT。

**Files:**
- Modify: `src/server/services/oauth/importStreamService.ts` (Task 2 创建)
- Modify: `src/server/services/modelService.ts` (新增 `persistModelAvailabilityBatch`)

**实现要点:**

1. `persistModelAvailabilityBatch(input: { items: Array<{ accountId: number; models: string[]; checkedAt: string; latencyMs: number }> })` — 批量操作：
   - `DELETE FROM modelAvailability WHERE accountId IN (id1, id2, ...) AND isManual = false` — 一条 SQL
   - `INSERT INTO modelAvailability VALUES (扁平化所有 items 的 models)` — 一条 SQL
   - 每个 accountId 的 `updateOauthModelDiscoveryState` 和 `setAccountRuntimeHealth` 仍逐条执行（这些涉及 extraConfig JSON 写入，不适合批量）

2. 在 importStreamService Phase 2 的分组逻辑中，组内 refresh 成功后调用 `persistModelAvailabilityBatch` 一次性写入组内所有账户

**验证:** `npx vitest run src/server/routes/api/oauth.test.ts -t "import"` 全过

---

## Task 7: 集成测试 + 更新 oauth.test.ts

**Objective:** 为 SSE 流式导入端点添加测试，验证端到端流程。

**Files:**
- Modify: `src/server/routes/api/oauth.test.ts`

**实现要点:**

1. 新增测试组 `describe('POST /api/oauth/import/stream')`：
   - 单条导入 → SSE event 序列：item → checkpoint → refreshed → done
   - 批量导入（同 provider） → 只有 1 次 model discovery 请求
   - 批量导入（跨 provider） → 每个 provider 各 1 次 discovery
   - 批内 fingerprint 去重 → skipped 条目正确
   - 单条 refresh 失败 → error event + done 含 failed > 0
   - SSE 连接中断 → 后端停止处理

2. SSE 响应解析辅助函数：消费 ReadableStream，收集所有 event

3. 保留原 `/api/oauth/import` 测试不变

**验证:** `npx vitest run src/server/routes/api/oauth.test.ts` 全过（含 2 个预先存在的 quota 失败）

---

## Task 8: 更新前端测试

**Objective:** 更新 `OAuthManagement.test.tsx` 适配新的流式导入 API 调用。

**Files:**
- Modify: `src/web/pages/OAuthManagement.test.tsx`

**实现要点:**

1. mock `api.importOAuthConnectionsStream` 替代 `api.importOAuthConnections`
2. 模拟 SSE event 序列（onItem → onCheckpoint → onRefreshed → onDone）
3. 验证进度状态转换和四态 toast 内容
4. 降级测试：mock stream 返回 404，验证回退到 `importOAuthConnections`

**验证:** `npx vitest run src/web/pages/OAuthManagement.test.tsx` 全过

---

## 执行顺序依赖

```
Task 1 (modelService 拆分)
  ↓
Task 2 (importStreamService)
  ↓
Task 3 (SSE 路由) ─── 依赖 Task 2
  ↓
Task 4 (前端 streamSse 扩展) ─── 独立，可与 Task 2/3 并行
  ↓
Task 5 (前端 UI 改造) ─── 依赖 Task 4
  ↓
Task 6 (批量写入) ─── 依赖 Task 1, Task 2
  ↓
Task 7 (后端测试) ─── 依赖 Task 3, Task 6
  ↓
Task 8 (前端测试) ─── 依赖 Task 5
```

可并行组：Task 1 + Task 4；Task 2 + Task 4；Task 3 + Task 5；Task 7 + Task 8
