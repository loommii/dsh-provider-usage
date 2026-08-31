# Command Code 提供方支持方案评估

> 目标：用量中心新增提供方 **Command Code**（自定义提供方专用，不可从 DSH 导入），新增一种既有**订阅使用量**又有**剩余额度**的卡片类型。
> 依据：`tmp/CommandCodeAPi查询调研.md`（Rainytoken 调研 + 实测）。状态：方案待确认。

---

## 1. 需求拆解

| 需求 | 说明 |
|---|---|
| 新增提供方 Command Code | 只能在「添加自定义提供方」中出现，**不能**出现在「从 DSH 导入提供方」列表 |
| 新卡片类型 | 同时展示**订阅使用量**（5h / 周 / 月窗口）与**剩余额度**（月度剩余 $） |
| API 来源 | 官方 API（调研文档十节） |

### 为什么 Command Code 不能从 DSH 导入

实测 DSH 本体（`@earendil-works/pi-ai` provider 注册表）**没有 commandcode provider**，DSH 模型设置里不存在对应配置项，自然也没有 `apiKeyEnv` 可读。因此：

- 不能进「从 DSH 导入提供方」（`/api/provider-usage/dsh-providers` 的 `IMPORTABLE` 列表）；
- 只能走「添加自定义提供方」：Key 加密存插件私有库（vault），实例 `type: 'manual'`、`source: 'vault'`——这是现有手动流程，天然满足需求。

---

## 2. 现状（已有两种提供方/适配器）

### Host 侧 `lib/index.js`

| 适配器 id | 类型 | 端点 | 结果模型 |
|---|---|---|---|
| `usage-percent`（OpenCode Go） | 订阅型 | `GET {baseUrl}/v1/usage` | `windows{rolling,weekly,monthly}` + `remaining%` |
| `balance-json`（DeepSeek） | 余额型 | `GET {baseUrl}/user/balance` | `cards[]`（币种/剩余/赠送/充值）+ `remaining` |

- `ADAPTERS` 数组注册适配器；`doQuery` 按 `cfg.id === 'balance-json'` 选解析器；
- `okResponse` 返回统一响应：`planName / remaining / unit / extra / windows / cards / isValid / …`；
- 凭证解析链 `resolveCredentialFor`：DSH 设置 `apiKeyEnv` → DSH 凭证 → 环境变量 → 私有库兜底；`source=vault` 时**跳过 DSH 链直接读私有库**；
- 缓存：每 adapter+ref+source 独立 30s 新鲜窗口 + 并发去重 + 3 快照环 + stale-while-error；
- 路由：`/query`、`/templates`、`/credentials`、`/dsh-providers`、`/credential-refs`、`/local-usage`、旧 `/opencode-go`。

### Client 侧 `lib/client.js`

- `ADAPTER_META`：适配器显示名（驱动下拉框、过滤 provider 清单）；
- 设置页：`openImport()`（DSH 导入）/ `openManual()`（自定义）→ `saveManual()` 写 vault + `type:'manual', source:'vault'`；
- 常驻卡片 `UsageCard`：按 `adapter === 'balance-json'` 区分 logo，按结果 `unit`/`windows` 渲染；
- 查询串：`adapter=<id>&ref=<ref>&source=vault`。

---

## 3. Command Code 官方 API 能力（调研结论）

| 端点 | 用途 | 认证 |
|---|---|---|
| `GET https://api.commandcode.ai/alpha/billing/credits` | 月度**剩余**额度（`credits.monthlyCredits`）+ 5h/周窗口 `used/cap/resetAt` | `Authorization: Bearer <API Key>` |
| `GET https://api.commandcode.ai/alpha/billing/subscriptions` | 订阅元数据：`planId`、`currentPeriodStart/End`、`status`、`cancelAtPeriodEnd` | 同上 |

实测数据（调研文档 §10）：

```json
// GET /alpha/billing/credits
{
  "credits": { "belowThreshold": false, "creditThreshold": 0, "monthlyCredits": 62.9432148907, "purchasedCredits": 0, "freeCredits": 0 },
  "windowLimits": {
    "limited": true, "exceeded": null,
    "fiveHour": { "used": 0.3699430743, "cap": 14, "exceeded": false, "resetAt": 1788114535553 },
    "weekly":   { "used": 7.0567851093, "cap": 35, "exceeded": false, "resetAt": 1788405909707 }
  }
}

// GET /alpha/billing/subscriptions
{ "success": true, "data": { "id": "sub_…", "status": "active", "planId": "individual-goat",
  "currentPeriodStart": "2026-08-27T03:14:04.000Z", "currentPeriodEnd": "2026-09-27T03:14:04.000Z",
  "cancelAtPeriodEnd": false, … } }
```

**关键限制（决定方案取舍）**：

1. API **不直接给月用量**：只有 5h/周两个窗口的 `used/cap`，没有 monthly 窗口；
2. 月用量只能推算：`已用 = 计划总额 − monthlyCredits`，其中计划总额来自 **planId → 映射表**（`individual-go`=10 / `individual-goat`=70 / `individual-pro`=80 / `individual-max`=150 / `individual-ultra`=300）；
3. 官方另有 `/internal/usage` 明细端点（可聚合出精确月用量），但需要 **Cookie 认证**（非 API Key），与「只填 API Key」的录入形态冲突，故不作为本次主方案。

---

## 4. 方案：新增 `commandcode-credits` 适配器（订阅+余额混合卡片）

### 4.1 适配器注册（host）

```js
{
  id: 'commandcode-credits',
  displayName: 'Command Code（订阅+余额）',
  baseUrl: 'https://api.commandcode.ai',
  usagePath: '/alpha/billing/credits',
  subscriptionPath: '/alpha/billing/subscriptions',
  defaultCredentialRef: 'COMMANDCODE_API_KEY',
  settingsProviderKey: null,            // 非 DSH provider → 凭证链直接跳过设置项
  description: 'Command Code 订阅使用量（5小时/周）+ 月度剩余额度',
  customOnly: true,                     // 仅自定义（客户端据此不出现在导入列表；host 侧不入 IMPORTABLE）
}
```

要点：

- **`customOnly: true`**：不进 `/dsh-providers` 的 `IMPORTABLE`（需求硬约束）；templates 照常返回（自定义表单选项），host 侧不强依赖该字段（导入列表是唯一出口）；
- **`settingsProviderKey: null`**：凭证链自动跳过「DSH 模型设置」这一步（`resolveCredentialFor` 现有逻辑对 undefined key 安全跳过），手动实例 `source=vault` 时本来就跳过 DSH 链——两者叠加保证 **Command Code Key 只来自插件私有库**；
- **双端点查询**：`doQuery` 对 `commandcode-credits` 并行 `fetch` 两个端点（`Promise.all`），任一失败按现有失败分类处理；订阅端点失败但 credits 成功时降级展示（无计划名/无月重置时间，仅窗口）。

### 4.2 解析器 `parseCommandCodeCredits`（新，host）

把两个端点响应换算成**混合模型**——沿用现有字段，不引入新协议：

```js
{
  planName: 'Command Code（GOAT）',        // 订阅端点 planId → 计划名；失败/未知 → 'Command Code'
  remaining: 62.94,                        // 月度剩余 $（credits.monthlyCredits）
  unit: 'USD',
  used: 7.06,                              // 月已用 = totalQuota − monthlyCredits（钳 0）
  totalQuota: 70,                          // planId → 映射表；未知计划 → null
  nextResetAt: '2026-09-27T03:14:04.000Z', // currentPeriodEnd
  windows: {
    fiveHour: { usedPct: 2.6, cap: 14, used: 0.37, resetsAt: '2026-08-30T02:28:55.000Z' },  // 由 used/cap 计算；resetsAt 与 parseUsage 命名一致
    weekly:   { usedPct: 20.2, cap: 35, used: 7.06, resetsAt: '2026-09-02T11:25:09.000Z' },
  },
  monthly: { usedPct: 10.1, used: 7.06, totalQuota: 70, remaining: 62.94, resetsAt: '…' }, // 新：月档（推算）
  cards: null,
  isValid: true,
  invalidMessage: null,
}
```

- `okResponse` 增加透传字段 `used`、`totalQuota`、`nextResetAt`（不破坏现有两类卡片；客户端按 `adapter` 决定渲染）；
- **月已用精度说明**：`totalQuota − monthlyCredits` 与调研实测完全吻合（70 − 62.94 = 7.06），但**依赖 planId 映射表**（官方出新计划/调价需更新；未知计划降级为只显示剩余+窗口，不显示月百分比）；
- 浮点处理：金额统一 `toFixed(2)` 展示，内部计算用原始 double；已用 `max(0, …)` 钳制。

### 4.3 客户端

- `ADAPTER_META['commandcode-credits'] = { displayName: 'Command Code（订阅+余额）' }` → 自定义表单下拉出现；
- **导入流程天然排除**：`openImport()` 读 `/dsh-providers`（IMPORTABLE 不含 commandcode）→ 导入列表无 Command Code；自定义表单选项来自 `ADAPTER_META` → 只有「添加自定义提供方」里能选到 Command Code；✅ 需求满足；
- 卡片渲染（按 `adapter === 'commandcode-credits'` 走新分支）：
  - 主大字：**月度剩余额度**（`$62.94` + 单位 USD）；
  - 副行：已用 `$7.06 / $70`（月已用/总额，来自 `used/totalQuota`）；
  - 三窗口进度条：**5h / 周 / 月**（沿用 `WindowRow`；月 = 新 `monthly` 对象）；
  - 重置时间：5h/周用窗口 resetAt，月用 `currentPeriodEnd`；
- logo：新增 Command Code 官方/近似标识（可用文字 logo「CC」或官方 favicon；待定，见 §7）；
- 设置页自定义表单 `openManual()` 的默认名称逻辑：`adapter==='commandcode-credits' → 'Command Code'`。

### 4.4 范围与边界

| 项 | 决策 |
|---|---|
| 月用量 | 方案 A（减法，调研推荐）——依赖 planId 映射表；API 无月窗口是官方限制 |
| purchased/freeCredits | 首版不并入展示（与 Rainytoken 一致：主数字=订阅剩余）；extra 中可选展示 |
| 订阅端点失败 | 降级：保留窗口+剩余，无 planName/月% /月重置 |
| `/internal/usage` 明细 | 不做（Cookie 认证，与 API Key 录入冲突；留作未来增强） |
| 计划映射表 | host 常量，注释标注「官方新增计划需更新」；未知计划降级 |
| 401/403 | 复用现有 unauthorized 分类与文案 |

### 4.5 测试

- `tests/host.test.mjs` 新增场景：
  - credits+subscriptions 双端点成功 → 断言 remaining/used/totalQuota/windows/monthly/planName；
  - 未知 planId → totalQuota=null、monthly.usedPct=null（降级不崩）；
  - 订阅端点 500 → 降级成功（窗口仍在）；
  - 401 → unauthorized；
  - `/dsh-providers` 不含 commandcode（导入排除）；`/templates` 含 commandcode-credits（自定义可选）；
  - source=vault 私有库 Key 直取（不用 DSH 凭证）。
- `tests/smoke.mjs` 保持模板数量断言同步（2→3）。

---

## 5. 备选方案对比（为什么选方案 4）

| 方案 | 做法 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| **A（推荐）** | 新适配器 `commandcode-credits` + 双端点 + 减法月用量 | 改动集中、复用全部基础设施（缓存/凭证/UI）、只填 API Key | 月用量依赖计划映射表 | ✅ |
| B | 复用 `usage-percent` 只展示窗口百分比 | 零新代码 | 无剩余额度，不满足需求 | ❌ |
| C | 复用 `balance-json` 只展示剩余 | 零新代码 | 无订阅使用量，不满足需求 | ❌ |
| D | `/internal/usage` 明细聚合月用量 | 月用量精确、不依赖映射表 | 需 Cookie 认证（录入形态冲突）、需全量同步 | 留作未来增强 |
| E | 在 DSH 模型设置里注册 commandcode provider 再导入 | 与现有导入语义一致 | Command Code **非 DSH 内置提供方**（pi-ai 注册表实测无），需改 DSH 本体，超出本插件范围 | ❌ |

---

## 6. 改动文件清单

| 文件 | 改动 |
|---|---|
| `lib/index.js` | `ADAPTERS` + commandcode-credits；`doQuery` 双端点分支；新增 `parseCommandCodeCredits` + planId 映射表；`okResponse` 透传 used/totalQuota/nextResetAt |
| `lib/client.js` | `ADAPTER_META` + commandcode-credits；卡片混合渲染分支；`openManual` 默认名；logo |
| `tests/host.test.mjs` | 新场景（§4.5） |
| `tests/smoke.mjs` | templates 数量断言 2→3 |
| `README.md` | 支持提供方表格 + 快速开始（Command Code：添加自定义提供方，填 API Key） |
| `docs/CHANGELOG.md` | 新版本条目（v0.6.0，MINOR） |

版本号：新增提供方 + 新卡片类型 = 用户可见功能 → **MINOR**（0.5.2 → 0.6.0，遵循 docs/规范/版本号说明.md）。

---

## 7. 决策记录（2026-08-31 已确认）

| # | 决策点 | 结论 | 说明 |
|---|---|---|---|
| 1 | 展示主数字 | **月已用百分比**为主大字 | 用户指定：(总额−剩余)/总额 = 已用百分比；副行「已用 $X / $Y + 剩余 $Z」 |
| 2 | 月用量方案 | **减法（planId 映射表）** | 用户认可减法；(70−62.94)/70 = 10.08% 与官方实测吻合 |
| 3 | purchased/freeCredits | **不展示** | 与 Rainytoken 一致；响应保留字段，extra 仅在 >0 时带出 |
| 4 | logo | **文字标识「CC」** | 无官方素材，紫色渐变圆角块占位，后续可换 |
| 5 | 卡片窗口 | 5h / 周 / 月三行 | 月 = 推算窗口，视觉与 OpenCode Go 一致 |

> 方案已按 §4 实施（v0.6.0），测试全绿（host 137 项含 4 个新场景）。
