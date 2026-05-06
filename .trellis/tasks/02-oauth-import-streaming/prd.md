# PRD: OAuth 批量导入 SSE 流式化

## 问题

73 个 OAuth JSON 文件导入时，串行 `refreshModelsForAccount`（每条 ~1s 上游网络请求）+ 重复 `rebuildRoutesOnly`（28 次），总耗时 ~76s。前端 `fetchAuthenticatedResponse` 默认 30s 超时，导致只有 28 条成功入库，剩余 45 条未处理。

## 目标

将 OAuth 批量导入改为 SSE 流式响应，叠加 5 项性能优化，73 条目导入从 ~76s 降至 ~3s，用户实时看到进度。

## 需求

### 功能需求

1. **SSE 流式端点** — `POST /api/oauth/import/stream`，返回 `text/event-stream`
2. **三阶段流水线** — Phase 0 预缓存 → Phase 1 串行 upsert → Phase 2 分组并发 refresh → Phase 3 rebuildRoutes
3. **实时进度推送** — 每条 upsert/refresh 完成即推送 SSE event
4. **同 Provider 模型共享** — 同 (provider, projectId) 的账户只做 1 次云端模型探测
5. **批量 DB 写入** — 按组批量 DELETE + INSERT modelAvailability
6. **ensureOauthSite 预缓存** — 按 provider 去重，避免重复 DB 查询
7. **断连安全** — 客户端断连后端停止处理；重试时 upsert 返回 updated/skipped
8. **向后兼容** — 原 `POST /api/oauth/import` 不变；前端降级回退

### 非功能需求

- 73 条目总耗时 < 5s（3 个 provider）
- 单条 upsert 延迟 < 2ms
- 并发刷新池大小 4（避免上游限流）
- SSE 连接超时 5 分钟

## 验收标准

- [ ] `POST /api/oauth/import/stream` 返回 SSE event 序列（item → checkpoint → refreshed → done）
- [ ] 73 条目导入 < 5s（3 个 provider，本地 dev 环境）
- [ ] 同 provider 的多个账户只触发 1 次云端模型探测
- [ ] 前端实时展示"正在导入 X/N"和"正在刷新模型 X/N"进度
- [ ] 客户端断连后端停止处理
- [ ] 旧版后端时前端自动降级到原接口
- [ ] 原 `/api/oauth/import` 测试全过
- [ ] `npx tsc --noEmit` 编译通过（仅预先存在的错误）

## 超出范围

- 增量 rebuildRoutesOnly（优化 4）— 留到后期，当前用全局 rebuild
- SSE 断点续传（优化 5）— 需要额外的 resume 参数和进度持久化，当前重试时 upsert 自动返回 updated/skipped 已足够安全
- `rebuildTokenRoutesFromAvailability` 的增量版本
