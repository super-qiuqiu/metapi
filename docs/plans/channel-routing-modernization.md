# 通道选择算法现代化最佳方案（Production Grade）

> 状态：设计完成（最佳方案）
> 日期：2026-05-06
> 部署前提：当前单实例 Metapi；架构按未来多实例兼容设计

## 一、目标与非目标

### 目标

1. 统一三种计费口径，消除 unitCost 不可比问题
2. 用连续统计估计替代开关式熔断，降低抖动
3. 将延迟与成功率显式纳入选路核心
4. 在热路径保持 O(1) 复杂度
5. 提供生产级可观测、可回滚、可恢复能力

### 非目标

1. 不引入 Deep RL/MPC/Gittins 复杂求解器
2. 不在热路径增加 DB/网络 IO
3. 不引入一次性“大爆改”，采用分阶段灰度

---

## 二、总体架构

1. 在线决策层（热路径，内存）
   - Contextual Thompson Sampling + P2C
   - log-space score 组合（数值稳定）
   - 仅使用内存态，不做外部 IO

2. 状态学习层（请求完成后）
   - `recordSuccess` / `recordFailure` 更新后验与 EWMA
   - `usage` 先清洗再入模（契约校验）

3. 状态持久化层（后台异步）
   - 脏状态批量 flush 到 DB（30-60s）
   - 启动时恢复（优先快照，其次历史计数先验）

4. 配置与回滚层
   - 秒级动态开关（无需重启）
   - 算法/特性可独立开关，支持分级回退

5. 观测与守门层
   - Prometheus/OTel 指标 + 采样决策日志
   - 阈值守门与自动回退

---

## 三、统计状态模型（ChannelRoutingState）

每个 channel 一份状态：

- `successAlpha`, `successBeta`（Beta 后验，健康度）
- `latencyLogMu`, `latencyLogSigma2`, `latencyN`（log-latency 后验）
- `promptEwma`, `completionEwma`, `cacheReadEwma`, `cacheCreationEwma`（成本期望）
- pricing snapshot（`quotaType` + 定价参数 + `groupMultiplier`）
- `manualWeight`（人工软偏好）
- `updatedAt`, `version`（持久化/演进）

### 初始化策略（启动时）

1. 先由 channel 聚合历史构造先验：
   - `alpha = 2 + successCount`
   - `beta = 2 + failCount`
   - `latencyLogMu = log(avgLatencyMs_clamped)`
   - `latencyLogSigma2 = 0.8`（保守宽先验）
2. 若 DB 快照存在，且合法、未过旧，快照覆盖先验
3. 若快照异常，告警并回退先验

---

## 四、usage 计费契约（强约束）

### 统一语义

1. `promptTokens` 为总输入 token
2. `cacheReadTokens` / `cacheCreationTokens` 为 `promptTokens` 子集
3. `nonCacheInput = max(0, prompt - cacheRead - cacheCreation)`

### sanitizeUsage（必经）

- 所有 token 非负
- `cacheRead + cacheCreation <= prompt`
- 非法则：
  - 本次 `expectedCost` 回退到上下文估算
  - 计数 `router_usage_contract_violation_total`
  - 记录采样告警日志（含 channel/model/upstream）

---

## 五、统一 expectedCost（生产口径）

按 `quotaType` 分支：

1. 按次
   - `expectedCost = perCallPrice * groupMultiplier`

2. 按量（含缓存）
   - `promptE`, `completionE` 优先取 channel EWMA，缺省取 model/context 估计
   - `cost = (nonCacheInput*inputRate + cacheRead*cacheReadRate + cacheCreation*cacheCreationRate + completion*outputRate)/1e6`
   - `expectedCost = max(eps, cost * groupMultiplier)`

3. 兼容分支
   - 若 provider 语义不完整/字段缺失，退化为安全估算并打指标 `router_cost_fallback_total`

---

## 六、失败分类与更新矩阵（与 retry 语义一致）

失败分类（统一词汇）：

1. `retryable_upstream`：5xx、timeout、connection reset
2. `throttling`：429、额度/限速
3. `caller_fault`：4xx 非429（请求参数问题）

更新规则：

- `success`: `alpha += 1`
- `retryable_upstream`: `beta += 1.0`
- `throttling`: `beta += 0.4`
- `caller_fault`: `beta += 0.0`（不惩罚 channel）

说明：

- cooldown 可保留，但必须携带 failure class，便于观测与策略分离

---

## 七、选路算法（Contextual TS + P2C，O(1)）

1. 候选过滤
   - 过滤 exclude、不可用、策略不匹配项
   - 保留现有 priority 分层语义（不破坏兼容）

2. 采样
   - `theta ~ Beta(alpha, beta)`
   - 延迟采样：`logN(mu, sigma2) -> exp`
   - cold-start 保护：`latencyN < 5` 用 site/model 级先验延迟

3. 打分（log-add，替代乘幂）

```text
logScore =
  a*log(clamp(theta, 0.05, 0.995))
  - b*log(clamp(latencyMs, 50, 120000))
  - c*log(clamp(expectedCost, 1e-6, 1e3))
  + d*log(clamp(manualWeight, 0.5, 2.0))
```

建议初值：
- `a=1.0, b=0.25, c=0.45, d=0.15`

4. 选择（P2C）
   - 随机抽 2 个候选，取 `logScore` 高者
   - `n<=2` 时退化为直接比较
   - 保持热路径 `O(1)`

---

## 八、连接复用优化（网络层）

`siteProxy.ts` 中 `Agent/ProxyAgent`：

- `keepAliveTimeout: 30_000`
- `keepAliveMaxTimeout`: 保持默认（或沿用现值）
- 不发主动心跳，不额外消耗额度
- 连接复用靠自然流量与较长 keepalive

---

## 九、状态持久化快照（最佳实现）

### 1) 新增状态表（推荐）

表：`channel_routing_state`

字段：
- `channel_id` PK
- `success_alpha`, `success_beta`
- `latency_log_mu`, `latency_log_sigma2`, `latency_n`
- `prompt_ewma`, `completion_ewma`, `cache_read_ewma`, `cache_creation_ewma`
- `version`
- `updated_at`

### 2) flush 策略

- 热路径只改内存 + 标记 dirty
- 后台每 30-60 秒批量 upsert dirty channels
- 进程退出前 best-effort flush 一次
- flush 失败不阻塞请求，仅告警与指标上报

### 3) 恢复策略

- 启动时批量加载状态表
- 合法性校验 + clamp
- 超旧快照（如 >24h）可降权（提高 `sigma2`）后使用

---

## 十、动态开关与回滚（秒级）

配置开关（热更新）：

- `routing.algorithm = legacy | bandit`
- `routing.bandit.features`:
  - `ewma_health`
  - `expected_cost`
  - `ts_sampling`
  - `p2c`

回滚挡位：

1. 完整 bandit -> 关闭 `ts_sampling` + `p2c`（保留 EWMA/cost）
2. 仍异常 -> `routing.algorithm=legacy`
3. 全程无需重启

---

## 十一、可观测性（必须项）

核心指标：

- `router_selected_channel_total{model,site,strategy}`
- `router_exploration_rate{model}`
- `router_fallback_legacy_total{reason}`
- `router_failure_class_total{class}`
- `router_expected_vs_actual_cost_error{model,site}`
- `router_usage_contract_violation_total`
- `router_state_flush_total` / `router_state_flush_fail_total` / `router_state_flush_duration_ms`
- `router_state_recovered_channels`
- `ewma_state_staleness_seconds`
- `router_score_component_histogram{theta,latency,cost}`

日志：

- 1-5% 决策采样日志：候选 top2、分数组件、最终选择、fallback reason

---

## 十二、分阶段实施（最佳实践）

### Phase 1：基础能力上线（低风险）

- 上线 EWMA 状态学习、usage 扩展、sanitize、指标
- 选路仍 legacy（但 health/latency 输入可切 EWMA）
- 上线 keepAlive 30s
- 启动阈值守门 + 自动回退机制

验收门槛（硬）：
- P95 TTFB 不恶化 > +5%
- 5xx 不恶化 > +0.3pct
- 成本中位数不恶化 > +3%

### Phase 2：核心算法灰度

- 开启 `expected_cost + ts_sampling + p2c`
- 按 model/group/site 分批灰度
- 越线自动回退（先关 ts/p2c，再回 legacy）

### Phase 3：稳态强化

- 启用 decay scheduler
- 启用定价同步任务（`modelPricingService -> routing state`）
- 固化参数与运维 runbook，完成复盘调参

---

## 十三、模块与边界归属（遵循 AGENTS.md）

建议新增：

- `src/server/services/routing/channelBanditStore.ts`
- `src/server/services/routing/channelBanditSelector.ts`
- `src/server/services/routing/channelBanditDecay.ts`
- `src/server/services/routing/channelRoutingStateRepo.ts`

改动点：

- `tokenRouter.ts`：接入新 selector / 记录接口扩展
- `siteProxy.ts`：`keepAliveTimeout` 调整
- proxy routes：`recordSuccess` 补传 usage（chat/completions/embeddings/images/videos/search/responsesWebsocket）
- `transformers/shared/normalized.ts`：确保 usage 契约一致

约束：

- route 层仅适配/透传，不承载算法逻辑
- 失败分类词汇复用现有 retry 体系
- 如触及架构边界，补 architecture test + `npm run repo:drift-check`

---

## 十四、参数建议（初始）

- Beta prior: `(2,2)`
- latency cold-start threshold: `N0=5`
- decay:
  - success：每分钟 `0.985~0.995` 区间（慢衰减）
  - latency sigma2：按时间缓慢回宽
  - token ewma：维持 `0.3/0.4` 更新系数
- manualWeight clamp: `[0.5, 2.0]`

---

## 十五、风险与对策

1. 口径不一致风险（usage/provider）
   - 对策：sanitize + fallback + violation 指标

2. 参数初值不合适
   - 对策：灰度 + 守门阈值 + 快速回退挡位

3. 快照写入失败
   - 对策：请求不受影响；告警；自动重试；状态仍在内存持续可用

4. 重启后状态陈旧
   - 对策：`updated_at` + 陈旧降权（增大 `sigma2`）

---

## 十六、最终结论

该最佳方案在不牺牲热路径性能的前提下，完整覆盖：

- 算法现代化（TS + P2C + EWMA）
- 计费统一（`expectedCost` 契约化）
- 生产级工程能力（可观测、可回滚、可恢复）
- 当前单实例最优落地 + 未来多实例可平滑演进
