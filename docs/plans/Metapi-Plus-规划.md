# Metapi Plus 功能规划建议

> 基于对 CLI Proxy API、Sub2API、Metapi、One API、New API、9Router、Kiro Gateway、Claude Code Proxy、BYOKEY、ProxyLLM 等项目的深度对比分析
>
> 定位：**极致个人体验** | 技术路线：**Fork 原项目**（TypeScript + Fastify + Drizzle ORM）

---

## 🔴 P0 — 核心差异化（杀手级功能，其他项目都没有或很弱）

### 1. RTK Token 压缩引擎（来自 9Router）

**为什么重要**: 9Router 最独特的卖点是 RTK（Request Token Killer），自动压缩 `git diff`/`grep`/`find`/`ls`/`tree` 等 tool_result 内容，**节省 20-40% 输入 Token**。Metapi 作为聚合网关，加这层等于所有上游都受益。

**实现思路**:
- 代理请求经过路由前，先拦截 `tool_result` 内容
- 根据内容类型自动选择过滤器（git-diff、grep、dedup-log、smart-truncate）
- 安全设计：压缩失败或输出更大时回退原始内容
- 可按路由/模型开关，Caveman Mode（压缩输出）可选
- 支持的过滤器类型：
  - `git-diff`：压缩 diff 输出，保留变更行上下文
  - `git-status`：精简状态信息
  - `grep`/`find`/`ls`/`tree`：压缩文件列表输出
  - `dedup-log`：日志去重
  - `smart-truncate`：智能截断长内容
  - `read-numbered`：压缩编号文件内容
  - `search-list`：压缩搜索结果列表

**效果示例**:
```
Without RTK: 47K tokens sent to LLM
With RTK:    28K tokens sent to LLM   (40% saved · same context · same answer)
```

---

### 2. 3 级自动降级策略（来自 9Router，增强 Metapi 现有路由）

Metapi 已有成本加权路由和故障冷却，但缺少**分层降级策略**。9Router 的 Subscription → Cheap → Free 三级模式非常适合个人用户。

**实现思路**:
- 路由策略新增「降级链」概念：`主力订阅 → 廉价备用 → 免费兜底`
- 当前层配额耗尽/429/错误时自动切到下一层
- 每层可设配额阈值触发降级（不只是故障才降级）
- 配额恢复后自动回升到更高层
- 降级链示例：
  ```
  Combo: "my-coding-stack"
    1. cc/claude-opus-4-6        (你的订阅)
    2. glm/glm-4.7               (廉价备用, $0.6/1M)
    3. kr/claude-sonnet-4.5      (免费兜底)
  ```

**降级触发条件**:
- 配额百分比低于阈值（可配置，如 10%）
- 收到 429 Too Many Requests
- 收到 402 Payment Required / Quota Exceeded
- 连续 N 次请求失败（可配置）
- 上游站点公告标记为停机

**恢复策略**:
- 定期探测已降级的通道
- 配额恢复后自动回升
- 可选：恢复后延迟一段时间再切回（避免频繁切换导致上下文断裂）

---

### 3. 免费模型 Provider 一键接入（来自 9Router + Kiro Gateway）

**为什么重要**: Metapi 目前偏重中转站聚合，对免费模型直连支持弱。9Router 内置了 Kiro/Vertex/OpenCode Free 等免费 Provider，Kiro Gateway 专门打通了 Kiro 免费通道。

**实现思路**:
- 新增 Provider 类型：`free-provider`（Kiro、Vertex AI、OpenCode Free 等）
- OAuth 流程内置（Kiro 用 AWS Builder ID，Vertex 用 GCP Service Account）
- 免费模型自动出现在路由表中
- 作为降级链的终极兜底层

**支持的免费 Provider**:

| Provider | 免费内容 | 认证方式 | 可用模型 |
|----------|---------|---------|---------|
| Kiro AI | Claude 4.5 + GLM-5 + MiniMax 无限免 | AWS Builder ID / Google / GitHub OAuth | claude-sonnet-4.5, claude-haiku-4.5, glm-5, MiniMax-M2.5 |
| OpenCode Free | 无需认证，自动获取模型列表 | 无需认证 | 自动发现 |
| Vertex AI | $300 免费额度（新 GCP 账号 90 天） | GCP Service Account JSON | gemini-3.1-pro-preview, gemini-3-flash-preview |

---

## 🟡 P1 — 显著体验提升

### 4. 配额实时追踪 + 恢复倒计时（来自 9Router + CPA）

**为什么重要**: 个人用户最痛的点之一是不知道配额还剩多少、什么时候恢复。9Router 和 CPA 都有这个功能。

**实现思路**:
- 针对每个上游账号，追踪：
  - Codex 的 5h/7d 窗口配额
  - Claude 的日/月用量
  - Gemini 的 RPM/RPD
- 配额百分比进度条 + 恢复倒计时
- 配额低于阈值自动告警（已有通知渠道可复用）
- 降级链联动：配额不足自动触发降级

**UI 展示**:
- Dashboard 新增「配额总览」卡片
- 每个账号显示：已用/总量、百分比、恢复倒计时
- 颜色编码：绿色(>50%) → 黄色(20-50%) → 红色(<20%) → 灰色(耗尽)
- 5h 滑动窗口的进度条（Codex 特有）

---

### 5. OAuth 原生支持增强（来自 CPA + Sub2API）

Metapi 已有 OAuth 管理，但可以增强：

**实现思路**:
- 支持 Claude Code / Codex / Gemini CLI / Antigravity 的 OAuth 设备流程
- 类似 CPA 的 Management API，支持远程 OAuth 启动和回调
- OAuth Token 自动刷新，无需手动重新授权
- 多 OAuth 账号轮询
- iFlow Cookie 导入支持（来自 CPA）

**OAuth 流程增强**:
- 本地回调服务器自动启动
- 设备码流程支持（无需浏览器回调的场景）
- Token 过期前主动刷新（可配置提前量）
- 刷新失败自动通知 + 降级链触发

---

### 6. 站点公告同步增强 → 停机/限流预警（来自 Sub2API）

Metapi 已有公告同步，但可以增强为**停机/限流预警**：

**实现思路**:
- 解析上游站点公告中的停机/限流信息
- 自动标记受影响的路由通道为 degraded
- 公告中的恢复时间可联动降级链自动恢复
- 支持的上游公告来源：`new-api`、`done-hub`、`sub2api`
- 新增公告类型分类：停机、限流、维护、新模型、价格变更
- 停机/限流公告自动触发降级链切换

---

### 7. 下游密钥细粒度控制（来自 One API）

**为什么重要**: One API 的令牌管理非常成熟（过期时间、额度、IP 白名单、模型白名单）。Metapi 已有下游密钥，但可以加强。

**实现思路**:
- 按 Key 设定：
  - 模型白名单/黑名单
  - 请求频率上限（RPM/TPM）
  - 每日/每月 Token 配额
  - IP 白名单/黑名单
  - 降级链绑定（不同 Key 走不同降级链）
- 按 Key 查看使用明细（哪个模型用了多少）
- Key 分享功能（生成限时邀请链接）
- 额度统计：显示每个 Key 的已用额度、剩余额度、费用趋势

---

## 🟢 P2 — 锦上添花

### 8. Caveman Mode — 输出压缩（来自 9Router）

- 注入精简 prompt 让 LLM 回复更简洁
- 可节省最多 65% 输出 Token
- 适合对输出详细度要求不高的场景（代码补全等）
- 可按路由/模型开关
- 与 RTK 独立，可叠加使用

---

### 9. 模型操练场增强（Metapi 已有，可从 9Router 的 Playground 借鉴）

- **对比测试**：同一 prompt 并发发送到多个上游，并排对比响应
- **延迟热力图**：可视化不同上游的响应速度分布
- **首 Token 延迟（TTFT）追踪**：记录并展示各上游的首字响应时间
- **流式/非流式双模式测试**（已有，确认完整性）
- **Token 消耗对比**：同一 prompt 在不同上游的 Token 消耗差异

---

### 10. 桌面 App 增强（Metapi 已有，可增强）

- **系统托盘** + 配额实时显示
- 类似 ProxyPilot / ZeroLimit 的菜单栏配额指示器
- 一键切换降级链层级
- 托盘图标颜色反映当前降级层级（绿=主力、黄=廉价、红=免费兜底）
- 配额耗尽时桌面通知

---

### 11. 格式自动转换增强（来自 9Router + CPA）

- 确保所有 OpenAI Responses API 端点完整支持
- Ollama 格式兼容（新增上游类型）
- Kiro 格式兼容（新增上游类型）
- Antigravity 专用端点（`/antigravity/v1/messages`、`/antigravity/v1beta/`）
- Amp CLI provider 路由模式（`/api/provider/{provider}/v1...`）

---

### 12. 浏览器扩展一键导入（来自 All API Hub）

- 一键从已登录的中转站提取 API Key
- 自动填充站点配置
- 支持从 All API Hub 备份导入（Metapi 已支持，确认完整性）

---

## 📐 架构层面的建议

### 模块化插件系统

```
metapi-plus/
├── src/
│   ├── core/           # 原有核心（路由、代理、站点管理）
│   ├── plugins/
│   │   ├── rtk/        # Token 压缩引擎
│   │   ├── cascade/    # 3级降级链
│   │   ├── quota/      # 配额实时追踪
│   │   ├── free-providers/  # 免费Provider接入
│   │   └── caveman/    # 输出压缩
│   └── web/            # 前端
```

**设计原则**:
- 每个 Plugin 可独立开关（UI 设置中勾选）
- 不影响原 Metapi 用户升级路径
- 降低维护负担
- 插件通过统一接口注册到代理请求生命周期

**插件生命周期钩子**:
```typescript
interface MetapiPlugin {
  name: string;
  version: string;
  
  // 请求前处理（如 RTK 压缩）
  beforeProxyRequest?(ctx: ProxyContext): Promise<ProxyContext>;
  
  // 响应后处理（如 Caveman 输出压缩）
  afterProxyResponse?(ctx: ProxyContext, response: ProxyResponse): Promise<ProxyResponse>;
  
  // 路由决策增强（如降级链）
  onRouteDecision?(ctx: RouteContext): Promise<RouteDecision>;
  
  // 定时任务（如配额追踪）
  onCron?(task: CronTask): Promise<void>;
  
  // 初始化
  onInit?(config: PluginConfig): Promise<void>;
  
  // 关闭清理
  onDestroy?(): Promise<void>;
}
```

---

### 数据库迁移策略

Fork 后保持 Drizzle ORM + SQLite 默认：

**新增表**:
- `cascade_chains`：降级链定义（链名、层级、每层路由规则）
- `cascade_chain_layers`：降级链层级（优先级、触发条件、目标路由）
- `quota_windows`：配额窗口追踪（账号ID、窗口类型5h/7d/monthly、已用/总量、重置时间）
- `free_provider_configs`：免费 Provider 配置（Provider 类型、OAuth 凭证、刷新状态）
- `rtk_filters`：RTK 过滤器配置（过滤器类型、启用状态、参数）

**与原项目共享表**（保持兼容）:
- 用户/站点/路由/通知/下游密钥等表不变
- 路由表增加 `cascade_chain_id` 外键（可空）
- 站点表增加 `free_provider_type` 字段（可空）

---

### 代理请求流水线重构

```
Client Request
    ↓
[Auth Check] → 下游密钥验证 + 配额检查
    ↓
[RTK Plugin] → tool_result 压缩（可选）
    ↓
[Caveman Plugin] → 注入精简 prompt（可选）
    ↓
[Route Decision] → 选择路由通道
    ↓
[Cascade Check] → 检查降级链状态，可能覆盖路由选择
    ↓
[Format Translation] → OpenAI ↔ Claude ↔ Gemini 格式转换
    ↓
[Proxy Request] → 发送请求到上游
    ↓
[Quota Tracking] → 记录用量到配额窗口
    ↓
[Error Handling] → 失败时触发降级链切换
    ↓
Client Response
```

---

## 🗓️ 建议开发路线图

| 阶段 | 功能 | 预估工作量 | 依赖 |
|------|------|-----------|------|
| **Phase 1** | RTK Token 压缩 + 3级降级链 + 配额追踪 | 3-4 周 | 无 |
| **Phase 2** | 免费 Provider 接入(Kiro/Vertex) + OAuth 增强 | 2-3 周 | Phase 1（降级链需免费 Provider 作为兜底层） |
| **Phase 3** | 下游密钥增强 + Caveman Mode + 模型对比测试 | 2-3 周 | 无强依赖 |
| **Phase 4** | 桌面 App 增强 + 浏览器扩展 + Ollama/Kiro 格式 | 2-3 周 | Phase 2（格式转换依赖新 Provider） |

---

## 🏗️ 与原项目的差异化定位

| 维度 | Metapi（原版） | Metapi Plus |
|------|---------------|-------------|
| 核心定位 | 中转站聚合网关 | 极致个人 AI 编码体验 |
| 目标用户 | 管理多个中转站的用户 | 重度 AI 编码用户 |
| 路由策略 | 成本加权智能路由 | 成本加权 + 降级链 + 配额感知 |
| Token 优化 | 无 | RTK 输入压缩 + Caveman 输出压缩 |
| 免费 Provider | 弱（依赖中转站） | 强（直连 Kiro/Vertex/OpenCode Free） |
| 配额追踪 | 余额看板 | 实时配额追踪 + 恢复倒计时 + 降级联动 |
| OAuth | 基础支持 | 完整设备流程 + 自动刷新 + 多账号轮询 |
| 下游密钥 | 基础管理 | 细粒度控制（模型/频率/配额/IP 限制） |

---

## 🔗 参考项目链接

| 项目 | GitHub | Stars | 关键借鉴点 |
|------|--------|-------|-----------|
| CLI Proxy API | router-for-me/CLIProxyAPI | 30.7k | OAuth 流程、配额管理、Management API、Go SDK |
| Sub2API | Wei-Shaw/sub2api | 17.9k | 计费系统、支付集成、Antigravity 支持、公告同步 |
| 9Router | decolua/9router | 3.9k | **RTK Token 压缩**、**3级降级链**、**免费 Provider**、Caveman Mode |
| Kiro Gateway | jwadow/kiro-gateway | 1.1k | Kiro OAuth 接入、免费 Claude 模型、Extended Thinking |
| One API | songquanpeng/one-api | 32.9k | 令牌细粒度管理、多机部署 |
| New API | QuantumNous/new-api | 30.7k | 格式互转、渠道增强 |
| Claude Code Proxy | fuergaosi233/claude-code-proxy | 2.6k | 反向代理思路（Claude→OpenAI） |
| BYOKEY | AprilNEA/BYOKEY | 97 | Rust 实现、Amp CLI 支持 |
| ProxyLLM | zhalice2011/ProxyLLM | 396 | 浏览器会话捕获 |
| Metapi | cita-777/metapi | 2.4k | Fork 基础项目 |

---

## 🔥 独家创新功能 — 让人眼前一亮的差异化亮点

> 以下功能在现有所有项目中**均未实现或极为罕见**，是 Metapi Plus 可以做到"人无我有"的杀手级特性。

### 🔴 A1. 语义缓存 + 灰区验证（Semantic Cache with Gray-Zone Verification）

**灵感来源**: [prompt-cache](https://github.com/messkan/prompt-cache) | **差异**: 现有项目完全无缓存层

**为什么让人眼前一亮**: 用户反复问类似问题（比如"解释这段代码"、"这个报错什么意思"），现在每次都重新调用上游烧 Token。加一层语义缓存后，**相似问题直接返回缓存的答案**，省钱+省时。

**核心设计**:
```
用户请求
  ↓
[语义向量检索] → 计算与历史请求的相似度
  ↓
相似度 > 0.95  → 直接返回缓存响应（零 Token 消耗）
相似度 < 0.60  → 跳过缓存，正常代理
相似度 0.60-0.95（灰区）→ 用廉价模型（如 haiku）验证意图是否一致
  ↓ 意图一致
返回缓存响应 + 标注"cached"
  ↓ 意图不同
正常代理 + 缓存新响应
```

**实现要点**:
- 使用轻量向量索引（如 `hnswlib-node` 或 `better-sqlite3` + 余弦相似度）
- 缓存键 = prompt 语义向量（排除 volatile 内容如 UUID、时间戳）
- 灰区验证用最便宜的模型（haiku/gpt-4o-mini），成本极低
- 缓存粒度：按模型+温度+top_p 分桶
- 过期策略：TTL + 使用频率加权（高频缓存更久）
- 缓存命中率 Dashboard：展示节省的 Token 数和金额

**预期效果**: 对于重复性高的使用场景（如代码审查、文档查询），**缓存命中率 30-70%**，直接节省对应比例的 Token 费用。

---

### 🔴 A2. 模型瀑布 — 质量自适应升级（Model Cascade with Quality Escalation）

**灵感来源**: [CostMelt](https://github.com/dmeltonyan/costmelt) 的 Overkill Detector | **差异**: 现有项目只做故障降级，无人做**质量升级**

**为什么让人眼前一亮**: 现在所有项目都是"贵的优先，挂了才降级"。但很多时候简单问题用便宜模型就够了，只有复杂问题才需要贵模型。**模型瀑布反过来：先用便宜模型试，质量不够再升级**。

**核心设计**:
```
用户请求
  ↓
[复杂度分类器] → 判断 prompt 复杂度（简单/中等/复杂）
  ↓
简单 → 直接用便宜模型（haiku / gpt-4o-mini）
中等 → 用中等模型（sonnet / gpt-4o）
复杂 → 用贵模型（opus / gpt-4o）
  ↓
[响应质量评估] → 便宜模型的回答是否足够好？
  ↓ 质量不足（低置信度/拒绝回答/格式错误）
自动升级到更贵的模型重试
  ↓
返回最终响应 + 元数据标注（使用了哪级模型、是否升级）
```

**复杂度分类器特征**:
- Token 数量（短 prompt 更可能简单）
- 是否包含代码/数学/推理关键词
- 是否包含工具调用（有工具更可能复杂）
- 对话轮次（越长的对话可能越复杂）

**质量评估信号**（无需额外 LLM 调用）:
- 响应中包含"我无法"/"I cannot" → 可能需要升级
- 响应被截断（finish_reason=LENGTH）→ 升级
- 响应 Token 数远低于预期 → 可能质量不足
- 上游返回 4xx/5xx → 升级

**预期效果**: 对于混合工作负载，**可节省 30-50% 的 Token 费用**，因为大量简单请求不再浪费贵模型。

---

### 🔴 A3. 请求去重 + 微批处理（Request Deduplication & Micro-Batching）

**灵感来源**: [CostMelt](https://github.com/dmeltonyan/costmelt) 的微批处理 | **差异**: 现有项目完全无此功能

**为什么让人眼前一亮**: 当多个客户端/会话同时发送**相同或高度相似**的请求时（比如团队多人问同一个报错），现有项目每个请求都独立转发。去重后**多个请求只发一次上游调用，结果共享给所有等待者**。

**核心设计**:
```
请求 A: "解释这个错误: TypeError..."
请求 B: "解释这个错误: TypeError..."  (几乎同时到达)
请求 C: "解释这个错误: ReferenceError..."  (不同错误)

  ↓
[去重窗口: 100ms]
  ↓
A 和 B 合并为一次上游调用 → 结果复制给 A 和 B
C 独立转发
  ↓
A/B 只消耗 1 次 Token，但两人都拿到结果
```

**微批处理**:
- 对于 Embedding 请求：多个请求合并为一个 batch 调用
- 对于简单 Chat 请求：10ms 窗口内的相似请求合并
- 保持流式体验：第一个响应流式返回，后续等待者拿到完整响应后也流式推送

**适用场景**:
- 团队多人同时使用同一套 API
- 自动化脚本并发请求
- CI/CD 批量检查

**预期效果**: 在团队场景下，**减少 20-40% 的重复上游调用**。

---

### 🟡 A4. 成本预测 — 请求前估价（Cost Prediction Before Execution）

**灵感来源**: 无（原创） | **差异**: 现有项目全是事后计费，无人做**事前估价**

**为什么让人眼前一亮**: 用户在发送请求前就能看到"这次调用预计花费多少 Token/金额"，可以决定是否继续。这就像打车前看到预估费用。

**核心设计**:
```
用户请求到达
  ↓
[Token 预估器] → 基于输入 prompt 估算输出 Token 数
  ↓
[成本计算] → 输入 Token 数 × 输入单价 + 预估输出 Token 数 × 输出单价
  ↓
[决策点]
  ↓ 成本 < 用户阈值 → 正常代理
  ↓ 成本 > 用户阈值 → 通知用户 / 降级到便宜模型 / 拒绝
  ↓
正常代理 + 实际成本记录
```

**Token 预估方法**:
- 简单模式：输入 Token 数 × 模型平均输出/输入比（从历史数据统计）
- 精确模式：按对话类型分类（代码生成通常输出长、简单问答输出短）

**UI 展示**:
- Dashboard 实时显示：本次请求预估成本
- 每日/每月成本预测曲线
- "你的月度预算还剩 XX%，按当前速率将在 N 天后用完"

---

### 🟡 A5. PII 自动脱敏 + 审计日志（Auto PII Redaction + Audit Log）

**灵感来源**: [LLM-nexus](https://github.com/saanvijay/LLM-nexus) + [llm-compliance-gateway](https://github.com/x-coderx/llm-compliance-gateway) | **差异**: 现有项目无任何 PII 保护

**为什么让人眼前一亮**: 很多人担心代码中的密钥、邮箱、手机号等泄露给上游 API。**自动脱敏**让用户放心使用任何上游，不用手动清理 prompt。

**核心设计**:
```
用户请求
  ↓
[PII 检测器] → 正则 + 轻量模型扫描 prompt
  ↓ 检测到 PII
[脱敏] → 替换为占位符（如 <EMAIL_1>、<API_KEY_1>）
  ↓ 记录脱敏映射表（会话级，不过期持久化）
  ↓ 转发脱敏后的请求到上游
  ↓
[响应到达]
  ↓
[还原] → 将占位符还原为原始值
  ↓
返回给用户
```

**支持的 PII 类型**:
- 邮箱地址
- 手机号码
- API Key（sk-xxx、Bearer xxx）
- IP 地址
- 身份证号
- 信用卡号
- 自定义正则（用户可配置）

**审计日志**:
- 记录所有请求/响应的元数据（时间、模型、Token 数、成本）
- 可选记录完整 prompt/response（脱敏后）
- 支持导出为 JSON/CSV
- 合规场景：满足 SOC2/GDPR 要求

---

### 🟡 A6. Prompt Key 重排序 — 对齐上游 Prompt Cache（Request Key Reordering）

**灵感来源**: [llm-reordering-proxy](https://github.com/jschmied/llm-reordering-proxy) | **差异**: 现有项目完全忽略上游 Prompt Cache

**为什么让人一亮**: OpenAI/Anthropic 等提供商有 Prompt Cache 机制（前缀相同则不重复计费）。但很多客户端的 JSON 字段顺序不稳定，导致**本该命中缓存的请求实际 miss 了**。重排序后缓存命中率从 0% 飙升到接近 100%。

**核心设计**:
```
原始请求:
{
  "messages": [...],        ← volatile, 变化频繁
  "model": "claude-sonnet", ← stable
  "max_tokens": 4096,       ← stable
  "temperature": 0.7,       ← stable
  "tools": [...]            ← stable
}

重排序后:
{
  "model": "claude-sonnet", ← stable 字段在前
  "max_tokens": 4096,
  "temperature": 0.7,
  "tools": [...],
  "messages": [...]         ← volatile 字段在后
}
```

**效果**: 上游 Prompt Cache 命中率从 **0/27k → 27k/27k cached tokens**（实际案例数据）

**实现成本**: 极低——只是 JSON key 重排序，几行代码

---

### 🟡 A7. Volatile 字段剥离 — 提升 KV Cache 命中率（Volatile Field Stripping）

**灵感来源**: [openclaw-kvcache-proxy](https://github.com/mallard1983/openclaw-kvcache-proxy) | **差异**: 现有项目不处理 volatile 字段

**为什么让人眼前一亮**: prompt 中的 UUID、时间戳、随机 ID 等每次请求都不同，导致上游缓存完全失效。剥离这些字段后，**KV Cache 命中率从 0.15 飙升到 0.94+，prompt eval 速度提升 22 倍**。

**核心设计**:
```
原始 prompt: "当前时间: 2026-05-06T14:32:15Z, 会话ID: a3f2-b8c1-..."
剥离后:      "当前时间: <TIMESTAMP>, 会话ID: <SESSION_ID>..."
```

- 自动检测并替换：UUID、ISO 时间戳、Unix 时间戳、请求 ID
- 保留映射表，响应还原
- 与 Prompt Key 重排序配合使用效果最佳

---

### 🟢 A8. 智能请求合并 — 同会话上下文复用（Context Reuse for Same Session）

**灵感来源**: 无（原创思路） | **差异**: 现有项目每次请求独立发送完整上下文

**为什么让人眼前一亮**: Claude Code / Cursor 等工具在多轮对话中每次都发送**完整上下文**（包括之前的所有 tool_result），Token 消耗线性增长。如果同一个会话的上下文已经在上游缓存中，可以**只发送增量部分**。

**核心设计**:
```
会话 Session-123:
  请求1: [system prompt] + [user: "读取文件A"] + [tool_result: <file A content>]
  请求2: [system prompt] + [user: "读取文件A"] + [tool_result: <file A content>]
         + [user: "修改第10行"] + [tool_result: <修改结果>]

传统方式: 请求2 完整发送所有内容 → 大量重复 Token

优化方式:
  1. 检测到与请求1有相同前缀（system prompt + 前2轮对话）
  2. 利用上游的 Prompt Cache 机制，只发送新增部分
  3. 或者在代理层缓存上下文，拼接后只转发增量
```

**实现方式**:
- 利用 OpenAI/Anthropic 的 Prompt Caching API 特性
- 对同一会话（相同 conversation_id 或 parent_message_id）跟踪上下文增长
- 计算与前一次请求的 diff，仅转发增量
- 依赖上游 Prompt Cache 命中来减少费用

---

### 🟢 A9. 多模型并发竞答 — 最快响应 + 质量投票（Parallel Model Racing）

**灵感来源**: 无（原创思路） | **差异**: 现有项目都是串行路由

**为什么让人眼前一亮**: 关键请求（如生产环境调试）可以同时发给多个上游，**谁先回用谁**，或者**多选投票**取最佳答案。

**模式**:
- **竞速模式**（Race）：同时发给 2-3 个上游，谁先返回完整响应就用谁，取消其他请求
- **投票模式**（Vote）：同时发给 2-3 个上游，等全部返回后比较，取最长的/最详细的
- **校验模式**（Verify）：先用便宜模型生成，再用贵模型验证关键部分

**适用场景**:
- 生产环境紧急问题，要最快得到答案
- 高价值决策，需要交叉验证
- 不确定哪个上游当前更稳定时

**成本控制**:
- 可设定每日本竞答配额
- 可仅对特定模型/路由开启
- 竞速模式下，后续请求的流式部分可取消（SSE 断开）

---

### 🟢 A10. AI 驱动的智能路由 — 超越规则的路由策略（AI-Powered Smart Routing）

**灵感来源**: [intent-router](https://github.com/JJValentin/intent-router) + [toolstream](https://github.com/tylerwilliamwick/toolstream) | **差异**: 现有项目路由基于静态规则（成本/余额/权重）

**为什么让人眼前一亮**: 用一个极小的本地模型（或规则引擎+语义分类器）判断用户意图，然后**自动选择最合适的模型**，而不需要用户手动指定模型名。

**核心设计**:
```
用户请求: "帮我重构这段代码的架构"
  ↓
[意图分类] → 编码/重构类 → 需要强编码模型
  ↓
[模型选择] → 自动路由到 Claude Sonnet / GPT-4o
  ↓
用户请求: "这段代码的变量名是什么意思"
  ↓
[意图分类] → 简单问答类 → 便宜模型即可
  ↓
[模型选择] → 自动路由到 Haiku / GPT-4o-mini
```

**实现方式（轻量版）**:
- 不用跑本地模型，用规则 + 关键词 + Token 数判断
- 分类维度：代码生成/代码修改/简单问答/复杂推理/创意写作/翻译
- 每个分类映射到最佳性价比模型
- 用户可自定义分类规则和模型映射

**实现方式（完整版）**:
- 用 tiny 模型（如 Qwen2.5-0.5B 或 DistilBERT）做意图分类
- 本地推理，延迟 < 50ms
- 准确率 > 90% 即可产生价值

---

## 🏆 创新功能优先级总览

| 优先级 | 功能 | 预期效果 | 实现难度 | WOW 系数 |
|--------|------|---------|---------|---------|
| **🔴 P0** | A1. 语义缓存+灰区验证 | 缓存命中率30-70%，直接省钱 | ⭐⭐⭐ 中 | ⭐⭐⭐⭐⭐ |
| **🔴 P0** | A2. 模型瀑布(质量升级) | 简单请求省30-50%费用 | ⭐⭐⭐ 中 | ⭐⭐⭐⭐⭐ |
| **🔴 P0** | A6. Prompt Key重排序 | Cache命中率0%→100%，零成本 | ⭐ 极低 | ⭐⭐⭐⭐⭐ |
| **🟡 P1** | A3. 请求去重+微批处理 | 团队场景减20-40%重复调用 | ⭐⭐⭐⭐ 高 | ⭐⭐⭐⭐ |
| **🟡 P1** | A4. 成本预测(请求前估价) | 事前可控，防止超支 | ⭐⭐ 低 | ⭐⭐⭐⭐ |
| **🟡 P1** | A5. PII自动脱敏+审计 | 安全合规，放心用任何上游 | ⭐⭐⭐ 中 | ⭐⭐⭐⭐ |
| **🟡 P1** | A7. Volatile字段剥离 | KV Cache命中0.15→0.94，22x加速 | ⭐⭐ 低 | ⭐⭐⭐⭐ |
| **🟢 P2** | A8. 同会话上下文复用 | 长对话场景省50%+ Token | ⭐⭐⭐⭐⭐ 极高 | ⭐⭐⭐⭐⭐ |
| **🟢 P2** | A9. 多模型并发竞答 | 关键场景更快更可靠 | ⭐⭐⭐ 中 | ⭐⭐⭐⭐ |
| **🟢 P2** | A10. AI智能路由 | 零配置自动选模型 | ⭐⭐⭐⭐ 高 | ⭐⭐⭐⭐⭐ |

---

## 🗓️ 修订后的完整开发路线图

| 阶段 | 功能 | 预估工作量 |
|------|------|-----------|
| **Phase 1** | Prompt Key 重排序(A6) + Volatile 字段剥离(A7) + RTK 压缩 + 3级降级链 | 3-4 周 |
| **Phase 2** | 语义缓存+灰区验证(A1) + 模型瀑布(A2) + 配额追踪 | 4-5 周 |
| **Phase 3** | 免费 Provider 接入 + OAuth 增强 + 成本预测(A4) | 2-3 周 |
| **Phase 4** | PII 脱敏+审计(A5) + 请求去重(A3) + 下游密钥增强 | 3-4 周 |
| **Phase 5** | 同会话上下文复用(A8) + 多模型竞答(A9) + AI 智能路由(A10) | 4-5 周 |
| **Phase 6** | 桌面 App 增强 + Caveman Mode + 浏览器扩展 + 模型对比测试 | 2-3 周 |

**Phase 1 的逻辑**: A6+A7 是投入产出比最高的功能（极低难度 + 巨大效果），先做可以立即让所有用户受益，建立口碑。
